// Automatic task assignment. A user task is created UNASSIGNED and flagged `allocation: 'pending'`; the allocator runner (a loop of its own, see index.ts,
// role 'allocator' or 'all') picks the person here. One allocator works a workspace at a time (a lease), so there is no race between replicas and the
// decision can use fresh per-person counts: open tasks, tasks given today, skills, limits, availability. Nobody qualifies = the task stays in its group queue
// ('queued') and is looked at again on the next pass. A task assigned by hand, by name or by `#{variable}` is never touched.
import type { AppContext } from '../../context.ts';
import { Collections, type AssignmentRule, type Role, type Task, type User } from '../../domain.ts';
import { findRows } from '../../store/find.ts';
import { notFound, validation } from '../../infra/errors.ts';
import { permissionGrants } from '../../infra/auth.ts';
import { coordinator } from '../../infra/coordinator.ts';
import { kickAllocator } from '../../engine/allocator-kick.ts';

/** how long a queued task waits before the allocator tries it again */
export const QUEUED_RETRY_MS = Number(process.env.ALLOCATOR_QUEUED_RETRY_MS || 15_000);
const STRATEGIES = ['roundRobin', 'leastLoaded', 'skills'] as const;
const OPEN: string[] = ['created', 'reserved', 'inprogress'];
const startOfDay = (iso: string) => `${iso.slice(0, 10)}T00:00:00.000Z`;          // UTC day
const list = (v: unknown): string[] => (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean);

/** enabled rules per workspace, kept a couple of seconds so creating a task does not query them every time */
const ruleCache = new Map<string, { at: number; rules: AssignmentRule[] }>();
export const resetRuleCache = () => ruleCache.clear();
export async function enabledRules(ctx: AppContext): Promise<AssignmentRule[]> {
  const hit = ruleCache.get(ctx.tenantId);
  if (hit && Date.now() - hit.at < 2000) return hit.rules;
  const rules = (await ctx.store.repo<AssignmentRule>(Collections.assignmentRules).query((r) => r.tenantId === ctx.tenantId && r.enabled)).sort(ruleOrder);
  ruleCache.set(ctx.tenantId, { at: Date.now(), rules });
  return rules;
}
const specificity = (r: AssignmentRule) => (r.scope.nodeId ? 4 : 0) + (r.scope.workflowId ? 2 : 0) + (r.scope.group ? 1 : 0);
const ruleOrder = (a: AssignmentRule, b: AssignmentRule) => specificity(b) - specificity(a) || a.priority - b.priority || a.name.localeCompare(b.name);
/** away = switched off, or away until a time that has not come yet */
export const isAvailable = (u: Pick<User, 'available' | 'awayUntil'>, now: string) => u.available !== false && !(u.awayUntil && u.awayUntil > now);
const offeredGroups = (t: Task) => [...new Set([t.group, ...(t.groups ?? [])].filter((g): g is string => !!g))];
export function ruleCovers(r: AssignmentRule, t: Pick<Task, 'workflowId' | 'nodeId' | 'group' | 'groups'>): boolean {
  return (!r.scope.workflowId || r.scope.workflowId === t.workflowId) && (!r.scope.nodeId || r.scope.nodeId === t.nodeId) && (!r.scope.group || offeredGroups(t as Task).includes(r.scope.group));
}

export interface RuleInput { name?: string; enabled?: boolean; priority?: number; scope?: AssignmentRule['scope']; strategy?: string; requiredSkills?: string[]; pool?: AssignmentRule['pool']; respectLimits?: boolean }
export interface PersonLoad { username: string; skills: string[]; available: boolean; awayUntil?: string; canWork: boolean; maxOpenTasks?: number; maxTasksPerDay?: number; open: number; inProgress: number; assignedToday: number; completedToday: number }

export class AllocationService {
  constructor(private ctx: AppContext) {}
  private rules() { return this.ctx.store.repo<AssignmentRule>(Collections.assignmentRules); }
  private tasks() { return this.ctx.store.repo<Task>(Collections.tasks); }
  private users() { return this.ctx.store.repo<User>(Collections.users); }

