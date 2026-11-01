// Analytics definitions: a query + parameters published under a slug, callable as an API. Everything that decides WHO may see
// WHAT lives here: the workspace comes from the context only, the caller's permissions must cover every source the query reads
// (checked on save, preview and every run — before any cache is consulted), private APIs belong to their owner, and a flow can
// only run an API whose owner explicitly allowed it.
import type { AppContext } from '../context.ts';
import { permissionGrants } from '../infra/auth.ts';
import { conflict, forbidden, notFound, validation } from '../infra/errors.ts';
import { permissionProblem } from '../modules/iam/permissions.ts';
import type { WorkflowServiceStore } from '../workflow-service/store/types.ts';
import { catalogView, makeEnv } from './catalog.ts';
import { SEED_MIGRATIONS } from './seed.ts';
import { authorizeQuery, collectParams, LIMITS, runQuery, validateQuery, type AnalyticsQuery, type RunResult } from './engine.ts';

export type ParamType = 'string' | 'number' | 'boolean' | 'date' | 'list';
export interface ParamSpec { name: string; type: ParamType; required?: boolean; default?: unknown; label?: string }
export interface AnalyticsApi {
  id: string; tenantId: string;
  slug: string; name: string; description?: string;
  query: AnalyticsQuery; params: ParamSpec[];
  /** seconds a result may be reused (0 = never); keyed by version + parameters, never shared across workspaces */
  cacheSeconds: number;
  status: 'draft' | 'published';
  /** 'private': only the owner can see, edit or call it · 'workspace': any member who passes the checks below */
  visibility: 'workspace' | 'private';
  /** an extra permission a caller must hold on top of the read permission of every source (e.g. "admin:iam") */
  requires?: string;
  /** the owner allows flows (case / process instance nodes) to call this API with the engine's authority */
  allowFlows?: boolean;
  /** shipped with the product (seed migration): only an administrator can change or delete it */
  builtIn?: boolean;
  ownerId: string; version: number;
  createdAt: string; createdBy: string; updatedAt: string; updatedBy: string;
}
export interface Caller { actor: string; permissions: string[] }

const COLLECTION = 'analytics_apis';
const SLUG_RE = /^[a-z][a-z0-9-]{2,47}$/;
const RESERVED = new Set(['run', 'catalog', 'preview', 'apis', 'query', 'queries', 'summary', 'tat', 'new']);
const PARAM_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,31}$/;

// bounded, in-process result cache. Authorization is always evaluated BEFORE a lookup, and the key carries the workspace, the API
// id and its version, so an entry can only ever be served to someone who passes the same checks for the same data.
// Bounded by BYTES (a few huge results cannot crowd out memory the way a count limit would); one result may use at most a quarter of it.
const CACHE_BYTES = Number(process.env.ANALYTICS_CACHE_BYTES) || 8_000_000;
export const cacheLimits = { bytes: CACHE_BYTES };
const cache = new Map<string, { at: number; result: RunResult; size: number }>();
let cacheSize = 0;
const cacheDrop = (k: string) => { const e = cache.get(k); if (e) { cacheSize -= e.size; cache.delete(k); } };
const cacheGet = (k: string, ttlMs: number) => {
  const e = cache.get(k);
  if (!e) return undefined;
  if (Date.now() - e.at > ttlMs) { cacheDrop(k); return undefined; }
  cache.delete(k); cache.set(k, e);                      // LRU touch
  return e.result;
};
const cachePut = (k: string, result: RunResult) => {
  const size = JSON.stringify(result).length;
  if (size > cacheLimits.bytes / 4) return;
  cacheDrop(k);
  while (cache.size && cacheSize + size > cacheLimits.bytes) cacheDrop(cache.keys().next().value as string);
  cache.set(k, { at: Date.now(), result, size }); cacheSize += size;
};
export const clearAnalyticsCache = () => { cache.clear(); cacheSize = 0; };
export const analyticsCacheStats = () => ({ entries: cache.size, bytes: cacheSize });
const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

export class AnalyticsService {
  constructor(private ctx: AppContext, private wf: WorkflowServiceStore) {
    // analytics is per workspace; the platform-wide scope ('all') has no single workspace to read from
    if (!ctx.tenantId || ctx.tenantId === 'all' || ctx.tenantId === '*') throw forbidden('analytics needs a workspace: pick one first');
  }
  private repo() { return this.ctx.store.repo<AnalyticsApi>(COLLECTION); }
  private isAdmin(c: Caller) { return permissionGrants(c.permissions, 'admin:iam'); }

