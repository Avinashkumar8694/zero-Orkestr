// Bounded, tenant-keyed pool of V8 isolates for js scripts/conditions (see sandbox.ts for the caller).
//
//  * One pool per tenant (workspace) — an isolate is NEVER shared across tenants.
//  * One isolate runs ONE execution at a time, so a timeout / OOM kill only ever hits the run that caused it.
//  * Effective concurrency (= pool size = per-workspace parallelism) =
//    max(1, min(maxConcurrentScripts || SCRIPT_POOL_DEFAULT_SIZE, SCRIPT_POOL_MAX_SIZE)). In reject mode this is
//    exactly the threshold at which new executions are refused.
//    Isolates are created lazily, reused across ALL of that workspace's processes, evicted after an idle period.
//  * Overflow behaviour is configurable (SCRIPT_OVERFLOW_MODE, per-workspace override scriptOverflowMode):
//    'queue' (default) — excess demand waits in a bounded FIFO queue per tenant (SCRIPT_QUEUE_MAX /
//    SCRIPT_QUEUE_TIMEOUT_MS → QUOTA_EXCEEDED); 'reject' — refused immediately with QUOTA_EXCEEDED, no waiting.
//  * A global ceiling (SCRIPT_MAX_ISOLATES) caps total isolates; when it is reached, waiting tenants are
//    served round-robin and may reclaim another tenant's IDLE isolate, so one noisy workspace can't starve others.
//  * Isolates are recycled after a timeout, OOM/dispose, a near-full heap, or SCRIPT_ISOLATE_MAX_RUNS runs.
//  * Every execution gets a FRESH context (new global scope / realm) inside the pooled isolate and releases it
//    afterwards, so no globalThis write or prototype pollution survives into the next script.
import os from 'node:os';
import ivm from 'isolated-vm';
import { ISOLATE_RUNTIME_SOURCE } from './isolate-runtime.ts';
import { quotaExceeded } from '../infra/errors.ts';

export type OverflowMode = 'queue' | 'reject';
export const isOverflowMode = (v: unknown): v is OverflowMode => v === 'queue' || v === 'reject';

export interface SandboxConfig {
  poolDefaultSize: number;
  poolMaxSize: number;
  overflowMode: OverflowMode;
  maxIsolates: number;
  queueMax: number;
  queueTimeoutMs: number;
  idleMs: number;
  maxRuns: number;
  memoryMb: number;
}

const num = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : d; };
const cfg: SandboxConfig = {
  poolDefaultSize: num(process.env.SCRIPT_POOL_DEFAULT_SIZE, 1),
  poolMaxSize: num(process.env.SCRIPT_POOL_MAX_SIZE, 16),
  overflowMode: isOverflowMode(process.env.SCRIPT_OVERFLOW_MODE) ? process.env.SCRIPT_OVERFLOW_MODE : 'queue',
  maxIsolates: num(process.env.SCRIPT_MAX_ISOLATES, Math.max(8, 2 * os.cpus().length)),
  queueMax: num(process.env.SCRIPT_QUEUE_MAX, 1000),
  queueTimeoutMs: num(process.env.SCRIPT_QUEUE_TIMEOUT_MS, 5000),
  idleMs: num(process.env.SCRIPT_ISOLATE_IDLE_MS, 60_000),
  maxRuns: num(process.env.SCRIPT_ISOLATE_MAX_RUNS, 1000),
  memoryMb: 64,
};
/** test hook: override limits at runtime (existing idle isolates keep their old idle timers). */
export function configureSandbox(patch: Partial<SandboxConfig>): void { Object.assign(cfg, patch); }
export function sandboxConfig(): Readonly<SandboxConfig> { return cfg; }

/** the concurrency a workspace actually gets for a given maxConcurrentScripts quota (0/undefined = default). */
export function effectiveScriptConcurrency(quota?: number): number {
  return Math.max(1, Math.min(Math.floor(quota || cfg.poolDefaultSize), cfg.poolMaxSize));
}
export function effectiveOverflowMode(workspaceMode?: string): OverflowMode {
  return isOverflowMode(workspaceMode) ? workspaceMode : cfg.overflowMode;
}

interface Pooled { isolate: ivm.Isolate; tenant: string; runs: number; idleTimer?: NodeJS.Timeout }
interface Waiter { resolve: (p: Pooled) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }
interface TenantPool { id: string; size: number; queueMax?: number; busy: number; all: Set<Pooled>; idle: Pooled[]; queue: Waiter[] }

const tenants = new Map<string, TenantPool>();
let total = 0;
let rr = 0;
const peakBusy = new Map<string, number>();
export function resetSandboxPeaks(): void { peakBusy.clear(); }
const perTenant = new Map<string, { created: number; recycled: number }>();
const bump = (id: string, k: 'created' | 'recycled') => { const e = perTenant.get(id) || { created: 0, recycled: 0 }; e[k]++; perTenant.set(id, e); };
const totals = { created: 0, recycled: 0, evictedIdle: 0, queueRejected: 0, overflowRejected: 0, queueTimeouts: 0, executions: 0 };