  // ---- rules
  async listRules(): Promise<AssignmentRule[]> { return (await this.rules().query((r) => r.tenantId === this.ctx.tenantId)).sort(ruleOrder); }
  private clean(input: RuleInput, base?: AssignmentRule): AssignmentRule {
    const name = (input.name ?? base?.name ?? '').trim();
    if (!name) throw validation('a rule needs a name');
    const strategy = (input.strategy ?? base?.strategy ?? 'leastLoaded') as AssignmentRule['strategy'];
    if (!STRATEGIES.includes(strategy)) throw validation(`strategy must be one of ${STRATEGIES.join(', ')}`);
    const requiredSkills = list(input.requiredSkills ?? base?.requiredSkills);
    if (strategy === 'skills' && !requiredSkills.length) throw validation('the skills strategy needs at least one required skill');
    const priority = Number(input.priority ?? base?.priority ?? 100);
    if (!Number.isFinite(priority)) throw validation('priority must be a number');
    const scope = { ...(base?.scope ?? {}), ...(input.scope ?? {}) };
    for (const k of Object.keys(scope) as Array<keyof typeof scope>) if (!scope[k]) delete scope[k];
    const pool = input.pool ?? base?.pool;
    const now = this.ctx.clock();
    return { id: base?.id ?? this.ctx.newId(), tenantId: this.ctx.tenantId, name, enabled: input.enabled ?? base?.enabled ?? true, priority, scope, strategy,
      ...(requiredSkills.length ? { requiredSkills } : {}), ...(pool && (list(pool.groups).length || list(pool.users).length) ? { pool: { groups: list(pool.groups), users: list(pool.users) } } : {}),
      respectLimits: input.respectLimits ?? base?.respectLimits ?? true, createdAt: base?.createdAt ?? now, updatedAt: now };
  }
  async createRule(input: RuleInput, actor: string): Promise<AssignmentRule> {
    const r = { ...this.clean(input), updatedBy: actor };
    await this.rules().put(r); resetRuleCache();
    await this.ctx.audit({ actor, kind: 'assignment-rule.created', data: { id: r.id, name: r.name } });
    return r;
  }
  async updateRule(id: string, input: RuleInput, actor: string): Promise<AssignmentRule> {
    const cur = await this.rules().get(id);
    if (!cur || cur.tenantId !== this.ctx.tenantId) throw notFound('Assignment rule');
    const r = { ...this.clean(input, cur), updatedBy: actor };
    await this.rules().put(r); resetRuleCache();
    await this.ctx.audit({ actor, kind: 'assignment-rule.updated', data: { id, name: r.name } });
    return r;
  }
  async deleteRule(id: string, actor: string): Promise<void> {
    const cur = await this.rules().get(id);
    if (!cur || cur.tenantId !== this.ctx.tenantId) throw notFound('Assignment rule');
    await this.rules().delete(id); resetRuleCache();
    await this.ctx.audit({ actor, kind: 'assignment-rule.deleted', data: { id, name: cur.name } });
  }

  // ---- per-person load: three queries for the whole workspace, counted in memory (not three per person)
  private async counts(now: string, withDone: boolean): Promise<Map<string, { open: number; inProgress: number; assignedToday: number; completedToday: number }>> {
    const t = this.ctx.tenantId, store = this.ctx.store, day = startOfDay(now);
    const by = new Map<string, { open: number; inProgress: number; assignedToday: number; completedToday: number }>();
    const slot = (u: string) => by.get(u) ?? by.set(u, { open: 0, inProgress: 0, assignedToday: 0, completedToday: 0 }).get(u)!;
    for (const x of await findRows<Task>(store, Collections.tasks, t, { eq: { status: OPEN } })) if (x.assignee) { const c = slot(x.assignee); c.open++; if (x.status === 'inprogress') c.inProgress++; }
    for (const x of await findRows<Task>(store, Collections.tasks, t, { gte: { claimedAt: day } })) if (x.assignee) slot(x.assignee).assignedToday++;
    if (withDone) for (const x of await findRows<Task>(store, Collections.tasks, t, { eq: { status: 'completed' }, gte: { completedAt: day } })) if (x.assignee) slot(x.assignee).completedToday++;
    return by;
  }
  private personLoad(user: User, now: string, c?: { open: number; inProgress: number; assignedToday: number; completedToday: number }): PersonLoad {
    return { username: user.username, skills: user.skills ?? [], available: isAvailable(user, now), awayUntil: user.awayUntil && user.awayUntil > now ? user.awayUntil : undefined, canWork: true, maxOpenTasks: user.maxOpenTasks, maxTasksPerDay: user.maxTasksPerDay,
      open: c?.open ?? 0, inProgress: c?.inProgress ?? 0, assignedToday: c?.assignedToday ?? 0, completedToday: c?.completedToday ?? 0 };
  }

