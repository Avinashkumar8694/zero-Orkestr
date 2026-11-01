// ISO-8601 duration / cycle parsing for timers. Deterministic (takes an explicit "now" ms).
export function parseDuration(iso: string): number {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso.trim());
  if (!m) return 0;
  const [, w, d, h, min, s] = m.map((x) => (x ? Number(x) : 0)) as number[];
  return ((((w * 7 + d) * 24 + h) * 60 + min) * 60 + s) * 1000;
}

/** ISO-8601 recurring-interval repeat count: "R3/PT1H" -> 3, "R/PT1H" (or no leading R) -> null
 *  (infinite/unbounded). Previously `computeDue` silently dropped this — every cycle repeated forever
 *  regardless of a declared count. */
export function parseCycleRepeatCount(cycle: string): number | null {
  const m = /^R(\d*)\//.exec(cycle.trim());
  if (!m) return null;
  return m[1] ? Number(m[1]) : null;
}

export function parseCycle(cycle: string): { count: number | null; ms: number } {
  const count = parseCycleRepeatCount(cycle);
  const period = cycle.split('/').slice(1).join('/') || cycle;
  return { count, ms: parseDuration(period) };
}

/** jBPM delay expression -> ms: ISO-8601 (`PT30M`, `P1D`), a repeating interval (`R/PT1H`: its period), or the designer's short form
 *  (`4h`, `2d`, `1h 30m`, `500ms`; a bare number is ms). 0 when it cannot be read. */
export function parseDelay(expr: string): number {
  const t = String(expr ?? '').trim();
  if (!t) return 0;
  if (/^R\d*\//.test(t)) return parseDelay(t.split('/').slice(1).join('/'));
  if (/^P/i.test(t)) return parseDuration(t.toUpperCase());
  if (/^\d+$/.test(t)) return Number(t);
  const unit: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const re = /(\d+)\s*(ms|d|h|m|s)\b/gi;
  let total = 0, any = false, m: RegExpExecArray | null;
  while ((m = re.exec(t))) { total += Number(m[1]) * unit[m[2]!.toLowerCase()]!; any = true; }
  return any && t.replace(re, '').trim() === '' ? total : 0;
}

/** SLA / due expression -> absolute ISO time: an absolute date, or a delay from `nowIso`. `#{var}` is filled from `vars`. */
export function dueFrom(expr: string, nowIso: string, vars: Record<string, unknown> = {}): string | null {
  const t = String(expr ?? '').replace(/#\{\s*([\w.]+)\s*\}/g, (_, k) => String(vars[k] ?? '')).trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) { const ms = Date.parse(t); return Number.isNaN(ms) ? null : new Date(ms).toISOString(); }
  const ms = parseDelay(t);
  return ms > 0 ? new Date(Date.parse(nowIso) + ms).toISOString() : null;
}

// ---------------------------------------------------------------------------------------------------------------- cron
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
interface CronField { any: boolean; set: Set<number>; last?: boolean }
function cronField(raw: string, min: number, max: number, names?: string[], nameBase = 0): CronField {
  const f = raw.trim().toUpperCase();
  if (f === '*' || f === '?') return { any: true, set: new Set(Array.from({ length: max - min + 1 }, (_, i) => min + i)) };
  const set = new Set<number>(); let last = false;
  const num = (t: string): number => {
    if (names) { const i = names.indexOf(t.slice(0, 3)); if (i >= 0 && /^[A-Z]{3}/.test(t)) return i + nameBase; }
    if (!/^\d+$/.test(t)) throw new Error(`bad cron value "${t}"`);
    return Number(t);
  };
  for (const part of f.split(',')) {
    if (part === 'L') { last = true; continue; }
    const [rng, stepS] = part.split('/'); const step = stepS === undefined ? 1 : Number(stepS);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step "${part}"`);
    let lo: number, hi: number;
    if (rng === '*' || rng === '?') { lo = min; hi = max; }
    else if (rng!.includes('-')) { const [x, y] = rng!.split('-'); lo = num(x!); hi = num(y!); }
    else { lo = num(rng!); hi = stepS === undefined ? lo : max; }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron value out of range in "${part}"`);
    for (let v = lo; v <= hi; v += step) set.add(v);
  }
  if (!set.size && !last) throw new Error('empty cron field');
  return { any: false, set, last };
}
interface Cron { sec: CronField; min: CronField; hour: CronField; dom: CronField; mon: CronField; dow: CronField; year?: CronField }
export function parseCron(expr: string): Cron {
  const parts = String(expr).trim().split(/\s+/);
  if (![5, 6, 7].includes(parts.length)) throw new Error('a cron expression has 5 fields (min hour day month weekday) or 6-7 (Quartz: seconds first)');
  const quartz = parts.length > 5;
  const [sec, min, hour, dom, mon, dow, year] = quartz ? parts : ['0', ...parts];
  // weekday numbers: POSIX 0-7 (0 and 7 are Sunday); Quartz 1-7 (1 is Sunday). Both are normalised to 0-6 with 0 = Sunday.
  const d = quartz ? cronField(dow!, 1, 7, DAYS, 1) : cronField(dow!, 0, 7, DAYS, 0);
  const dset = new Set<number>(); for (const v of d.set) dset.add(quartz ? v - 1 : v % 7);
  return {
    sec: cronField(sec!, 0, 59), min: cronField(min!, 0, 59), hour: cronField(hour!, 0, 23), dom: cronField(dom!, 1, 31), mon: cronField(mon!, 1, 12, MONTHS, 1),
    dow: { any: d.any, set: dset }, ...(year && year !== '*' ? { year: cronField(year, 1970, 2199) } : {}),
  };
}
export const cronValid = (expr: string): boolean => { try { parseCron(expr); return true; } catch { return false; } };

/** the first matching instant strictly after `fromMs` (UTC), or null when none exists in the next ~6 years */
export function cronNext(expr: string, fromMs: number): number | null {
  const c = parseCron(expr);
  const start = Math.floor(fromMs / 1000) * 1000 + 1000;
  const first = new Date(start);
  const day0 = Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate());
  const times: number[] = [];                                                   // seconds-of-day, ascending
  for (const h of [...c.hour.set].sort((a, b) => a - b)) for (const m of [...c.min.set].sort((a, b) => a - b)) for (const s of [...c.sec.set].sort((a, b) => a - b)) times.push(h * 3600 + m * 60 + s);
  for (let i = 0; i < 2200; i++) {
    const dayMs = day0 + i * 86_400_000; const d = new Date(dayMs);
    if (!c.mon.set.has(d.getUTCMonth() + 1) || (c.year && !c.year.set.has(d.getUTCFullYear()))) continue;
    const lastDom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const domOk = c.dom.set.has(d.getUTCDate()) || (c.dom.last === true && d.getUTCDate() === lastDom);
    const dowOk = c.dow.set.has(d.getUTCDay());
    // both restricted: either matches (POSIX); otherwise the restricted one decides
    const dayOk = !c.dom.any && !c.dow.any ? domOk || dowOk : !c.dom.any ? domOk : !c.dow.any ? dowOk : true;
    if (!dayOk) continue;
    const from = i === 0 ? (start - dayMs) / 1000 : 0;
    const t = times.find((x) => x >= from);
    if (t !== undefined) return dayMs + t * 1000;
  }
  return null;
}

