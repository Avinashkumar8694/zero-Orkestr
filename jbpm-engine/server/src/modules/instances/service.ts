// Process-instance lifecycle: start against a resolved deployment, query, inspect, resume.
import { enforceInstanceStart } from '../plans/plans.ts';
import { effectiveLimitsFor } from '../platform/limits.ts';
import type { AppContext } from '../../context.ts';
import { Collections, type AuditEvent, type Deployment, type Instance, type TimerJob } from '../../domain.ts';
import { ExecutionEngine, type EngineEvent } from '../../engine/execution-engine.ts';
import { DeploymentService } from '../deployments/service.ts';
import { ErrorService } from '../errors/service.ts';
import { NotificationService } from '../notifications/service.ts';
import { SettingsService } from '../settings/service.ts';
import { notFound, conflict, validation, quotaExceeded } from '../../infra/errors.ts';

export function makeResolveCalled(ctx: AppContext) {
  return async (processId: string): Promise<{ dep: Deployment; processId: string } | undefined> => {
    const deps = await ctx.store.repo<Deployment>(Collections.deployments).query((d) => d.tenantId === ctx.tenantId && d.status === 'active');
    for (const dep of deps) {
      const p = (dep.engine?.processes || []).find((x) => x.id === processId);
      if (p) return { dep, processId: p.id! };
    }
    return undefined;
  };
}

export class InstanceService {
  private engine: ExecutionEngine;
  private deployments: DeploymentService;
  constructor(private ctx: AppContext, emit: (e: EngineEvent) => void = () => {}) {
    this.deployments = new DeploymentService(ctx);
    this.engine = new ExecutionEngine(ctx, emit, makeResolveCalled(ctx));
  }
  private repo() { return this.ctx.store.repo<Instance>(Collections.instances); }

  /** SystemSettings.maxActiveInstances (0/undefined = unlimited) caps how many TOP-LEVEL (root)
   *  instances this tenant may have running/waiting at once — child/subprocess instances aren't
   *  independently gated since they aren't independently "started" via this API either; they're a
   *  direct consequence of a parent that already passed this same check. */
  private async assertInstanceQuota(): Promise<void> {
    const { maxActiveInstances } = (await effectiveLimitsFor(this.ctx)).effective;
    if (!maxActiveInstances) return;
    const active = await this.repo().query((i) =>
      i.tenantId === this.ctx.tenantId && !i.parentInstanceId && (i.status === 'running' || i.status === 'waiting'));
    if (active.length >= maxActiveInstances) {
      throw quotaExceeded(`per-tenant active-instance quota exceeded (max ${maxActiveInstances})`, { quota: 'maxActiveInstances', max: maxActiveInstances, current: active.length });
    }
  }

  /** Every engine entry point funnels through here on the way out: a run that ended in `failed`
   *  lands one row in the Execution Errors queue (deduped by ErrorService.record) and a bell
   *  notification for whoever started the instance. */
  private async recordIfFailed(inst: Instance): Promise<Instance> {
    if (inst.status !== 'failed' || !inst.error) return inst;
    const dep = await this.ctx.store.repo<Deployment>(Collections.deployments).get(inst.deploymentId);
    const proc = (dep?.engine.processes || []).find((p) => p.id === inst.processId) || dep?.engine.processes?.[0];
    const node = proc?.nodes?.find((n) => n.id === inst.error!.nodeId);
    const rec = await new ErrorService(this.ctx).record({
      type: 'process',
      instanceId: inst.id, workflowId: inst.workflowId, deploymentId: inst.deploymentId, processId: inst.processId,
      nodeId: inst.error.nodeId || undefined, nodeName: (node as any)?.name, nodeType: (node as any)?.type,
      message: inst.error.message, stack: inst.error.stack,
    });
    // only ping on the FIRST occurrence — a retried node failing 40 times is one queue row, not 40 bells
    if (rec.occurrences === 1 && inst.startedBy && inst.startedBy !== 'system' && inst.startedBy !== 'timer') {
      await new NotificationService(this.ctx).notify({
        userId: inst.startedBy, kind: 'instance-failed',
        title: `Instance ${inst.id} failed`, body: inst.error.message,
        link: `/instances/${inst.id}`, instanceId: inst.id,
      });
    }
    return inst;
  }

