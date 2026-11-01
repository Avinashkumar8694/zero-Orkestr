// User task — creates a Task work item and waits until it is completed (which resumes the token).
import type { NodeHandler } from '../types.ts';
import { Collections, type Task, type TaskComment, type TimerJob } from '../../../domain.ts';
import { computeDue, parseDelay, dueFrom } from '../../duration.ts';
import { DEADLINE_TYPES, parseDeadlines } from '../../deadlines.ts';
import { findRows } from '../../../store/find.ts';
import { SettingsService } from '../../../modules/settings/service.ts';

// taskVar ← $processVar (or a literal) — same "$name reads a process variable" convention as
// call/http/workItem's own input mappings (see e.g. call/handler.ts).
function mapTaskInputs(n: any, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [tv, spec] of Object.entries(n.inputs || {})) out[tv] = typeof spec === 'string' && spec.startsWith('$') ? vars[spec.slice(1)] : spec;
  return out;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean) : typeof v === 'string' ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
/** $variable or ${variable} placeholders filled from the process variables */
const resolveText = (v: unknown, vars: Record<string, unknown>): string => {
  const s = String(v ?? '');
  if (s.startsWith('$') && !s.startsWith('${')) return String(vars[s.slice(1)] ?? '');
  return s.replace(/\$\{([^}]+)\}/g, (_, name) => String(vars[name.trim()] ?? ''));
};

/** Candidates: the listed actors plus registered members of the offered groups (minus excluded owners). Both strategies are stateless queries on indexed
 *  fields — nothing is held in memory or counted in a shared variable — so they behave the same with several replicas (two tasks created at the very same
 *  moment may pick the same person; that is the price of not locking, and the next task balances it). */
async function pickOwner(c: any, n: any, task: Task): Promise<string | undefined> {
  const store = c.app.store, tenant = c.app.tenantId;
  const candidates = new Set<string>(list(n.actors));
  for (const g of new Set([task.group, ...list(n.groups)].filter((x): x is string => !!x))) {
    for (const u of await findRows<{ id: string; username: string; active?: boolean }>(store, Collections.users, tenant, { contains: { path: 'groups', value: [g] } })) if (u.active !== false) candidates.add(u.username);
  }
  for (const x of task.excludedOwners ?? []) candidates.delete(x);
  const people = [...candidates].sort();
  if (!people.length) return undefined;
  const score = async (u: string): Promise<string> => {
    if (n.assignmentStrategy === 'leastLoaded') return String((await findRows(store, Collections.tasks, tenant, { eq: { assignee: u, status: ['created', 'reserved', 'inprogress'] } })).length).padStart(8, '0');
    // roundRobin: whoever was given a task from THIS node longest ago (never = first)
    const mine = await findRows<Task>(store, Collections.tasks, tenant, { eq: { assignee: u, nodeId: n.id } });
    return mine.reduce((m, t) => (t.createdAt > m ? t.createdAt : m), '');
  };
  const scored = await Promise.all(people.map(async (u) => [u, await score(u)] as const));
  scored.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0].localeCompare(b[0])));
  return scored[0]![0];
}

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
  const task: Task = {
    id: c.app.newId(), tenantId: c.app.tenantId, instanceId: c.inst.id,
    tokenId: c.inst.tokens.find((t) => t.nodeId === n.id)!.id, nodeId: n.id,
    name: n.name || n.form || 'Task', formName: n.form, group: n.group || n.assignee,
    businessAdmin: n.businessAdmin, excludedOwners: n.excludedOwners, priority: n.priority,
    ...(list(n.actors).length ? { actors: list(n.actors) } : {}), ...(list(n.groups).length ? { groups: list(n.groups) } : {}),
    ...(list(n.businessAdminGroups).length ? { businessAdminGroups: list(n.businessAdminGroups) } : {}), ...(list(n.stakeholders).length ? { stakeholders: list(n.stakeholders) } : {}),
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
  // Assignment strategy: pick an owner among the offered actors / group members instead of leaving the task in the queue
  if (!task.assignee && (n.assignmentStrategy === 'leastLoaded' || n.assignmentStrategy === 'roundRobin')) {
    const chosen = await pickOwner(c, n, task);
    if (chosen) { task.assignee = chosen; task.status = 'reserved'; task.claimedAt = now; }
  }
  // "suspend until": the task exists but is hidden from claiming until the time (a durable job makes it available)
  const resumeAt = typeof n.suspendUntil === 'string' && n.suspendUntil.trim() ? dueFrom(n.suspendUntil, now, c.inst.variables) : null;
  if (resumeAt && resumeAt > now) task.status = 'suspended';
  await c.app.store.repo<Task>(Collections.tasks).put(task);
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
