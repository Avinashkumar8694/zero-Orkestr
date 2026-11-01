// Platform-governed limits for the script runtime and workspace quotas — a 3-level model:
//
//   effective = min(workspace setting, per-workspace platform cap, global platform cap); unset → the default.
//
//  1. GLOBAL (platform) level  — PlatformLimits: defaults + hard caps for every workspace. Stored OUTSIDE any
//     workspace (tenantId 'platform', id 'platform-limits'); env vars are only the bootstrap defaults, the stored
//     document overrides them live (no restart).
//  2. PER-WORKSPACE override   — WorkspaceLimits (id `ws-limits:<workspaceId>`): the platform admin can tighten a
//     workspace's caps/defaults (never above the global cap) and optionally lock its overflow mode.
//  3. WORKSPACE level          — the workspace's own SystemSettings (scriptPoolSize, scriptQueueMax,
//     scriptOverflowMode, quotas), writable by its admins but only inside the caps above.
//
// Only the fixed platform administrator can write levels 1 and 2 (see http/platform-routes.ts).
import { resolvePlan } from '../plans/plans.ts';
import type { Store } from '../../store/repository.ts';
import { makeContext, type AppContext } from '../../context.ts';
import { Collections, type SystemSettings } from '../../domain.ts';
import type { Entity } from '../../store/repository.ts';
import { validation, notFound } from '../../infra/errors.ts';
import { isOverflowMode, sandboxConfig, configureSandbox, setPoolLimits, sandboxStats, type OverflowMode } from '../../engine/isolate-pool.ts';
import { SettingsService } from '../settings/service.ts';
import { coordinator } from '../../infra/coordinator.ts';

export const PLATFORM_TENANT = 'platform';
const GLOBAL_ID = 'platform-limits';

/** all platform-level knobs; 0 on the two quota caps means "no cap" (unlimited). */
export interface PlatformLimits {
  scriptPoolDefaultSize: number;      // pool size (= script parallelism) for a workspace that doesn't ask for one
  scriptPoolMaxSize: number;          // hard cap on any workspace's pool size (memory ≈ size × 64 MB worst case)
  scriptQueueDefaultMax: number;      // default number of executions that may wait per workspace
  scriptQueueMaxCap: number;          // hard cap on any workspace's queue length
  scriptQueueTimeoutMs: number;       // longest an execution may wait in a queue
  scriptMaxIsolates: number;          // server-wide ceiling of live isolates (per pod)
  scriptOverflowModeDefault: OverflowMode;
  maxActiveInstancesCap: number;      // 0 = no cap
  maxActiveTimersCap: number;         // 0 = no cap
  maxReplicasCap: number;             // most replicas that may serve any one workspace; 0 = no cap
  /** may workspace admins see and manage the script pool / queue / overflow settings (within the caps)? a workspace can override this */
  scriptControlsVisible: boolean;
}
/** per-workspace platform override — every field optional; unset = inherit the global value. */
export interface WorkspaceLimits {
  scriptPoolDefaultSize?: number;
  scriptPoolMaxSize?: number;
  scriptQueueDefaultMax?: number;
  scriptQueueMaxCap?: number;
  maxActiveInstancesCap?: number;
  maxActiveTimersCap?: number;
  maxReplicasCap?: number;
  /** show / hide the script controls for this workspace's admins; unset = inherit the global switch */
  scriptControlsVisible?: boolean;
  /** when set, the workspace cannot choose its own overflow mode */
  lockedOverflowMode?: OverflowMode;
}