  async start(input: { workflowId: string; processId?: string; environment?: string; deploymentId?: string; variables?: Record<string, unknown>; correlationKey?: string; async?: boolean }, actor: string): Promise<Instance> {
    let dep: Deployment;
    if (input.deploymentId) dep = await this.deployments.get(input.deploymentId);
    else dep = await this.deployments.resolveActive(input.workflowId, input.environment || 'prod');
    if (dep.status === 'archived') throw conflict('cannot start on an archived deployment');
    await this.assertInstanceQuota();
    await enforceInstanceStart(this.ctx);       // plan: trial/plan expiry + daily / weekly / monthly start budgets
    return this.recordIfFailed(await this.engine.start(dep, input.variables || {}, actor, { processId: input.processId, correlationKey: input.correlationKey, async: input.async === true }));
  }

  async get(id: string): Promise<Instance> {
    const i = await this.repo().get(id);
    if (!i || i.tenantId !== this.ctx.tenantId) throw notFound('Instance');
    return i;
  }

  async list(filter: { workflowId?: string; status?: string; deploymentId?: string; correlationKey?: string; search?: string; limit?: number; offset?: number; full?: boolean }): Promise<Instance[]> {
    const q = (filter.search || '').trim().toLowerCase();
    const all = (await this.repo().query((i) =>
      i.tenantId === this.ctx.tenantId &&
      (!filter.workflowId || i.workflowId === filter.workflowId) &&
      (!filter.status || i.status === filter.status) &&
      (!filter.deploymentId || i.deploymentId === filter.deploymentId) &&
      (!filter.correlationKey || i.correlationKey === filter.correlationKey) &&
      (!q || i.id.toLowerCase().includes(q) || (i.processId || '').toLowerCase().includes(q) || (i.startedBy || '').toLowerCase().includes(q) || (i.correlationKey || '').toLowerCase().includes(q))))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    const offset = filter.offset != null ? Number(filter.offset) : 0;
    const limit = filter.limit != null ? Number(filter.limit) : all.length;
    const paged = all.slice(offset, offset + limit);

    if (filter.full) return paged;
    // Strip heavy runtime execution history and token structures for list queries
    return paged.map((i) => ({
      ...i,
      history: [],
      tokens: [],
    }));
  }

  async diagramState(id: string) {
    const i = await this.get(id);
    return this.engine.diagramState(i);
  }

  async history(id: string) { return (await this.get(id)).history; }

  /** Resume a waiting token (used by task completion / signals). */
  async resume(id: string, tokenId: string, vars?: Record<string, unknown>): Promise<Instance> {
    const inst = await this.get(id);
    const dep = await this.deployments.get(inst.deploymentId);
    return this.recordIfFailed(await this.engine.resumeToken(inst, dep, tokenId, vars));
  }

  /** Fail a waiting token (used by task rejection / failure). */
  async failToken(id: string, tokenId: string, errorMessage?: string, errorDetails?: Record<string, unknown>): Promise<Instance> {
    const inst = await this.get(id);
    const dep = await this.deployments.get(inst.deploymentId);
    return this.recordIfFailed(await this.engine.failToken(inst, dep, tokenId, errorMessage, errorDetails));
  }

  /** Fire a due timer job (catch timer → resume; boundary timer → activate the boundary). */
  async fireTimer(job: TimerJob): Promise<Instance> {
    const inst = await this.get(job.instanceId);
    const dep = await this.deployments.get(inst.deploymentId);
    return this.recordIfFailed(await this.engine.fireTimerJob(inst, dep, job.nodeId, job.tokenId));
  }

  /** The worker runs an async job: release the parked token so its node executes (see ExecutionEngine.fireAsync). */
  async fireAsync(job: TimerJob): Promise<Instance> {
    const inst = await this.get(job.instanceId);
    const dep = await this.deployments.get(inst.deploymentId);
    return this.recordIfFailed(await this.engine.fireAsync(inst, dep, job.tokenId));
  }

  async failAsync(inst: Instance, nodeId: string, message: string): Promise<Instance> {
    const dep = await this.deployments.get(inst.deploymentId);
    return this.recordIfFailed(await this.engine.failInstanceAt(inst, dep, nodeId, message));
  }

