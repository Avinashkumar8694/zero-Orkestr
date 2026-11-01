// The Analytics Builder's query engine: validate against the catalogue, compile to closures, run with push-down, semi-join + hash
// joins, streaming aggregation and guards. Pure of HTTP and storage details — it only talks to an Env (see catalog.ts).
import { ApiError, validation } from '../infra/errors.ts';
import { permissionGrants } from '../infra/auth.ts';
import { forbidden } from '../infra/errors.ts';
import { BUCKETS, FUNCTIONS, OPERATORS, RELATIONS, SOURCES, SOURCE_PERMISSION, type Env, type FieldType, type Relation, type SourceDef, type SourceKey } from './catalog.ts';

type Rec = Record<string, any>;
export type Op = (typeof OPERATORS)[number];
export type Fn = (typeof FUNCTIONS)[number];
export type Bucket = (typeof BUCKETS)[number];
export type Literal = string | number | boolean | null | Array<string | number | boolean>;
export type Value = Literal | { param: string } | { now: string };
export interface Cond { field: string; op: Op; value?: Value }
export interface Group { op: 'and' | 'or'; items: Array<Cond | Group> }
export interface AnalyticsQuery {
  from: SourceKey;
  joins?: Array<{ rel: string; as?: string; from?: string; type?: 'left' | 'inner' }>;
  where?: Cond | Group;
  select?: Array<{ field: string; as?: string }>;
  groupBy?: Array<{ field: string; bucket?: Bucket; as?: string }>;
  metrics?: Array<{ fn: Fn; field?: string; as?: string }>;
  having?: Cond | Group;
  sort?: Array<{ field: string; dir?: 'asc' | 'desc' }>;
  limit?: number; offset?: number;
}
export interface Column { key: string; label: string; type: FieldType }
export interface RunMeta { tookMs: number; scanned: number; returned: number; total: number | null; truncated: boolean; truncatedReason?: string; cached?: boolean }
export interface RunResult { mode: 'rows' | 'aggregate'; columns: Column[]; rows: Rec[]; meta: RunMeta }

export const LIMITS = { maxScan: 200_000, maxRows: 1_000, defaultRows: 100, budgetMs: 10_000, maxPath: 6 };
const bad = (m: string) => validation(`analytics: ${m}`);

type Wide = Record<string, Rec | null>;
interface Compiled<T> { fn: T; aliases: Set<string> }
interface Plan {
  from: { alias: string; src: SourceKey };
  aliases: Map<string, SourceKey>;
  joins: Array<{ rel: Relation; alias: string; fromAlias: string; type: 'left' | 'inner' }>;
}

// ------------------------------------------------------------------------------------------------ values
function nowValue(spec: string, nowMs: number): string {
  const m = /^([+-]?)(\d+)\s*([smhdw])$/.exec(spec.trim());
  if (!m) throw bad(`"now" expects a relative time such as -7d, -12h, +30m (got "${spec}")`);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[3] as 's'] ;
  return new Date(nowMs + (m[1] === '-' ? -1 : 1) * Number(m[2]) * unit).toISOString();
}
export function collectParams(q: AnalyticsQuery): string[] {
  const out = new Set<string>();
  const walk = (n: Cond | Group | undefined) => {
    if (!n) return;
    if ('items' in n) n.items.forEach(walk);
    else if (n.value && typeof n.value === 'object' && !Array.isArray(n.value) && 'param' in n.value) out.add(n.value.param);
  };
  walk(q.where); walk(q.having);
  return [...out];
}
function resolveValue(v: Value | undefined, params: Record<string, unknown> | null, nowMs: number): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if ('param' in v) {
      if (!params) return undefined;                         // validate-only compile
      if (!(v.param in params)) throw bad(`parameter "${v.param}" was not supplied`);
      return params[v.param];
    }
    if ('now' in v) return nowValue(v.now, nowMs);
  }
  return v;
}
const norm = (t: FieldType | undefined, v: unknown): unknown => {
  if (v === undefined || v === null) return undefined;
  if (t === 'number') { const n = Number(v); return Number.isNaN(n) ? undefined : n; }
  if (t === 'date') { const n = typeof v === 'number' ? v : Date.parse(String(v)); return Number.isNaN(n) ? undefined : n; }
  if (t === 'boolean') return v === true || v === 'true' || v === 1 || v === '1';
  if (t === 'string') return String(v);
  return v;                                                // json / unknown: compared as given
};
const eqLoose = (a: unknown, b: unknown) => a === b || (a !== undefined && b !== undefined && typeof a !== 'object' && typeof b !== 'object' && String(a) === String(b));