/** Next fire time (ISO) from a timer spec — an ISO / short delay string, a date, `cron:<expr>`, or an object with
 *  duration | date | cycle | cron. `#{var}` is filled from `vars`; an empty result is an error (never a silent immediate fire). */
export function computeDue(timer: any, nowIso: string, vars: Record<string, unknown> = {}): string {
  const nowMs = Date.parse(nowIso);
  const fill = (raw: string): string => {
    if (!raw.includes('#{')) return raw;
    const out = raw.replace(/#\{\s*([\w.]+)\s*\}/g, (_, k: string) => String(k.split('.').reduce((c: any, x) => (c == null ? undefined : c[x]), vars) ?? '')).trim();
    if (!out) throw new Error(`timer expression "${raw}": the variable has no value`);
    return out;
  };
  const cron = (expr: string): string => {
    const at = cronNext(expr, nowMs);
    if (at === null) throw new Error(`cron expression "${expr}" never fires`);
    return new Date(at).toISOString();
  };
  const one = (t0: string): string => {
    const t = fill(t0).trim();
    if (t.startsWith('cron:')) return cron(t.slice(5));
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return new Date(t).toISOString();
    return new Date(nowMs + parseDelay(t)).toISOString();
  };
  if (typeof timer === 'string') return one(timer);
  if (timer?.cron) return cron(fill(String(timer.cron)));
  if (timer?.date) return new Date(fill(String(timer.date))).toISOString();
  if (timer?.duration) return one(String(timer.duration));
  if (timer?.cycle) {
    const c = fill(String(timer.cycle)).trim();
    if (c.startsWith('cron:')) return cron(c.slice(5));
    if (timer.language === 'cron') return cron(c);
    return new Date(nowMs + parseDelay(c.split('/').slice(1).join('/') || c)).toISOString();
  }
  return new Date(nowMs).toISOString();
}
/** the stored `cycle` text for a recurring spec (a cron expression is kept as `cron:<expr>`), or undefined for a one-shot */
export function cycleOf(spec: any): string | undefined {
  if (typeof spec === 'string') return spec.startsWith('cron:') ? spec : /^R\d*\//.test(spec) ? spec : undefined;
  if (spec?.cron) return `cron:${spec.cron}`;
  if (spec?.cycle) return spec.language === 'cron' && !String(spec.cycle).startsWith('cron:') ? `cron:${spec.cycle}` : String(spec.cycle);
  return undefined;
}