  /** Fire a due start-timer/cron job → begin a new instance on the scheduled deployment+process. */
  async startScheduled(job: TimerJob): Promise<Instance> {
    const dep = await this.deployments.get(job.deploymentId!);
    if (dep.status !== 'active') throw conflict('scheduled deployment is no longer active');
    await this.assertInstanceQuota();
    await enforceInstanceStart(this.ctx);
    return this.recordIfFailed(await this.engine.start(dep, {}, 'timer', { processId: job.processId }));
  }

  async abort(id: string, actor: string): Promise<Instance> {
    const i = await this.get(id);
    if (i.status === 'completed' || i.status === 'aborted') return i;
    // Aborts the instance AND its whole subtree (no orphan children left active); a child abort also
    // unblocks / propagates to the waiting parent.
    const aborted = await this.engine.abortInstance(i);
    await this.ctx.audit({ actor, kind: 'instance.aborted', workflowId: i.workflowId, instanceId: i.id });
    return aborted;
  }

  /** Deliver a signal/message to a running instance (resumes matching waiting tokens). Blocked on a
   *  terminal instance — there's nothing left to resume, and silently no-op'ing behind a success toast
   *  would just mislead the caller into thinking the signal did something. Also blocked on `suspended`
   *  ("a paused tree does no work — tasks/signals/timers on it are refused until resume", per suspend()'s
   *  own doc comment below) and `failed` (an unhandled error already removed the waiting token, so
   *  there's nothing left for a signal to resume either — retryFailedNode is the real recovery path). */
  async signal(id: string, name: string, payload: unknown, actor: string): Promise<Instance> {
    const inst = await this.get(id);
    if (inst.status === 'completed' || inst.status === 'aborted') throw conflict(`instance is ${inst.status}; cannot signal a terminal instance`);
    if (inst.status === 'suspended') throw conflict('instance is suspended; resume it before signaling');
    if (inst.status === 'failed') throw conflict('instance is failed; retry the failed node instead of signaling');
    const dep = await this.deployments.get(inst.deploymentId);
    await this.ctx.audit({ actor, kind: 'instance.signaled', workflowId: inst.workflowId, instanceId: id, data: { name } });
    return this.recordIfFailed(await this.engine.signalInstance(inst, dep, name, payload));
  }

  /** Broadcast a signal/message to all matching running/waiting instances in the tenant and trigger matching signal starts.
   *  Matches jBPM KIE-Server POST /server/containers/{id}/processes/instances/signal/{signalName}. */
  async broadcast(name: string, payload: unknown, actor: string, correlationKey?: string): Promise<{ signaled: number }> {
    await this.ctx.audit({ actor, kind: 'instance.broadcastSignaled', workflowId: '*', data: { name, correlationKey } });
    return this.engine.broadcastSignal(name, payload, correlationKey);
  }

  /** Re-trigger a node (retry a failed node, or replay a node) and continue the flow. Blocked on a
   *  terminal instance — same "completed/aborted is read-only" rule as updateVariables() above; unlike
   *  that check, this one is load-bearing: the engine's retryNode() has no defensive check of its own
   *  and will happily push a fresh active token onto a completed instance, flip it back to 'running',
   *  and resume execution — silently resurrecting a finished process instead of erroring. Also blocked
   *  on `suspended` — same resurrection risk (retryNode forces status back to 'running', bypassing the
   *  whole point of a pause) — the instance must be resumed first. */
  async retry(id: string, nodeId: string, actor: string): Promise<Instance> {
    const inst = await this.get(id);
    if (inst.status === 'completed' || inst.status === 'aborted') throw conflict(`instance is ${inst.status}; cannot retry a terminal instance`);
    if (inst.status === 'suspended') throw conflict('instance is suspended; resume it before retrying a node');
    const dep = await this.deployments.get(inst.deploymentId);
    await this.ctx.audit({ actor, kind: 'instance.node.retriggered', workflowId: inst.workflowId, instanceId: id, nodeId });
    return this.recordIfFailed(await this.engine.retryNode(inst, dep, nodeId));
  }