  catalog(c: Caller) {
    const v = catalogView();
    return { ...v, sources: v.sources.map((s) => ({ ...s, allowed: permissionGrants(c.permissions, s.permission) })) };
  }

  // ---- ad-hoc ---------------------------------------------------------------------------------------------------------
  async preview(query: AnalyticsQuery, params: Record<string, unknown> | undefined, c: Caller): Promise<RunResult> {
    authorizeQuery(query, c.permissions);
    validateQuery(query);
    const declared = Object.fromEntries(collectParams(query).map((n) => [n, params?.[n]]));
    for (const [n, v] of Object.entries(declared)) if (v === undefined) throw validation(`analytics: preview needs a value for parameter "${n}"`);
    return runQuery(makeEnv(this.ctx, this.wf), query, declared);
  }

  // ---- definitions ----------------------------------------------------------------------------------------------------
  private visibleTo(a: AnalyticsApi, c: Caller): boolean { return a.tenantId === this.ctx.tenantId && (a.visibility === 'workspace' || a.ownerId === c.actor); }

  async list(c: Caller): Promise<AnalyticsApi[]> {
    return (await this.repo().query((a) => this.visibleTo(a, c))).sort((a, b) => a.name.localeCompare(b.name));
  }
  async get(id: string, c: Caller): Promise<AnalyticsApi> {
    const a = await this.repo().get(id);
    if (!a || !this.visibleTo(a, c)) throw notFound('Analytics API');
    return a;
  }