const GLOBAL_INT_FIELDS = ['scriptPoolDefaultSize', 'scriptPoolMaxSize', 'scriptQueueDefaultMax', 'scriptQueueMaxCap', 'scriptQueueTimeoutMs', 'scriptMaxIsolates', 'maxActiveInstancesCap', 'maxActiveTimersCap', 'maxReplicasCap'] as const;
const WS_INT_FIELDS = ['scriptPoolDefaultSize', 'scriptPoolMaxSize', 'scriptQueueDefaultMax', 'scriptQueueMaxCap', 'maxActiveInstancesCap', 'maxActiveTimersCap', 'maxReplicasCap'] as const;
/** fields where 0 is a legal value (no cap / no waiting) rather than "must be ≥ 1" */
const ZERO_OK = new Set(['scriptQueueDefaultMax', 'scriptQueueMaxCap', 'maxActiveInstancesCap', 'maxActiveTimersCap', 'maxReplicasCap']);

const envNum = (v: string | undefined, d: number) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? n : d; };
/** bootstrap defaults (env); a stored platform document overrides these field by field. */
const ENV_DEFAULTS = (): PlatformLimits => ({
  scriptPoolDefaultSize: envNum(process.env.SCRIPT_POOL_DEFAULT_SIZE, 1),
  scriptPoolMaxSize: envNum(process.env.SCRIPT_POOL_MAX_SIZE, 16),
  scriptQueueDefaultMax: envNum(process.env.SCRIPT_QUEUE_DEFAULT_MAX, 1000),
  scriptQueueMaxCap: envNum(process.env.SCRIPT_QUEUE_MAX, 1000),
  scriptQueueTimeoutMs: envNum(process.env.SCRIPT_QUEUE_TIMEOUT_MS, 5000),
  scriptMaxIsolates: sandboxConfig().maxIsolates,
  scriptOverflowModeDefault: isOverflowMode(process.env.SCRIPT_OVERFLOW_MODE) ? process.env.SCRIPT_OVERFLOW_MODE : 'queue',
  maxActiveInstancesCap: envNum(process.env.MAX_ACTIVE_INSTANCES_CAP, 0),
  maxActiveTimersCap: envNum(process.env.MAX_ACTIVE_TIMERS_CAP, 0),
  maxReplicasCap: envNum(process.env.MAX_REPLICAS_CAP, 0),
  scriptControlsVisible: process.env.SCRIPT_CONTROLS_VISIBLE === 'true',
});
const BOOT_DEFAULTS = ENV_DEFAULTS();

type Stored<T> = Entity & { id: string; tenantId: string; data: Partial<T>; updatedAt?: string; updatedBy?: string };

// ------------------------------------------------------------------------------------------ resolution
export interface EffectiveLimits {
  scriptPoolSize: number;          // = parallelism
  scriptQueueMax: number;
  scriptOverflowMode: OverflowMode;
  scriptQueueTimeoutMs: number;
  maxActiveInstances: number;      // 0 = unlimited
  maxActiveTimers: number;
  maxReplicas: number;             // 0 = unlimited
}
export interface LimitCaps {
  scriptPoolMaxSize: number;
  scriptPoolDefaultSize: number;
  scriptQueueMaxCap: number;
  scriptQueueDefaultMax: number;
  lockedOverflowMode?: OverflowMode;
  maxActiveInstancesCap: number;   // 0 = unlimited
  maxActiveTimersCap: number;
  maxReplicasCap: number;          // 0 = unlimited
}

const atLeast1 = (n: number) => Math.max(1, Math.floor(n));
/** 0 = unlimited cap; a positive cap clamps a (0 = unlimited) request to the cap */
const capQuota = (value: number | undefined, cap: number) => {
  const v = value || 0;
  return cap > 0 ? (v === 0 ? cap : Math.min(v, cap)) : v;
};