  /** Parent + child instances (call activities) for related-instance navigation. */
  async related(id: string): Promise<{ instance: Instance; parent: Instance | null; children: Instance[] }> {
    const inst = await this.get(id);
    const parent = inst.parentInstanceId ? (await this.repo().get(inst.parentInstanceId)) || null : null;
    const children = await this.repo().query((c) => c.tenantId === this.ctx.tenantId && c.parentInstanceId === id);
    return { instance: inst, parent, children };
  }

  /** Every descendant of `rootId` at ANY depth (call activities, embedded/event sub-processes,
   *  multi-instance children, recursively) — the root itself plus every instance reachable by
   *  following `parentInstanceId` down. Read-only; includes terminal instances by default so
   *  callers get the full historical case tree. */
  async descendants(rootId: string, opts: { includeTerminal?: boolean } = {}): Promise<Instance[]> {
    const includeTerminal = opts.includeTerminal ?? true;
    const root = await this.get(rootId);
    const out: Instance[] = [root];
    const walk = async (parentId: string): Promise<void> => {
      const children = await this.repo().query((c) =>
        c.tenantId === this.ctx.tenantId && c.parentInstanceId === parentId &&
        (includeTerminal || c.status === 'running' || c.status === 'waiting' || c.status === 'suspended'));
      for (const child of children) {
        out.push(child);
        await walk(child.id);
      }
    };
    await walk(rootId);
    return out;
  }

  /** Suspend pauses the WHOLE subtree: the instance and every active descendant (call activities /
   *  sub-processes). A paused tree does no work — tasks/signals/timers on it are refused until resume.
   *  Only a running/waiting instance can be suspended — there's nothing to pause on a terminal instance,
   *  and a 'failed' instance has no active/waiting token either (the failure already removed it), so
   *  "suspending" it would silently do nothing; reject up front instead of a no-op with no feedback. */
  async suspend(id: string, actor: string): Promise<Instance> {
    const i = await this.get(id);
    if (i.status !== 'running' && i.status !== 'waiting') throw conflict(`instance is ${i.status}; only a running or waiting instance can be suspended`);
    await this.suspendTree(i);
    await this.ctx.audit({ actor, kind: 'instance.suspended', workflowId: i.workflowId, instanceId: id });
    return this.get(id);
  }
  private async suspendTree(i: Instance): Promise<void> {
    if (i.status === 'running' || i.status === 'waiting') {
      i.status = 'suspended'; await this.repo().put(i);
    }
    const kids = await this.repo().query((c) => c.tenantId === this.ctx.tenantId && c.parentInstanceId === i.id && (c.status === 'running' || c.status === 'waiting'));
    for (const k of kids) await this.suspendTree(k);
  }

  /** Resume restores the whole paused subtree to running/waiting. Only a suspended instance can be
   *  resumed — mirrors suspend()'s own guard above. */
  async resumeInstance(id: string, actor: string): Promise<Instance> {
    const i = await this.get(id);
    if (i.status !== 'suspended') throw conflict(`instance is ${i.status}; only a suspended instance can be resumed`);
    await this.resumeTree(i);
    await this.ctx.audit({ actor, kind: 'instance.resumed', workflowId: i.workflowId, instanceId: id });
    return this.get(id);
  }
  private async resumeTree(i: Instance): Promise<void> {
    if (i.status === 'suspended') {
      i.status = i.tokens.some((t) => t.state === 'active') ? 'running' : 'waiting'; await this.repo().put(i);
    }
    const kids = await this.repo().query((c) => c.tenantId === this.ctx.tenantId && c.parentInstanceId === i.id && c.status === 'suspended');
    for (const k of kids) await this.resumeTree(k);
  }