  private validateParams(raw: unknown): ParamSpec[] {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > 20) throw validation('params must be a list of at most 20');
    const seen = new Set<string>();
    return raw.map((p: any) => {
      if (!p || !PARAM_RE.test(String(p.name ?? ''))) throw validation('every parameter needs a name of letters, digits and _ (starting with a letter)');
      if (seen.has(p.name)) throw validation(`parameter "${p.name}" is declared twice`);
      seen.add(p.name);
      if (!['string', 'number', 'boolean', 'date', 'list'].includes(p.type)) throw validation(`parameter "${p.name}": type must be string, number, boolean, date or list`);
      const spec: ParamSpec = { name: p.name, type: p.type, ...(p.required ? { required: true } : {}), ...(p.label ? { label: String(p.label).slice(0, 80) } : {}) };
      if (p.default !== undefined) spec.default = this.coerce(spec, p.default);
      return spec;
    });
  }

  private validateDefinition(input: any, c: Caller): Pick<AnalyticsApi, 'slug' | 'name' | 'description' | 'query' | 'params' | 'cacheSeconds' | 'status' | 'visibility' | 'requires' | 'allowFlows'> {
    const slug = String(input.slug ?? '').trim().toLowerCase();
    if (!SLUG_RE.test(slug)) throw validation('slug must be 3–48 characters: lower-case letters, digits and dashes, starting with a letter');
    if (RESERVED.has(slug)) throw validation(`"${slug}" is reserved — choose another slug`);
    const name = String(input.name ?? '').trim();
    if (name.length < 2 || name.length > 100) throw validation('name must be 2–100 characters');
    const query = input.query as AnalyticsQuery;
    authorizeQuery(query, c.permissions);                                  // you cannot publish what you may not read
    validateQuery(query);
    const params = this.validateParams(input.params);
    const used = collectParams(query), declared = new Set(params.map((p) => p.name));
    for (const u of used) if (!declared.has(u)) throw validation(`the query uses parameter "${u}", which is not declared`);
    const cacheSeconds = input.cacheSeconds === undefined ? 30 : Number(input.cacheSeconds);
    if (!Number.isInteger(cacheSeconds) || cacheSeconds < 0 || cacheSeconds > 3600) throw validation('cacheSeconds must be a whole number from 0 to 3600');
    const status = input.status === 'published' ? 'published' : 'draft';
    const visibility = input.visibility === 'private' ? 'private' : 'workspace';
    let requires: string | undefined;
    if (input.requires) {
      const bad = permissionProblem(String(input.requires));
      if (bad) throw validation(`requires: ${bad}`);
      if (!permissionGrants(c.permissions, String(input.requires))) throw forbidden('you cannot require a permission you do not hold yourself');
      requires = String(input.requires);
    }
    return { slug, name, description: input.description ? String(input.description).slice(0, 500) : undefined, query, params, cacheSeconds, status, visibility, requires, allowFlows: input.allowFlows === true };
  }

  async create(input: any, c: Caller): Promise<AnalyticsApi> {
    const d = this.validateDefinition(input ?? {}, c);
    if ((await this.repo().query((a) => a.tenantId === this.ctx.tenantId && a.slug === d.slug)).length) throw conflict(`slug "${d.slug}" is already used in this workspace`);
    const now = this.ctx.clock();
    const a: AnalyticsApi = { id: this.ctx.newId(), tenantId: this.ctx.tenantId, ...d, ownerId: c.actor, version: 1, createdAt: now, createdBy: c.actor, updatedAt: now, updatedBy: c.actor };
    await this.repo().put(a);
    await this.ctx.audit({ actor: c.actor, kind: 'analytics.created', data: { id: a.id, slug: a.slug, status: a.status, visibility: a.visibility } });
    return a;
  }

  private async writable(id: string, c: Caller): Promise<AnalyticsApi> {
    const a = await this.get(id, c);
    if (a.ownerId !== c.actor && !this.isAdmin(c)) throw forbidden('only the owner or a workspace administrator can change this analytics API');
    return a;
  }

  async update(id: string, input: any, c: Caller): Promise<AnalyticsApi> {
    const cur = await this.writable(id, c);
    const d = this.validateDefinition({ ...cur, ...input }, c);
    if (d.slug !== cur.slug && (await this.repo().query((a) => a.tenantId === this.ctx.tenantId && a.slug === d.slug && a.id !== id)).length) throw conflict(`slug "${d.slug}" is already used in this workspace`);
    const next: AnalyticsApi = { ...cur, ...d, version: cur.version + 1, updatedAt: this.ctx.clock(), updatedBy: c.actor };
    await this.repo().put(next);
    await this.ctx.audit({ actor: c.actor, kind: 'analytics.updated', data: { id, slug: next.slug, version: next.version, status: next.status } });
    return next;
  }

  async remove(id: string, c: Caller): Promise<void> {
    const a = await this.writable(id, c);
    await this.repo().delete(id);
    await this.ctx.audit({ actor: c.actor, kind: 'analytics.deleted', data: { id, slug: a.slug } });
  }

  /** create a shipped (seed) API: published, workspace-visible, owned by "system". Returns false when the slug is already in use. */
  async createBuiltIn(api: { slug: string; name: string; description: string; query: AnalyticsQuery; params?: ParamSpec[]; cacheSeconds?: number }): Promise<boolean> {
    // a deterministic id: two processes (or replicas) seeding the same workspace at the same moment write the SAME row, so a race can
    // never produce duplicates
    const id = `${this.ctx.tenantId}:builtin:${api.slug}`;
    if ((await this.repo().query((a) => a.tenantId === this.ctx.tenantId && a.slug === api.slug)).length) return false;
    const d = this.validateDefinition({ ...api, status: 'published', visibility: 'workspace' }, { actor: 'system', permissions: ['*'] });
    const now = this.ctx.clock();
    await this.repo().put({ id, tenantId: this.ctx.tenantId, ...d, builtIn: true, ownerId: 'system', version: 1, createdAt: now, createdBy: 'system', updatedAt: now, updatedBy: 'system' });
    return true;
  }

  // ---- calling a published API ----------------------------------------------------------------------------------------
  private coerce(p: ParamSpec, v: unknown): unknown {
    const fail = () => validation(`parameter "${p.name}" must be ${p.type === 'list' ? 'a list' : `a ${p.type}`}`);
    if (p.type === 'string') { if (typeof v === 'object') throw fail(); return String(v); }
    if (p.type === 'number') { const n = Number(v); if (v === '' || v === null || Number.isNaN(n)) throw fail(); return n; }
    if (p.type === 'boolean') { if (v === true || v === 'true' || v === '1') return true; if (v === false || v === 'false' || v === '0') return false; throw fail(); }
    if (p.type === 'date') { const ms = Date.parse(String(v)); if (Number.isNaN(ms)) throw fail(); return new Date(ms).toISOString(); }
    if (Array.isArray(v)) return v.slice(0, 200).map((x) => (typeof x === 'object' ? String(x) : x));
    if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 200);
    throw fail();
  }
  private resolveParams(a: AnalyticsApi, given: Record<string, unknown>): Record<string, unknown> {
    const known = new Set(a.params.map((p) => p.name));
    for (const k of Object.keys(given)) if (!known.has(k)) throw validation(`unknown parameter "${k}" (this API takes: ${[...known].join(', ') || 'none'})`);
    const out: Record<string, unknown> = {};
    for (const p of a.params) {
      const v = given[p.name];
      if (v === undefined || v === '') {
        if (p.default !== undefined) out[p.name] = p.default;
        else if (p.required) throw validation(`parameter "${p.name}" is required`);
        else out[p.name] = p.type === 'list' ? [] : null;
      } else out[p.name] = this.coerce(p, v);
    }
    return out;
  }

  /** `via: 'http'` — the caller is a person / token: their permissions decide. `via: 'flow'` — a flow node runs it with the engine's
   *  authority, which is only allowed for an API whose owner set `allowFlows`. */
  async run(slug: string, given: Record<string, unknown>, via: 'http' | 'flow', c: Caller): Promise<RunResult & { slug: string; version: number }> {
    const a = (await this.repo().query((x) => x.tenantId === this.ctx.tenantId && x.slug === String(slug).toLowerCase() && x.status === 'published'))[0];
    if (!a || (via === 'http' && !this.visibleTo(a, c))) throw notFound('Analytics API');
    if (via === 'flow') {
      if (!a.allowFlows) throw forbidden(`analytics API "${a.slug}" is not available to flows (its owner has not enabled "allow flows")`);
    } else {
      if (a.requires && !permissionGrants(c.permissions, a.requires)) throw forbidden(`this analytics API needs the "${a.requires}" permission`);
      authorizeQuery(a.query, c.permissions);                              // BEFORE the cache: a cached result is only for those who may read it
    }
    const params = this.resolveParams(a, given);
    const key = `${this.ctx.tenantId}|${a.id}|${a.version}|${stable(params)}`;
    const ttl = a.cacheSeconds * 1000;
    const hit = ttl > 0 ? cacheGet(key, ttl) : undefined;
    const result = hit ?? await runQuery(makeEnv(this.ctx, this.wf), a.query, params);
    if (!hit && ttl > 0 && !result.meta.truncated) cachePut(key, result);
    await this.ctx.audit({ actor: via === 'flow' ? 'flow' : c.actor, kind: 'analytics.run', data: { slug: a.slug, version: a.version, via, rows: result.meta.returned, cached: !!hit } });
    return { slug: a.slug, version: a.version, ...result, meta: { ...result.meta, cached: !!hit } };
  }
}

