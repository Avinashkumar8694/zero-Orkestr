// WorkflowInstance — a business-facing CASE record (see ../domain.ts). Wraps the existing BPM
// InstanceService/TaskService/QueryService rather than reimplementing anything they already do: this
// module is an additive layer, not a replacement — a caller who wants the raw BPM APIs directly can
// still use them (see docs/usage_docs/14-workflow-instance-management.md).
import type { AppContext } from '../../context.ts';
import { Collections, type Task, type Instance } from '../../domain.ts';
import type { EngineEvent } from '../../engine/execution-engine.ts';
import { InstanceService } from '../../modules/instances/service.ts';
import { TaskService } from '../../modules/tasks/service.ts';
import { DeploymentService } from '../../modules/deployments/service.ts';
import { QueryService } from '../../modules/queries/service.ts';
import { notFound, validation, conflict } from '../../infra/errors.ts';
import type { WorkflowServiceStore } from '../store/types.ts';
import type { WorkflowInstance, WorkflowInstanceAudit, WorkflowInstanceComment } from '../domain.ts';
import { WorkflowDefinitionService } from './workflow-definition-service.ts';

export interface WorkflowInstanceAggregate {
  workflowInstance: WorkflowInstance;
  bpmInstance: Instance | null;
  tasks: Task[];
  signals: { listensFor: string[]; throws: string[] } | null;
  commentCount: number;
  auditCount: number;
}

export class WorkflowInstanceService {
  private definitions: WorkflowDefinitionService;
  private bpmInstances: InstanceService;
  private tasksApi: TaskService;
  private deployments: DeploymentService;
  private queries: QueryService;
  constructor(private ctx: AppContext, private store: WorkflowServiceStore, emit: (e: EngineEvent) => void = () => {}) {
    this.definitions = new WorkflowDefinitionService(ctx, store);
    this.bpmInstances = new InstanceService(ctx, emit);
    this.tasksApi = new TaskService(ctx, emit);
    this.deployments = new DeploymentService(ctx);
    this.queries = new QueryService(ctx);
  }
  private repo() { return this.store.instances(); }

  async get(id: string): Promise<WorkflowInstance> {
    const w = await this.repo().get(id);
    if (!w || w.tenantId !== this.ctx.tenantId) throw notFound('WorkflowInstance');
    return w;
  }

