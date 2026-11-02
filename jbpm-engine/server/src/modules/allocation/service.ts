// Automatic task assignment. A user task is created UNASSIGNED and flagged `allocation: 'pending'`; the allocator runner (a loop of its own, see index.ts,
// role 'allocator' or 'all') picks the person here. One allocator works a workspace at a time (a lease), so there is no race between replicas and the
// decision can use fresh per-person counts: open tasks, tasks given today, skills, limits, availability. Nobody qualifies = the task stays in its group queue
// ('queued') and is looked at again on the next pass. A task assigned by hand, by name or by `#{variable}` is never touched.
import type { AppContext } from '../../context.ts';
import { Collections, type AssignmentRule, type Task, type User } from '../../domain.ts';
import { findRows } from '../../store/find.ts';
import { notFound, validation } from '../../infra/errors.ts';

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
const offeredGroups = (t: Task) => [...new Set([t.group, ...(t.groups ?? [])].filter((g): g is string => !!g))];
export function ruleCovers(r: AssignmentRule, t: Pick<Task, 'workflowId' | 'nodeId' | 'group' | 'groups'>): boolean {
  return (!r.scope.workflowId || r.scope.workflowId === t.workflowId) && (!r.scope.nodeId || r.scope.nodeId === t.nodeId) && (!r.scope.group || offeredGroups(t as Task).includes(r.scope.group));
}

export interface RuleInput { name?: string; enabled?: boolean; priority?: number; scope?: AssignmentRule['scope']; strategy?: string; requiredSkills?: string[]; pool?: AssignmentRule['pool']; respectLimits?: boolean }
export interface PersonLoad { username: string; skills: string[]; available: boolean; maxOpenTasks?: number; maxTasksPerDay?: number; open: number; inProgress: number; assignedToday: number; completedToday: number }

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

  // ---- per-person load
  private async load(user: User, now: string): Promise<PersonLoad> {
    const t = this.ctx.tenantId, store = this.ctx.store, day = startOfDay(now);
    const mine = await findRows<Task>(store, Collections.tasks, t, { eq: { assignee: user.username, status: OPEN } });
    const today = await findRows<Task>(store, Collections.tasks, t, { eq: { assignee: user.username }, gte: { claimedAt: day } });
    const done = await findRows<Task>(store, Collections.tasks, t, { eq: { assignee: user.username, status: 'completed' }, gte: { completedAt: day } });
    return { username: user.username, skills: user.skills ?? [], available: user.available !== false, maxOpenTasks: user.maxOpenTasks, maxTasksPerDay: user.maxTasksPerDay,
      open: mine.length, inProgress: mine.filter((x) => x.status === 'inprogress').length, assignedToday: today.length, completedToday: done.length };
  }

  /** the tracker: who has what right now, and how many tasks are waiting for a person */
  async tracker(): Promise<{ people: PersonLoad[]; waiting: { pending: number; queued: number }; rules: number }> {
    const now = this.ctx.clock(), t = this.ctx.tenantId;
    const users = (await this.users().query((u) => u.tenantId === t && u.active)).sort((a, b) => a.username.localeCompare(b.username));
    const people = await Promise.all(users.map((u) => this.load(u, now)));
    const unassigned = async (state: string) => (await findRows<Task>(this.ctx.store, Collections.tasks, t, { eq: { allocation: state } })).filter((x) => !x.assignee && x.status !== 'completed').length;
    const waiting = { pending: await unassigned('pending'), queued: await unassigned('queued') };
    return { people, waiting, rules: (await this.listRules()).filter((r) => r.enabled).length };
  }

  // ---- the allocator
  /** One pass: give each waiting task to a person. Safe to call from one process at a time per workspace (the runner holds a lease). */
  async runOnce(limit = 200): Promise<{ assigned: number; queued: number }> {
    const t = this.ctx.tenantId, now = this.ctx.clock();
    const waiting = (await findRows<Task>(this.ctx.store, Collections.tasks, t, { eq: { allocation: ['pending', 'queued'] }, orderBy: 'createdAt', limit }))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt.localeCompare(b.createdAt));
    if (!waiting.length) return { assigned: 0, queued: 0 };
    const rules = await enabledRules(this.ctx);
    const users = new Map((await this.users().query((u) => u.tenantId === t && u.active)).map((u) => [u.username, u] as const));
    const byGroup = new Map<string, string[]>();
    for (const u of users.values()) for (const g of u.groups ?? []) (byGroup.get(g) ?? byGroup.set(g, []).get(g)!).push(u.username);
    const loads = new Map<string, PersonLoad>();                                   // fresh per pass, and updated as this pass assigns, so one pass spreads work evenly
    const loadOf = async (name: string) => loads.get(name) ?? loads.set(name, await this.load(users.get(name)!, now)).get(name)!;
    let assigned = 0, queued = 0;
    for (const w of waiting) {
      const task = await this.tasks().get(w.id);                                    // re-read: it may have been claimed or reassigned by hand since
      // a suspended task ("suspend until") is hidden from everyone: it stays flagged and is assigned once it resumes
      if (!task || task.assignee || (task.allocation !== 'pending' && task.allocation !== 'queued') || ['completed', 'cancelled', 'skipped', 'failed', 'suspended'].includes(task.status)) continue;
      const rule = (() => {
        if (task.allocationStrategy || task.requiredSkills?.length) return { strategy: (task.requiredSkills?.length ? 'skills' : task.allocationStrategy) as AssignmentRule['strategy'], requiredSkills: task.requiredSkills, respectLimits: true, pool: undefined as AssignmentRule['pool'] };
        return rules.find((r) => ruleCovers(r, task));
      })();
      if (!rule) { if (task.allocation !== 'queued') { task.allocation = 'queued'; task.allocationNote = 'no assignment rule applies: left in the group queue'; await this.tasks().put(task); queued++; } continue; }
      // who is offered the task: the rule's pool, else the people / group members the task itself names
      const names = new Set<string>(rule.pool ? [...list(rule.pool.users), ...list(rule.pool.groups).flatMap((g) => byGroup.get(g) ?? [])] : [...(task.actors ?? []), ...offeredGroups(task).flatMap((g) => byGroup.get(g) ?? [])]);
      for (const x of task.excludedOwners ?? []) names.delete(x);
      if (!names.size) { await this.park(task, 'nobody is offered this task'); queued++; continue; }
      const need = list(rule.requiredSkills);
      const eligible: PersonLoad[] = []; const why = new Set<string>();
      for (const name of [...names].sort()) {
        const user = users.get(name);
        if (!user) { if (!need.length) eligible.push({ username: name, skills: [], available: true, open: 0, inProgress: 0, assignedToday: 0, completedToday: 0 }); else why.add('no one with the required skills'); continue; }
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
    return { assigned, queued };
  }
  private async park(task: Task, note: string) { if (task.allocation !== 'queued' || task.allocationNote !== note) { task.allocation = 'queued'; task.allocationNote = note; await this.tasks().put(task); } }
}