  /** the tracker: who has what right now, and how many tasks are waiting for a person */
  async tracker(): Promise<{ people: PersonLoad[]; waiting: { pending: number; queued: number }; rules: number }> {
    const now = this.ctx.clock(), t = this.ctx.tenantId;
    const users = (await this.users().query((u) => u.tenantId === t && u.active)).sort((a, b) => a.username.localeCompare(b.username));
    const roles = await this.ctx.store.repo<Role>(Collections.roles).query((r) => r.tenantId === t);
    const rolePerms = new Map(roles.map((r) => [r.name, r.permissions] as const));
    const counts = await this.counts(now, true);
    const people = users.map((u) => ({ ...this.personLoad(u, now, counts.get(u.username)), canWork: !roles.length || permissionGrants((u.roles ?? []).flatMap((r) => rolePerms.get(r) ?? []), 'task:manage') }));
    const unassigned = async (state: string) => (await findRows<Task>(this.ctx.store, Collections.tasks, t, { eq: { allocation: state } })).filter((x) => !x.assignee && x.status !== 'completed').length;
    const waiting = { pending: await unassigned('pending'), queued: await unassigned('queued') };
    return { people, waiting, rules: (await this.listRules()).filter((r) => r.enabled).length };
  }

  // ---- the allocator
  /** One pass: give each waiting task to a person. Safe to call from one process at a time per workspace (the runner holds a lease). */
  async runOnce(limit = 200, opts: { force?: boolean } = {}): Promise<{ assigned: number; queued: number; more: boolean }> {
    // a second, per-task claim on top of the runner's per-workspace lease (a short Redis lease, in-process without Redis): if a lease ever lapsed mid-pass
    // (a stalled process) and a second runner started, the two still could not both decide the same task
    const held: Array<() => Promise<void>> = [];
    try { return await this.pass(limit, opts, held); } finally { await Promise.all(held.map((r) => r().catch(() => {}))); }
  }
  private async pass(limit: number, opts: { force?: boolean }, held: Array<() => Promise<void>>): Promise<{ assigned: number; queued: number; more: boolean }> {
    const t = this.ctx.tenantId, now = this.ctx.clock();
    // a task nobody could take is looked at again after a pause, not on every pass (capacity frees up when work is completed, rules or people change)
    const retryAfter = new Date(Date.parse(now) - QUEUED_RETRY_MS).toISOString();
    // new work first; tasks nobody could take only fill what is left of the batch, least recently tried first, so they can neither starve new work nor each other
    const fresh = await findRows<Task>(this.ctx.store, Collections.tasks, t, { eq: { allocation: ['pending'] }, orderBy: 'createdAt', limit });
    const retry = fresh.length >= limit ? [] : (await findRows<Task>(this.ctx.store, Collections.tasks, t, { eq: { allocation: ['queued'] }, orderBy: 'allocationTriedAt', limit: limit - fresh.length }))
      .filter((x) => opts.force || !x.allocationTriedAt || x.allocationTriedAt <= retryAfter);
    const more = fresh.length >= limit;                                                // a full batch of new work: there may be more behind it
    const waiting = [...fresh, ...retry].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt.localeCompare(b.createdAt));
    if (!waiting.length) return { assigned: 0, queued: 0, more: false };
    const rules = await enabledRules(this.ctx);
    const everyone = await this.users().query((u) => u.tenantId === t);                    // disabled accounts too: a disabled person NAMED on a task must still be recognised and skipped
    const users = new Map(everyone.map((u) => [u.username, u] as const));
    const roles = await this.ctx.store.repo<Role>(Collections.roles).query((r) => r.tenantId === t);
    const rolePerms = new Map(roles.map((r) => [r.name, r.permissions] as const));
    // can this person actually work tasks? Only judged when the workspace has roles defined (a workspace without any keeps every account eligible)
    const canWork = (u: User) => !roles.length || permissionGrants((u.roles ?? []).flatMap((r) => rolePerms.get(r) ?? []), 'task:manage');
    const byGroup = new Map<string, string[]>();
    for (const u of everyone.filter((x) => x.active)) for (const g of u.groups ?? []) (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(u.username);
    const counts = await this.counts(now, false);                                   // fresh per pass, and updated as this pass assigns, so one pass spreads work evenly
    const loads = new Map<string, PersonLoad>();
    const loadOf = async (name: string) => loads.get(name) ?? loads.set(name, this.personLoad(users.get(name)!, now, counts.get(name))).get(name)!;
    let assigned = 0, queued = 0;
    for (const w of waiting) {
      const mine = await coordinator().tryLock(`task:${t}:${w.id}`, 30_000);
      if (!mine) continue;                                                           // another runner is deciding this very task
      held.push(mine);
      const task = await this.tasks().get(w.id);                                    // re-read: it may have been claimed or reassigned by hand since
      // a suspended task ("suspend until") is hidden from everyone: it stays flagged and is assigned once it resumes
      if (!task || task.assignee || (task.allocation !== 'pending' && task.allocation !== 'queued') || ['completed', 'cancelled', 'skipped', 'failed', 'suspended'].includes(task.status)) continue;
      const rule = (() => {
        if (task.allocationStrategy || task.requiredSkills?.length) return { strategy: (task.requiredSkills?.length ? 'skills' : task.allocationStrategy) as AssignmentRule['strategy'], requiredSkills: task.requiredSkills, respectLimits: true, pool: undefined as AssignmentRule['pool'] };
        return rules.find((r) => ruleCovers(r, task));
      })();
      if (!rule) { if (task.allocation !== 'queued' || !task.allocationTriedAt) { task.allocation = 'queued'; task.allocationNote = 'no assignment rule applies: left in the group queue'; task.allocationTriedAt = now; await this.tasks().put(task); queued++; } continue; }
      // who is offered the task: the rule's pool, else the people / group members the task itself names
      const names = new Set<string>(rule.pool ? [...list(rule.pool.users), ...list(rule.pool.groups).flatMap((g) => byGroup.get(g) ?? [])] : [...(task.actors ?? []), ...offeredGroups(task).flatMap((g) => byGroup.get(g) ?? [])]);
      for (const x of task.excludedOwners ?? []) names.delete(x);
      if (!names.size) { await this.park(task, 'nobody is offered this task'); queued++; continue; }
      const need = list(rule.requiredSkills);
      const eligible: PersonLoad[] = []; const why = new Set<string>();
      for (const name of [...names].sort()) {
        const user = users.get(name);
        if (!user) { if (!need.length) eligible.push({ username: name, skills: [], available: true, canWork: true, open: 0, inProgress: 0, assignedToday: 0, completedToday: 0 }); else why.add('no one with the required skills'); continue; }
        if (!user.active) { why.add('the people offered the task are disabled'); continue; }
        if (!canWork(user)) { why.add('the people offered the task have no permission to work tasks'); continue; }
        const l = await loadOf(name);
        if (!l.available) { why.add('everyone qualified is away'); continue; }
        if (need.some((s) => !l.skills.includes(s))) { why.add(`no one with the skills ${need.join(', ')}`); continue; }
        if (rule.respectLimits && ((l.maxOpenTasks && l.open >= l.maxOpenTasks) || (l.maxTasksPerDay && l.assignedToday >= l.maxTasksPerDay))) { why.add('everyone qualified is at their limit'); continue; }
        eligible.push(l);
      }
      if (!eligible.length) { await this.park(task, [...why].join('; ') || 'nobody qualifies'); queued++; continue; }
      const last = (l: PersonLoad) => users.get(l.username)?.lastAssignedAt ?? '';
      eligible.sort(rule.strategy === 'roundRobin'
        ? (a, b) => last(a).localeCompare(last(b)) || a.username.localeCompare(b.username)
        : (a, b) => a.open - b.open || a.assignedToday - b.assignedToday || last(a).localeCompare(last(b)) || a.username.localeCompare(b.username));
      const pick = eligible[0]!;
      task.assignee = pick.username; task.status = 'reserved'; task.claimedAt = now; task.allocation = 'assigned'; task.allocatedAt = now;
      task.allocationNote = `${rule.strategy}${'name' in rule && rule.name ? ` by rule "${rule.name}"` : ''}`;
      await this.tasks().put(task);
      const u = users.get(pick.username); if (u) { u.lastAssignedAt = now; await this.users().put(u); }
      pick.open++; pick.assignedToday++;
      assigned++;
    }
    return { assigned, queued, more };
  }
  // ---- availability (a person for themselves, an admin for anyone) and giving unstarted work back
  /** Mark a person away (optionally until a time) or back. Becoming unavailable returns their not-yet-started, automatically assigned tasks to the pool
   *  so someone else gets them; work they have started, or claimed by hand, stays with them (`keepTasks` keeps everything). */
  async setAvailability(username: string, input: { available: boolean; awayUntil?: string | null; keepTasks?: boolean }, actor: string): Promise<{ available: boolean; awayUntil?: string; released: number }> {
    if (typeof input.available !== 'boolean') throw validation('available must be true or false');
    const user = (await this.users().query((u) => u.tenantId === this.ctx.tenantId && u.username === username))[0];
    if (!user) throw notFound('User account (availability is kept on workspace user accounts)');
    const now = this.ctx.clock();
    let until: string | undefined;
    if (input.awayUntil) {
      if (Number.isNaN(Date.parse(input.awayUntil))) throw validation('awayUntil must be a date and time');
      until = new Date(input.awayUntil).toISOString();
      if (until <= now) throw validation('awayUntil must be in the future');
    }
    // "away until a time" is a timed absence (the person stays marked available and the time does the rest); plain "away" stays until they switch back
    if (input.available) { user.available = true; delete user.awayUntil; }
    else if (until) { user.available = true; user.awayUntil = until; }
    else { user.available = false; delete user.awayUntil; }
    await this.users().put(user);
    const away = !isAvailable(user, now);
    const released = away && !input.keepTasks ? await this.releaseUnstarted(username, 'person is away') : 0;
    await this.ctx.audit({ actor, kind: away ? 'user.away' : 'user.available', data: { username, awayUntil: until, released } });
    return { available: !away, awayUntil: user.awayUntil, released };
  }

  /** Give back what the allocator assigned but the person has not started: it returns to the pool and is assigned again. */
  async releaseUnstarted(username: string, why: string): Promise<number> {
    const mine = await findRows<Task>(this.ctx.store, Collections.tasks, this.ctx.tenantId, { eq: { assignee: username, status: 'reserved' } });
    let n = 0;
    for (const t of mine) {
      if (t.allocation !== 'assigned') continue;                 // claimed or assigned by hand: not ours to take back
      t.assignee = undefined; t.status = 'created'; t.claimedAt = undefined; t.allocation = 'pending'; t.allocationNote = `returned to the pool: ${why}`;
      await this.tasks().put(t); n++;
    }
    if (n) kickAllocator();
    return n;
  }

  private async park(task: Task, note: string) { task.allocation = 'queued'; task.allocationNote = note; task.allocationTriedAt = this.ctx.clock(); await this.tasks().put(task); }
}
