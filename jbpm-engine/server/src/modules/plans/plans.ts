// Plans, metered usage and the checks that enforce them.
//
//   resolvePlan(store, tenantId)  → the workspace's plan with its effective limits (cached ~2 s; a workspace row that
//                                   does not exist — bare engine contexts — resolves to "no plan = unlimited")
//   enforce*(ctx)                 → called at the point where work is created: process start, workflow create, member
//                                   invite, deploy. Refuses with 402 PLAN_EXPIRED when the plan/trial has lapsed and
//                                   with 429 QUOTA_EXCEEDED (limit, used, resetsAt) when a limit is reached.
//   reserve*                      → daily / weekly / monthly process-start counters, incremented atomically per
//                                   workspace (an in-process lock; counters live in the `usage` collection).
//
// With several replicas the read-modify-write below also takes a cluster-wide lock (Redis) so counters never lose updates.
// The platform administrator (ctx.planExempt) is not subject to plan limits or expiry in any workspace.
import type { Store } from '../../store/repository.ts';
import type { AppContext } from '../../context.ts';
import { Collections, type Deployment, type Instance, type Plan, type Tenant, type TenantMember, type Usage, type Workflow } from '../../domain.ts';
import { coordinator } from '../../infra/coordinator.ts';
import { conflict, notFound, planExpired, quotaExceeded, validation } from '../../infra/errors.ts';
import { DEFAULT_PLAN_LIMITS, LIMIT_CATALOG, PLAN_LIMIT_KEYS, TRIAL_DAYS, UNLIMITED, cap, type PlanLimitKey, type PlanLimits } from './plan-limits.ts';

export interface ResolvedPlan {
  tenant?: Tenant;
  key: string;
  name: string;
  limits: Required<PlanLimits>;
  planExpiresAt: string | null;
  expired: boolean;
}

// ---------------------------------------------------------------------------------------------- resolution
const TTL_MS = 2000;
let caches = new WeakMap<Store, Map<string, { at: number; v: ResolvedPlan }>>();
/** call after any plan / workspace-plan write so the next request sees it */
export function invalidatePlanCache(store: Store): void { caches.delete(store); }

const knownLimits = (raw: unknown): Partial<PlanLimits> => {
  const out: Partial<PlanLimits> = {};
  if (raw && typeof raw === 'object') for (const k of PLAN_LIMIT_KEYS) { const v = (raw as any)[k]; if (typeof v === 'number' && Number.isFinite(v)) out[k] = v; }
  return out;
};

export async function resolvePlan(store: Store, tenantId: string, nowMs = Date.now()): Promise<ResolvedPlan> {
  let m = caches.get(store);
  if (!m) { m = new Map(); caches.set(store, m); }
  const hit = m.get(tenantId);
  if (hit && nowMs - hit.at < TTL_MS && nowMs >= hit.at) return recompute(hit.v, nowMs);

  const tenant = tenantId === 'all' ? undefined : await store.repo<Tenant>(Collections.tenants).get(tenantId);
  let v: ResolvedPlan;
  if (!tenant) {
    v = { key: 'none', name: 'No plan', limits: DEFAULT_PLAN_LIMITS.enterprise, planExpiresAt: null, expired: false };
  } else {
    const key = tenant.plan || 'enterprise';
    const row = (await store.repo<Plan>(Collections.plans).query((p) => p.key === key))[0];
    const base = DEFAULT_PLAN_LIMITS[key] ?? DEFAULT_PLAN_LIMITS.enterprise;
    v = { tenant, key, name: row?.name ?? key, limits: { ...base, ...knownLimits(row?.limits) } as Required<PlanLimits>, planExpiresAt: tenant.planExpiresAt ?? null, expired: false };
  }
  m.set(tenantId, { at: nowMs, v });
  return recompute(v, nowMs);
}
const recompute = (v: ResolvedPlan, nowMs: number): ResolvedPlan => ({ ...v, expired: !!v.planExpiresAt && Date.parse(v.planExpiresAt) < nowMs });

