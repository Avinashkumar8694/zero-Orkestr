// Additive analytics for the Workflow Instance module — nothing here changes any EXISTING
// QueryService output (see the module plan's decision #2: delegation-aware TAT is a new, separate
// endpoint, not a change to today's numbers).
import type { AppContext } from '../../context.ts';
import { Collections, type Instance, type Task } from '../../domain.ts';
import { InstanceService } from '../../modules/instances/service.ts';
import { TaskService } from '../../modules/tasks/service.ts';
import { QueryService } from '../../modules/queries/service.ts';
import { notFound } from '../../infra/errors.ts';
import type { WorkflowServiceStore } from '../store/types.ts';

const durationMs = (from?: string, to?: string) => (from && to ? Math.max(0, Date.parse(to) - Date.parse(from)) : undefined);
function parseBound(val?: string, endOfDay = false): string | undefined {
  if (!val) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
    return endOfDay ? `${val}T23:59:59.999Z` : `${val}T00:00:00.000Z`;
  }
  return val;
}

export interface OwnershipSegment { holder: string; from: string; to: string; durationMs: number; }
export interface OwnershipTimeline { taskId: string; segments: OwnershipSegment[]; totalMs: number; }

export class WorkflowAnalyticsService {
  private bpmInstances: InstanceService;
  private tasksApi: TaskService;
  private queries: QueryService;
  constructor(private ctx: AppContext, private store: WorkflowServiceStore) {
    this.bpmInstances = new InstanceService(ctx);
    this.tasksApi = new TaskService(ctx);
    this.queries = new QueryService(ctx);
  }

  private isAll() { return this.ctx.tenantId === 'all' || this.ctx.tenantId === '*'; }

  async summary(opts?: { since?: string; from?: string; to?: string }) {
    const isAll = this.isAll();
    let cases = await this.store.instances().query((w) => isAll || w.tenantId === this.ctx.tenantId);
    const fromBound = parseBound(opts?.from || opts?.since, false);
    const toBound = parseBound(opts?.to, true);
    if (fromBound) cases = cases.filter((c) => c.createdAt >= fromBound);
    if (toBound) cases = cases.filter((c) => c.createdAt <= toBound);
    const byStatus: Record<string, number> = {};
    const byWorkflowName: Record<string, number> = {};
    const terminalStatuses = new Set(['completed', 'closed', 'resolved', 'rejected', 'cancelled']);
    let activeCases = 0;
    let closedCases = 0;
    for (const c of cases) {
      byStatus[c.status] = (byStatus[c.status] || 0) + 1;
      byWorkflowName[c.workflowName] = (byWorkflowName[c.workflowName] || 0) + 1;
      if (terminalStatuses.has((c.status || '').toLowerCase())) closedCases++;
      else activeCases++;
    }
    return {
      total: cases.length,
      byStatus,
      byWorkflowName,
      activeCases,
      closedCases,
      withoutPiid: cases.filter((c) => !c.piid).length,
    };
  }

  /** TAT by case type (workflow definition name) uses the underlying BPM instance's own
   *  `startedAt`/`endedAt` — well-defined regardless of whatever free-form business `status` string a
   *  case is in — rather than the case's own `status`, which has no fixed "this means done" value.
   *  TAT by user reuses the existing task-level analytics unchanged. */
  async tat(opts?: { since?: string; from?: string; to?: string }) {
    const isAll = this.isAll();
    let cases = await this.store.instances().query((w) => (isAll || w.tenantId === this.ctx.tenantId) && !!w.piid);
    const fromBound = parseBound(opts?.from || opts?.since, false);
    const toBound = parseBound(opts?.to, true);
    if (fromBound) cases = cases.filter((c) => c.createdAt >= fromBound);
    if (toBound) cases = cases.filter((c) => c.createdAt <= toBound);
    const byName = new Map<string, number[]>();
    for (const c of cases) {
      const bpm = await this.bpmInstances.get(c.piid!).catch(() => null);
      const ms = bpm ? durationMs(bpm.startedAt, bpm.endedAt) : undefined;
      if (ms == null) continue;
      (byName.get(c.workflowName) ?? byName.set(c.workflowName, []).get(c.workflowName)!).push(ms);
    }
    const stats = (v: number[]) => ({ count: v.length, avgMs: v.length ? Math.round(v.reduce((a, x) => a + x, 0) / v.length) : 0, minMs: v.length ? Math.min(...v) : 0, maxMs: v.length ? Math.max(...v) : 0 });
    const byWorkflowName = [...byName].map(([workflowName, v]) => ({ workflowName, ...stats(v) }));
    const taskAnalytics = await this.queries.taskAnalytics(opts);
    return { byWorkflowName, byUser: taskAnalytics.byAssignee };
  }

  /** Reconstructs how long EACH holder actually held a task, from its own audit trail
   *  (`task.delegated`/`task.forwarded` events carry `data.{from,to}` — see modules/tasks/service.ts).
   *  Segments always partition [task.createdAt, task.completedAt-or-now] contiguously — no gaps, no
   *  overlaps, by construction — so `segments` always sums to `totalMs`. With zero hand-offs, this
   *  collapses to the exact same single-holder duration `QueryService.taskAnalytics()` already
   *  attributes to `completedBy || assignee` — this is a strict refinement, not a contradiction. */
  async ownershipTimeline(taskId: string): Promise<OwnershipTimeline> {
    const task = await this.tasksApi.get(taskId);
    const events = (await this.tasksApi.events(taskId))
      .filter((e) => e.kind === 'task.delegated' || e.kind === 'task.forwarded')
      .sort((a, b) => a.at.localeCompare(b.at));
    const end = task.completedAt || this.ctx.clock();

    const segments: OwnershipSegment[] = [];
    // With zero hand-offs, `task.assignee` (its current, final state) IS reliable as "the one and
    // only holder" — but the moment there's at least one hand-off, `task.assignee` reflects who
    // holds it NOW, not who held it before that first hand-off; the only trustworthy source for that
    // first holder is the first event's own `from` (falling back to the task's group — "queued, not
    // yet held by a specific person" — never to the CURRENT assignee, which is a different point in
    // time and would silently misattribute the whole first segment to the wrong person).
    let holder = events.length
      ? ((events[0]!.data as any)?.from || task.group || '(unassigned)')
      : (task.completedBy || task.assignee || task.group || '(unassigned)');
    let start = task.createdAt;
    for (const e of events) {
      segments.push({ holder, from: start, to: e.at, durationMs: durationMs(start, e.at) ?? 0 });
      holder = (e.data as any)?.to || '(unassigned)';
      start = e.at;
    }
    segments.push({ holder, from: start, to: end, durationMs: durationMs(start, end) ?? 0 });
    return { taskId, segments, totalMs: segments.reduce((a, s) => a + s.durationMs, 0) };
  }

  /** Every task at any depth under `rootPiid`'s BPM subtree, active or completed — the
   *  "all tasks/processes/subprocesses at any level" cross-cutting view. Each entry's `instance`
   *  shows which specific (possibly nested) BPM instance the task actually belongs to. */
  async tasksAndProcesses(rootPiid: string): Promise<{ instances: Instance[]; tasks: Task[] }> {
    const instances = await this.bpmInstances.descendants(rootPiid);
    if (!instances.length) throw notFound('BPM instance');
    const ids = new Set(instances.map((i) => i.id));
    const tasks = (await this.ctx.store.repo<Task>(Collections.tasks).query((t) => t.tenantId === this.ctx.tenantId && ids.has(t.instanceId)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { instances, tasks };
  }
}
