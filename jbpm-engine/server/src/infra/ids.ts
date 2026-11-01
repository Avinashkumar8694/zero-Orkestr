// Sortable, dependency-free IDs (ULID-like: time prefix + random-ish suffix) and an injectable clock.
// The execution engine takes clock/newId as injected deps so the step function stays deterministic.
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(ms: number, len: number): string {
  let out = '';
  for (let i = len - 1; i >= 0; i--) { out = B32[ms % 32] + out; ms = Math.floor(ms / 32); }
  return out;
}

let seq = 0;
/** Monotonic-ish id. Not cryptographically random; fine for entity ids. */
export function newId(nowMs = Date.now()): string {
  seq = (seq + 1) % 0xffffff;
  const time = encodeTime(nowMs, 10);
  let rand = '';
  const mix = (seq * 2654435761) >>> 0;
  // keep r a NON-NEGATIVE 32-bit int at every step (>>>0); a signed XOR could make r%32 negative
  // and index B32 out of range → 'undefined' chars in the id.
  let r = (mix + (nowMs % 0x10000)) >>> 0;
  for (let i = 0; i < 6; i++) { rand = B32[r % 32] + rand; r = (Math.floor(r / 32) + (i + 1) * 131 * (seq + 1)) >>> 0; }
  return time + rand;
}

export type Clock = () => string; // ISO string
export const systemClock: Clock = () => new Date().toISOString();

/** A fixed/advanceable clock for tests. */
export function fakeClock(startIso = '2025-01-01T00:00:00.000Z') {
  let t = new Date(startIso).getTime();
  const clock: Clock = () => new Date(t).toISOString();
  return {
    clock,
    now: () => new Date(t).toISOString(),
    advanceMs: (ms: number) => { t += ms; },
    set: (iso: string) => { t = new Date(iso).getTime(); },
  };
}

/** jBPM's ProcessInstance.getId() is a long; this engine's ids are strings. Java scripts see this number (FNV-1a, 53 bits, identical to the sidecar's
 *  KContext.stableLong) and the API resolves it back to the instance, so a payload carrying it can be called back (signals, lookups). */
export function numericIdOf(id: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < id.length; i++) { h ^= BigInt(id.charCodeAt(i)); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; }
  return String(h & 0x1fffffffffffffn);   // 53 bits: the largest integer that survives a JSON number unchanged
}