// ---------------------------------------------------------------------------------------------- usage windows
const DAY = 86_400_000;
export function periodWindows(nowMs: number) {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear(), mo = d.getUTCMonth();
  const dayStart = Date.UTC(y, mo, d.getUTCDate());
  const weekStart = dayStart - ((new Date(dayStart).getUTCDay() + 6) % 7) * DAY;     // ISO week: Monday
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return {
    day: { key: iso(dayStart), resetsAt: new Date(dayStart + DAY).toISOString() },
    week: { key: iso(weekStart), resetsAt: new Date(weekStart + 7 * DAY).toISOString() },
    month: { key: `${y}-${String(mo + 1).padStart(2, '0')}`, resetsAt: new Date(Date.UTC(y, mo + 1, 1)).toISOString() },
  } as const;
}
const PERIODS: Array<['day' | 'week' | 'month', PlanLimitKey]> = [['day', 'instancesPerDay'], ['week', 'instancesPerWeek'], ['month', 'instancesPerMonth']];
const usageId = (tenantId: string, period: string, key: string) => `${tenantId}:${period}:${key}`;

const locks = new Map<string, Promise<unknown>>();
function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/** Checks all three period budgets and, only if none is exhausted, counts this start in all three — atomically per workspace. */
async function reserveInstanceStart(ctx: AppContext, p: ResolvedPlan): Promise<void> {
  const nowMs = Date.parse(ctx.clock());
  const w = periodWindows(nowMs);
  const repo = ctx.store.repo<Usage>(Collections.usage);
  // in-process lock first (cheap, serialises this replica's own requests), then the cluster-wide lock so another replica
  // cannot read the same counters between our read and our write
  await withLock(ctx.tenantId, () => coordinator().mutex(`usage:${ctx.tenantId}`, async () => {
    const docs = await Promise.all(PERIODS.map(async ([period]) => (await repo.get(usageId(ctx.tenantId, period, w[period].key))) ?? { id: usageId(ctx.tenantId, period, w[period].key), tenantId: ctx.tenantId, period, key: w[period].key, count: 0, resetsAt: w[period].resetsAt } as Usage));
    PERIODS.forEach(([period, limitKey], i) => {
      const limit = cap(p.limits[limitKey]);
      if (limit !== undefined && docs[i].count >= limit) {
        throw quotaExceeded(`Plan limit reached: ${limit} process starts per ${period} on the ${p.name} plan. It resets at ${w[period].resetsAt}.`,
          { quota: limitKey, limit, used: docs[i].count, resetsAt: w[period].resetsAt, plan: p.key });
      }
    });
    for (const d of docs) { d.count += 1; await repo.put(d); }
  }));
}

// ---------------------------------------------------------------------------------------------- enforcement
const exempt = (ctx: AppContext) => !!ctx.planExempt || ctx.tenantId === 'all';

function assertActive(p: ResolvedPlan, what: string): void {
  if (p.expired) {
    throw planExpired(`Your ${p.name} plan ended on ${p.planExpiresAt!.slice(0, 10)}. Your workflows and history are kept and stay readable; choose a plan to continue ${what}.`, { plan: p.key, expiredAt: p.planExpiresAt });
  }
}
const atLimit = (what: string, limitKey: PlanLimitKey, limit: number, used: number, p: ResolvedPlan) =>
  quotaExceeded(`Plan limit reached: the ${p.name} plan allows ${what}. Remove one or upgrade your plan.`, { quota: limitKey, limit, used, plan: p.key });

export async function enforceInstanceStart(ctx: AppContext): Promise<void> {
  if (exempt(ctx)) return;
  const p = await resolvePlan(ctx.store, ctx.tenantId, Date.parse(ctx.clock()));
  if (p.key === 'none') return;
  assertActive(p, 'starting process instances');
  await reserveInstanceStart(ctx, p);
}

export async function enforceWorkflowCreate(ctx: AppContext): Promise<void> {
  if (exempt(ctx)) return;
  const p = await resolvePlan(ctx.store, ctx.tenantId, Date.parse(ctx.clock()));
  if (p.key === 'none') return;
  assertActive(p, 'creating workflows');
  const limit = cap(p.limits.maxWorkflows);
  if (limit === undefined) return;
  const used = (await ctx.store.repo<Workflow>(Collections.workflows).query((w) => w.tenantId === ctx.tenantId && !w.archived)).length;
  if (used >= limit) throw atLimit(`${limit} workflows`, 'maxWorkflows', limit, used, p);
}

