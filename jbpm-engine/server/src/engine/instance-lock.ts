// Per-instance mutual exclusion. An instance is a row that is loaded, changed and saved back; two writers at the same moment (a signal and a
// timer, two task completions, an API edit during a run — on one replica or on two) would overwrite each other. So every such step runs
// inside withInstanceLock():
//   · in this process: a FIFO queue per instance (waiters are served in order, with a timeout instead of waiting forever);
//   · across replicas: the coordinator's lease (Redis) when state is shared — a dead replica's lease expires, so another continues.
// Re-entrant for the same call chain (a step that touches its own instance again does not wait on itself).
// Never block while holding: work that must happen on ANOTHER instance after this one finishes (a child telling its parent) is queued with
// deferAfterLock() and runs after the outermost lock is released, so two instances can never wait on each other.
import { AsyncLocalStorage } from 'node:async_hooks';
import { coordinator } from '../infra/coordinator.ts';
import { ApiError } from '../infra/errors.ts';

interface Chain { held: Set<string>; deferred: Array<() => Promise<unknown>> }
const als = new AsyncLocalStorage<Chain>();
const tails = new Map<string, Promise<void>>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
export const lockConfig = { waitMs: num(process.env.INSTANCE_LOCK_WAIT_MS, 10_000), ttlMs: num(process.env.INSTANCE_LOCK_TTL_MS, 120_000) };

/** Thrown when an instance stayed busy for the whole wait: callers retry (HTTP 409; a timer job is left scheduled for the next tick). */
export const instanceBusy = (id: string) => new ApiError('CONFLICT', `instance ${id} is busy (another operation is changing it); retry`, { busy: true });
export const isBusy = (e: unknown): boolean => e instanceof ApiError && (e.details as { busy?: boolean } | undefined)?.busy === true;

async function acquireLocal(key: string, id: string, waitMs: number): Promise<() => void> {
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  tails.set(key, tail);
  tail.finally(() => { if (tails.get(key) === tail) tails.delete(key); }).catch(() => undefined);
  const timedOut = await Promise.race([prev.then(() => false), sleep(waitMs).then(() => true)]);
  if (timedOut) { release(); throw instanceBusy(id); }       // our slot passes straight through; the holder is unaffected
  return release;
}

async function acquireShared(key: string, id: string, waitMs: number): Promise<() => Promise<void>> {
  const co = coordinator();
  if (!co.shared || co.degraded) return async () => undefined;   // one replica (or Redis down → per-replica, logged by the coordinator)
  const deadline = Date.now() + waitMs;
  for (;;) {
    const rel = await co.claim(`inst:${key}`, lockConfig.ttlMs);
    if (rel) return rel;
    if (Date.now() >= deadline) throw instanceBusy(id);
    await sleep(25 + Math.floor(Math.random() * 50));
  }
}

export async function withInstanceLock<T>(tenantId: string, id: string, fn: () => Promise<T>, waitMs = lockConfig.waitMs): Promise<T> {
  const key = `${tenantId}:${id}`;
  const cur = als.getStore();
  if (cur?.held.has(key)) return fn();                               // same chain already holds it
  const chain: Chain = cur ?? { held: new Set(), deferred: [] };
  const local = await acquireLocal(key, id, waitMs);
  let shared: () => Promise<void>;
  try { shared = await acquireShared(key, id, waitMs); } catch (e) { local(); throw e; }
  let ok = false;
  try {
    const out = await als.run({ held: new Set([...chain.held, key]), deferred: chain.deferred }, fn);
    ok = true;
    return out;
  } finally {
    await shared().catch(() => undefined);
    local();
    if (!cur) {                                                      // outermost: run what was deferred, now that nothing is held
      while (chain.deferred.length) { const d = chain.deferred.shift()!; if (ok) await d(); else await d().catch(() => undefined); }
    }
  }
}

/** Run `fn` after the outermost instance lock of this call chain is released (immediately when no lock is held). */
export async function deferAfterLock(fn: () => Promise<unknown>): Promise<void> {
  const cur = als.getStore();
  if (cur) cur.deferred.push(fn); else await fn();
}