/** the caps a workspace is subject to = per-workspace override tightened by (never above) the global values */
export function capsOf(g: PlatformLimits, o: WorkspaceLimits = {}): LimitCaps {
  const poolCap = atLeast1(Math.min(o.scriptPoolMaxSize ?? Infinity, g.scriptPoolMaxSize));
  const queueCap = Math.max(0, Math.floor(Math.min(o.scriptQueueMaxCap ?? Infinity, g.scriptQueueMaxCap)));
  const minQuotaCap = (a: number | undefined, b: number) => (a && a > 0 ? (b > 0 ? Math.min(a, b) : a) : b);
  return {
    scriptPoolMaxSize: poolCap,
    scriptPoolDefaultSize: Math.min(atLeast1(o.scriptPoolDefaultSize ?? g.scriptPoolDefaultSize), poolCap),
    scriptQueueMaxCap: queueCap,
    scriptQueueDefaultMax: Math.min(Math.max(0, o.scriptQueueDefaultMax ?? g.scriptQueueDefaultMax), queueCap),
    lockedOverflowMode: o.lockedOverflowMode,
    maxActiveInstancesCap: minQuotaCap(o.maxActiveInstancesCap, g.maxActiveInstancesCap),
    maxActiveTimersCap: minQuotaCap(o.maxActiveTimersCap, g.maxActiveTimersCap),
    maxReplicasCap: minQuotaCap(o.maxReplicasCap, g.maxReplicasCap),
  };
}

/** min(workspace setting, per-workspace cap, global cap); unset → default (itself already ≤ cap). */
export function resolveLimits(g: PlatformLimits, o: WorkspaceLimits | undefined, s: Partial<SystemSettings>): EffectiveLimits {
  const c = capsOf(g, o);
  const requestedPool = s.scriptPoolSize || s.maxConcurrentScripts;   // maxConcurrentScripts = deprecated alias
  return {
    scriptPoolSize: Math.min(requestedPool || c.scriptPoolDefaultSize, c.scriptPoolMaxSize),
    scriptQueueMax: Math.min(s.scriptQueueMax ?? c.scriptQueueDefaultMax, c.scriptQueueMaxCap),
    scriptOverflowMode: c.lockedOverflowMode ?? (isOverflowMode(s.scriptOverflowMode) ? s.scriptOverflowMode : g.scriptOverflowModeDefault),
    scriptQueueTimeoutMs: g.scriptQueueTimeoutMs,
    maxActiveInstances: capQuota(s.maxActiveInstances, c.maxActiveInstancesCap),
    maxActiveTimers: capQuota(s.maxActiveTimers, c.maxActiveTimersCap),
    maxReplicas: c.maxReplicasCap,
  };
}

/** The slice of a workspace's script budget this replica enforces. The effective limits are for the WHOLE workspace;
 *  with H replicas holding it (infra/coordinator.ts) the pool is split exactly — replica of rank r gets
 *  floor(size/H) plus one while r < size mod H — so the replicas' pools add up to the workspace's size. When there are
 *  more holders than slots (a pool can't go below 1 per replica) `clusterCap` asks the sandbox to also take a shared
 *  slot around each run. The queue is split evenly (rounded up). */
export function replicaShare(workspaceId: string, e: Pick<EffectiveLimits, 'scriptPoolSize' | 'scriptQueueMax'>): { size: number; queueMax: number; clusterCap?: number } {
  const co = coordinator();
  const { holders, rank } = co.holdersOf(workspaceId);
  const size = e.scriptPoolSize;
  const mine = Math.floor(size / holders) + (rank < size % holders ? 1 : 0);
  return {
    size: Math.max(1, mine),
    queueMax: e.scriptQueueMax > 0 ? Math.ceil(e.scriptQueueMax / holders) : 0,
    clusterCap: co.shared && holders > size ? size : undefined,
  };
}