export async function enforceMemberInvite(ctx: AppContext): Promise<void> {
  if (exempt(ctx)) return;
  const p = await resolvePlan(ctx.store, ctx.tenantId, Date.parse(ctx.clock()));
  if (p.key === 'none') return;
  assertActive(p, 'inviting people');
  const limit = cap(p.limits.maxTeamMembers);
  if (limit === undefined) return;
  const used = (await ctx.store.repo<TenantMember>(Collections.tenantMembers).query((m) => m.tenantId === ctx.tenantId && m.role !== 'system_admin' && (m.status === 'active' || m.status === 'invited'))).length;
  if (used >= limit) throw atLimit(`${limit} team members (including pending invitations)`, 'maxTeamMembers', limit, used, p);
}

export async function enforceDeploy(ctx: AppContext): Promise<void> {
  if (exempt(ctx)) return;
  const p = await resolvePlan(ctx.store, ctx.tenantId, Date.parse(ctx.clock()));
  if (p.key === 'none') return;
  assertActive(p, 'deploying');
  const limit = cap(p.limits.maxDeployments);
  if (limit === undefined) return;
  const used = (await ctx.store.repo<Deployment>(Collections.deployments).query((d) => d.tenantId === ctx.tenantId && d.status !== 'archived')).length;
  if (used >= limit) throw atLimit(`${limit} deployments`, 'maxDeployments', limit, used, p);
}

// ---------------------------------------------------------------------------------------------- reporting
export async function planUsageFor(ctx: AppContext) {
  const nowMs = Date.parse(ctx.clock());
  const p = await resolvePlan(ctx.store, ctx.tenantId, nowMs);
  const w = periodWindows(nowMs);
  const repo = ctx.store.repo<Usage>(Collections.usage);
  const periods: Record<string, { used: number; limit: number | null; remaining: number | null; resetsAt: string }> = {};
  for (const [period, limitKey] of PERIODS) {
    const used = (await repo.get(usageId(ctx.tenantId, period, w[period].key)))?.count ?? 0;
    const limit = cap(p.limits[limitKey]) ?? null;
    periods[period] = { used, limit, remaining: limit === null ? null : Math.max(0, limit - used), resetsAt: w[period].resetsAt };
  }
  const t = ctx.tenantId;
  const [wf, members, deps, inst, timers] = await Promise.all([
    ctx.store.repo<Workflow>(Collections.workflows).query((x) => x.tenantId === t && !x.archived),
    ctx.store.repo<TenantMember>(Collections.tenantMembers).query((m) => m.tenantId === t && m.role !== 'system_admin' && (m.status === 'active' || m.status === 'invited')),
    ctx.store.repo<Deployment>(Collections.deployments).query((d) => d.tenantId === t && d.status !== 'archived'),
    ctx.store.repo<Instance>(Collections.instances).query((i) => i.tenantId === t && !i.parentInstanceId && (i.status === 'running' || i.status === 'waiting')),
    ctx.store.repo<{ id: string; tenantId: string; status: string }>(Collections.timers).query((j) => j.tenantId === t && j.status === 'scheduled'),
  ]);
  const res = (used: number, key: PlanLimitKey) => ({ used, limit: cap(p.limits[key]) ?? null });
  return {
    plan: { key: p.key, name: p.name }, trialEndsAt: p.planExpiresAt, expired: p.expired,
    limits: Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, cap(p.limits[k]) ?? null])),
    usage: periods,
    resources: { workflows: res(wf.length, 'maxWorkflows'), teamMembers: res(members.length, 'maxTeamMembers'), deployments: res(deps.length, 'maxDeployments'), activeInstances: res(inst.length, 'maxActiveInstances'), activeTimers: res(timers.length, 'maxActiveTimers') },
  };
}