let snapshot: ivm.ExternalCopy<ArrayBuffer> | null | undefined;
/** the runtime is run once into a V8 startup snapshot; each fresh context then starts from it (cheap) rather
 *  than re-evaluating the shim source. Falls back to evaluating the source per context if snapshots fail. */
function getSnapshot(): ivm.ExternalCopy<ArrayBuffer> | null {
  if (snapshot === undefined) {
    try { snapshot = ivm.Isolate.createSnapshot([{ code: ISOLATE_RUNTIME_SOURCE }]); } catch { snapshot = null; }
  }
  return snapshot;
}

export function sandboxStats() {
  const alive: Record<string, number> = {};
  const queued: Record<string, number> = {};
  let queuedTotal = 0;
  for (const t of tenants.values()) {
    if (t.all.size) alive[t.id] = t.all.size;
    if (t.queue.length) queued[t.id] = t.queue.length;
    queuedTotal += t.queue.length;
  }
  const running: Record<string, number> = {}, effective: Record<string, number> = {};
  for (const t of tenants.values()) { if (t.busy) running[t.id] = t.busy; effective[t.id] = t.size; }
  return { perTenant: Object.fromEntries(perTenant), running, peakRunning: Object.fromEntries(peakBusy), effectiveConcurrency: effective, isolatesAlive: alive, totalIsolates: total, idle: [...tenants.values()].reduce((a, t) => a + t.idle.length, 0), queued: queued, queuedTotal, ...totals };
}

function poolOf(id: string, requestedSize: number | undefined, queueMax?: number): TenantPool {
  let t = tenants.get(id);
  if (!t) { t = { id, size: effectiveScriptConcurrency(), busy: 0, all: new Set(), idle: [], queue: [] }; tenants.set(id, t); }
  // quota applies as pool size; an unset quota leaves the tenant's last-known size (default on first sight)
  if (requestedSize) resize(t, effectiveScriptConcurrency(requestedSize));
  if (queueMax !== undefined) t.queueMax = queueMax;
  return t;
}

/** live resize: growing is lazy (isolates are created on demand, and waiting work is pumped right away);
 *  shrinking drains idle isolates now and retires busy ones when their run ends. Queued work is never dropped. */
function resize(t: TenantPool, size: number): void {
  const grew = size > t.size;
  t.size = size;
  while (t.all.size > t.size && t.idle.length) dispose(t.idle[0], 'recycled');
  if (grew && t.queue.length) pump();
}

/** apply new limits to a workspace's live pool (platform admin changed something) without a restart. */
export function setPoolLimits(tenantId: string, l: { size: number; queueMax: number; mode?: OverflowMode }): void {
  const t = tenants.get(tenantId);
  if (!t) return;
  t.queueMax = l.queueMax;
  resize(t, effectiveScriptConcurrency(l.size));
}

function dispose(p: Pooled, why: 'recycled' | 'idle' | 'dead'): void {
  const t = tenants.get(p.tenant);
  if (p.idleTimer) clearTimeout(p.idleTimer);
  if (t) { t.all.delete(p); const i = t.idle.indexOf(p); if (i >= 0) t.idle.splice(i, 1); }
  total--;
  if (why === 'recycled') { totals.recycled++; bump(p.tenant, 'recycled'); } else if (why === 'idle') totals.evictedIdle++;
  try { if (!p.isolate.isDisposed) p.isolate.dispose(); } catch { /* already gone */ }
  if (t && !t.all.size && !t.queue.length) tenants.delete(p.tenant);
}

function create(t: TenantPool): Pooled {
  const snap = getSnapshot();
  const p: Pooled = { isolate: new ivm.Isolate({ memoryLimit: cfg.memoryMb, ...(snap ? { snapshot: snap } : {}) }), tenant: t.id, runs: 0 };
  t.all.add(p); total++; totals.created++; bump(t.id, 'created');
  return p;
}

/** hand out capacity to waiting tenants, one assignment per tenant per round (round-robin fairness). */
function pump(): void {
  let progressed = true;
  while (progressed) {
    progressed = false;
    const waiting = [...tenants.values()].filter((t) => t.queue.length);
    if (!waiting.length) return;
    for (let k = 0; k < waiting.length; k++) {
      const t = waiting[(rr + k) % waiting.length];
      const w = t.queue[0];
      if (!w) continue;
      let p = t.idle.pop();
      if (p?.idleTimer) { clearTimeout(p.idleTimer); p.idleTimer = undefined; }
      if (!p && t.all.size < t.size) {
        if (total >= cfg.maxIsolates) reclaimIdleFromOthers(t.id);
        if (total < cfg.maxIsolates) p = create(t);
      }
      if (!p) continue;
      t.queue.shift();
      clearTimeout(w.timer);
      w.resolve(grant(t, p));
      progressed = true;
    }
    rr++;
  }
}