/** validates a workspace's own settings patch against its caps (422 stating the cap). Throws; returns nothing. */
export function assertWithinCaps(patch: Partial<SystemSettings>, c: LimitCaps): void {
  const int = (k: string, v: unknown, min: number) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw validation(`${k} must be an integer ≥ ${min}`);
  };
  for (const k of ['scriptPoolSize', 'maxConcurrentScripts'] as const) {
    const v = patch[k];
    if (v === undefined || v === null) continue;
    int(k, v, 0);   // 0 = "use the default"
    if (v > c.scriptPoolMaxSize) throw validation(`${k} ${v} exceeds the cap of ${c.scriptPoolMaxSize} for this workspace`, { field: k, cap: c.scriptPoolMaxSize });
  }
  if (patch.scriptQueueMax !== undefined && patch.scriptQueueMax !== null) {
    int('scriptQueueMax', patch.scriptQueueMax, 0);
    if (patch.scriptQueueMax > c.scriptQueueMaxCap) throw validation(`scriptQueueMax ${patch.scriptQueueMax} exceeds the cap of ${c.scriptQueueMaxCap} for this workspace`, { field: 'scriptQueueMax', cap: c.scriptQueueMaxCap });
  }
  for (const [k, cap] of [['maxActiveInstances', c.maxActiveInstancesCap], ['maxActiveTimers', c.maxActiveTimersCap]] as const) {
    const v = patch[k];
    if (v === undefined || v === null) continue;
    int(k, v, 0);
    if (cap > 0 && v === 0) throw validation(`${k}: 0 (unlimited) is not allowed — this workspace is capped at ${cap}`, { field: k, cap });
    if (cap > 0 && v > cap) throw validation(`${k} ${v} exceeds the cap of ${cap} for this workspace`, { field: k, cap });
  }
  if (patch.scriptOverflowMode !== undefined && patch.scriptOverflowMode !== null) {
    if (!isOverflowMode(patch.scriptOverflowMode)) throw validation("scriptOverflowMode must be 'queue' or 'reject' (or null to use the platform default)");
    if (c.lockedOverflowMode && patch.scriptOverflowMode !== c.lockedOverflowMode) throw validation(`scriptOverflowMode is locked to '${c.lockedOverflowMode}' for this workspace by the platform administrator`, { field: 'scriptOverflowMode', locked: c.lockedOverflowMode });
  }
}

// ------------------------------------------------------------------------------------------ storage
const cache = new WeakMap<Store, { at: number; global: PlatformLimits; ws: Map<string, WorkspaceLimits> }>();
const TTL_MS = 1000;
const invalidate = (store: Store) => cache.delete(store);

async function readGlobal(store: Store): Promise<PlatformLimits> {
  const row = await store.repo<Stored<PlatformLimits>>(Collections.settings).get(GLOBAL_ID);
  return { ...ENV_DEFAULTS(), ...(row?.data || {}) };
}
async function readWs(store: Store, workspaceId: string): Promise<WorkspaceLimits> {
  return (await store.repo<Stored<WorkspaceLimits>>(Collections.settings).get(`ws-limits:${workspaceId}`))?.data || {};
}

/** Cheap enough to call on every script execution (1 s cache, invalidated by writes on this process). */
export async function platformLimitsOf(store: Store, workspaceId: string): Promise<{ global: PlatformLimits; override: WorkspaceLimits }> {
  let c = cache.get(store);
  if (!c || Date.now() - c.at > TTL_MS) { c = { at: Date.now(), global: await readGlobal(store), ws: new Map() }; cache.set(store, c); }
  let ws = c.ws.get(workspaceId);
  if (!ws) { ws = await readWs(store, workspaceId); c.ws.set(workspaceId, ws); }
  return { global: c.global, override: ws };
}

/** push the platform-wide knobs into the running sandbox (live, no restart) */
export function applyGlobalToSandbox(g: PlatformLimits): void {
  configureSandbox({ poolDefaultSize: g.scriptPoolDefaultSize, poolMaxSize: g.scriptPoolMaxSize, queueMax: g.scriptQueueMaxCap, queueTimeoutMs: g.scriptQueueTimeoutMs, maxIsolates: g.scriptMaxIsolates, overflowMode: g.scriptOverflowModeDefault });
}

/** Everything a script/condition execution needs from the limits model for `ctx`'s workspace. Also (re)applies the
 *  platform-wide values to the sandbox so an admin's change is picked up by the very next execution. */