// ---------------------------------------------------------------------------------------------- platform administration
export const PLAN_STATUSES = ['active', 'disabled', 'upcoming', 'hidden'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
/** a stored plan's status; the legacy `hidden` flag still means hidden, and built-in plans that were never stored are hidden (assignable only) */
export const statusOf = (row: Plan | undefined): PlanStatus => row ? (row.status ?? (row.hidden ? 'hidden' : 'active')) : 'hidden';

const KEY_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const DAY_MS = 86_400_000;

/** the editable fields of a plan, validated once for create and update */
export interface PlanInput {
  name?: string; description?: string; status?: string; isDefault?: boolean; isCustom?: boolean; trialDays?: number | null;
  contactConfig?: { type?: string; value?: string; label?: string } | null; features?: unknown; sortOrder?: number; limits?: Record<string, unknown>;
  /** legacy: public === (status is not hidden) */
  public?: boolean;
}

const safeLine = (v: unknown, field: string, min: number, max: number): string => {
  if (typeof v !== 'string') throw validation(`${field} must be text`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw validation(`${field} must be ${min}–${max} characters`);
  if (/[\u0000-\u001f<>]/.test(t)) throw validation(`${field} may not contain control characters or < >`);
  return t;
};

export class PlanService {
  constructor(private store: Store) {}
  private plans() { return this.store.repo<Plan>(Collections.plans); }
  private tenants() { return this.store.repo<Tenant>(Collections.tenants); }

  /** Idempotent seed top-up: every stored built-in plan gets the limit keys it lacks (admin-edited values are never overwritten). */
  async ensureDefaults(): Promise<void> {
    for (const row of await this.plans().query(() => true)) {
      let next: Plan = { ...row };
      if (row.key === 'trial' && row.trialDays === 14) {            // the original default trial length
        next = { ...next, trialDays: TRIAL_DAYS, description: row.description.replace('14 days', `${TRIAL_DAYS} days`) };
      }
      const defaults = DEFAULT_PLAN_LIMITS[row.key];
      if (defaults) {
        const have = knownLimits(row.limits);
        const limits: Record<string, unknown> = { ...(row.limits ?? {}) };
        delete limits.maxInstances;                                 // the old, never-enforced total
        for (const k of PLAN_LIMIT_KEYS) if (have[k] === undefined) limits[k] = defaults[k];
        next = { ...next, limits };
      }
      if (JSON.stringify(next) !== JSON.stringify(row)) await this.plans().put(next);
    }
    invalidatePlanCache(this.store);
  }

  private shape(key: string, row: Plan | undefined, workspaces: number) {
    return {
      key, name: row?.name ?? key, description: row?.description ?? '', stored: !!row,
      status: statusOf(row), public: statusOf(row) !== 'hidden',            // `public` kept for older clients
      isDefault: !!row?.isDefault, isCustom: !!row?.isCustom, trialDays: row?.trialDays ?? null,
      contactConfig: row?.contactConfig ?? null, features: row?.features ?? [], sortOrder: row?.sortOrder ?? 0,
      workspaces,
      limits: { ...(DEFAULT_PLAN_LIMITS[key] ?? DEFAULT_PLAN_LIMITS.enterprise), ...knownLimits(row?.limits) },
    };
  }

  async list() {
    const all = await this.plans().query(() => true);
    const gone = new Set(all.filter((r) => (r as unknown as { deleted?: boolean }).deleted).map((r) => r.key));   // deleted built-in plans
    const rows = all.filter((r) => !gone.has(r.key));
    const tenants = await this.tenants().query(() => true);
    const keys = [...new Set([...Object.keys(DEFAULT_PLAN_LIMITS).filter((k) => !gone.has(k)), ...rows.map((r) => r.key)])];
    return keys.map((key) => this.shape(key, rows.find((r) => r.key === key), tenants.filter((t) => (t.plan || 'enterprise') === key).length))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  private async one(key: string) {
    const found = (await this.list()).find((p) => p.key === key);
    if (!found) throw notFound('Plan');
    return found;
  }

  /** Cross-field rules: the default plan is active, selectable by anyone and has no "contact us" flow. */
  private assertCoherent(p: { status: PlanStatus; isDefault: boolean; isCustom: boolean; trialDays: number | null }): void {
    if (p.isDefault && p.status !== 'active') throw validation('The default plan must be Active: new workspaces start on it');
    if (p.isDefault && p.isCustom) throw validation('A "contact us" plan cannot be the default plan');
    if (p.isCustom && p.trialDays) throw validation('A "contact us" plan has no trial: an administrator assigns it');
  }

  private cleanLimits(raw: Record<string, unknown> | undefined): Partial<PlanLimits> {
    const limits: Partial<PlanLimits> = {};
    for (const [k, v] of Object.entries(raw ?? {})) {
      if (!(k in LIMIT_CATALOG)) throw validation(`unknown plan limit "${k}" (known: ${PLAN_LIMIT_KEYS.join(', ')})`);
      if (typeof v !== 'number' || !Number.isInteger(v) || v < UNLIMITED) throw validation(`${k} must be an integer ≥ -1 (-1 = unlimited)`);
      limits[k as PlanLimitKey] = v;
    }
    return limits;
  }

  private cleanContact(raw: PlanInput['contactConfig']): Plan['contactConfig'] {
    if (raw === null || raw === undefined) return null;
    if (raw.type !== 'email' && raw.type !== 'url') throw validation("contact type must be 'email' or 'url'");
    const value = String(raw.value ?? '').trim().slice(0, 255);
    if (value) {
      const ok = raw.type === 'email' ? /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value) : /^https?:\/\/[^\s<>]+$/i.test(value);
      if (!ok) throw validation(raw.type === 'email' ? 'contact value must be an e-mail address' : 'contact value must be an http(s) URL');
    }
    return { type: raw.type, value, ...(raw.label ? { label: safeLine(raw.label, 'contact button text', 1, 60) } : {}) };
  }

  private cleanFeatures(raw: unknown): string[] {
    if (!Array.isArray(raw)) throw validation('features must be a list of short labels');
    if (raw.length > 30) throw validation('at most 30 feature labels');
    return raw.map((f) => safeLine(f, 'feature label', 1, 60));
  }

  private cleanStatus(v: unknown): PlanStatus {
    if (!PLAN_STATUSES.includes(v as PlanStatus)) throw validation(`status must be one of: ${PLAN_STATUSES.join(', ')}`);
    return v as PlanStatus;
  }

  private cleanTrial(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 365) throw validation('trialDays must be a whole number of days between 1 and 365 (empty = no trial)');
    return v;
  }

  /** Create a plan. It starts Hidden — nobody sees or can select it — until the administrator publishes it (sets it Active / Coming soon / Disabled). */
  async create(input: PlanInput & { key?: string }, actor: string) {
    const key = String(input.key ?? '').trim();
    if (!KEY_RE.test(key)) throw validation('plan key must be 2–32 chars: lowercase letters, digits, - or _, starting with a letter');
    const prior = (await this.plans().query((p) => p.key === key))[0];
    if ((prior && !(prior as unknown as { deleted?: boolean }).deleted) || (DEFAULT_PLAN_LIMITS[key] && !prior)) throw conflict(`a plan with the key "${key}" already exists`);
    const name = safeLine(input.name ?? key, 'name', 2, 100);
    const status = input.status === undefined ? 'hidden' : this.cleanStatus(input.status);
    const isDefault = input.isDefault === true, isCustom = input.isCustom === true;
    const trialDays = this.cleanTrial(input.trialDays);
    this.assertCoherent({ status, isDefault, isCustom, trialDays });
    const row: Plan = {
      id: `plan_${key}`, tenantId: 'system', key, name,
      description: input.description === undefined || input.description === null ? '' : safeLine(input.description, 'description', 0, 500),
      isDefault, isCustom, trialDays, contactConfig: isCustom ? this.cleanContact(input.contactConfig) : null,
      limits: { ...DEFAULT_PLAN_LIMITS.starter, ...this.cleanLimits(input.limits) } as Record<string, unknown>,
      features: input.features === undefined ? [] : this.cleanFeatures(input.features), status, sortOrder: Number.isInteger(input.sortOrder) ? input.sortOrder : 0,
    };
    if (isDefault) await this.clearDefault(key);
    await this.plans().put(row);
    invalidatePlanCache(this.store); void actor;
    return this.one(key);
  }

  private async clearDefault(exceptKey: string) {
    for (const p of await this.plans().query((x) => x.isDefault && x.key !== exceptKey)) await this.plans().put({ ...p, isDefault: false });
  }

  async update(key: string, patch: PlanInput, actor: string) {
    if (!KEY_RE.test(key)) throw validation('plan key must be 2–32 chars: lowercase letters, digits, - or _, starting with a letter');
    const existing = (await this.plans().query((p) => p.key === key))[0];
    if (!existing && !DEFAULT_PLAN_LIMITS[key]) throw notFound('Plan');
    const base: Plan = existing ?? {
      id: `plan_${key}`, tenantId: 'system', key, name: key, description: '', isDefault: false, isCustom: false, trialDays: null, contactConfig: null,
      limits: { ...DEFAULT_PLAN_LIMITS[key] }, features: [], status: 'hidden', sortOrder: 0,
    };
    // legacy `public` flag from the first Plans screen
    const wantedStatus = patch.status !== undefined ? this.cleanStatus(patch.status) : patch.public !== undefined ? (patch.public ? 'active' : 'hidden') : statusOf(base);
    const next: Plan = {
      ...base,
      name: patch.name !== undefined ? safeLine(patch.name, 'name', 2, 100) : base.name,
      description: patch.description !== undefined ? (patch.description === null ? '' : safeLine(patch.description, 'description', 0, 500)) : base.description,
      status: wantedStatus,
      isDefault: patch.isDefault ?? base.isDefault,
      isCustom: patch.isCustom ?? base.isCustom,
      trialDays: patch.trialDays !== undefined ? this.cleanTrial(patch.trialDays) : base.trialDays,
      features: patch.features !== undefined ? this.cleanFeatures(patch.features) : base.features,
      sortOrder: patch.sortOrder !== undefined ? (Number.isInteger(patch.sortOrder) && Math.abs(patch.sortOrder) <= 1000 ? patch.sortOrder : (() => { throw validation('sortOrder must be a whole number between -1000 and 1000'); })()) : base.sortOrder,
      limits: patch.limits ? { ...(base.limits ?? {}), ...this.cleanLimits(patch.limits) } : base.limits,
    };
    delete (next as Partial<Plan>).hidden;
    next.contactConfig = next.isCustom ? (patch.contactConfig !== undefined ? this.cleanContact(patch.contactConfig) : base.contactConfig ?? null) : null;
    this.assertCoherent({ status: statusOf(next), isDefault: !!next.isDefault, isCustom: !!next.isCustom, trialDays: next.trialDays ?? null });
    if (base.isDefault && patch.isDefault === false) throw validation('Make another plan the default instead: new workspaces need a plan to start on');
    if (next.isDefault && !base.isDefault) await this.clearDefault(key);
    await this.plans().put(next);
    invalidatePlanCache(this.store); void actor;
    return this.one(key);
  }

  /** Delete a plan nobody is on. The default plan cannot be deleted; a plan in use is retired by setting it Hidden. */
  async remove(key: string, actor: string): Promise<void> {
    const existing = (await this.plans().query((p) => p.key === key))[0];
    if (!existing && !DEFAULT_PLAN_LIMITS[key]) throw notFound('Plan');
    if (existing?.isDefault) throw conflict('The default plan cannot be deleted: make another plan the default first');
    const using = (await this.tenants().query((t) => (t.plan || 'enterprise') === key)).length;
    if (using > 0) throw conflict(`${using} workspace(s) are on this plan — move them to another plan, or set the plan's status to Hidden to retire it`);
    if (existing && !DEFAULT_PLAN_LIMITS[key]) await this.plans().delete(existing.id);
    else await this.plans().put({ id: existing?.id ?? `plan_${key}`, tenantId: 'system', key, name: key, description: '', isDefault: false, isCustom: false, trialDays: null, limits: {}, features: [], status: 'hidden', sortOrder: 0, deleted: true } as unknown as Plan);   // a built-in plan leaves a marker row so the seed never brings it back
    invalidatePlanCache(this.store); void actor;
  }

  /** The plan new workspaces start on (the default plan, else the built-in trial) and when its trial ends. */
  async startingPlan(nowMs = Date.now()): Promise<{ plan: string; planExpiresAt: string | null }> {
    const row = (await this.plans().query((p) => p.isDefault && statusOf(p) === 'active'))[0];
    const key = row?.key ?? 'trial';
    const days = row ? row.trialDays : TRIAL_DAYS;
    return { plan: key, planExpiresAt: days ? new Date(nowMs + days * DAY_MS).toISOString() : null };
  }

  /** What a visitor / workspace is shown: hidden plans are not listed; disabled and coming-soon ones are, but cannot be picked. */
  async catalogue(currentKey?: string) {
    const all = await this.list();
    return all
      .filter((p) => p.stored && (p.status !== 'hidden' || p.key === currentKey))
      .map((p) => ({
        key: p.key, name: p.name, description: p.description, status: p.status, trialDays: p.trialDays, isCustom: p.isCustom,
        contactConfig: p.contactConfig, features: p.features, limits: p.limits, isDefault: p.isDefault,
        current: p.key === currentKey, selectable: p.status === 'active' && !p.isCustom && p.key !== currentKey,
      }));
  }

  /** A workspace switches itself to a plan it is offered (active, not "contact us"); refused while it is over the new plan's limits. */
  async select(tenantId: string, planKey: string, used: Record<string, number>): Promise<Tenant> {
    const t = await this.tenants().get(tenantId);
    if (!t) throw notFound('Workspace');
    const row = (await this.plans().query((p) => p.key === planKey))[0];
    if (!row || statusOf(row) === 'hidden') throw notFound('Plan');
    if (statusOf(row) === 'upcoming') throw conflict(`"${row.name}" is coming soon and cannot be selected yet`);
    if (statusOf(row) === 'disabled') throw conflict(`"${row.name}" is not available right now`);
    if (row.isCustom) throw conflict(`"${row.name}" is a custom plan: contact us and an administrator will assign it`);
    if ((t.plan || '') === planKey) throw conflict('Your workspace is already on this plan');
    const limits = { ...(DEFAULT_PLAN_LIMITS[planKey] ?? DEFAULT_PLAN_LIMITS.enterprise), ...knownLimits(row.limits) } as Required<PlanLimits>;
    const over = Object.entries(used).filter(([k, n]) => { const c = cap(limits[k as PlanLimitKey]); return c !== undefined && n > c; })
      .map(([k, n]) => `${LIMIT_CATALOG[k as PlanLimitKey]?.label ?? k}: you have ${n}, "${row.name}" allows ${cap(limits[k as PlanLimitKey])}`);
    if (over.length) throw conflict(`Your workspace is over the limits of "${row.name}" — reduce first: ${over.join('; ')}`);
    return this.assign(tenantId, planKey, {});
  }

  /** Put a workspace on a plan; a plan with a trial gets its window (the plan's trialDays from now unless a date is given), other plans none unless given. */
  async assign(tenantId: string, plan: string, opts: { planExpiresAt?: string | null; extendDays?: number }): Promise<Tenant> {
    const t = await this.tenants().get(tenantId);
    if (!t) throw notFound('Workspace');
    const all = await this.list();
    const known = all.find((p) => p.key === plan);
    if (!known) throw validation(`unknown plan "${plan}"`);
    let expires: string | null;
    if (opts.planExpiresAt !== undefined) {
      if (opts.planExpiresAt !== null && Number.isNaN(Date.parse(opts.planExpiresAt))) throw validation('planExpiresAt must be an ISO date or null');
      expires = opts.planExpiresAt;
    } else if (typeof opts.extendDays === 'number') {
      if (!Number.isFinite(opts.extendDays) || opts.extendDays < 0 || opts.extendDays > 3650) throw validation('extendDays must be between 0 and 3650');
      const base = Math.max(Date.now(), t.planExpiresAt ? Date.parse(t.planExpiresAt) : 0);
      expires = new Date(base + opts.extendDays * DAY_MS).toISOString();
    } else {
      const days = known.stored ? known.trialDays : (plan === 'trial' ? TRIAL_DAYS : null);
      expires = days ? new Date(Date.now() + days * DAY_MS).toISOString() : null;
    }
    const next: Tenant = { ...t, plan, planExpiresAt: expires, updatedAt: new Date().toISOString() };
    await this.tenants().put(next);
    invalidatePlanCache(this.store);
    return next;
  }
}