/** at the global ceiling: free one IDLE isolate of the tenant holding the most idle ones (never a busy one). */
function reclaimIdleFromOthers(forTenant: string): void {
  // loop: the ceiling may have been lowered below the number of live isolates
  while (total >= cfg.maxIsolates && reclaimOne(forTenant)) { /* keep freeing idle isolates */ }
}
function reclaimOne(forTenant: string): boolean {
  let best: TenantPool | undefined;
  for (const o of tenants.values()) if (o.id !== forTenant && o.idle.length && (!best || o.idle.length > best.idle.length)) best = o;
  const victim = best?.idle[0];
  if (!victim) return false;
  dispose(victim, 'idle');
  return true;
}

function grant(t: TenantPool, p: Pooled): Pooled {
  t.busy++;
  peakBusy.set(t.id, Math.max(peakBusy.get(t.id) || 0, t.busy));
  return p;
}

async function acquire(tenantId: string, size?: number, mode?: OverflowMode, queueMax?: number): Promise<Pooled> {
  const t = poolOf(tenantId, size, queueMax);
  if (!t.queue.length) {
    const p = t.idle.pop();
    if (p) { if (p.idleTimer) { clearTimeout(p.idleTimer); p.idleTimer = undefined; } return grant(t, p); }
    if (t.all.size < t.size) {
      if (total >= cfg.maxIsolates) reclaimIdleFromOthers(t.id);
      if (total < cfg.maxIsolates) return grant(t, create(t));
    }
  }
  if (mode === 'reject') {
    // at the workspace's effective concurrency (or the global ceiling): refuse immediately, never wait
    totals.overflowRejected++;
    if (tenants.get(t.id) === t && !t.all.size && !t.queue.length) tenants.delete(t.id);
    if (t.all.size < t.size) throw quotaExceeded(`server script capacity exhausted (global isolate ceiling ${cfg.maxIsolates})`, { quota: 'scriptMaxIsolates', max: cfg.maxIsolates });
    throw quotaExceeded(`per-tenant concurrent script quota exceeded (max ${t.size})`, { quota: 'maxConcurrentScripts', max: t.size, current: t.busy });
  }
  const qMax = t.queueMax ?? cfg.queueMax;
  if (t.queue.length >= qMax) {
    totals.queueRejected++;
    throw quotaExceeded(`script queue full for this workspace (max ${qMax} waiting)`, { quota: 'scriptQueue', max: qMax });
  }
  return new Promise<Pooled>((resolve, reject) => {
    const w: Waiter = {
      resolve, reject,
      timer: setTimeout(() => {
        const i = t.queue.indexOf(w);
        if (i >= 0) t.queue.splice(i, 1);
        totals.queueTimeouts++;
        if (!t.all.size && !t.queue.length) tenants.delete(t.id);
        reject(quotaExceeded(`timed out after ${cfg.queueTimeoutMs}ms waiting for a script slot in this workspace`, { quota: 'scriptQueueTimeout', timeoutMs: cfg.queueTimeoutMs }));
      }, cfg.queueTimeoutMs),
    };
    t.queue.push(w);
  });
}

function release(p: Pooled, recycle: boolean): void {
  const t = tenants.get(p.tenant);
  if (t && t.busy > 0) t.busy--;
  p.runs++;
  if (!t || recycle || p.isolate.isDisposed || p.runs >= cfg.maxRuns || t.all.size > t.size) { dispose(p, 'recycled'); pump(); return; }
  t.idle.push(p);
  p.idleTimer = setTimeout(() => dispose(p, 'idle'), cfg.idleMs);
  p.idleTimer.unref();
  pump();
}

/** Runs `fn` with a fresh context inside a pooled isolate of `tenantId`. `fn` must not retain the context. */
export async function withIsolate<T>(tenantId: string, poolSize: number | undefined, mode: OverflowMode, queueMax: number | undefined, fn: (isolate: ivm.Isolate, context: ivm.Context) => Promise<T>): Promise<T> {
  const p = await acquire(tenantId, poolSize, mode, queueMax);
  totals.executions++;
  let context: ivm.Context | undefined;
  let recycle = false;
  try {
    context = await p.isolate.createContext();
    if (!getSnapshot()) await (await p.isolate.compileScript(ISOLATE_RUNTIME_SOURCE)).run(context);
    return await fn(p.isolate, context);
  } catch (e) {
    // timeout or OOM/dispose: this isolate is suspect — replace it. Ordinary script errors keep it.
    if (p.isolate.isDisposed || /timed out|memory limit|disposed/i.test((e as Error)?.message || '')) recycle = true;
    throw e;
  } finally {
    try { context?.release(); } catch { /* isolate gone */ }
    try {
      if (!p.isolate.isDisposed && p.isolate.getHeapStatisticsSync().used_heap_size > cfg.memoryMb * 1048576 * 0.6) recycle = true;
    } catch { recycle = true; }
    release(p, recycle);
  }
}