export async function effectiveLimitsFor(ctx: AppContext): Promise<{ effective: EffectiveLimits; caps: LimitCaps; settings: SystemSettings }> {
  const [{ global, override: wsOverride }, settings, plan] = await Promise.all([platformLimitsOf(ctx.store, ctx.tenantId), new SettingsService(ctx).get(), resolvePlan(ctx.store, ctx.tenantId, Date.parse(ctx.clock()))]);
  applyGlobalToSandbox(global);
  // the plan is one more cap layer: min(platform global, per-workspace override, plan) — it can only tighten
  const pos = (v: number) => (v > 0 ? v : undefined);
  const tight = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));
  const override: WorkspaceLimits = { ...wsOverride,
    scriptPoolMaxSize: tight(wsOverride.scriptPoolMaxSize, pos(plan.limits.concurrentScripts)),
    maxActiveInstancesCap: tight(wsOverride.maxActiveInstancesCap, pos(plan.limits.maxActiveInstances)),
    maxActiveTimersCap: tight(wsOverride.maxActiveTimersCap, pos(plan.limits.maxActiveTimers)),
    maxReplicasCap: tight(wsOverride.maxReplicasCap, pos(plan.limits.maxReplicas)) };
  return { effective: resolveLimits(global, override, settings), caps: capsOf(global, override), settings };
}

/** The most replicas that may serve `workspaceId` right now (0 = unlimited) = min(platform cap, per-workspace cap, plan).
 *  Cheap (cached reads only) — the request gate calls it on every API call. */
export async function maxReplicasFor(store: Store, workspaceId: string): Promise<number> {
  const [{ global, override }, plan] = await Promise.all([platformLimitsOf(store, workspaceId), resolvePlan(store, workspaceId)]);
  const pos = (v: number | undefined) => (v !== undefined && v > 0 ? v : undefined);
  const all = [pos(global.maxReplicasCap), pos(override.maxReplicasCap), pos(plan.limits.maxReplicas)].filter((v): v is number => v !== undefined);
  return all.length ? Math.min(...all) : 0;
}

// ------------------------------------------------------------------------------------------ service
const intField = (k: string, v: unknown, zeroOk: boolean) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < (zeroOk ? 0 : 1)) throw validation(`${k} must be an integer ≥ ${zeroOk ? 0 : 1}`);
};

export class PlatformLimitsService {
  private ctx: AppContext;
  constructor(private store: Store, now?: AppContext) { this.ctx = now ?? makeContext({ store, tenantId: PLATFORM_TENANT }); }

  async getGlobal(): Promise<{ limits: PlatformLimits; defaults: PlatformLimits; overriddenFields: string[] }> {
    const row = await this.store.repo<Stored<PlatformLimits>>(Collections.settings).get(GLOBAL_ID);
    return { limits: { ...ENV_DEFAULTS(), ...(row?.data || {}) }, defaults: BOOT_DEFAULTS, overriddenFields: Object.keys(row?.data || {}) };
  }