// ------------------------------------------------------------------------------------------------ seed migrations
interface SeedMarker { id: string; tenantId: string; version: number; at: string }
const SEED_COLLECTION = 'analytics_seed';

/** Apply every seed migration this workspace has not had yet, in order. A no-op (one read) when it is up to date, so it is safe to call
 *  on every start. Never touches an API the workspace already has under the same slug, and never re-creates one it deleted. */
const seeding = new Map<string, Promise<unknown>>();
export function runAnalyticsSeedMigrations(ctx: AppContext, wf: WorkflowServiceStore): Promise<{ applied: number[]; created: string[] }> {
  // one run at a time per workspace inside this process (the server boots through more than one seeding path)
  const prev = seeding.get(ctx.tenantId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => applySeedMigrations(ctx, wf));
  seeding.set(ctx.tenantId, next);
  next.finally(() => { if (seeding.get(ctx.tenantId) === next) seeding.delete(ctx.tenantId); }).catch(() => undefined);
  return next;
}
async function applySeedMigrations(ctx: AppContext, wf: WorkflowServiceStore): Promise<{ applied: number[]; created: string[] }> {
  const marker = await ctx.store.repo<SeedMarker>(SEED_COLLECTION).get(`${ctx.tenantId}:analytics`);
  const have = marker?.version ?? 0;
  const pending = SEED_MIGRATIONS.filter((m) => m.version > have);
  const out = { applied: [] as number[], created: [] as string[] };
  if (!pending.length) return out;
  const svc = new AnalyticsService(ctx, wf);
  for (const m of pending) {
    for (const api of m.apis) { if (await svc.createBuiltIn(api)) out.created.push(api.slug); }
    await ctx.store.repo<SeedMarker>(SEED_COLLECTION).put({ id: `${ctx.tenantId}:analytics`, tenantId: ctx.tenantId, version: m.version, at: ctx.clock() });
    out.applied.push(m.version);
  }
  await ctx.audit({ actor: 'system', kind: 'analytics.seeded', data: { versions: out.applied, created: out.created } });
  return out;
}

export { LIMITS };
