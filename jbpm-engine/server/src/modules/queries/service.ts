// Query / task-admin / analytics module — read-only aggregates mirroring the jBPM KIE-Server query &
// dashboard APIs (see docs/17): process-definition catalog + live stats, per-user / per-group task
// inboxes, tasks completed by a user, related tasks, referenced signals, and TAT (turn-around-time)
// analytics for tasks and process instances. Everything is tenant-scoped and derived from the store.
import type { AppContext } from '../../context.ts';
import { Collections, type Instance, type Task, type Deployment, type TimerJob, type AuditEvent, type Workflow } from '../../domain.ts';

type DurStats = { count: number; avgMs: number; minMs: number; maxMs: number };
export type AdvancedDurStats = DurStats & { p50Ms: number; p95Ms: number };
const durationMs = (from?: string, to?: string) => (from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : undefined);
function stats(values: number[]): DurStats {
  if (!values.length) return { count: 0, avgMs: 0, minMs: 0, maxMs: 0 };
  const sum = values.reduce((a, b) => a + b, 0);
  return { count: values.length, avgMs: Math.round(sum / values.length), minMs: Math.min(...values), maxMs: Math.max(...values) };
}

function advancedStats(values: number[]): AdvancedDurStats {
  if (!values.length) return { count: 0, avgMs: 0, minMs: 0, maxMs: 0, p50Ms: 0, p95Ms: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p50 = sorted[Math.floor(sorted.length * 0.50)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return {
    count: sorted.length,
    avgMs: Math.round(sum / sorted.length),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    p50Ms: p50,
    p95Ms: p95,
  };
}

function parseBound(val?: string, endOfDay = false): string | undefined {
  if (!val) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    return endOfDay ? `${val}T23:59:59.999Z` : `${val}T00:00:00.000Z`;
  }
  return val;
}

export class QueryService {
  constructor(private ctx: AppContext) {}
  private I() { return this.ctx.store.repo<Instance>(Collections.instances); }
  private T() { return this.ctx.store.repo<Task>(Collections.tasks); }
  private D() { return this.ctx.store.repo<Deployment>(Collections.deployments); }
  private J() { return this.ctx.store.repo<TimerJob>(Collections.timers); }
  private A() { return this.ctx.store.repo<AuditEvent>(Collections.audit); }
  private W() { return this.ctx.store.repo<Workflow>(Collections.workflows); }
  private isAll() { return this.ctx.tenantId === 'all' || this.ctx.tenantId === '*'; }
  private mine<T extends { tenantId: string }>(xs: T[]) { return this.isAll() ? xs : xs.filter((x) => x.tenantId === this.ctx.tenantId); }
  private allInstances() { return this.isAll() ? this.I().query(() => true) : this.I().query((i) => i.tenantId === this.ctx.tenantId); }
  private allTasks() { return this.isAll() ? this.T().query(() => true) : this.T().query((t) => t.tenantId === this.ctx.tenantId); }

  // ---- process definitions (across active deployments) ----
  /** Every process definition currently deployed & active, with live instance stats (jBPM def catalog). */
  async processDefinitions() {
    const active = await this.D().query((d) => (this.isAll() || d.tenantId === this.ctx.tenantId) && d.status === 'active');
    const instances = await this.allInstances();
    const defs: any[] = [];
    for (const dep of active) {
      for (const p of dep.engine?.processes || []) {
        const insts = instances.filter((i) => i.processId === p.id && i.deploymentId === dep.id);
        defs.push({
          processId: p.id, name: (p as any).name || p.id, package: (p as any).package,
          deploymentId: dep.id, workflowId: dep.workflowId, environment: dep.environment,
          version: dep.versionLabel || (dep.versionNumber != null ? `v${dep.versionNumber}` : undefined),
          nodes: (p.nodes || []).length,
          instances: { total: insts.length, active: insts.filter((i) => i.status === 'running' || i.status === 'waiting').length },
        });
      }
    }
    return defs;
  }

  private async resolveProcess(processId: string) {
    const active = await this.D().query((d) => d.tenantId === this.ctx.tenantId && d.status === 'active');
    for (const dep of active) {
      const p = (dep.engine?.processes || []).find((x) => x.id === processId);
      if (p) return { dep, p };
    }
    return undefined;
  }

  /** Instances of a given process definition (across its active deployment). */
  async processInstances(processId: string, status?: string) {
    const insts = await this.allInstances();
    return insts.filter((i) => i.processId === processId && (!status || i.status === status))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Signals/messages a process references — what it listens for (start/catch/boundary) and throws. */
  async processSignals(processId: string) {
    const found = await this.resolveProcess(processId);
    if (!found) return { processId, listensFor: [], throws: [] };
    const listens = new Set<string>(); const throws = new Set<string>();
    for (const n of found.p.nodes || []) {
      const a = n as any; const ev = a.event || {};
      const name = ev.signal || ev.message || a.on?.signal || a.on?.message;
      if (!name) continue;
      if (n.type === 'throw' || n.type === 'send' || (n.type === 'end' && a.throw)) throws.add(name);
      else listens.add(name);   // start / catch / boundary / receive
    }
    return { processId, listensFor: [...listens], throws: [...throws] };
  }

  // ---- users / task inboxes ----
  /** Derived user directory: initiators, task assignees/completers and audit actors, with work counts. */
  async users() {
    const [instances, tasks, audit] = [await this.allInstances(), await this.allTasks(), this.mine(await this.A().query(() => true))];
    const map = new Map<string, { user: string; groups: Set<string>; startedInstances: number; openTasks: number; completedTasks: number }>();
    const rec = (name?: string) => {
      if (!name) return undefined;
      if (!map.has(name)) map.set(name, { user: name, groups: new Set(), startedInstances: 0, openTasks: 0, completedTasks: 0 });
      return map.get(name)!;
    };
    for (const i of instances) { const e = rec(i.startedBy); if (e) e.startedInstances++; }
    for (const t of tasks) {
      const owner = rec(t.assignee);
      if (owner) { if (t.status === 'completed') owner.completedTasks++; else owner.openTasks++; if (t.group) owner.groups.add(t.group); }
      if (t.status === 'completed' && t.completedBy && t.completedBy !== t.assignee) { const c = rec(t.completedBy); if (c) c.completedTasks++; }
    }
    for (const a of audit) rec(a.actor);
    return [...map.values()].map((e) => ({ ...e, groups: [...e.groups] })).sort((a, b) => a.user.localeCompare(b.user));
  }

  /** Tasks owned by a user (their inbox). */
  async tasksForUser(user: string, status?: string) {
    const tasks = await this.allTasks();
    return tasks.filter((t) => t.assignee === user && (!status || t.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** Tasks a user has completed. */
  async tasksCompletedByUser(user: string) {
    const tasks = await this.allTasks();
    return tasks.filter((t) => t.status === 'completed' && t.completedBy === user)
      .sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || ''));
  }
  /** Tasks for a group (the queue / potential-owner list). */
  async tasksForGroup(group: string, status?: string) {
    const tasks = await this.allTasks();
    return tasks.filter((t) => t.group === group && (!status || t.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  /** Tasks belonging to a process instance. */
  async instanceTasks(instanceId: string) {
    const tasks = await this.allTasks();
    return tasks.filter((t) => t.instanceId === instanceId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ---- analytics / TAT ----
  /** Task turn-around-time grouped by task name, plus a per-assignee completed breakdown and SLA stats. */
  async taskAnalytics(opts?: { since?: string; from?: string; to?: string; processId?: string; workflowId?: string }) {
    let tasks = await this.allTasks();
    const fromBound = parseBound(opts?.from || opts?.since, false);
    const toBound = parseBound(opts?.to, true);
    if (fromBound) tasks = tasks.filter((t) => t.createdAt >= fromBound);
    if (toBound) tasks = tasks.filter((t) => t.createdAt <= toBound);
    if (opts?.processId || opts?.workflowId) {
      const insts = await this.allInstances();
      const pInstIds = new Set(insts.filter((i) => {
        if (opts.processId && i.processId !== opts.processId && i.workflowId !== opts.processId) return false;
        if (opts.workflowId && i.workflowId !== opts.workflowId) return false;
        return true;
      }).map((i) => i.id));
      tasks = tasks.filter((t) => pInstIds.has(t.instanceId));
    }
    const byName = new Map<string, number[]>();
    const byAssignee = new Map<string, number[]>();
    const groupMap = new Map<string, number>();

    let totalWithDue = 0;
    let onTime = 0;
    let overdue = 0;
    const now = Date.now();

    for (const t of tasks) {
      if (t.status !== 'completed' && t.group) {
        groupMap.set(t.group, (groupMap.get(t.group) || 0) + 1);
      }
      if (t.dueAt) {
        totalWithDue++;
        const dueTime = Date.parse(t.dueAt);
        if (t.status === 'completed') {
          const compTime = t.completedAt ? Date.parse(t.completedAt) : now;
          if (compTime <= dueTime) onTime++;
          else overdue++;
        } else {
          if (now > dueTime) overdue++;
          else onTime++;
        }
      }

      const ms = durationMs(t.createdAt, t.completedAt);
      if (ms == null || t.status !== 'completed') continue;
      (byName.get(t.name) || byName.set(t.name, []).get(t.name)!).push(ms);
      const who = t.completedBy || t.assignee;
      if (who) (byAssignee.get(who) || byAssignee.set(who, []).get(who)!).push(ms);
    }

    const complianceRate = totalWithDue > 0 ? Math.round((onTime / totalWithDue) * 100) : 100;

    return {
      byTask: [...byName].map(([name, v]) => ({ name, ...stats(v) })),
      byAssignee: [...byAssignee].map(([user, v]) => ({ user, ...stats(v) })),
      openByStatus: this.countBy(tasks, (t) => t.status),
      sla: { totalWithDue, onTime, overdue, complianceRate },
      byGroup: [...groupMap].map(([group, count]) => ({ group, count })),
    };
  }
  /** Process-instance turn-around-time grouped by process definition, plus a status mix, daily throughput and failure rate. */
  async processAnalytics(opts?: { since?: string; from?: string; to?: string; processId?: string; workflowId?: string; days?: number }) {
    let instances = await this.allInstances();
    const fromBound = parseBound(opts?.from || opts?.since, false);
    const toBound = parseBound(opts?.to, true);
    if (fromBound) instances = instances.filter((i) => i.startedAt >= fromBound);
    if (toBound) instances = instances.filter((i) => i.startedAt <= toBound);
    if (opts?.processId) instances = instances.filter((i) => i.processId === opts.processId || i.workflowId === opts.processId);
    if (opts?.workflowId) instances = instances.filter((i) => i.workflowId === opts.workflowId);

    const byProc = new Map<string, number[]>();
    let failedCount = 0;
    for (const i of instances) {
      if (i.status === 'failed') failedCount++;
      const ms = durationMs(i.startedAt, i.endedAt);
      if (ms == null) continue;
      const key = i.processId || i.workflowId;
      (byProc.get(key) || byProc.set(key, []).get(key)!).push(ms);
    }

    // Daily throughput: generate buckets based on explicit from/to dates or past N days
    const dailyMap = new Map<string, { started: number; completed: number; failed: number }>();
    let startDate: Date;
    let endDate: Date;
    const now = new Date();

    if (fromBound && toBound) {
      startDate = new Date(fromBound);
      endDate = new Date(toBound);
    } else if (fromBound) {
      startDate = new Date(fromBound);
      endDate = now;
    } else if (toBound) {
      endDate = new Date(toBound);
      startDate = new Date(endDate.getTime() - 13 * 86400000);
    } else {
      const numDays = opts?.days ? Math.min(Math.max(Number(opts.days), 3), 90) : 14;
      endDate = now;
      startDate = new Date(now.getTime() - (numDays - 1) * 86400000);
    }

    if (Number.isNaN(startDate.getTime())) startDate = new Date(now.getTime() - 13 * 86400000);
    if (Number.isNaN(endDate.getTime()) || endDate < startDate) endDate = now;

    const startStr = startDate.toISOString().slice(0, 10);
    const endStr = endDate.toISOString().slice(0, 10);
    const cursor = new Date(`${startStr}T00:00:00.000Z`);
    while (true) {
      const key = cursor.toISOString().slice(0, 10);
      dailyMap.set(key, { started: 0, completed: 0, failed: 0 });
      if (key >= endStr || dailyMap.size >= 90) break;
      cursor.setDate(cursor.getDate() + 1);
    }

    for (const i of instances) {
      const startKey = i.startedAt?.slice(0, 10);
      if (startKey && dailyMap.has(startKey)) {
        dailyMap.get(startKey)!.started++;
      }
      const endKey = i.endedAt?.slice(0, 10) || startKey;
      if (endKey && dailyMap.has(endKey)) {
        if (i.status === 'completed') dailyMap.get(endKey)!.completed++;
        else if (i.status === 'failed') dailyMap.get(endKey)!.failed++;
      }
    }

    const dailyThroughput = [...dailyMap].map(([date, counts]) => ({ date, ...counts }));
    const total = instances.length;
    const failureRate = total > 0 ? Number(((failedCount / total) * 100).toFixed(1)) : 0;

    return {
      byProcess: [...byProc].map(([processId, v]) => ({ processId, ...stats(v) })),
      byStatus: this.countBy(instances, (i) => i.status),
      dailyThroughput,
      failureRate,
      total,
    };
  }
  /** Dashboard counts across instances, tasks, deployments and jobs. */
  async summary(opts?: { since?: string; from?: string; to?: string; processId?: string; workflowId?: string }) {
    const isAll = this.isAll();
    let instances = await this.allInstances();
    let tasks = await this.allTasks();
    const fromBound = parseBound(opts?.from || opts?.since, false);
    const toBound = parseBound(opts?.to, true);
    if (fromBound) {
      instances = instances.filter((i) => i.startedAt >= fromBound);
      tasks = tasks.filter((t) => t.createdAt >= fromBound);
    }
    if (toBound) {
      instances = instances.filter((i) => i.startedAt <= toBound);
      tasks = tasks.filter((t) => t.createdAt <= toBound);
    }
    if (opts?.processId || opts?.workflowId) {
      instances = instances.filter((i) => {
        if (opts.processId && i.processId !== opts.processId && i.workflowId !== opts.processId) return false;
        if (opts.workflowId && i.workflowId !== opts.workflowId) return false;
        return true;
      });
      const instIds = new Set(instances.map((i) => i.id));
      tasks = tasks.filter((t) => instIds.has(t.instanceId));
    }
    const deployments = await this.D().query((d) => isAll || d.tenantId === this.ctx.tenantId);
    const jobs = await this.J().query((j) => isAll || j.tenantId === this.ctx.tenantId);
    return {
      instances: { total: instances.length, byStatus: this.countBy(instances, (i) => i.status) },
      tasks: { total: tasks.length, byStatus: this.countBy(tasks, (t) => t.status) },
      deployments: { total: deployments.length, active: deployments.filter((d) => d.status === 'active').length },
      jobs: { scheduled: jobs.filter((j) => j.status === 'scheduled').length, fired: jobs.filter((j) => j.status === 'fired').length },
    };
  }
  /** Scheduled/fired timer jobs (jBPM "jobs" admin list). */
  async jobs(status?: string) {
    return (await this.J().query((j) => (this.isAll() || j.tenantId === this.ctx.tenantId) && (!status || j.status === status)))
      .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  }

  /** SLA breach and overdue analytics across open tasks and process instances. */
  async slaViolations(opts?: { workflowId?: string }) {
    const now = this.ctx.clock();
    let tasks = await this.allTasks();
    if (opts?.workflowId) {
      const insts = await this.allInstances();
      const pInstIds = new Set(insts.filter((i) => i.workflowId === opts.workflowId).map((i) => i.id));
      tasks = tasks.filter((t) => pInstIds.has(t.instanceId));
    }
    const openTasks = tasks.filter((t) => t.status !== 'completed' && t.status !== 'skipped' && t.status !== 'error' && t.status !== 'failed' && t.status !== 'exited');
    const overdueTasks: Task[] = [];
    const atRiskTasks: Task[] = [];
    const nowMs = Date.parse(now);
    const dayMs = 24 * 60 * 60 * 1000;

    for (const t of openTasks) {
      if (!t.dueAt) continue;
      const dueMs = Date.parse(t.dueAt);
      if (dueMs < nowMs) overdueTasks.push(t);
      else if (dueMs - nowMs <= dayMs) atRiskTasks.push(t);
    }

    const byGroup = new Map<string, number>();
    for (const t of overdueTasks) {
      const g = t.group || 'unassigned';
      byGroup.set(g, (byGroup.get(g) || 0) + 1);
    }

    const byPriority = new Map<string, number>();
    for (const t of overdueTasks) {
      const p = String(t.priority ?? 0);
      byPriority.set(p, (byPriority.get(p) || 0) + 1);
    }

    return {
      totalOpenTasks: openTasks.length,
      overdueCount: overdueTasks.length,
      atRiskCount: atRiskTasks.length,
      overdueTasks: overdueTasks.map((t) => ({ id: t.id, name: t.name, instanceId: t.instanceId, assignee: t.assignee, group: t.group, dueAt: t.dueAt, priority: t.priority })),
      atRiskTasks: atRiskTasks.map((t) => ({ id: t.id, name: t.name, instanceId: t.instanceId, assignee: t.assignee, group: t.group, dueAt: t.dueAt, priority: t.priority })),
      overdueByGroup: Object.fromEntries(byGroup),
      overdueByPriority: Object.fromEntries(byPriority),
    };
  }

  /** Workload distribution across users and examiner groups. */
  async workload(opts?: { workflowId?: string }) {
    let tasks = await this.allTasks();
    if (opts?.workflowId) {
      const insts = await this.allInstances();
      const pInstIds = new Set(insts.filter((i) => i.workflowId === opts.workflowId).map((i) => i.id));
      tasks = tasks.filter((t) => pInstIds.has(t.instanceId));
    }
    const openTasks = tasks.filter((t) => t.status !== 'completed' && t.status !== 'skipped' && t.status !== 'error' && t.status !== 'failed' && t.status !== 'exited');
    const userMap = new Map<string, { user: string; openTasks: number; inProgress: number; reserved: number }>();
    const groupMap = new Map<string, { group: string; openTasks: number; unassigned: number }>();

    for (const t of openTasks) {
      if (t.assignee) {
        if (!userMap.has(t.assignee)) userMap.set(t.assignee, { user: t.assignee, openTasks: 0, inProgress: 0, reserved: 0 });
        const u = userMap.get(t.assignee)!;
        u.openTasks++;
        if (t.status === 'inprogress') u.inProgress++;
        if (t.status === 'reserved') u.reserved++;
      }
      const g = t.group || 'unassigned';
      if (!groupMap.has(g)) groupMap.set(g, { group: g, openTasks: 0, unassigned: 0 });
      const grp = groupMap.get(g)!;
      grp.openTasks++;
      if (!t.assignee) grp.unassigned++;
    }

    return {
      totalOpen: openTasks.length,
      users: [...userMap.values()].sort((a, b) => b.openTasks - a.openTasks),
      groups: [...groupMap.values()].sort((a, b) => b.openTasks - a.openTasks),
    };
  }

  /** Project-level rollup analytics: completed tasks, instances, and TAT for a single project or across all projects in the tenant. */
  async projectAnalytics(opts?: { workflowId?: string; from?: string; to?: string; since?: string }) {
    let instances = await this.allInstances();
    let tasks = await this.allTasks();
    const fromBound = parseBound(opts?.from || opts?.since, false);
    const toBound = parseBound(opts?.to, true);
    if (fromBound) {
      instances = instances.filter((i) => i.startedAt >= fromBound);
      tasks = tasks.filter((t) => t.createdAt >= fromBound);
    }
    if (toBound) {
      instances = instances.filter((i) => i.startedAt <= toBound);
      tasks = tasks.filter((t) => t.createdAt <= toBound);
    }

    const workflows = await this.W().query((w) => w.tenantId === this.ctx.tenantId);
    const wfNameMap = new Map<string, string>();
    for (const w of workflows) {
      wfNameMap.set(w.id, w.name || w.key);
      wfNameMap.set(w.key, w.name || w.key);
    }

    const projectKeys = new Set<string>();
    for (const i of instances) {
      if (i.workflowId) projectKeys.add(i.workflowId);
    }
    for (const w of workflows) {
      projectKeys.add(w.id);
    }

    if (opts?.workflowId) {
      instances = instances.filter((i) => i.workflowId === opts.workflowId);
      const instIds = new Set(instances.map((i) => i.id));
      tasks = tasks.filter((t) => instIds.has(t.instanceId));
      projectKeys.clear();
      projectKeys.add(opts.workflowId);
    }

    const now = Date.now();
    const byProject: any[] = [];

    for (const pKey of projectKeys) {
      const pInsts = instances.filter((i) => i.workflowId === pKey);
      const pInstIds = new Set(pInsts.map((i) => i.id));
      const pTasks = tasks.filter((t) => pInstIds.has(t.instanceId));

      const instDurations: number[] = [];
      let completedInsts = 0;
      let failedInsts = 0;
      let activeInsts = 0;

      for (const i of pInsts) {
        if (i.status === 'completed') {
          completedInsts++;
          const d = durationMs(i.startedAt, i.endedAt);
          if (d != null) instDurations.push(d);
        } else if (i.status === 'failed') {
          failedInsts++;
        } else if (i.status === 'running' || i.status === 'waiting') {
          activeInsts++;
        }
      }

      const taskDurations: number[] = [];
      let completedTasks = 0;
      let inProgressTasks = 0;
      let reservedTasks = 0;
      let overdueTasks = 0;
      let totalWithDue = 0;
      let onTimeTasks = 0;

      for (const t of pTasks) {
        if (t.status === 'completed') {
          completedTasks++;
          const d = durationMs(t.createdAt, t.completedAt);
          if (d != null) taskDurations.push(d);
        } else if (t.status === 'inprogress') {
          inProgressTasks++;
        } else if (t.status === 'reserved' || t.status === 'created') {
          reservedTasks++;
        }

        if (t.dueAt) {
          totalWithDue++;
          const dueTime = Date.parse(t.dueAt);
          if (t.status === 'completed') {
            const compTime = t.completedAt ? Date.parse(t.completedAt) : now;
            if (compTime <= dueTime) onTimeTasks++;
            else overdueTasks++;
          } else {
            if (now > dueTime) overdueTasks++;
            else onTimeTasks++;
          }
        }
      }

      const openTasks = inProgressTasks + reservedTasks;
      const successRate = pInsts.length > 0 ? Math.round((completedInsts / pInsts.length) * 100) : 100;
      const complianceRate = totalWithDue > 0 ? Math.round((onTimeTasks / totalWithDue) * 100) : 100;

      byProject.push({
        workflowId: pKey,
        name: wfNameMap.get(pKey) || pKey,
        instances: {
          total: pInsts.length,
          active: activeInsts,
          completed: completedInsts,
          failed: failedInsts,
          successRate,
        },
        tasks: {
          total: pTasks.length,
          completed: completedTasks,
          open: openTasks,
          inProgress: inProgressTasks,
          reserved: reservedTasks,
          overdue: overdueTasks,
        },
        instanceTat: stats(instDurations),
        taskTat: stats(taskDurations),
        sla: { totalWithDue, onTime: onTimeTasks, overdue: overdueTasks, complianceRate },
      });
    }

    const allInstDurations = instances.filter((i) => i.status === 'completed').map((i) => durationMs(i.startedAt, i.endedAt)).filter((d): d is number => d != null);
    const allTaskDurations = tasks.filter((t) => t.status === 'completed').map((t) => durationMs(t.createdAt, t.completedAt)).filter((d): d is number => d != null);
    const totalCompletedTasks = tasks.filter((t) => t.status === 'completed').length;
    const totalOpenTasks = tasks.filter((t) => t.status === 'inprogress' || t.status === 'reserved' || t.status === 'created').length;
    let totalDue = 0;
    let totalOnTime = 0;
    let totalOverdue = 0;
    for (const t of tasks) {
      if (t.dueAt) {
        totalDue++;
        const dueTime = Date.parse(t.dueAt);
        if (t.status === 'completed') {
          const compTime = t.completedAt ? Date.parse(t.completedAt) : now;
          if (compTime <= dueTime) totalOnTime++;
          else totalOverdue++;
        } else {
          if (now > dueTime) totalOverdue++;
          else totalOnTime++;
        }
      }
    }

    return {
      summary: {
        totalProjects: projectKeys.size,
        totalInstances: instances.length,
        activeInstances: instances.filter((i) => i.status === 'running' || i.status === 'waiting').length,
        completedInstances: instances.filter((i) => i.status === 'completed').length,
        failedInstances: instances.filter((i) => i.status === 'failed').length,
        totalTasks: tasks.length,
        completedTasks: totalCompletedTasks,
        openTasks: totalOpenTasks,
        overdueTasks: totalOverdue,
        instanceTat: stats(allInstDurations),
        taskTat: stats(allTaskDurations),
        sla: { totalWithDue: totalDue, onTime: totalOnTime, overdue: totalOverdue, complianceRate: totalDue > 0 ? Math.round((totalOnTime / totalDue) * 100) : 100 },
      },
      byProject: byProject.sort((a, b) => b.instances.total - a.instances.total),
    };
  }

  /** Per-user productivity and TAT analytics across tasks, with per-task-definition breakdown. */
  async userAnalytics(opts?: { user?: string; workflowId?: string; group?: string; from?: string; to?: string; since?: string }) {
    let tasks = await this.allTasks();
    const fromBound = parseBound(opts?.from || opts?.since, false);
    const toBound = parseBound(opts?.to, true);
    if (fromBound) tasks = tasks.filter((t) => t.createdAt >= fromBound);
    if (toBound) tasks = tasks.filter((t) => t.createdAt <= toBound);
    if (opts?.group) tasks = tasks.filter((t) => t.group === opts.group);

    if (opts?.workflowId) {
      const insts = await this.allInstances();
      const pInstIds = new Set(insts.filter((i) => i.workflowId === opts.workflowId).map((i) => i.id));
      tasks = tasks.filter((t) => pInstIds.has(t.instanceId));
    }

    const now = Date.now();
    const userTaskMap = new Map<string, Task[]>();

    for (const t of tasks) {
      const u = t.completedBy || t.assignee;
      if (!u) continue;
      if (opts?.user && u !== opts.user) continue;
      (userTaskMap.get(u) || userTaskMap.set(u, []).get(u)!).push(t);
    }

    if (opts?.user && !userTaskMap.has(opts.user)) {
      userTaskMap.set(opts.user, []);
    }

    const result = [...userTaskMap].map(([user, uTasks]) => {
      const completed = uTasks.filter((t) => t.status === 'completed');
      const active = uTasks.filter((t) => t.status === 'inprogress' || t.status === 'reserved');
      const durations = completed.map((t) => durationMs(t.createdAt, t.completedAt)).filter((d): d is number => d != null);

      let totalWithDue = 0;
      let onTime = 0;
      let overdue = 0;
      for (const t of uTasks) {
        if (t.dueAt) {
          totalWithDue++;
          const dueTime = Date.parse(t.dueAt);
          if (t.status === 'completed') {
            const compTime = t.completedAt ? Date.parse(t.completedAt) : now;
            if (compTime <= dueTime) onTime++;
            else overdue++;
          } else {
            if (now > dueTime) overdue++;
            else onTime++;
          }
        }
      }

      const byTaskMap = new Map<string, number[]>();
      for (const t of completed) {
        const d = durationMs(t.createdAt, t.completedAt);
        if (d != null) {
          (byTaskMap.get(t.name) || byTaskMap.set(t.name, []).get(t.name)!).push(d);
        }
      }

      return {
        user,
        tasksCompleted: completed.length,
        tasksActive: active.length,
        tasksTotal: uTasks.length,
        byStatus: this.countBy(uTasks, (t) => t.status),
        tat: advancedStats(durations),
        sla: { totalWithDue, onTime, overdue, complianceRate: totalWithDue > 0 ? Math.round((onTime / totalWithDue) * 100) : 100 },
        byTaskName: [...byTaskMap].map(([taskName, durs]) => ({ taskName, ...stats(durs) })),
      };
    }).sort((a, b) => b.tasksCompleted - a.tasksCompleted);

    return opts?.user ? (result[0] || { user: opts.user, tasksCompleted: 0, tasksActive: 0, tasksTotal: 0, byStatus: {}, tat: advancedStats([]), sla: { totalWithDue: 0, onTime: 0, overdue: 0, complianceRate: 100 }, byTaskName: [] }) : result;
  }

  /** Per-group / queue backlog, completion, and TAT analytics. */
  async groupAnalytics(opts?: { group?: string; workflowId?: string; from?: string; to?: string; since?: string }) {
    let tasks = await this.allTasks();
    const fromBound = parseBound(opts?.from || opts?.since, false);
    const toBound = parseBound(opts?.to, true);
    if (fromBound) tasks = tasks.filter((t) => t.createdAt >= fromBound);
    if (toBound) tasks = tasks.filter((t) => t.createdAt <= toBound);

    if (opts?.workflowId) {
      const insts = await this.allInstances();
      const pInstIds = new Set(insts.filter((i) => i.workflowId === opts.workflowId).map((i) => i.id));
      tasks = tasks.filter((t) => pInstIds.has(t.instanceId));
    }

    const now = Date.now();
    const groupTaskMap = new Map<string, Task[]>();

    for (const t of tasks) {
      const g = t.group || 'unassigned';
      if (opts?.group && g !== opts.group) continue;
      (groupTaskMap.get(g) || groupTaskMap.set(g, []).get(g)!).push(t);
    }

    if (opts?.group && !groupTaskMap.has(opts.group)) {
      groupTaskMap.set(opts.group, []);
    }

    const result = [...groupTaskMap].map(([group, gTasks]) => {
      const completed = gTasks.filter((t) => t.status === 'completed');
      const open = gTasks.filter((t) => t.status === 'inprogress' || t.status === 'reserved' || t.status === 'created');
      const unassigned = open.filter((t) => !t.assignee);
      const inProgress = open.filter((t) => t.status === 'inprogress');
      const durations = completed.map((t) => durationMs(t.createdAt, t.completedAt)).filter((d): d is number => d != null);

      let totalWithDue = 0;
      let onTime = 0;
      let overdue = 0;
      for (const t of gTasks) {
        if (t.dueAt) {
          totalWithDue++;
          const dueTime = Date.parse(t.dueAt);
          if (t.status === 'completed') {
            const compTime = t.completedAt ? Date.parse(t.completedAt) : now;
            if (compTime <= dueTime) onTime++;
            else overdue++;
          } else {
            if (now > dueTime) overdue++;
            else onTime++;
          }
        }
      }

      const byUserMap = new Map<string, number[]>();
      for (const t of completed) {
        const u = t.completedBy || t.assignee || 'unassigned';
        const d = durationMs(t.createdAt, t.completedAt);
        if (d != null) {
          (byUserMap.get(u) || byUserMap.set(u, []).get(u)!).push(d);
        }
      }

      const byTaskMap = new Map<string, number[]>();
      for (const t of completed) {
        const d = durationMs(t.createdAt, t.completedAt);
        if (d != null) {
          (byTaskMap.get(t.name) || byTaskMap.set(t.name, []).get(t.name)!).push(d);
        }
      }

      return {
        group,
        tasksTotal: gTasks.length,
        tasksCompleted: completed.length,
        tasksOpen: open.length,
        tasksUnassigned: unassigned.length,
        tasksInProgress: inProgress.length,
        tat: advancedStats(durations),
        sla: { totalWithDue, onTime, overdue, complianceRate: totalWithDue > 0 ? Math.round((onTime / totalWithDue) * 100) : 100 },
        byUser: [...byUserMap].map(([user, durs]) => ({ user, ...stats(durs) })),
        byTaskName: [...byTaskMap].map(([taskName, durs]) => ({ taskName, ...stats(durs) })),
      };
    }).sort((a, b) => b.tasksTotal - a.tasksTotal);

    return opts?.group ? (result[0] || { group: opts.group, tasksTotal: 0, tasksCompleted: 0, tasksOpen: 0, tasksUnassigned: 0, tasksInProgress: 0, tat: advancedStats([]), sla: { totalWithDue: 0, onTime: 0, overdue: 0, complianceRate: 100 }, byUser: [], byTaskName: [] }) : result;
  }

  /** Per-task-definition metrics across processes: overall TAT, SLA compliance, plus average TAT per user and per group. */
  async taskDefinitionsAnalytics(opts?: { workflowId?: string; processId?: string; from?: string; to?: string; since?: string }) {
    let instances = await this.allInstances();
    let tasks = await this.allTasks();
    const fromBound = parseBound(opts?.from || opts?.since, false);
    const toBound = parseBound(opts?.to, true);
    if (fromBound) tasks = tasks.filter((t) => t.createdAt >= fromBound);
    if (toBound) tasks = tasks.filter((t) => t.createdAt <= toBound);

    const instMap = new Map(instances.map((i) => [i.id, i]));
    if (opts?.workflowId) {
      instances = instances.filter((i) => i.workflowId === opts.workflowId);
      const pInstIds = new Set(instances.map((i) => i.id));
      tasks = tasks.filter((t) => pInstIds.has(t.instanceId));
    }
    if (opts?.processId) {
      instances = instances.filter((i) => i.processId === opts.processId || i.workflowId === opts.processId);
      const pInstIds = new Set(instances.map((i) => i.id));
      tasks = tasks.filter((t) => pInstIds.has(t.instanceId));
    }

    const now = Date.now();
    const byTask = new Map<string, Task[]>();

    for (const t of tasks) {
      (byTask.get(t.name) || byTask.set(t.name, []).get(t.name)!).push(t);
    }

    return [...byTask].map(([taskName, tList]) => {
      const completed = tList.filter((t) => t.status === 'completed');
      const open = tList.filter((t) => t.status === 'inprogress' || t.status === 'reserved' || t.status === 'created');
      const failed = tList.filter((t) => t.status === 'failed' || t.status === 'error');
      const durations = completed.map((t) => durationMs(t.createdAt, t.completedAt)).filter((d): d is number => d != null);

      let totalWithDue = 0;
      let onTime = 0;
      let overdue = 0;
      for (const t of tList) {
        if (t.dueAt) {
          totalWithDue++;
          const dueTime = Date.parse(t.dueAt);
          if (t.status === 'completed') {
            const compTime = t.completedAt ? Date.parse(t.completedAt) : now;
            if (compTime <= dueTime) onTime++;
            else overdue++;
          } else {
            if (now > dueTime) overdue++;
            else onTime++;
          }
        }
      }

      const byUserMap = new Map<string, number[]>();
      for (const t of completed) {
        const u = t.completedBy || t.assignee;
        if (u) {
          const d = durationMs(t.createdAt, t.completedAt);
          if (d != null) (byUserMap.get(u) || byUserMap.set(u, []).get(u)!).push(d);
        }
      }

      const byGroupMap = new Map<string, number[]>();
      for (const t of completed) {
        const g = t.group || 'unassigned';
        const d = durationMs(t.createdAt, t.completedAt);
        if (d != null) (byGroupMap.get(g) || byGroupMap.set(g, []).get(g)!).push(d);
      }

      const sampleInst = tList[0] ? instMap.get(tList[0].instanceId) : undefined;

      return {
        taskName,
        processId: sampleInst?.processId,
        workflowId: sampleInst?.workflowId,
        totalCount: tList.length,
        completedCount: completed.length,
        openCount: open.length,
        failedCount: failed.length,
        tat: advancedStats(durations),
        sla: { totalWithDue, onTime, overdue, complianceRate: totalWithDue > 0 ? Math.round((onTime / totalWithDue) * 100) : 100 },
        byAssignee: [...byUserMap].map(([user, durs]) => ({ user, ...stats(durs) })),
        byGroup: [...byGroupMap].map(([group, durs]) => ({ group, ...stats(durs) })),
      };
    }).sort((a, b) => b.totalCount - a.totalCount);
  }

  /** Per-process-definition analytics: cycle time TAT, success rate, and human task volume. */
  async processDefinitionsAnalytics(opts?: { workflowId?: string; from?: string; to?: string; since?: string }) {
    let instances = await this.allInstances();
    let tasks = await this.allTasks();
    const fromBound = parseBound(opts?.from || opts?.since, false);
    const toBound = parseBound(opts?.to, true);
    if (fromBound) {
      instances = instances.filter((i) => i.startedAt >= fromBound);
      tasks = tasks.filter((t) => t.createdAt >= fromBound);
    }
    if (toBound) {
      instances = instances.filter((i) => i.startedAt <= toBound);
      tasks = tasks.filter((t) => t.createdAt <= toBound);
    }
    if (opts?.workflowId) {
      instances = instances.filter((i) => i.workflowId === opts.workflowId);
      const pInstIds = new Set(instances.map((i) => i.id));
      tasks = tasks.filter((t) => pInstIds.has(t.instanceId));
    }

    const activeDeps = await this.D().query((d) => d.tenantId === this.ctx.tenantId && d.status === 'active');
    const procDefsMap = new Map<string, { processId: string; name: string; workflowId: string; package?: string; deploymentId: string; version?: string }>();

    for (const dep of activeDeps) {
      for (const p of dep.engine?.processes || []) {
        procDefsMap.set(p.id, {
          processId: p.id,
          name: (p as any).name || p.id,
          workflowId: dep.workflowId,
          package: (p as any).package,
          deploymentId: dep.id,
          version: dep.versionLabel || (dep.versionNumber != null ? `v${dep.versionNumber}` : undefined),
        });
      }
    }

    for (const i of instances) {
      const pid = i.processId || i.workflowId;
      if (pid && !procDefsMap.has(pid)) {
        procDefsMap.set(pid, {
          processId: pid,
          name: pid,
          workflowId: i.workflowId,
          deploymentId: i.deploymentId,
        });
      }
    }

    const now = Date.now();
    return [...procDefsMap.values()].map((meta) => {
      const pInsts = instances.filter((i) => i.processId === meta.processId || (i.workflowId === meta.processId && !i.processId));
      const pInstIds = new Set(pInsts.map((i) => i.id));
      const pTasks = tasks.filter((t) => pInstIds.has(t.instanceId));

      const completedInsts = pInsts.filter((i) => i.status === 'completed');
      const runningInsts = pInsts.filter((i) => i.status === 'running' || i.status === 'waiting');
      const failedInsts = pInsts.filter((i) => i.status === 'failed');
      const abortedInsts = pInsts.filter((i) => i.status === 'aborted');
      const durations = completedInsts.map((i) => durationMs(i.startedAt, i.endedAt)).filter((d): d is number => d != null);

      const tasksCompleted = pTasks.filter((t) => t.status === 'completed').length;
      let totalWithDue = 0;
      let onTime = 0;
      let overdue = 0;
      for (const t of pTasks) {
        if (t.dueAt) {
          totalWithDue++;
          const dueTime = Date.parse(t.dueAt);
          if (t.status === 'completed') {
            const compTime = t.completedAt ? Date.parse(t.completedAt) : now;
            if (compTime <= dueTime) onTime++;
            else overdue++;
          } else {
            if (now > dueTime) overdue++;
            else onTime++;
          }
        }
      }

      return {
        ...meta,
        instances: {
          total: pInsts.length,
          running: runningInsts.length,
          completed: completedInsts.length,
          failed: failedInsts.length,
          aborted: abortedInsts.length,
          successRate: pInsts.length > 0 ? Math.round((completedInsts.length / pInsts.length) * 100) : 100,
        },
        tat: advancedStats(durations),
        totalTasks: pTasks.length,
        tasksCompleted,
        avgTasksPerInstance: pInsts.length > 0 ? Number((pTasks.length / pInsts.length).toFixed(1)) : 0,
        sla: { totalWithDue, onTime, overdue, complianceRate: totalWithDue > 0 ? Math.round((onTime / totalWithDue) * 100) : 100 },
      };
    }).sort((a, b) => b.instances.total - a.instances.total);
  }

  private countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const x of xs) { const k = key(x); out[k] = (out[k] || 0) + 1; }
    return out;
  }
}