  async putGlobal(patch: Record<string, unknown>, actor: string) {
    const clean: Partial<PlatformLimits> = {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === null) continue;                                 // null = revert this field to its env default
      if ((GLOBAL_INT_FIELDS as readonly string[]).includes(k)) { intField(k, v, ZERO_OK.has(k)); (clean as any)[k] = v; }
      else if (k === 'scriptControlsVisible') { if (typeof v !== 'boolean') throw validation('scriptControlsVisible must be true or false'); clean[k] = v; }
      else if (k === 'scriptOverflowModeDefault') { if (!isOverflowMode(v)) throw validation("scriptOverflowModeDefault must be 'queue' or 'reject'"); clean[k] = v; }
      else throw validation(`unknown platform limit "${k}"`);
    }
    const row = await this.store.repo<Stored<PlatformLimits>>(Collections.settings).get(GLOBAL_ID);
    const data: Partial<PlatformLimits> = { ...(row?.data || {}), ...clean };
    for (const [k, v] of Object.entries(patch || {})) if (v === null) delete (data as any)[k];
    const merged = { ...ENV_DEFAULTS(), ...data };
    if (merged.scriptPoolDefaultSize > merged.scriptPoolMaxSize) throw validation(`scriptPoolDefaultSize (${merged.scriptPoolDefaultSize}) cannot exceed scriptPoolMaxSize (${merged.scriptPoolMaxSize})`);
    if (merged.scriptQueueDefaultMax > merged.scriptQueueMaxCap) throw validation(`scriptQueueDefaultMax (${merged.scriptQueueDefaultMax}) cannot exceed scriptQueueMaxCap (${merged.scriptQueueMaxCap})`);
    await this.store.repo<Stored<PlatformLimits>>(Collections.settings).put({ id: GLOBAL_ID, tenantId: PLATFORM_TENANT, data, updatedAt: this.ctx.clock(), updatedBy: actor });
    invalidate(this.store);
    await this.ctx.audit({ actor, kind: 'platform.limits.updated', data: { changed: Object.keys(patch || {}), values: clean } });
    await this.applyLive();
    return this.getGlobal();
  }

  private async requireWorkspace(id: string) {
    const t = await this.store.repo<{ id: string; name?: string; slug?: string }>(Collections.tenants).get(id);
    if (!t) throw notFound('Workspace');
    return t;
  }

  async getWorkspace(workspaceId: string) {
    await this.requireWorkspace(workspaceId);
    const [global, override] = [(await this.getGlobal()).limits, await readWs(this.store, workspaceId)];
    const settings = await new SettingsService(makeContext({ store: this.store, tenantId: workspaceId })).get();
    return { workspaceId, override, caps: capsOf(global, override), effective: resolveLimits(global, override, settings), workspaceSettings: { scriptPoolSize: settings.scriptPoolSize, maxConcurrentScripts: settings.maxConcurrentScripts, scriptQueueMax: settings.scriptQueueMax, scriptOverflowMode: settings.scriptOverflowMode, maxActiveInstances: settings.maxActiveInstances, maxActiveTimers: settings.maxActiveTimers } };
  }

  async putWorkspace(workspaceId: string, patch: Record<string, unknown>, actor: string) {
    await this.requireWorkspace(workspaceId);
    const g = (await this.getGlobal()).limits;
    const current = await readWs(this.store, workspaceId);
    const next: WorkspaceLimits = { ...current };
    for (const [k, v] of Object.entries(patch || {})) {
      if (k === 'scriptControlsVisible') {
        if (v === null) delete next.scriptControlsVisible;
        else if (typeof v !== 'boolean') throw validation('scriptControlsVisible must be true, false or null');
        else next.scriptControlsVisible = v;
      } else if (k === 'lockedOverflowMode') {
        if (v === null) delete next.lockedOverflowMode;
        else if (!isOverflowMode(v)) throw validation("lockedOverflowMode must be 'queue', 'reject' or null");
        else next.lockedOverflowMode = v;
      } else if ((WS_INT_FIELDS as readonly string[]).includes(k)) {
        if (v === null) { delete (next as any)[k]; continue; }
        intField(k, v, ZERO_OK.has(k));
        (next as any)[k] = v;
      } else throw validation(`unknown workspace limit "${k}"`);
    }
    // a workspace override may tighten the global caps but never lift them
    if (next.scriptPoolMaxSize !== undefined && next.scriptPoolMaxSize > g.scriptPoolMaxSize) throw validation(`scriptPoolMaxSize ${next.scriptPoolMaxSize} exceeds the global cap of ${g.scriptPoolMaxSize}`, { cap: g.scriptPoolMaxSize });
    if (next.scriptQueueMaxCap !== undefined && next.scriptQueueMaxCap > g.scriptQueueMaxCap) throw validation(`scriptQueueMaxCap ${next.scriptQueueMaxCap} exceeds the global cap of ${g.scriptQueueMaxCap}`, { cap: g.scriptQueueMaxCap });
    if (next.scriptPoolDefaultSize !== undefined && next.scriptPoolDefaultSize > Math.min(next.scriptPoolMaxSize ?? Infinity, g.scriptPoolMaxSize)) throw validation('scriptPoolDefaultSize cannot exceed the pool cap');
    await this.store.repo<Stored<WorkspaceLimits>>(Collections.settings).put({ id: `ws-limits:${workspaceId}`, tenantId: PLATFORM_TENANT, data: next, updatedAt: this.ctx.clock(), updatedBy: actor });
    invalidate(this.store);
    await this.ctx.audit({ actor, kind: 'platform.workspace-limits.updated', data: { workspaceId, changed: Object.keys(patch || {}), values: next } });
    await this.applyLive();
    return this.getWorkspace(workspaceId);
  }

  /** re-resolve every workspace that currently has a live pool and resize it in place: growing is lazy, shrinking
   *  drains idle isolates and retires busy ones after their run, queued work is kept. */
  async applyLive(): Promise<void> {
    invalidate(this.store);
    const g = (await this.getGlobal()).limits;
    applyGlobalToSandbox(g);
    const live = new Set([...Object.keys(sandboxStats().isolatesAlive), ...Object.keys(sandboxStats().queued)]);
    for (const id of live) {
      if (id.startsWith('_')) continue;
      const settings = await new SettingsService(makeContext({ store: this.store, tenantId: id })).get();
      const e = resolveLimits(g, await readWs(this.store, id), settings);
      const share = replicaShare(id, e);
      setPoolLimits(id, { size: share.size, queueMax: share.queueMax, mode: e.scriptOverflowMode });
    }
  }

  /** read-only usage: per workspace effective limits + live pool numbers */
  async usage() {
    const g = (await this.getGlobal()).limits;
    const stats = sandboxStats();
    const tenants = await this.store.repo<{ id: string; name?: string; slug?: string; plan?: string; planExpiresAt?: string | null; status?: string }>(Collections.tenants).list();
    const rows = [];
    for (const t of tenants) {
      const settings = await new SettingsService(makeContext({ store: this.store, tenantId: t.id })).get();
      const override = await readWs(this.store, t.id);
      rows.push({
        workspaceId: t.id, name: t.name, slug: t.slug, plan: t.plan ?? null, planExpiresAt: t.planExpiresAt ?? null, status: t.status ?? 'active',
        effective: resolveLimits(g, override, settings), caps: capsOf(g, override),
        pool: { size: stats.effectiveConcurrency[t.id] ?? null, isolatesAlive: stats.isolatesAlive[t.id] ?? 0, running: stats.running[t.id] ?? 0, queued: stats.queued[t.id] ?? 0, peakRunning: stats.peakRunning[t.id] ?? 0, created: stats.perTenant[t.id]?.created ?? 0, recycled: stats.perTenant[t.id]?.recycled ?? 0 },
      });
    }
    return { global: g, server: { totalIsolates: stats.totalIsolates, maxIsolates: sandboxConfig().maxIsolates, queuedTotal: stats.queuedTotal, created: stats.created, recycled: stats.recycled, executions: stats.executions, queueRejected: stats.queueRejected, overflowRejected: stats.overflowRejected, queueTimeouts: stats.queueTimeouts }, workspaces: rows };
  }
}

/** Do this workspace's admins get to see and manage script parallelism? workspace override, else the global switch (default: no). */
export async function scriptControlsVisibleFor(store: Store, workspaceId: string): Promise<boolean> {
  const { global, override } = await platformLimitsOf(store, workspaceId);
  return override.scriptControlsVisible ?? global.scriptControlsVisible ?? false;
}