// ------------------------------------------------------------------------------------------------ compile
function parseRef(plan: Plan, ref: string, nowMs: number): { alias: string; type: FieldType; label: string; get: (w: Wide) => unknown } {
  if (typeof ref !== 'string' || !ref.trim()) throw bad('a field is required');
  const segs = ref.split('.');
  if (segs.length > LIMITS.maxPath + 2) throw bad(`field path "${ref}" is too deep`);
  let alias = plan.from.alias, rest = segs;
  if (plan.aliases.has(segs[0]!)) { alias = segs[0]!; rest = segs.slice(1); }
  const src: SourceDef = SOURCES[plan.aliases.get(alias)!];
  const name = rest[0];
  if (!name) throw bad(`"${ref}" names a source, not a field (try ${ref}.id)`);
  const def = src.fields.find((x) => x.key === name);
  if (def) {
    if (rest.length > 1) throw bad(`"${ref}": ${src.label} field "${name}" has no sub-fields`);
    return { alias, type: def.type, label: def.label, get: (w) => { const r = w[alias]; return r ? def.get(r, nowMs) : undefined; } };
  }
  const dyn = src.dynamic.find((d) => d.key === name);
  if (dyn && rest.length > 1) {
    const path = rest.slice(1);
    if (path.length > LIMITS.maxPath) throw bad(`field path "${ref}" is too deep`);
    return { alias, type: 'json', label: ref, get: (w) => { const r = w[alias]; let c: any = r ? dyn.get(r) : undefined; for (const p of path) { if (c == null) return undefined; c = c[p]; } return c; } };
  }
  const known = [...src.fields.map((x) => x.key), ...src.dynamic.map((d) => `${d.key}.<path>`)].join(', ');
  throw bad(`unknown field "${ref}" on ${src.label} (known: ${known})`);
}

function compileCond(plan: Plan, c: Cond, params: Record<string, unknown> | null, nowMs: number): Compiled<(w: Wide) => boolean> {
  if (!OPERATORS.includes(c.op)) throw bad(`unknown operator "${c.op}"`);
  const ref = parseRef(plan, c.field, nowMs);
  const raw = resolveValue(c.value, params, nowMs);
  const t = ref.type;
  const one = (v: unknown) => norm(t, v);
  const many = Array.isArray(raw) ? raw.map(one) : [];
  const exp = one(raw);
  if (params && ['in', 'nin'].includes(c.op) && !Array.isArray(raw)) throw bad(`operator "${c.op}" on "${c.field}" needs a list`);
  if (params && c.op === 'between' && (!Array.isArray(raw) || raw.length !== 2)) throw bad(`operator "between" on "${c.field}" needs [low, high]`);
  const get = (w: Wide) => one(ref.get(w));
  let fn: (w: Wide) => boolean;
  switch (c.op) {
    case 'eq': fn = (w) => eqLoose(get(w), exp); break;
    case 'ne': fn = (w) => !eqLoose(get(w), exp); break;
    case 'gt': fn = (w) => { const a = get(w); return a !== undefined && exp !== undefined && (a as any) > (exp as any); }; break;
    case 'gte': fn = (w) => { const a = get(w); return a !== undefined && exp !== undefined && (a as any) >= (exp as any); }; break;
    case 'lt': fn = (w) => { const a = get(w); return a !== undefined && exp !== undefined && (a as any) < (exp as any); }; break;
    case 'lte': fn = (w) => { const a = get(w); return a !== undefined && exp !== undefined && (a as any) <= (exp as any); }; break;
    case 'in': fn = (w) => { const a = get(w); return many.some((m) => eqLoose(a, m)); }; break;
    case 'nin': fn = (w) => { const a = get(w); return !many.some((m) => eqLoose(a, m)); }; break;
    case 'contains': fn = (w) => { const a = ref.get(w); return typeof a === 'string' ? a.toLowerCase().includes(String(raw ?? '').toLowerCase()) : Array.isArray(a) && a.some((x) => eqLoose(x, raw)); }; break;
    case 'startsWith': fn = (w) => { const a = ref.get(w); return typeof a === 'string' && a.toLowerCase().startsWith(String(raw ?? '').toLowerCase()); }; break;
    case 'between': fn = (w) => { const a = get(w); return a !== undefined && many[0] !== undefined && many[1] !== undefined && (a as any) >= (many[0] as any) && (a as any) <= (many[1] as any); }; break;
    case 'isNull': fn = (w) => { const a = ref.get(w); return a === undefined || a === null; }; break;
    case 'notNull': fn = (w) => { const a = ref.get(w); return a !== undefined && a !== null; }; break;
  }
  return { fn, aliases: new Set([ref.alias]) };
}

