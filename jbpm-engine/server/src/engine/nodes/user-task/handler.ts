// User task — creates a Task work item and waits until it is completed (which resumes the token).
import type { NodeHandler } from '../types.ts';
import { Collections, type Task, type TaskComment, type TimerJob } from '../../../domain.ts';
import { computeDue, parseDelay, dueFrom } from '../../duration.ts';
import { DEADLINE_TYPES, parseDeadlines } from '../../deadlines.ts';
import { findRows } from '../../../store/find.ts';
import { kickAllocator } from '../../allocator-kick.ts';
import { enabledRules, ruleCovers } from '../../../modules/allocation/service.ts';
import { SettingsService } from '../../../modules/settings/service.ts';

// taskVar ← $processVar (or a literal) — same "$name reads a process variable" convention as
// call/http/workItem's own input mappings (see e.g. call/handler.ts).
function mapTaskInputs(n: any, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [tv, spec] of Object.entries(n.inputs || {})) out[tv] = typeof spec === 'string' && spec.startsWith('$') ? vars[spec.slice(1)] : spec;
  return out;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
const lookup = (vars: Record<string, unknown>, path: string): unknown => path.split('.').reduce<any>((cur, k) => (cur == null ? undefined : cur[k]), vars);
/** $variable, ${variable} and jBPM's #{variable} placeholders (dotted paths allowed) filled from the process variables */
const resolveText = (v: unknown, vars: Record<string, unknown>): string => {
  const s = String(v ?? '');
  if (s.startsWith('$') && !s.startsWith('${')) return String(vars[s.slice(1)] ?? '');
  return s.replace(/[$#]\{([^}]+)\}/g, (_, name) => String(lookup(vars, name.trim()) ?? ''));
};
/** owner lists (actors, groups, administrators): each entry may be a placeholder; a list variable expands to all its members, a text one may hold a comma-separated list */
const resolveOwners = (v: unknown, vars: Record<string, unknown>): string[] => list(v).flatMap((x) => {
  const m = /^(?:[$#]\{([^}]+)\}|\$(\w+))$/.exec(x.trim());
  if (m) { const val = lookup(vars, (m[1] || m[2]!).trim()); if (Array.isArray(val)) return val.map((e) => String(e).trim()).filter(Boolean); }
  return resolveText(x, vars).split(',').map((e) => e.trim()).filter(Boolean);
});

export const handler: NodeHandler = async (c) => {
  const n = c.node;
  const now = c.app.clock();
  let dueAt: string | undefined = undefined;
  if (n.dueDate) {
    dueAt = computeDue(n.dueDate, now);
  } else {
    const settings = await new SettingsService(c.app).get().catch(() => null);
    if (settings?.defaultTaskSlaHours && settings.defaultTaskSlaHours > 0) {
      dueAt = new Date(Date.parse(now) + settings.defaultTaskSlaHours * 3600 * 1000).toISOString();
    }
  }
  // placeholders in owner fields (#{var}, ${var}, $var) are filled from the instance's variables, as in jBPM; several resolved groups: the first is `group`, the rest join `groups`
  const [groupOne, ...moreGroups] = resolveOwners(n.group || n.assignee, c.inst.variables);
  const actors = resolveOwners(n.actors, c.inst.variables);
  const groups = [...new Set([...moreGroups, ...resolveOwners(n.groups, c.inst.variables)])];
  const task: Task = {
    id: c.app.newId(), tenantId: c.app.tenantId, instanceId: c.inst.id,
    tokenId: c.inst.tokens.find((t) => t.nodeId === n.id)!.id, nodeId: n.id,
    name: resolveText(n.name || n.form || 'Task', c.inst.variables), formName: n.form, group: groupOne || undefined,
    businessAdmin: resolveOwners(n.businessAdmin, c.inst.variables)[0], priority: n.priority,
    ...(resolveOwners(n.excludedOwners, c.inst.variables).length ? { excludedOwners: resolveOwners(n.excludedOwners, c.inst.variables) } : {}),
    ...(actors.length ? { actors } : {}), ...(groups.length ? { groups } : {}),
    ...(resolveOwners(n.businessAdminGroups, c.inst.variables).length ? { businessAdminGroups: resolveOwners(n.businessAdminGroups, c.inst.variables) } : {}), ...(resolveOwners(n.stakeholders, c.inst.variables).length ? { stakeholders: resolveOwners(n.stakeholders, c.inst.variables) } : {}),
    ...(n.locale ? { locale: String(n.locale) } : {}), createdBy: n.createdBy ? String(n.createdBy) : (c.inst.startedBy || 'system'),
    status: 'created', inputs: { ...mapTaskInputs(n, c.inst.variables), ...(n.content ? { Content: resolveText(n.content, c.inst.variables) } : {}) }, createdAt: now,
    ...(dueAt ? { dueAt } : {}),
  };
  // Swimlane auto-claim (jBPM): the task goes to whoever completed the previous task of the same lane in this instance
  if (n.swimlane) {
    task.swimlane = String(n.swimlane);
    if (n.autoClaim === true) {
      const done = (await findRows<Task>(c.app.store, Collections.tasks, c.app.tenantId, { eq: { instanceId: c.inst.id, swimlane: task.swimlane, status: 'completed' } }))
        .filter((t) => t.completedBy).sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''))[0];
      if (done?.completedBy && !task.excludedOwners?.includes(done.completedBy)) { task.assignee = done.completedBy; task.status = 'reserved'; task.claimedAt = now; }
    }
  }
  // "suspend until": the task exists but is hidden from claiming until the time (a durable job makes it available)
  const resumeAt = typeof n.suspendUntil === 'string' && n.suspendUntil.trim() ? dueFrom(n.suspendUntil, now, c.inst.variables) : null;
  // Automatic assignment is the allocator runner's job (modules/allocation): the task is created unassigned and flagged, so creating a task never waits on, or races with,
  // another one. Anything already assigned (a name, a #{variable}, a swimlane auto-claim) is left alone.
  if (resumeAt && resumeAt > now) task.status = 'suspended';
  task.workflowId = c.inst.workflowId;
  const strategy = n.assignmentStrategy === 'leastLoaded' || n.assignmentStrategy === 'roundRobin' ? n.assignmentStrategy : undefined;
  const skills = resolveOwners(n.requiredSkills, c.inst.variables);
  if (strategy) task.allocationStrategy = strategy;
  if (skills.length) task.requiredSkills = skills;
  const offered = !task.assignee && !!(task.actors?.length || task.group || task.groups?.length);
  if (offered && (strategy || skills.length || (await enabledRules(c.app)).some((r) => ruleCovers(r, task)))) task.allocation = 'pending';
  await c.app.store.repo<Task>(Collections.tasks).put(task);
  if (task.allocation === 'pending') kickAllocator();
  if (task.status === 'suspended' && resumeAt) {
    await c.app.store.repo<TimerJob>(Collections.timers).put({ id: c.app.newId(), tenantId: c.app.tenantId, instanceId: c.inst.id, tokenId: task.tokenId, nodeId: n.id, kind: 'deadline', dueAt: resumeAt, fired: 0, status: 'scheduled', taskId: task.id, deadline: { type: 'resumeTask', action: {} } });
  }
  if (typeof n.comment === 'string' && n.comment.trim()) {
    await c.app.store.repo<TaskComment>(Collections.comments).put({ id: c.app.newId(), tenantId: c.app.tenantId, taskId: task.id, author: task.createdBy || 'system', body: resolveText(n.comment, c.inst.variables).trim(), at: now });
  }
  // jBPM deadlines: one job per (component, expiry); the worker acts only if the task is still in the watched state
  for (const type of DEADLINE_TYPES) {
    const { deadlines } = parseDeadlines(n[type], type);     // an unreadable text never blocks the task (validation flags it at publish)
    for (const d of deadlines) for (const expiry of d.expiries) {
      const dueAt = new Date(Date.parse(now) + parseDelay(expiry)).toISOString();
      await c.app.store.repo<TimerJob>(Collections.timers).put({ id: c.app.newId(), tenantId: c.app.tenantId, instanceId: c.inst.id, tokenId: task.tokenId, nodeId: n.id, kind: 'deadline', dueAt, fired: 0, status: 'scheduled', taskId: task.id, deadline: { type, action: d.action } });
    }
  }
  c.emit({ kind: 'task.created', instanceId: c.inst.id, taskId: task.id });
  return { wait: { kind: 'task', ref: task.id } };
};
