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

/** Next fire time (ISO) from a timer spec (duration | cycle | date), given now (ISO). */
export function computeDue(timer: any, nowIso: string): string {
  const nowMs = Date.parse(nowIso);
  if (typeof timer === 'string') return new Date(nowMs + parseDuration(timer)).toISOString();
  if (timer?.date) return new Date(timer.date).toISOString();
  if (timer?.duration) return new Date(nowMs + parseDuration(timer.duration)).toISOString();
  if (timer?.cycle) { const period = timer.cycle.split('/').slice(1).join('/') || timer.cycle; return new Date(nowMs + parseDuration(period)).toISOString(); }
  return new Date(nowMs).toISOString();
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