function compileNode(plan: Plan, n: Cond | Group, params: Record<string, unknown> | null, nowMs: number, depth = 0): Compiled<(w: Wide) => boolean> {
  if (depth > 8) throw bad('filters are nested too deeply');
  if ('items' in n) {
    if (n.op !== 'and' && n.op !== 'or') throw bad(`a filter group is "and" or "or" (got "${(n as any).op}")`);
    const parts = n.items.map((i) => compileNode(plan, i, params, nowMs, depth + 1));
    const aliases = new Set(parts.flatMap((p) => [...p.aliases]));
    const fns = parts.map((p) => p.fn);
    return { fn: n.op === 'and' ? (w) => fns.every((f) => f(w)) : (w) => fns.some((f) => f(w)), aliases };
  }
  return compileCond(plan, n, params, nowMs);
}

function buildPlan(q: AnalyticsQuery): Plan {
  if (!q || typeof q !== 'object') throw bad('a query is required');
  if (!SOURCES[q.from]) throw bad(`unknown source "${q.from}" (use ${Object.keys(SOURCES).join(', ')})`);
  const aliases = new Map<string, SourceKey>([[q.from, q.from]]);
  const joins: Plan['joins'] = [];
  if ((q.joins?.length ?? 0) > 8) throw bad('at most 8 joins');
  for (const j of q.joins ?? []) {
    const rel = RELATIONS[j.rel];
    if (!rel) throw bad(`unknown relation "${j.rel}"`);
    const fromAlias = j.from ?? [...aliases].find(([, s]) => s === rel.from)?.[0];
    if (!fromAlias || aliases.get(fromAlias) !== rel.from) throw bad(`relation "${j.rel}" starts from ${SOURCES[rel.from].label}, which is not in this query yet`);
    const alias = j.as ?? rel.to;
    if (!/^[a-z][a-zA-Z0-9]*$/.test(alias)) throw bad(`alias "${alias}" must be letters and digits`);
    if (aliases.has(alias)) throw bad(`alias "${alias}" is already used — give this join an "as"`);
    aliases.set(alias, rel.to);
    joins.push({ rel, alias, fromAlias, type: j.type === 'inner' ? 'inner' : 'left' });
  }
  return { from: { alias: q.from, src: q.from }, aliases, joins };
}

// ------------------------------------------------------------------------------------------------ aggregation helpers
const pad = (n: number) => String(n).padStart(2, '0');
function bucketOf(v: unknown, b: Bucket): string | null {
  const ms = typeof v === 'number' ? v : Date.parse(String(v ?? ''));
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms), y = d.getUTCFullYear(), mo = pad(d.getUTCMonth() + 1), da = pad(d.getUTCDate());
  if (b === 'hour') return `${y}-${mo}-${da}T${pad(d.getUTCHours())}:00Z`;
  if (b === 'day') return `${y}-${mo}-${da}`;
  if (b === 'month') return `${y}-${mo}`;
  const monday = new Date(Date.UTC(y, d.getUTCMonth(), d.getUTCDate() - ((d.getUTCDay() + 6) % 7)));
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}
interface Acc { count: number; n: number; sum: number; min: number; max: number; set?: Set<string>; vals?: number[] }
const newAcc = (m: { fn: Fn }): Acc => ({ count: 0, n: 0, sum: 0, min: Infinity, max: -Infinity, ...(m.fn === 'countDistinct' ? { set: new Set<string>() } : {}), ...(/^p\d+$/.test(m.fn) ? { vals: [] } : {}) });
function pct(vals: number[], p: number): number | null {
  if (!vals.length) return null;
  const s = [...vals].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}
const cmp = (a: unknown, b: unknown) => (a == null ? (b == null ? 0 : -1) : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0);
const colKey = (field: string) => field.replace(/\./g, '_');

// ------------------------------------------------------------------------------------------------ validate / run
/** Throws a readable validation error for anything the catalogue does not allow. Returns the columns the result will have. */
export function validateQuery(q: AnalyticsQuery): Column[] {
  return compileAll(q, null, Date.now()).columns;
}