  /** Inline edit from the Variables tab. Each write lands in the audit trail with before/after
   *  values, which is exactly what variableHistory() reads back — no separate history table. */
  async updateVariables(id: string, patch: Record<string, unknown>, actor: string): Promise<Instance> {
    const i = await this.get(id);
    if (i.status === 'completed' || i.status === 'aborted') throw conflict(`instance is ${i.status}; variables are read-only`);
    // A suspended instance's whole point is that nothing touches its state until resume — same rule as
    // signal()/retry() above; editing variables underneath a paused instance is just as much a "reach
    // into a frozen tree" violation as resuming a token would be.
    if (i.status === 'suspended') throw conflict('instance is suspended; variables are read-only until resumed');
    // The system setting exists to let an org turn OFF jBPM's normally-permissive "edit variables on a
    // live instance directly" behavior — was previously defined (server/src/domain.ts, with a live
    // toggle in the Settings UI) but never actually consulted anywhere; wire it in here so it does what
    // its name says instead of being a no-op switch.
    if ((i.status === 'running' || i.status === 'waiting') && !(await new SettingsService(this.ctx).get()).allowRunningVariableEdits) {
      throw conflict('editing variables on a running/waiting instance is disabled by system settings; suspend it first');
    }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw validation('expected an object of variable name → value');
    const changes = Object.entries(patch)
      .filter(([k, v]) => JSON.stringify(i.variables[k]) !== JSON.stringify(v))
      .map(([k, v]) => ({ name: k, from: i.variables[k], to: v }));
    if (!changes.length) return i;
    for (const c of changes) i.variables[c.name] = c.to;
    await this.repo().put(i);
    await this.ctx.audit({ actor, kind: 'instance.variables.updated', workflowId: i.workflowId, instanceId: id, data: { changes } });
    return i;
  }

  /** Per-variable change history for the Variables tab, newest first (optionally one variable). */
  async variableHistory(id: string, name?: string): Promise<Array<{ name: string; from: unknown; to: unknown; at: string; actor: string }>> {
    await this.get(id);
    const events = await this.ctx.store.repo<AuditEvent>(Collections.audit)
      .query((e) => e.tenantId === this.ctx.tenantId && e.instanceId === id && e.kind === 'instance.variables.updated');
    const out: Array<{ name: string; from: unknown; to: unknown; at: string; actor: string }> = [];
    for (const e of events) {
      for (const c of ((e.data as any)?.changes || []) as Array<{ name: string; from: unknown; to: unknown }>) {
        if (!name || c.name === name) out.push({ ...c, at: e.at, actor: e.actor });
      }
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  /** Read-only process graph + per-node execution counts (jBPM "instance badges") for the diagram. */
  async graph(id: string) {
    const inst = await this.get(id);
    const dep = await this.deployments.get(inst.deploymentId);
    const p = (dep.engine.processes || []).find((x) => x.id === inst.processId) || dep.engine.processes?.[0];
    const counts: Record<string, number> = {};
    for (const h of inst.history) counts[h.nodeId] = (counts[h.nodeId] || 0) + 1;
    return { nodes: p?.nodes || [], flows: p?.flows || [], diagram: this.engine.diagramState(inst), counts, status: inst.status };
  }

  /** Detailed list of executed and active node instances (jBPM node instances query). */
  async nodes(id: string) {
    const inst = await this.get(id);
    const dep = await this.deployments.get(inst.deploymentId).catch(() => null);
    const proc = dep?.engine.processes.find((p) => p.id === inst.processId) || dep?.engine.processes?.[0];
    const nodeMap = new Map((proc?.nodes || []).map((n) => [n.id, n]));
    const historyNodes = inst.history.map((h, idx) => ({
      id: `hist_${idx}_${h.nodeId}`,
      tokenId: h.tokenId,
      nodeId: h.nodeId,
      nodeName: (nodeMap.get(h.nodeId) as any)?.name || h.nodeId,
      type: h.type || (nodeMap.get(h.nodeId) as any)?.type || 'unknown',
      state: 'completed' as const,
      enteredAt: h.enteredAt,
      exitedAt: h.exitedAt,
      outcome: h.outcome,
    }));
    const activeNodes = inst.tokens.map((t) => ({
      id: `tok_${t.id}`,
      tokenId: t.id,
      nodeId: t.nodeId,
      nodeName: (nodeMap.get(t.nodeId) as any)?.name || t.nodeId,
      type: (nodeMap.get(t.nodeId) as any)?.type || 'unknown',
      state: t.state,
      enteredAt: t.enteredAt,
      waitFor: t.waitFor,
    }));
    return [...historyNodes, ...activeNodes];
  }

  /** Bulk abort instances. */
  async abortMany(ids: string[], actor: string): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of ids) {
      try {
        await this.abort(id, actor);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  /** Bulk signal instances. */
  async signalMany(ids: string[], name: string, payload: unknown, actor: string): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of ids) {
      try {
        await this.signal(id, name, payload, actor);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }
}