  async list(filter: { workflowName?: string; workflowDefinitionId?: string; status?: string; piid?: string } = {}): Promise<WorkflowInstance[]> {
    return (await this.repo().query((w) =>
      w.tenantId === this.ctx.tenantId &&
      (!filter.workflowName || w.workflowName === filter.workflowName) &&
      (!filter.workflowDefinitionId || w.workflowDefinitionId === filter.workflowDefinitionId) &&
      (!filter.status || w.status === filter.status) &&
      (!filter.piid || w.piid === filter.piid)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Convenience search into `data` (business fields) alongside the flat filters `list()` already
   *  covers — a plain-equality quick-search, not the full ad-hoc query engine (see
   *  query-engine-service.ts) which supports operators/groupBy/saved queries; this exists so "find a
   *  case by one of its own data fields" doesn't require reaching for the heavier tool. */
  async search(filter: { workflowName?: string; status?: string; data?: Record<string, unknown> }): Promise<WorkflowInstance[]> {
    const base = await this.list({ workflowName: filter.workflowName, status: filter.status });
    if (!filter.data || !Object.keys(filter.data).length) return base;
    return base.filter((w) => Object.entries(filter.data!).every(([k, v]) => (w.data as any)?.[k] === v));
  }

  /** Resolves the WorkflowDefinition by name, validates `workflowData` against its schema (a no-op
   *  if validation isn't enabled), creates the case row, then starts the underlying BPM instance and
   *  backfills `piid` — a BPM-start failure marks the case `status:'failed'` with `startError` rather
   *  than leaving it stuck at `'initiated'` forever or silently vanishing; the row always ends in a
   *  resolved, explainable state either way. */
  async create(input: { workflowName: string; variables?: Record<string, unknown>; workflowData?: Record<string, unknown> }, actor: string): Promise<WorkflowInstance> {
    if (!input.workflowName?.trim()) throw validation('workflowName is required');
    const def = await this.definitions.getByName(input.workflowName.trim());
    const data = input.workflowData ?? {};
    this.definitions.validateData(def, data);
    const dep = await this.deployments.get(def.deploymentId);

    const now = this.ctx.clock();
    let row: WorkflowInstance = {
      id: this.ctx.newId(), tenantId: this.ctx.tenantId, workflowDefinitionId: def.id,
      workflowName: def.name, deploymentId: def.deploymentId, data, status: 'initiated', piid: null,
      createdAt: now, createdBy: actor, updatedAt: now, updatedBy: actor,
    };
    await this.repo().put(row);
    await this.addAudit(row.id, actor, 'workflowInstance.created', { workflowName: def.name });

    try {
      const bpm = await this.bpmInstances.start(
        {
          workflowId: dep.workflowId,
          deploymentId: def.deploymentId,
          processId: def.processId,
          variables: { ...(input.variables || {}), _caseInstanceId: row.id },
        },
        actor
      );
      row = { ...row, piid: bpm.id, status: bpm.status === 'failed' ? 'failed' : 'active', updatedAt: this.ctx.clock(), updatedBy: actor };
      if (bpm.status === 'failed') row.startError = bpm.error?.message;
      await this.repo().put(row);
      await this.addAudit(row.id, actor, 'workflowInstance.bpmStarted', { piid: bpm.id, bpmStatus: bpm.status });
    } catch (e) {
      row = { ...row, status: 'failed', startError: (e as Error).message, updatedAt: this.ctx.clock(), updatedBy: actor };
      await this.repo().put(row);
      await this.addAudit(row.id, actor, 'workflowInstance.startFailed', { error: (e as Error).message });
    }
    return row;
  }

  private async assertCaseActionable(w: WorkflowInstance): Promise<void> {
    const s = (w.status || '').toLowerCase();
    const terminal = ['completed', 'closed', 'settled', 'settled_and_closed', 'aborted', 'failed', 'cancelled'];
    if (terminal.includes(s)) {
      throw conflict(`case is ${w.status}; it is closed and read-only`);
    }
    if (w.piid) {
      const bpm = await this.bpmInstances.get(w.piid).catch(() => null);
      if (bpm && (bpm.status === 'completed' || bpm.status === 'aborted')) {
        throw conflict(`underlying process instance is ${bpm.status}; case is read-only`);
      }
    }
  }

  /** Workflow-level status — an open, business-defined vocabulary (e.g. "Pending Review",
   *  "Escalated") tracked independently of the underlying BPM `Instance.status`, which stays whatever
   *  the engine says regardless of what a case's business status is set to. */
  async updateStatus(id: string, status: string, actor: string): Promise<WorkflowInstance> {
    if (!status?.trim()) throw validation('status is required');
    const w = await this.get(id);
    await this.assertCaseActionable(w);
    const next = { ...w, status: status.trim(), updatedAt: this.ctx.clock(), updatedBy: actor };
    await this.repo().put(next);
    await this.addAudit(id, actor, 'workflowInstance.statusChanged', { from: w.status, to: next.status });
    return next;
  }

  /** Replaces `data` wholesale (PUT semantics) — validated against the definition's schema if
   *  validation is enabled, applied as-is otherwise. */
  async updateData(id: string, data: Record<string, unknown>, actor: string): Promise<WorkflowInstance> {
    const w = await this.get(id);
    await this.assertCaseActionable(w);
    const def = await this.definitions.get(w.workflowDefinitionId);
    this.definitions.validateData(def, data);
    const next = { ...w, data, updatedAt: this.ctx.clock(), updatedBy: actor };
    await this.repo().put(next);
    await this.addAudit(id, actor, 'workflowInstance.dataUpdated', {});
    return next;
  }

  /** Read the case business data dictionary. */
  async getData(id: string): Promise<Record<string, unknown>> {
    const w = await this.get(id);
    return w.data || {};
  }

  /** Delete a top-level key from the case business data. */
  async deleteDataKey(id: string, key: string, actor: string): Promise<WorkflowInstance> {
    const w = await this.get(id);
    await this.assertCaseActionable(w);
    const nextData = { ...(w.data || {}) };
    delete nextData[key];
    const def = await this.definitions.get(w.workflowDefinitionId);
    this.definitions.validateData(def, nextData);
    const next = { ...w, data: nextData, updatedAt: this.ctx.clock(), updatedBy: actor };
    await this.repo().put(next);
    await this.addAudit(id, actor, 'workflowInstance.dataKeyDeleted', { key });
    return next;
  }

  /** Explicitly closes a case (case lifecycle completion) with resolution comments. */
  async close(id: string, resolution: string, actor: string): Promise<WorkflowInstance> {
    const w = await this.get(id);
    const next = { ...w, status: 'closed', updatedAt: this.ctx.clock(), updatedBy: actor };
    await this.repo().put(next);
    await this.addAudit(id, actor, 'workflowInstance.closed', { resolution: resolution || 'Case closed by user' });
    return next;
  }

  /** Reopens a previously closed case. */
  async reopen(id: string, reason: string, actor: string): Promise<WorkflowInstance> {
    const w = await this.get(id);
    const s = (w.status || '').toLowerCase();
    if (s !== 'closed' && s !== 'settled_and_closed' && s !== 'completed') {
      throw conflict(`case is ${w.status}; only closed cases can be reopened`);
    }
    const next = { ...w, status: 'active', updatedAt: this.ctx.clock(), updatedBy: actor };
    await this.repo().put(next);
    await this.addAudit(id, actor, 'workflowInstance.reopened', { reason: reason || 'Case reopened' });
    return next;
  }

  /** Case Role Management: read assigned roles. */
  async getRoles(id: string): Promise<Record<string, string[]>> {
    const w = await this.get(id);
    return w.roles || {};
  }

  /** Case Role Management: assign users/groups to a role. */
  async setRole(id: string, roleName: string, members: string[], actor: string): Promise<Record<string, string[]>> {
    const w = await this.get(id);
    await this.assertCaseActionable(w);
    const roles = { ...(w.roles || {}) };
    roles[roleName] = Array.isArray(members) ? members : [members];
    const next = { ...w, roles, updatedAt: this.ctx.clock(), updatedBy: actor };
    await this.repo().put(next);
    await this.addAudit(id, actor, 'workflowInstance.roleAssigned', { roleName, members });
    return roles;
  }

  /** Case Role Management: remove a role assignment. */
  async deleteRole(id: string, roleName: string, actor: string): Promise<Record<string, string[]>> {
    const w = await this.get(id);
    await this.assertCaseActionable(w);
    const roles = { ...(w.roles || {}) };
    delete roles[roleName];
    const next = { ...w, roles, updatedAt: this.ctx.clock(), updatedBy: actor };
    await this.repo().put(next);
    await this.addAudit(id, actor, 'workflowInstance.roleRemoved', { roleName });
    return roles;
  }

  /** Case Milestones: list stages/milestones achieved. */
  async getMilestones(id: string): Promise<Array<{ id: string; name: string; status: string; achievedAt?: string; achievedBy?: string }>> {
    const w = await this.get(id);
    return w.milestones || [];
  }

  /** Case Milestones: record or achieve a milestone. */
  async achieveMilestone(id: string, name: string, actor: string): Promise<Array<{ id: string; name: string; status: string; achievedAt?: string; achievedBy?: string }>> {
    const w = await this.get(id);
    await this.assertCaseActionable(w);
    const milestones = [...(w.milestones || [])];
    const existing = milestones.find((m) => m.name.toLowerCase() === name.toLowerCase());
    const now = this.ctx.clock();
    if (existing) {
      existing.status = 'achieved';
      existing.achievedAt = now;
      existing.achievedBy = actor;
    } else {
      milestones.push({ id: this.ctx.newId(), name, status: 'achieved', achievedAt: now, achievedBy: actor });
    }
    const next = { ...w, milestones, updatedAt: now, updatedBy: actor };
    await this.repo().put(next);
    await this.addAudit(id, actor, 'workflowInstance.milestoneAchieved', { milestone: name });
    return milestones;
  }

  /** Broadcast a signal across all case/workflow instances. */
  async broadcastSignal(name: string, payload: unknown, actor: string): Promise<{ signaled: number }> {
    return this.bpmInstances.broadcast(name, payload, actor);
  }

  // ---- flags management (L1/L3 compliance flags) ----
  async getFlags(id: string): Promise<{ caseLevel: any[]; policyLevel: any[]; beneficiaryLevel: any[] }> {
    const w = await this.get(id);
    const flags = (w.data as any)?.flags || {};
    return {
      caseLevel: flags.caseLevel || [],
      policyLevel: flags.policyLevel || [],
      beneficiaryLevel: flags.beneficiaryLevel || [],
    };
  }

  async addFlag(id: string, input: { level?: 'caseLevel' | 'policyLevel' | 'beneficiaryLevel'; flagType: string; reason?: string; flagValue?: unknown }, actor: string): Promise<any> {
    const w = await this.get(id);
    await this.assertCaseActionable(w);
    if (!input.flagType?.trim()) throw validation('flagType is required');
    const level = input.level || 'caseLevel';
    const currentFlags = await this.getFlags(id);
    const flagItem = {
      id: this.ctx.newId(),
      flagType: input.flagType.trim(),
      flagValue: input.flagValue !== undefined ? input.flagValue : true,
      reason: input.reason || '',
      raisedAt: this.ctx.clock(),
      raisedBy: actor,
    };
    currentFlags[level].push(flagItem);
    const nextData = { ...(w.data || {}), flags: currentFlags };
    const next = { ...w, data: nextData, updatedAt: this.ctx.clock(), updatedBy: actor };
    await this.repo().put(next);
    await this.addAudit(id, actor, 'workflowInstance.flagRaised', { flagType: input.flagType, level });
    return flagItem;
  }

  async deleteFlag(id: string, flagId: string, actor: string): Promise<void> {
    const w = await this.get(id);
    await this.assertCaseActionable(w);
    const currentFlags = await this.getFlags(id);
    let removed = false;
    for (const lvl of ['caseLevel', 'policyLevel', 'beneficiaryLevel'] as const) {
      const idx = currentFlags[lvl].findIndex((f: any) => f.id === flagId || f.flagType === flagId);
      if (idx !== -1) {
        currentFlags[lvl].splice(idx, 1);
        removed = true;
        break;
      }
    }
    if (!removed) throw notFound('Flag');
    const nextData = { ...(w.data || {}), flags: currentFlags };
    const next = { ...w, data: nextData, updatedAt: this.ctx.clock(), updatedBy: actor };
    await this.repo().put(next);
    await this.addAudit(id, actor, 'workflowInstance.flagCleared', { flagId });
  }

  // ---- documents management (supporting evidence / POA / certificates) ----
  async getDocuments(id: string): Promise<any[]> {
    const w = await this.get(id);
    return (w.data as any)?.documents || [];
  }

  async addDocument(id: string, input: { document_name: string; document_type?: string; s3_key?: string; required?: boolean; status?: string; type?: string }, actor: string): Promise<any> {
    const w = await this.get(id);
    await this.assertCaseActionable(w);
    if (!input.document_name?.trim()) throw validation('document_name is required');
    const currentDocs = [...((w.data as any)?.documents || [])];
    const docItem = {
      id: this.ctx.newId(),
      document_name: input.document_name.trim(),
      document_type: input.document_type || 'SUPPORTING',
      s3_key: input.s3_key || null,
      required: Boolean(input.required),
      status: input.status || 'UPLOADED',
      type: input.type || 'USER_UPLOADED',
      uploadedAt: this.ctx.clock(),
      uploadedBy: actor,
    };
    currentDocs.push(docItem);
    const nextData = { ...(w.data || {}), documents: currentDocs };
    const next = { ...w, data: nextData, updatedAt: this.ctx.clock(), updatedBy: actor };
    await this.repo().put(next);
    await this.addAudit(id, actor, 'workflowInstance.documentAdded', { document_name: input.document_name });
    return docItem;
  }

  async deleteDocument(id: string, docId: string, actor: string): Promise<void> {
    const w = await this.get(id);
    await this.assertCaseActionable(w);
    const currentDocs = [...((w.data as any)?.documents || [])];
    const idx = currentDocs.findIndex((d: any) => d.id === docId || d.document_name === docId);
    if (idx === -1) throw notFound('Document');
    currentDocs.splice(idx, 1);
    const nextData = { ...(w.data || {}), documents: currentDocs };
    const next = { ...w, data: nextData, updatedAt: this.ctx.clock(), updatedBy: actor };
    await this.repo().put(next);
    await this.addAudit(id, actor, 'workflowInstance.documentDeleted', { docId });
  }

  // ---- dynamic / ad-hoc activities (jBPM dynamic tasks) ----
  async createDynamicTask(id: string, input: { name: string; group?: string; assignee?: string; priority?: number; dueAt?: string; inputs?: Record<string, unknown> }, actor: string): Promise<Task> {
    const w = await this.get(id);
    await this.assertCaseActionable(w);
    if (!input.name?.trim()) throw validation('task name is required');
    const now = this.ctx.clock();
    const task: Task = {
      id: this.ctx.newId(),
      tenantId: this.ctx.tenantId,
      instanceId: w.piid || w.id,
      tokenId: this.ctx.newId(),
      nodeId: 'dynamic_user_task',
      name: input.name.trim(),
      group: input.group,
      assignee: input.assignee,
      priority: input.priority ?? 5,
      status: input.assignee ? 'reserved' : 'created',
      inputs: input.inputs || {},
      outputs: {},
      createdAt: now,
      dueAt: input.dueAt,
    };
    await this.ctx.store.repo<Task>(Collections.tasks).put(task);
    await this.addAudit(id, actor, 'workflowInstance.dynamicTaskCreated', { taskId: task.id, name: task.name });
    return task;
  }

  private async requirePiid(w: WorkflowInstance): Promise<string> {
    if (!w.piid) throw conflict('this workflow instance has no BPM process instance yet (piid is unset)');
    return w.piid;
  }

  async signal(id: string, name: string, payload: unknown, actor: string): Promise<Instance> {
    const w = await this.get(id);
    const piid = await this.requirePiid(w);
    await this.addAudit(id, actor, 'workflowInstance.signaled', { name });
    return this.bpmInstances.signal(piid, name, payload, actor);
  }

  /** Every Task at any depth under this case's BPM subtree — inside a sub-process, a call activity, a
   *  multi-instance fan-out, however many levels down — active or long since completed (and possibly
   *  delegated away from whoever originally got it; see the ownership-timeline analytics endpoint for
   *  reconstructing that history). */
  async tasks(id: string): Promise<Task[]> {
    const w = await this.get(id);
    if (!w.piid) return [];
    const descendantIds = new Set((await this.bpmInstances.descendants(w.piid)).map((i) => i.id));
    return (await this.ctx.store.repo<Task>(Collections.tasks).query((t) => t.tenantId === this.ctx.tenantId && descendantIds.has(t.instanceId)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async signals(id: string): Promise<{ listensFor: string[]; throws: string[] } | null> {
    const w = await this.get(id);
    if (!w.piid) return null;
    const bpm = await this.bpmInstances.get(w.piid).catch(() => null);
    if (!bpm?.processId) return null;
    return this.queries.processSignals(bpm.processId);
  }

  /** Completes a specific task belonging to this case (at any depth) — the "user decision" action.
   *  Scoped through the case (not a bare taskId passthrough) so a caller can't accidentally act on a
   *  task from an unrelated instance just by guessing an id. */
  async decision(id: string, taskId: string, outputs: Record<string, unknown>, actor: string): Promise<Task> {
    const mine = await this.tasks(id);
    if (!mine.some((t) => t.id === taskId)) throw notFound('Task on this workflow instance');
    const task = await this.tasksApi.complete(taskId, outputs, actor);
    await this.addAudit(id, actor, 'workflowInstance.decision', { taskId, outputs });
    return task;
  }

  /** Delegates the case's current open task. If more than one task is open, `taskId` disambiguates —
   *  matches the plan's "current open task" convenience while still supporting the general case. */
  async delegate(id: string, to: string, actor: string, taskId?: string): Promise<Task> {
    const w = await this.get(id);
    await this.assertCaseActionable(w);
    const mine = await this.tasks(id);
    const open = mine.filter((t) => t.status !== 'completed' && t.status !== 'skipped' && t.status !== 'exited' && t.status !== 'error');
    const target = taskId ? open.find((t) => t.id === taskId) : open.length === 1 ? open[0] : undefined;
    if (!target) throw conflict(taskId ? 'that task is not an open task on this workflow instance' : `${open.length} open tasks on this workflow instance — pass taskId to disambiguate`);
    const task = await this.tasksApi.delegate(target.id, to, actor);
    await this.addAudit(id, actor, 'workflowInstance.delegated', { taskId: target.id, to });
    return task;
  }

  async aggregate(id: string): Promise<WorkflowInstanceAggregate> {
    const w = await this.get(id);
    const [bpmInstance, tasks, signals, comments, audits] = await Promise.all([
      w.piid ? this.bpmInstances.get(w.piid).catch(() => null) : Promise.resolve(null),
      this.tasks(id),
      this.signals(id),
      this.listComments(id),
      this.listAudits(id),
    ]);
    return { workflowInstance: w, bpmInstance, tasks, signals, commentCount: comments.length, auditCount: audits.length };
  }

  // ---- comments (dedicated table — see domain.ts's doc comment on why this isn't the shared Collections.comments) ----
  async listComments(id: string): Promise<WorkflowInstanceComment[]> {
    await this.get(id);
    return (await this.store.comments().query((c) => c.tenantId === this.ctx.tenantId && c.workflowInstanceId === id)).sort((a, b) => a.at.localeCompare(b.at));
  }
  async addComment(id: string, body: string, author: string): Promise<WorkflowInstanceComment> {
    const w = await this.get(id);
    await this.assertCaseActionable(w);
    if (!body?.trim()) throw validation('comment body is required');
    const c: WorkflowInstanceComment = { id: this.ctx.newId(), tenantId: this.ctx.tenantId, workflowInstanceId: id, author, body: body.trim(), at: this.ctx.clock() };
    await this.store.comments().put(c);
    await this.addAudit(id, author, 'workflowInstance.commented', {});
    return c;
  }
  async deleteComment(id: string, commentId: string, actor: string): Promise<void> {
    const w = await this.get(id);
    await this.assertCaseActionable(w);
    const c = await this.store.comments().get(commentId);
    if (!c || c.tenantId !== this.ctx.tenantId || c.workflowInstanceId !== id) throw notFound('Comment');
    if (c.author !== actor) throw validation('only the comment author can delete it');
    await this.store.comments().delete(commentId);
    await this.addAudit(id, actor, 'workflowInstance.comment.deleted', {});
  }

  // ---- audit (dedicated table) — see domain.ts's doc comment on why this isn't the shared Collections.audit ----
  async listAudits(id: string): Promise<WorkflowInstanceAudit[]> {
    await this.get(id);
    return (await this.store.audits().query((a) => a.tenantId === this.ctx.tenantId && a.workflowInstanceId === id)).sort((a, b) => b.at.localeCompare(a.at));
  }
  /** System-generated audit entries flow through here too (every mutating method above calls this) —
   *  it's also exposed to callers directly so a manual, out-of-band audit note can be recorded, per
   *  the user's own requirement ("create audits" alongside "create comments"). */
  async addAudit(id: string, actor: string, kind: string, data?: Record<string, unknown>): Promise<WorkflowInstanceAudit> {
    const a: WorkflowInstanceAudit = { id: this.ctx.newId(), tenantId: this.ctx.tenantId, workflowInstanceId: id, actor, kind, data, at: this.ctx.clock() };
    await this.store.audits().put(a);
    return a;
  }
  async deleteAudit(id: string, auditId: string, actor: string): Promise<void> {
    await this.get(id);
    const a = await this.store.audits().get(auditId);
    if (!a || a.tenantId !== this.ctx.tenantId || a.workflowInstanceId !== id) throw notFound('Audit entry');
    await this.store.audits().delete(auditId);
  }
}