interface Full { plan: Plan; columns: Column[]; mode: 'rows' | 'aggregate'; run: (env: Env, query: AnalyticsQuery) => Promise<RunResult> }

function compileAll(q: AnalyticsQuery, params: Record<string, unknown> | null, nowMs: number): Full {
  const plan = buildPlan(q);
  const aggregate = !!(q.groupBy?.length || q.metrics?.length);
  if (aggregate && q.select?.length) throw bad('use either "select" (rows) or "groupBy"/"metrics" (aggregate), not both');
  const where = q.where ? compileNode(plan, q.where, params, nowMs) : undefined;

  // top-level AND conditions on the `from` source alone are pushed into the fetch
  const items = where && q.where ? ('items' in q.where && q.where.op === 'and' ? q.where.items : [q.where]) : [];
  const compiledItems = items.map((i) => compileNode(plan, i, params, nowMs));
  const pushed = compiledItems.filter((c) => [...c.aliases].every((a) => a === plan.from.alias)).map((c) => c.fn);
  const rest = compiledItems.filter((c) => ![...c.aliases].every((a) => a === plan.from.alias)).map((c) => c.fn);

  const referenced = new Set<string>();
  const ref = (f: string) => { const r = parseRef(plan, f, nowMs); referenced.add(r.alias); return r; };
  q.where && compileNode(plan, q.where, params, nowMs).aliases.forEach((a) => referenced.add(a));

  const columns: Column[] = [];
  let outRow!: (w: Wide) => Rec;
  const groupFns: Array<{ as: string; get: (w: Wide) => unknown }> = [];
  const metricDefs: Array<{ as: string; fn: Fn; get?: (w: Wide) => unknown; type: FieldType }> = [];

  if (aggregate) {
    for (const g of q.groupBy ?? []) {
      const r = ref(g.field);
      if (g.bucket && !BUCKETS.includes(g.bucket)) throw bad(`unknown bucket "${g.bucket}"`);
      if (g.bucket && r.type !== 'date') throw bad(`"${g.field}" is not a date, so it cannot be bucketed`);
      const as = g.as ?? colKey(g.field);
      groupFns.push({ as, get: g.bucket ? (w) => bucketOf(r.get(w), g.bucket!) : (w) => r.get(w) ?? null });
      columns.push({ key: as, label: g.as ?? r.label, type: g.bucket ? 'string' : r.type });
    }
    if (!q.metrics?.length) throw bad('add at least one metric (for example count) when grouping');
    for (const m of q.metrics) {
      if (!FUNCTIONS.includes(m.fn)) throw bad(`unknown function "${m.fn}"`);
      if (m.fn !== 'count' && !m.field) throw bad(`"${m.fn}" needs a field`);
      const r = m.field ? ref(m.field) : undefined;
      if (r && ['sum', 'avg', 'min', 'max'].includes(m.fn) && !['number', 'date', 'json'].includes(r.type)) throw bad(`"${m.fn}" needs a numeric field (${m.field} is ${r.type})`);
      const as = m.as ?? (m.field ? `${m.fn}_${colKey(m.field)}` : m.fn);
      metricDefs.push({ as, fn: m.fn, get: r?.get, type: 'number' });
      columns.push({ key: as, label: m.as ?? as, type: 'number' });
    }
    if (new Set(columns.map((c) => c.key)).size !== columns.length) throw bad('two output columns have the same name — give one an "as"');
  } else {
    const sel = q.select?.length ? q.select : Object.values(SOURCES[plan.from.src].fields).filter((x) => !x.computed).map((x) => ({ field: `${plan.from.alias}.${x.key}`, as: x.key }));
    const getters = sel.map((s) => { const r = ref(s.field); const key = s.as ?? colKey(s.field); columns.push({ key, label: s.as ?? r.label, type: r.type }); return { key, get: r.get }; });
    if (new Set(columns.map((c) => c.key)).size !== columns.length) throw bad('two output columns have the same name — give one an "as"');
    outRow = (w) => { const o: Rec = {}; for (const g of getters) o[g.key] = g.get(w) ?? null; return o; };
  }

  // sort / having refer to output columns (aggregate) or to fields / output columns (rows)
  const colTypes = new Map(columns.map((c) => [c.key, c.type]));
  const sortSpecs = (q.sort ?? []).map((s) => {
    if (s.dir && s.dir !== 'asc' && s.dir !== 'desc') throw bad(`sort direction is "asc" or "desc"`);
    const dir = s.dir === 'desc' ? -1 : 1;
    if (colTypes.has(s.field)) return { col: s.field, dir, get: undefined as undefined | ((w: Wide) => unknown) };
    if (aggregate) throw bad(`cannot sort by "${s.field}": in aggregate mode sort by one of ${[...colTypes.keys()].join(', ')}`);
    return { col: undefined as string | undefined, dir, get: ref(s.field).get };
  });
  let havingFn: ((r: Rec) => boolean) | undefined;
  if (q.having) {
    if (!aggregate) throw bad('"having" only applies to aggregate queries');
    const hplan: Plan = { from: { alias: '$', src: 'workspace' }, aliases: new Map(), joins: [] };
    const asSrc: SourceDef = { key: 'workspace', label: 'result', fields: columns.map((c) => ({ key: c.key, label: c.label, type: c.type, get: (r: Rec) => r[c.key] })), dynamic: [] };
    // evaluate against output rows through a throwaway one-source plan
    (SOURCES as any).__result = asSrc; hplan.aliases.set('$', '__result' as SourceKey); hplan.from = { alias: '$', src: '__result' as SourceKey };
    try { const c = compileNode(hplan, q.having, params, nowMs); havingFn = (r) => c.fn({ $: r }); } finally { delete (SOURCES as any).__result; }
    (SOURCES as any).__result = asSrc;               // parseRef reads SOURCES at call time too, so keep it for the closures above
    delete (SOURCES as any).__result;
  }

  q.sort?.forEach((s) => { if (!colTypes.has(s.field) && !aggregate) referenced.add(ref(s.field).alias); });

  const limit = Math.min(Math.max(1, Math.floor(q.limit ?? LIMITS.defaultRows)), LIMITS.maxRows);
  const offset = Math.max(0, Math.floor(q.offset ?? 0));

  const run = async (env: Env): Promise<RunResult> => {
    const t0 = Date.now();
    let scanned = 0, truncated = false, reason: string | undefined;
    const over = () => { if (Date.now() - t0 > LIMITS.budgetMs) { truncated = true; reason ||= 'time budget'; return true; } return false; };

    let fromRows = await env.table(plan.from.src);
    scanned += fromRows.length;
    if (fromRows.length > LIMITS.maxScan) { fromRows = fromRows.slice(0, LIMITS.maxScan); truncated = true; reason = `scan limit (${LIMITS.maxScan} rows)`; }
    const w0: Wide[] = [];
    for (const r of fromRows) { const w: Wide = { [plan.from.alias]: r }; if (pushed.every((p) => p(w))) w0.push(w); }

    let wide = w0;
    const simple = !plan.joins.length && !sortSpecs.length && !aggregate;
    for (const j of plan.joins) {
      if (over()) break;
      // a one-cardinality left join that nothing reads cannot change the result: skip it
      if (j.type === 'left' && !j.rel.many && !referenced.has(j.alias) && !plan.joins.some((x) => x.fromAlias === j.alias)) continue;
      const lefts = new Set<Rec>(); for (const w of wide) { const r = w[j.fromAlias]; if (r) lefts.add(r); }
      const map = await j.rel.fetch(env, [...lefts]);
      const next: Wide[] = [];
      for (const w of wide) {
        const l = w[j.fromAlias]; const k = l ? j.rel.leftKey(l) : undefined;
        const rights = k !== undefined ? map.get(k) : undefined;
        if (!rights?.length) { if (j.type === 'left') next.push({ ...w, [j.alias]: null }); }
        else for (const r of rights) { next.push({ ...w, [j.alias]: r }); if (next.length > LIMITS.maxScan) break; }
        if (next.length > LIMITS.maxScan) { truncated = true; reason = `join expanded past ${LIMITS.maxScan} rows`; break; }
      }
      scanned += next.length;
      wide = next;
    }
    const rows = rest.length ? wide.filter((w) => rest.every((p) => p(w))) : wide;

    let out: Rec[]; let total: number | null;
    if (aggregate) {
      const groups = new Map<string, { keys: unknown[]; accs: Acc[] }>();
      let i = 0;
      for (const w of rows) {
        if ((++i & 1023) === 0 && over()) break;
        const keys = groupFns.map((g) => g.get(w));
        const gk = keys.length ? JSON.stringify(keys) : '';
        let g = groups.get(gk);
        if (!g) { g = { keys, accs: metricDefs.map(newAcc) }; groups.set(gk, g); }
        metricDefs.forEach((m, mi) => {
          const a = g!.accs[mi]!;
          if (!m.get) { a.count++; return; }                       // count of rows
          const v = m.get(w);
          if (v === undefined || v === null) return;
          if (m.fn === 'count') { a.count++; return; }
          if (m.fn === 'countDistinct') { a.set!.add(typeof v === 'object' ? JSON.stringify(v) : String(v)); return; }
          const n = typeof v === 'number' ? v : Date.parse(String(v)) ; const num = typeof v === 'number' ? v : Number.isNaN(Number(v)) ? n : Number(v);
          if (Number.isNaN(num)) return;
          a.n++; a.sum += num; if (num < a.min) a.min = num; if (num > a.max) a.max = num; a.vals?.push(num);
        });
      }
      if (!groupFns.length && !groups.size) groups.set('', { keys: [], accs: metricDefs.map(newAcc) });
      out = [...groups.values()].map((g) => {
        const o: Rec = {};
        groupFns.forEach((gf, k) => { o[gf.as] = g.keys[k] ?? null; });
        metricDefs.forEach((m, k) => {
          const a = g.accs[k]!;
          o[m.as] = m.fn === 'count' ? a.count : m.fn === 'countDistinct' ? a.set!.size : m.fn === 'sum' ? a.sum
            : m.fn === 'avg' ? (a.n ? Math.round((a.sum / a.n) * 100) / 100 : null) : m.fn === 'min' ? (a.n ? a.min : null) : m.fn === 'max' ? (a.n ? a.max : null)
              : pct(a.vals ?? [], Number(m.fn.slice(1)));
        });
        return o;
      });
      if (havingFn) out = out.filter(havingFn);
      if (sortSpecs.length) out.sort((a, b) => { for (const s of sortSpecs) { const c = cmp(a[s.col!], b[s.col!]) * s.dir; if (c) return c; } return 0; });
      total = out.length; out = out.slice(offset, offset + limit);
    } else if (simple) {
      out = []; total = null;
      for (const w of rows) { out.push(outRow(w)); if (out.length >= offset + limit) break; }
      out = out.slice(offset);
    } else {
      total = rows.length;
      let items = rows.map((w) => ({ w, sv: sortSpecs.map((s) => (s.get ? s.get(w) : undefined)) }));
      if (sortSpecs.length) {
        const proj = sortSpecs.some((s) => s.col) ? new Map(items.map((it) => [it, outRow(it.w)])) : undefined;
        items.sort((a, b) => { for (let k = 0; k < sortSpecs.length; k++) { const s = sortSpecs[k]!; const av = s.col ? proj!.get(a)![s.col] : a.sv[k], bv = s.col ? proj!.get(b)![s.col] : b.sv[k]; const c = cmp(av, bv) * s.dir; if (c) return c; } return 0; });
      }
      items = items.slice(offset, offset + limit);
      out = items.map((it) => outRow(it.w));
    }
    return { mode: aggregate ? 'aggregate' : 'rows', columns, rows: out, meta: { tookMs: Date.now() - t0, scanned, returned: out.length, total, truncated, ...(reason ? { truncatedReason: reason } : {}) } };
  };
  return { plan, columns, mode: aggregate ? 'aggregate' : 'rows', run: (env) => run(env) };
}

/** Compile `q` with concrete parameter values and run it. */
export async function runQuery(env: Env, q: AnalyticsQuery, params: Record<string, unknown> = {}): Promise<RunResult> {
  try { return await compileAll(q, params, env.nowMs).run(env, q); }
  catch (e) { if (e instanceof ApiError) throw e; throw e; }
}

/** every source a query reads: `from`, each joined source, and the source a relation starts from */
export function sourcesOf(q: AnalyticsQuery): SourceKey[] {
  const plan = buildPlan(q);
  return [...new Set<SourceKey>([...plan.aliases.values()])];
}

/** Refuse unless `permissions` (the caller's own, in this workspace) grant the read permission of every source in the query.
 *  Runs before anything is fetched — and, for published APIs, before any cached result is served. */
export function authorizeQuery(q: AnalyticsQuery, permissions: string[]): void {
  for (const s of sourcesOf(q)) {
    const need = SOURCE_PERMISSION[s];
    if (!permissionGrants(permissions, need)) throw forbidden(`analytics: reading ${SOURCES[s].label} data needs the "${need}" permission`);
  }
}
