// Token-based interpreter over the SDK engine JSON. See docs/08-execution-engine.md.
// Deterministic core (clock/newId injected). Persists the instance after runToQuiescence.
import { effectiveLimitsFor } from '../modules/platform/limits.ts';
import type { AppContext } from '../context.ts';
import { Collections, type Deployment, type Instance, type NodeSla, type NodeVisit, type Task, type TimerJob, type Token } from '../domain.ts';
import type { EngineFlow, EngineNode, EngineProcess } from '../sdk/index.ts';
import { NODE_HANDLERS, CHILD_OUTPUT_MAPPERS, buildMultiInstanceResult, type HandlerCtx, type HandlerResult } from './nodes/index.ts';
import { varTypesOf, kcontextInfoOf, onActionOf, scriptLimitsOf } from './nodes/kcontext-info.ts';
// Aliased (not `boundary`) since fireBoundary()'s own parameter below is already named `boundary`.
import * as boundaryHandler from './nodes/boundary/handler.ts';
import { computeDue, cycleOf, parseDuration, parseDelay, dueFrom } from './duration.ts';
import { kickWorker, ASYNC_CAPABLE } from './async-kick.ts';
import { withInstanceLock, deferAfterLock } from './instance-lock.ts';
import { findRows } from '../store/find.ts';
import { compactHistory } from './history-cap.ts';

/** a multi-instance activity seen as the for-each it runs as: one nested single-activity instance per item (see pick(): `parent::mi:<id>`) */
const miView = (node: any, p: EngineProcess) => ({ ...node, ...node.multiInstance, miInline: true, type: 'forEach', process: `${p.id}::mi:${node.id}` });
import { evalCondition } from './sandbox.ts';
import { completionReached, collectCompleted } from './nodes/for-each/handler.ts';
import { runScript } from './sandbox.ts';
import { config } from '../infra/config.ts';
import { conflict, quotaExceeded, validation } from '../infra/errors.ts';
import { SettingsService } from '../modules/settings/service.ts';
import { NotificationService } from '../modules/notifications/service.ts';

// Error codes the Node runtime raises (documented in docs/14-error-handling.md); user codes also
// allowed. Re-exported from nodes/boundary/handler.ts, which owns error-catch matching logic now.
export const ENGINE_ERRORS = boundaryHandler.ENGINE_ERRORS;
const ERROR_VAR = 'errorInfo';   // { code, node, message } bound when an error is caught

export type EngineEvent =
  | { kind: 'instance.started' | 'instance.updated' | 'instance.completed' | 'instance.failed'; instanceId: string }
  | { kind: 'node.entered' | 'node.exited'; instanceId: string; nodeId: string; tokenId: string }
  | { kind: 'task.created'; instanceId: string; taskId: string };

export class ExecutionEngine {
  constructor(
    private ctx: AppContext,
    private emit: (e: EngineEvent) => void = () => {},
    /** resolve a called process id -> its active deployment (enables call-activity child instances) */
    private resolveCalled?: (processId: string, from?: Deployment) => Promise<{ dep: Deployment; processId: string } | undefined>,
  ) {}
  private inst() { return this.ctx.store.repo<Instance>(Collections.instances); }
  private deps() { return this.ctx.store.repo<Deployment>(Collections.deployments); }

  // ---- process graph helpers ----
  /** The process (definition) an instance runs — selected by its processId, else the first. */
  private pick(dep: Deployment, processId?: string): EngineProcess {
    const list = dep.engine.processes || [];
    // Embedded sub-process: a composite id "parentProcess::nodeId" resolves to a synthetic process
    // built from that subprocess node's own nodes/flows, so it runs as a nested instance.
    if (processId && processId.includes('::')) {
      const [parentId, nodeId] = processId.split('::');
      const parent = list.find((x) => x.id === parentId) || list[0];
      if (nodeId!.startsWith('mi:')) {                                           // one item of a multi-instance activity: start -> the activity -> end
        const act = parent?.nodes.find((n) => n.id === nodeId!.slice(3)) as any;
        if (!act) throw new Error('multi-instance activity not found');
        const { multiInstance: _mi, ...single } = act;
        return { id: processId, name: act.name || 'Item', vars: parent!.vars, nodes: [{ id: 'mi_s', type: 'start' }, single, { id: 'mi_e', type: 'end' }], flows: [{ id: 'mi_f1', from: 'mi_s', to: act.id }, { id: 'mi_f2', from: act.id, to: 'mi_e' }] } as unknown as EngineProcess;
      }
      const sub = parent?.nodes.find((n) => n.id === nodeId) as any;
      if (!sub) throw new Error('embedded sub-process not found');
      return { id: processId, name: sub.name || 'Sub-process', nodes: sub.nodes || [], flows: sub.flows || [], ...(sub.adHoc ? { adHoc: true, completionCondition: sub.completionCondition } : {}) } as EngineProcess;
    }
    const p = (processId && list.find((x) => x.id === processId)) || list[0];
    if (!p) throw new Error('deployment has no process');
    return p;
  }
  private proc(inst: Instance, dep: Deployment): EngineProcess { return this.pick(dep, inst.processId); }
  private nodeMap(p: EngineProcess) { return new Map(p.nodes.map((n) => [n.id!, n])); }
  private outgoing(p: EngineProcess, nodeId: string): EngineFlow[] { return p.flows.filter((f) => f.from === nodeId); }
  private incoming(p: EngineProcess, nodeId: string): EngineFlow[] { return p.flows.filter((f) => f.to === nodeId); }

  // ---- lifecycle ----
  async start(dep: Deployment, variables: Record<string, unknown>, actor: string, opts: { processId?: string; correlationKey?: string; parentInstanceId?: string; isErrorHandler?: boolean; async?: boolean; startAt?: string } = {}): Promise<Instance> {
    const p = this.pick(dep, opts.processId);
    const startNode = p.nodes.find((n) => n.type === 'start') || p.nodes[0];
    if (!startNode) throw new Error('process has no start node');
    const now = this.ctx.clock();
    const seed: Record<string, unknown> = {};
    for (const v of p.vars || []) seed[v.name] = undefined;
    const inst: Instance = {
      id: this.ctx.newId(), tenantId: this.ctx.tenantId, deploymentId: dep.id, workflowId: dep.workflowId, processId: p.id,
      correlationKey: opts.correlationKey, status: 'running', variables: { ...seed, ...variables },
      tokens: [{ id: this.ctx.newId(), nodeId: startNode.id!, state: 'active', enteredAt: now }],
      history: [], startedAt: now, startedBy: actor,
      parentInstanceId: opts.parentInstanceId,
      isErrorHandler: opts.isErrorHandler,
    };
    if (opts.startAt) {                                          // started by an instantiating event gateway: the triggering catch counts as done
      inst.tokens = this.outgoing(p, opts.startAt).map((f) => ({ id: this.ctx.newId(), nodeId: f.to, state: 'active' as const, enteredAt: now }));
      inst.history.push({ tokenId: '-', nodeId: opts.startAt, type: 'catch', enteredAt: now, exitedAt: now, outcome: 'triggered' });
    }
    this.assertRequiredVars(p, inst.variables);
    this.applyProcessProperties(p, inst, now);
    this.emit({ kind: 'instance.started', instanceId: inst.id });
    // Every instance is created here — a direct start, a scheduled/cron start, a call-activity or
    // multi-instance child, or a signal/message start-event peer instance (see startChild()/
    // broadcast() below, both of which route through this same method) — so this is the one place
    // that needs to log it for the Audit Log's PIID column to ever show a "started" row at all.
    await this.ctx.audit({ actor, kind: 'instance.started', workflowId: dep.workflowId, deploymentId: dep.id, instanceId: inst.id, data: { processId: inst.processId } });
    if (opts.async) {
      // background start: the instance exists (and is visible) now; its first node runs in the worker, not in this request
      const t = inst.tokens[0]!;
      t.state = 'waiting'; t.waitFor = { kind: 'async', ref: startNode.id };
      await this.inst().put(inst);
      await this.scheduleAsync(inst, t.id, startNode.id!, undefined);
      return inst;
    }
    await this.runToQuiescence(inst, dep);
    return inst;
  }

  /** Event sub-processes (signal / message / escalation / timer / condition triggers): while the instance lives, each one has a LISTENER token
   *  (durable, like any waiting token; a timer trigger also has its ordinary timer job). The listener never keeps the instance alive on its own. */
  private armEventSubprocesses(p: EngineProcess, inst: Instance, now: string): void {
    for (const n of p.nodes as any[]) {
      if (n.type !== 'subprocess' || !n.on || typeof n.on !== 'object' || 'error' in n.on) continue;
      const on = n.on as Record<string, any>;
      const id = this.ctx.newId();
      if (on.timer) {
        inst.tokens.push({ id, nodeId: n.id, state: 'waiting', waitFor: { kind: 'timer', ref: n.id }, listener: true, enteredAt: now });
        void this.scheduleTimer(inst, id, n.id, computeDue(on.timer, now, inst.variables), cycleOf(on.timer));
      } else if (on.signal || on.message || on.escalation) {
        inst.tokens.push({ id, nodeId: n.id, state: 'waiting', waitFor: { kind: on.message ? 'message' : 'signal', ref: String(on.message || on.signal || on.escalation) }, listener: true, enteredAt: now });
      } else if (on.condition) {
        inst.tokens.push({ id, nodeId: n.id, state: 'waiting', waitFor: { kind: 'condition', ref: n.id }, listener: true, enteredAt: now });
      }
    }
  }

  /** An event sub-process trigger fired: (interrupting) end everything else in the scope, then run the sub-process body as a nested instance
   *  that shares this instance's variables. A non-interrupting listener stays armed for the next event. */
  private async fireEventSubprocess(inst: Instance, dep: Deployment, listener: Token): Promise<Instance> {
    const p = this.proc(inst, dep);
    const node = this.nodeMap(p).get(listener.nodeId) as any;
    if (!node) { this.removeToken(inst, listener.id); return this.runToQuiescence(inst, dep); }
    const interrupting = node.interrupting !== false;
    if (interrupting) {
      for (const t of [...inst.tokens]) {
        this.removeToken(inst, t.id);
        await this.cancelTimersForToken(inst, t.id);
        if (!t.listener) await this.exitOpenTaskForToken(t.id);
      }
      await this.abortDescendants(inst.id);
    } else if (listener.waitFor?.kind === 'condition') {
      this.removeToken(inst, listener.id);                      // a condition is an edge: it fires once
    }
    const run: Token = { id: this.ctx.newId(), nodeId: node.id, state: 'waiting', waitFor: { kind: 'child' }, enteredAt: this.ctx.clock() };
    inst.tokens.push(run);
    const child = await this.startChild(dep, `${p.id}::${node.id}`, { ...inst.variables }, inst.startedBy, inst.id, run.id);
    if (child.status === 'completed') { Object.assign(inst.variables, child.variables); this.removeToken(inst, run.id); }
    else if (child.status === 'aborted' || child.status === 'failed') {
      this.removeToken(inst, run.id);
      if (!(await this.raiseError(inst, p, dep, node.id, 'SUBPROCESS_ERROR', `event sub-process ${child.status}: ${child.id}`))) { inst.status = 'failed'; inst.error ||= { nodeId: node.id, message: `event sub-process ${child.status}`, at: this.ctx.clock() }; return this.runToQuiescence(inst, dep); }
    } else run.waitFor = { kind: 'child', ref: child.id };
    inst.status = 'running';
    return this.runToQuiescence(inst, dep);
  }

  /** Ad-hoc scope with a completion condition: complete when it becomes true. `completed` = node visits finished so far, `active` = tokens in play. */
  private async adHocComplete(inst: Instance, p: EngineProcess, dep: Deployment): Promise<boolean> {
    const expr = (p as any).completionCondition;
    if (!(p as any).adHoc || !expr || !inst.tokens.some((t) => t.waitFor?.kind === 'adhoc')) return false;
    const live = new Set(inst.tokens.map((t) => t.id));         // a step has finished when its token is gone
    const completed = inst.history.filter((h) => h.tokenId !== '-' && !live.has(h.tokenId) && h.outcome !== 'queued').length + Object.values(inst.historyCompacted ?? {}).reduce((a, b) => a + b, 0);
    const active = inst.tokens.filter((t) => !t.listener && t.waitFor?.kind !== 'adhoc').length;
    const ok = await evalCondition(String(expr), 'js', { ...inst.variables, completed, active });
    if (ok) inst.tokens = inst.tokens.filter((t) => t.listener).map((t) => t);
    return ok;
  }

  /** Conditional events (catch / boundary): a token waiting on a condition is released when the condition becomes true. Called whenever an
   *  instance has nothing left to run (so after any node, signal, task completion or variable edit) — only THIS instance's waiting condition
   *  tokens are looked at, so there is no polling and no scan of other instances. Returns true when something woke up. */
  private async wakeConditions(inst: Instance, p: EngineProcess, dep: Deployment): Promise<boolean> {
    const waiting = inst.tokens.filter((t) => t.state === 'waiting' && t.waitFor?.kind === 'condition');
    if (!waiting.length) return false;
    const nodes = this.nodeMap(p);
    let woke = false;
    for (const t of waiting) {
      const node = nodes.get(t.nodeId) as any;
      const expr = node?.event?.condition ?? (t.listener ? node?.on?.condition : undefined);
      if (!expr) continue;
      const c = this.buildCtx(node, inst, p, {}, dep, t.id);
      const ok = await evalCondition(String(expr), node.event?.lang, inst.variables, undefined, varTypesOf(c), { ...kcontextInfoOf(c), ...(await scriptLimitsOf(c)), onAction: onActionOf(c) });
      if (!ok) continue;
      if (t.listener) { await this.fireEventSubprocess(inst, dep, t); return true; }
      if (node.type === 'boundary') await this.activateBoundary(inst, dep, node, t.id);
      else { t.state = 'active'; t.waitFor = undefined; }               // the catch runs again, sees its condition true, and passes
      woke = true;
    }
    return woke;
  }
  /** After an outside change to an instance's variables: let any satisfied condition proceed. */
  async recheckConditions(inst: Instance, dep: Deployment): Promise<Instance> {
    if (!inst.tokens.some((t) => t.state === 'waiting' && t.waitFor?.kind === 'condition')) return inst;
    if (inst.status === 'waiting') inst.status = 'running';
    return this.runToQuiescence(inst, dep);
  }

  /** Variable tags (jBPM): `required` — the instance cannot start without a value for it. */
  private assertRequiredVars(p: EngineProcess, vars: Record<string, unknown>): void {
    const missing = (p.vars || []).filter((v) => (v as any).tags?.includes?.('required') && (vars[v.name] === undefined || vars[v.name] === null || vars[v.name] === '')).map((v) => v.name);
    if (missing.length) throw validation(`required variable${missing.length > 1 ? 's' : ''} missing: ${missing.join(', ')}`, { missing });
  }

  /** Process-level properties applied once at start: description template, process SLA, ad-hoc autostart nodes. */
  private applyProcessProperties(p: EngineProcess, inst: Instance, now: string): void {
    const pp = p as any;
    if (typeof pp.description === 'string' && pp.description.trim()) {
      inst.description = pp.description.replace(/#\{\s*([\w.]+)\s*\}/g, (_: string, k: string) => String(k.split('.').reduce((c: any, x: string) => (c == null ? undefined : c[x]), inst.variables) ?? '')).slice(0, 300);
    }
    if (typeof pp.slaDueDate === 'string' && pp.slaDueDate.trim()) {
      const dueAt = dueFrom(pp.slaDueDate, now, inst.variables);
      if (dueAt) {
        inst.sla = { dueAt, status: 'pending' };
        void this.timerRepo().put({ id: this.ctx.newId(), tenantId: this.ctx.tenantId, instanceId: inst.id, tokenId: '', nodeId: '', kind: 'sla', dueAt, fired: 0, status: 'scheduled' });
      }
    }
    if (pp.adHoc === true) {                                      // ad-hoc: nodes marked autoStart that nothing flows into begin on their own
      for (const n of p.nodes as any[]) {
        if (n.autoStart === true && n.type !== 'start' && !p.flows.some((f) => f.to === n.id)) inst.tokens.push({ id: this.ctx.newId(), nodeId: n.id, state: 'active', enteredAt: now });
      }
      // with a completion condition the scope stays open (people start activities on demand) until the condition is true
      if (pp.completionCondition && !inst.tokens.some((t) => t.waitFor?.kind === 'adhoc')) inst.tokens.push({ id: this.ctx.newId(), nodeId: '__adhoc', state: 'waiting', waitFor: { kind: 'adhoc' }, enteredAt: now });
    }
    this.armEventSubprocesses(p, inst, now);
  }

  /** Advance every active token until the instance waits, completes, aborts, or fails. */
  async runToQuiescence(inst: Instance, dep: Deployment): Promise<Instance> {
    const p = this.proc(inst, dep);
    const nodes = this.nodeMap(p);
    const joins: Record<string, Set<string>> = {};
    let guard = 0;
    const pendingLocal: string[] = [];
    const roVars = (p.vars || []).filter((v) => (v as any).tags?.includes?.('readonly')).map((v) => v.name);
    try {
      while (inst.status === 'running') {
        const token = inst.tokens.find((t) => t.state === 'active');
        if (!token) {
          // signals thrown with scope 'instance' are delivered now that this step has settled (never re-entering the loop mid-step)
          if (pendingLocal.length) { for (const nm of pendingLocal.splice(0)) await this.signalInstance(inst, dep, nm); continue; }
          if (await this.wakeConditions(inst, p, dep)) continue;
          if (await this.adHocComplete(inst, p, dep)) { inst.tokens = []; break; }
          break;
        }
        if (++guard > 100000) throw new Error('step budget exceeded (possible loop)');
        const node = nodes.get(token.nodeId);
        if (!node) { this.removeToken(inst, token.id); continue; }

        const visit: NodeVisit = { tokenId: token.id, nodeId: node.id!, type: node.type, enteredAt: this.ctx.clock(), ...(token.sla ? { sla: { ...token.sla } } : {}) };
        inst.history.push(visit);
        this.emit({ kind: 'node.entered', instanceId: inst.id, nodeId: node.id!, tokenId: token.id });

        const before: Record<string, string | undefined> = {};
        for (const n of roVars) before[n] = inst.variables[n] === undefined ? undefined : JSON.stringify(inst.variables[n]);
        let result: HandlerResult;
        try { result = await this.handle(node, inst, p, joins, dep, token.id); }
        catch (e) { result = { error: (e as Error).message, errorCode: 'RUNTIME_ERROR' }; }

        if (result.vars) Object.assign(inst.variables, result.vars);
        if (roVars.length) {                                       // `readonly` variables: set once; a later change is refused and undone
          const changed = roVars.find((n) => before[n] !== undefined && JSON.stringify(inst.variables[n]) !== before[n]);
          if (changed) {
            for (const n of roVars) if (before[n] !== undefined) inst.variables[n] = JSON.parse(before[n]!);
            result = { error: `variable "${changed}" is read-only and was already set`, errorCode: 'VARIABLE_READONLY' };
          }
        }
        visit.exitedAt = this.ctx.clock();
        visit.outcome = result.outcome || (result.wait ? 'waiting' : result.end || (result.error ? 'error' : 'done'));
        this.emit({ kind: 'node.exited', instanceId: inst.id, nodeId: node.id!, tokenId: token.id });

        if (result.abort) { inst.tokens = []; inst.status = 'aborted'; if ((result as any).cancelled) { inst.cancelled = true; if (result.vars) Object.assign(inst.variables, result.vars); } break; }
        if (result.signalLocal) pendingLocal.push(result.signalLocal);
        if (result.wait?.kind === 'async') {
          // jBPM "Is Async": park the token (the instance is saved), hand the node to the worker, and let the caller go
          token.state = 'waiting'; token.waitFor = result.wait; visit.outcome = 'queued';
          try { await this.scheduleAsync(inst, token.id, node.id!, node as any); await this.startSla(inst, token, node as any, visit); }
          catch (e) {
            this.removeToken(inst, token.id);
            if (await this.raiseError(inst, p, dep, node.id!, 'RUNTIME_ERROR', (e as Error).message)) continue;
            inst.status = 'failed'; inst.error = { nodeId: node.id!, message: (e as Error).message, at: this.ctx.clock() }; break;
          }
          continue;
        }
        if (result.wait) {
          token.state = 'waiting'; token.waitFor = result.wait;
          try {
            await this.startSla(inst, token, node as any, visit);
            if (result.wait.kind === 'timer' && result.wait.dueAt) await this.scheduleTimer(inst, token.id, node.id!, result.wait.dueAt);
            // schedule any timer boundary events attached to this (now waiting) host node — WHICH
            // boundaries match is boundary/handler.ts's own decision; scheduling the actual TimerJob
            // still needs this.ctx.newId()/clock() and the timer repo, so that part stays here.
            for (const b of boundaryHandler.boundaryTimerHosts(p.nodes, node.id!)) {
              const spec = (b as any).event.timer;
              const cycle = cycleOf(spec);
              await this.scheduleTimer(inst, token.id, b.id!, computeDue(spec, this.ctx.clock(), inst.variables), cycle);
            }
          } catch (e) {
            // couldn't durably schedule the timer (e.g. maxActiveTimers quota) — fail this node the
            // same way a handler error does, rather than leave the token parked on a wait nothing
            // will ever resolve (default maxActiveTimers is 0/unlimited, so this never fires unless
            // an admin opted in — no behavior change for any existing deployment).
            this.removeToken(inst, token.id);
            const code = (e as { code?: string }).code === 'QUOTA_EXCEEDED' ? 'QUOTA_EXCEEDED' : 'RUNTIME_ERROR';
            if (await this.raiseError(inst, p, dep, node.id!, code, (e as Error).message)) continue;
            inst.status = 'failed'; inst.error = { nodeId: node.id!, message: (e as Error).message, at: this.ctx.clock() }; break;
          }
          // Message/signal/escalation boundaries get a WAITING token of their own, same idea as the
          // timer boundaries just above but via a token broadcast()/signalInstance() can resume,
          // instead of a TimerJob — see resumeToken()'s own boundary branch for what happens when one
          // of these actually resolves.
          for (const b of boundaryHandler.messageBoundaryHosts(p.nodes, node.id!)) {
            inst.tokens.push({ id: this.ctx.newId(), nodeId: b.node.id!, state: 'waiting', waitFor: { kind: b.kind, ref: b.name }, enteredAt: this.ctx.clock() });
          }
          continue;
        }
        if (result.error) {
          this.removeToken(inst, token.id);
          const code = result.errorCode || 'RUNTIME_ERROR';
          if (await this.raiseError(inst, p, dep, node.id!, code, result.error, result.errorDetails)) continue;   // routed to an error catch
          inst.status = 'failed'; inst.error ||= { nodeId: node.id!, message: result.error, at: this.ctx.clock() }; break;
        }
        if (result.end === 'terminate') { inst.tokens = []; inst.status = 'completed'; break; }
        if (result.end === 'error') {
          this.removeToken(inst, token.id);
          const code = (node as any).throw?.error || 'ERROR';
          const rethrow = result.rethrow ?? (node as any).throw?.rethrow ?? (node as any).rethrow;
          if (await this.raiseError(inst, p, dep, node.id!, code, `error end: ${code}`, undefined, rethrow)) continue;
          inst.status = 'failed'; inst.error ||= { nodeId: node.id!, message: `unhandled error end (${code})`, at: this.ctx.clock() }; break;
        }
        // an activity that completed normally and has a compensation boundary → remember its handler.
        // WHICH boundaries match is boundary/handler.ts's decision; resolving the boundary's outgoing
        // flow to find the actual handler node needs this.outgoing (flow-list access boundary's
        // module doesn't have), so that resolution stays here.
        for (const b of boundaryHandler.compensationBoundaries(p.nodes, node.id!)) {
          const target = this.outgoing(p, b.id!)[0]?.to;
          if (target) (inst.compensations ||= []).push({ host: node.id!, handler: target });
        }
        // consume current token, then spawn successors — never past a self-abort a script just
        // triggered mid-handler (inst.status no longer 'running'): an aborted instance must not
        // keep accumulating new tokens just because the node it aborted from "completed normally"
        // from the handler's own point of view.
        if (token.sla) await this.settleSla(inst, token.id, 'met');
        this.removeHostToken(inst, p, token.id, node.id!);
        if (result.end === 'complete' || result.consume || inst.status !== 'running') { /* no successors */ }
        else {
          const targets = result.next ?? this.defaultTargets(p, node, inst);
          for (const t of targets) inst.tokens.push({ id: this.ctx.newId(), nodeId: t, state: 'active', enteredAt: this.ctx.clock() });
        }
      }
      // settle final status
      if (inst.status === 'running') {
        const keepsAlive = inst.tokens.some((t) => t.state === 'waiting' && !t.listener);
        inst.status = keepsAlive ? 'waiting' : 'completed';
        if (!keepsAlive) inst.tokens = [];                          // only event sub-process listeners were left: the scope has ended, so they go with it
      }
      if (inst.status === 'completed' || inst.status === 'aborted' || inst.status === 'failed') inst.endedAt = this.ctx.clock();
      if (inst.status === 'completed' && inst.sla?.status === 'pending') inst.sla = { ...inst.sla, status: 'met', at: this.ctx.clock() };
    } catch (err) {
      inst.status = 'failed';
      inst.error = { nodeId: '', message: (err as Error).message, stack: (err as Error).stack, at: this.ctx.clock() };
      inst.endedAt = this.ctx.clock();
    }
    compactHistory(inst);
    await this.inst().put(inst);
    this.emit({ kind: inst.status === 'failed' ? 'instance.failed' : inst.status === 'completed' ? 'instance.completed' : 'instance.updated', instanceId: inst.id });
    // Reached a terminal state → no orphans: abort any still-active child instances (e.g. a terminate
    // end / failure left parallel call-activities or sub-processes running), AND no dangling tasks —
    // an interrupting boundary timer/error cancels its host token here (see fireBoundary/raiseError)
    // but never touched the separate Task record for that host, and a terminate end or unhandled
    // failure can just as easily leave an OTHER parallel branch's task open. Any instance that just
    // became completed/aborted/failed must leave zero actionable tasks behind.
    if (inst.status === 'completed' || inst.status === 'aborted' || inst.status === 'failed') {
      await this.cancelTimersForInstance(inst.id);
      await this.exitOpenTasks(inst.id);
      await this.abortDescendants(inst.id);
    }
    // Notify the parent's waiting call/sub-process token: completed → resume; aborted/failed → propagate.
    if (inst.parentInstanceId) {
      // after this instance's lock is released: two instances must never wait on each other's lock (see instance-lock.ts)
      if (inst.status === 'completed') await deferAfterLock(() => this.tryResumeParent(inst));
      else if (inst.status === 'aborted' || inst.status === 'failed') await deferAfterLock(() => this.tryFailParent(inst));
    }
    return inst;
  }

  /** Abort every still-active descendant instance (recursively), cancelling their timers. An
   *  `independent` child (see `Instance.independent`) is skipped — its lifecycle isn't tied to its
   *  parent's, so it keeps running standalone instead of being cascade-torn-down. */
  private async abortDescendants(parentId: string): Promise<void> {
    const children = await this.inst().query((c) =>
      c.tenantId === this.ctx.tenantId && c.parentInstanceId === parentId &&
      (c.status === 'running' || c.status === 'waiting' || c.status === 'suspended'));
    for (const child of children) {
      if (child.independent) continue;
      child.status = 'aborted'; child.tokens = []; child.endedAt = this.ctx.clock();
      await this.cancelTimersForInstance(child.id);
      await this.exitOpenTasks(child.id);
      await this.inst().put(child);
      this.emit({ kind: 'instance.updated', instanceId: child.id });
      await this.abortDescendants(child.id);
    }
  }

  /** No instance in a terminal state should leave an actionable task behind — see the callers'
   *  comments for the specific ways a task's host activity can otherwise be cancelled without the
   *  separate Task record ever finding out. 'exited' (jBPM's own term) covers every such case; a
   *  task already completed/skipped/errored (its OWN terminal states) is untouched. */
  private async exitOpenTasks(instanceId: string): Promise<void> {
    const open = await this.ctx.store.repo<Task>(Collections.tasks).query((t) =>
      t.tenantId === this.ctx.tenantId && t.instanceId === instanceId &&
      (t.status === 'created' || t.status === 'reserved' || t.status === 'inprogress'));
    for (const t of open) { t.status = 'exited'; await this.ctx.store.repo<Task>(Collections.tasks).put(t); }
  }

  /** Same, scoped to one token — an interrupting boundary cancels only ITS host token, which may be
   *  one of several still-active branches on a parallel gateway; the instance itself stays running,
   *  so exitOpenTasks(instanceId) above (only called once the whole instance settles) would never
   *  reach this task otherwise. */
  private async exitOpenTaskForToken(tokenId: string): Promise<void> {
    const open = await this.ctx.store.repo<Task>(Collections.tasks).query((t) =>
      t.tenantId === this.ctx.tenantId && t.tokenId === tokenId &&
      (t.status === 'created' || t.status === 'reserved' || t.status === 'inprogress'));
    for (const t of open) { t.status = 'exited'; await this.ctx.store.repo<Task>(Collections.tasks).put(t); }
  }

  /** Public entry: abort an instance and its whole subtree; also unblock a waiting parent. */
  async abortInstance(inst: Instance): Promise<Instance> {
    if (inst.status === 'completed' || inst.status === 'aborted') return inst;
    inst.status = 'aborted'; inst.tokens = []; inst.endedAt = this.ctx.clock();
    await this.cancelTimersForInstance(inst.id);
    await this.exitOpenTasks(inst.id);
    await this.inst().put(inst);
    this.emit({ kind: 'instance.updated', instanceId: inst.id });
    await this.abortDescendants(inst.id);
    if (inst.parentInstanceId) await this.tryFailParent(inst);
    return inst;
  }

  /** A child instance aborted/failed → remove the parent's waiting token and raise an error there
   *  (routes to an error boundary if one is attached, otherwise the parent fails and cascades). */
  private tryFailParent(child: Instance): Promise<void> {
    return withInstanceLock(this.ctx.tenantId, child.parentInstanceId!, () => this.tryFailParentLocked(child));
  }
  private async tryFailParentLocked(child: Instance): Promise<void> {
    const parent = await this.inst().get(child.parentInstanceId!);
    if (!parent || parent.status === 'completed' || parent.status === 'aborted' || parent.status === 'failed') return;
    const token = parent.tokens.find((t) => t.state === 'waiting' &&
      ((t.waitFor?.kind === 'child' && t.waitFor?.ref === child.id) || (t.waitFor?.kind === 'multiInstance' && t.id === child.parentTokenId)));
    if (!token) return;
    const pdep = await this.deps().get(parent.deploymentId);
    if (!pdep) return;
    const p = this.pick(pdep, parent.processId);
    if (token.waitFor?.kind === 'multiInstance') { await this.settleMultiInstance(parent, pdep, p, token); return; }
    this.removeToken(parent, token.id);
    // Same code family the sync completion path in call/handler.ts and subprocess/handler.ts raises
    // for the identical failure, just detected later (the child instead parked in a wait) — kept in
    // sync so a boundary/global catch sees the same code regardless of which path the child took.
    const callNode = p.nodes.find((n) => n.id === token.nodeId) as any;
    const policy = callNode?.type === 'call' ? callNode.onChildFailure : undefined;
    if (policy === 'continue') {                                  // carry on: record what happened, follow the normal outgoing flow
      parent.variables[callNode.errorVar || 'callError'] = { childInstanceId: child.id, childStatus: child.status, childError: child.error ?? null };
      for (const t of this.defaultTargets(p, callNode, parent)) parent.tokens.push({ id: this.ctx.newId(), nodeId: t, state: 'active', enteredAt: this.ctx.clock() });
      parent.status = 'running';
      await this.runToQuiescence(parent, pdep);
      return;
    }
    if (policy === 'abort') {                                     // abort the parent at once (no error routing); the usual cleanup + upward notification follow
      parent.tokens = []; parent.status = 'aborted';
      await this.runToQuiescence(parent, pdep);
      return;
    }
    const prefix = callNode?.type === 'call' ? 'CALL' : 'SUBPROCESS';
    const code = child.cancelled ? 'TRANSACTION_CANCELLED' : `${prefix}_${child.status === 'aborted' ? 'ABORTED' : 'ERROR'}`;
    await this.failParentWith(parent, p, pdep, token.nodeId, code, `child instance ${child.status}: ${child.id}`);
  }

  /** A child instance completed → map its outputs into the parent and continue the parent flow. */
  private tryResumeParent(child: Instance): Promise<void> {
    return withInstanceLock(this.ctx.tenantId, child.parentInstanceId!, () => this.tryResumeParentLocked(child));
  }
  private async tryResumeParentLocked(child: Instance): Promise<void> {
    const parent = await this.inst().get(child.parentInstanceId!);
    if (!parent) return;
    const token = parent.tokens.find((t) => t.state === 'waiting' &&
      ((t.waitFor?.kind === 'child' && t.waitFor?.ref === child.id) || (t.waitFor?.kind === 'multiInstance' && t.id === child.parentTokenId)));
    if (!token) return;
    const pdep = await this.deps().get(parent.deploymentId);
    if (!pdep) return;
    const p = this.pick(pdep, parent.processId);
    if (token.waitFor?.kind === 'multiInstance') { await this.settleMultiInstance(parent, pdep, p, token); return; }
    const callNode = p.nodes.find((n) => n.id === token.nodeId) as any;
    // Mapping is node-type-specific (subprocess shares scope, call is isolated) — see each type's own
    // mapChildOutputs in nodes/index.ts's CHILD_OUTPUT_MAPPERS (same logic the sync-completion path uses).
    const mapper = callNode ? CHILD_OUTPUT_MAPPERS[callNode.type as string] : undefined;
    const vars = mapper ? mapper(callNode, child) : {};
    if (child.isErrorHandler && pdep.globalErrorHandler) {
      let mappings = pdep.globalErrorHandler.outputMappings;
      if (pdep.globalErrorHandler.rules) {
        const matched = pdep.globalErrorHandler.rules.find((r) => r.processId === child.processId);
        if (matched?.outputMappings) mappings = matched.outputMappings;
      }
      if (mappings) {
        for (const [targetVar, sourceVar] of Object.entries(mappings)) {
          if (child.variables[sourceVar] !== undefined) {
            vars[targetVar] = child.variables[sourceVar];
          } else if (child.variables[targetVar] !== undefined) {
            vars[sourceVar] = child.variables[targetVar];
          }
        }
      }
      vars['errorRepaired'] = true;
      if (child.variables['errorHandlerAction'] === 'retry') {
        Object.assign(parent.variables, vars);
        delete parent.error;
        this.removeToken(parent, token.id);
        parent.tokens.push({ id: this.ctx.newId(), nodeId: token.nodeId, state: 'active', enteredAt: this.ctx.clock() });
        parent.status = 'running';
        await this.runToQuiescence(parent, pdep);
        return;
      }
    }
    await this.resumeToken(parent, pdep, token.id, vars);
  }

  /** Shared terminal-outcome logic for a child settling into a parent's waiting call/subprocess/
   *  multi-instance token: route to an error boundary if one is attached, otherwise fail the parent
   *  and cascade upward — the same either way regardless of which node type raised it. */
  private async failParentWith(parent: Instance, p: EngineProcess, pdep: Deployment, nodeId: string, code: string, message: string): Promise<void> {
    if (await this.raiseError(parent, p, pdep, nodeId, code, message)) {
      parent.status = 'running';
      await this.runToQuiescence(parent, pdep);   // handler token → runs recovery, then settles (may cascade)
    } else {
      parent.status = 'failed';
      parent.error = { nodeId, message, at: this.ctx.clock() };
      parent.endedAt = this.ctx.clock();
      await this.exitOpenTasks(parent.id);
      await this.inst().put(parent);
      this.emit({ kind: 'instance.failed', instanceId: parent.id });
      await this.abortDescendants(parent.id);
      if (parent.parentInstanceId) await this.tryFailParent(parent);   // propagate up
    }
  }

  /** One of a multi-instance (forEach) node's children just settled (completed/failed/aborted) —
   *  re-derive the node's full state from ALL its children (found by parentTokenId, not stored on the
   *  token itself — see WaitSpec's 'multiInstance' doc comment) and either: start the next item
   *  (sequential, more items left, nothing failed yet), stay parked (parallel, some still running),
   *  fail the node (any child aborted/failed — real MI default semantics), or resume with the
   *  collected itemResult array (every child completed). */
  private async settleMultiInstance(parent: Instance, pdep: Deployment, p: EngineProcess, token: Token): Promise<void> {
    const raw = p.nodes.find((node) => node.id === token.nodeId) as any;
    if (!raw) { this.removeToken(parent, token.id); return; }
    const n = raw.multiInstance ? miView(raw, p) : raw;
    const items = Array.isArray(parent.variables[n.over]) ? (parent.variables[n.over] as unknown[]) : [];
    let siblings = (await this.inst().query((i) => i.tenantId === this.ctx.tenantId && i.parentInstanceId === parent.id && i.parentTokenId === token.id))
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const alreadyFailed = siblings.some((s) => s.status === 'failed' || s.status === 'aborted');
    if (!n.parallel && !alreadyFailed && siblings.length < items.length && siblings.every((s) => s.status === 'completed')) {
      const item = items[siblings.length];
      const childVars: Record<string, unknown> = n.miInline ? { ...parent.variables } : {};
      for (const v of (n.pass || [])) childVars[v] = parent.variables[v];
      if (n.as) childVars[n.as] = item;
      const resolved = n.miInline ? { dep: pdep, processId: n.process } : this.resolveCalled ? await this.resolveCalled(n.process, pdep) : undefined;
      if (resolved) {
        await this.startChild(resolved.dep, resolved.processId, childVars, parent.startedBy, parent.id, token.id);
        siblings = (await this.inst().query((i) => i.tenantId === this.ctx.tenantId && i.parentInstanceId === parent.id && i.parentTokenId === token.id))
          .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      }
    }
    if (!siblings.some((s) => s.status === 'failed' || s.status === 'aborted') && await completionReached(n, siblings, items.length, parent.variables)) {
      // early finish: the parent moves on with the results so far; the still-running items are aborted AFTER the parent's wait is gone,
      // so their abort does not raise an error back into it
      const leftovers = siblings.filter((s) => s.status === 'running' || s.status === 'waiting' || s.status === 'suspended');
      await this.resumeToken(parent, pdep, token.id, collectCompleted(siblings, n));
      for (const l of leftovers) { const fresh = await this.inst().get(l.id); if (fresh && (fresh.status === 'running' || fresh.status === 'waiting' || fresh.status === 'suspended')) await this.abortInstance(fresh); }
      return;
    }
    const result = buildMultiInstanceResult(siblings, items.length, n);
    if (result.wait) return;   // still outstanding children — stay parked, nothing to do yet
    if (result.error) {
      this.removeToken(parent, token.id);
      await this.failParentWith(parent, p, pdep, token.nodeId!, result.errorCode || 'MULTIINSTANCE_ERROR', result.error);
      return;
    }
    // Same "exit the wait node, spawn successors, resume the loop" path every other wait-node type
    // resumes through — gets onExit/cancelEventGatewaySiblings/defaultTargets for free instead of
    // duplicating them here.
    await this.resumeToken(parent, pdep, token.id, result.vars);
  }

  /** Start a child process instance linked to a parent token (call activity). `independent` decouples
   *  the child's lifecycle from the parent's — see the `Instance.independent` doc comment. */
  private async startChild(dep: Deployment, processId: string, vars: Record<string, unknown>, actor: string, parentInstanceId: string, parentTokenId: string, independent?: boolean): Promise<Instance> {
    const p = this.pick(dep, processId);
    const startNode = p.nodes.find((n) => n.type === 'start') || p.nodes[0];
    const now = this.ctx.clock();
    const seed: Record<string, unknown> = {};
    for (const v of p.vars || []) seed[v.name] = undefined;
    const child: Instance = {
      id: this.ctx.newId(), tenantId: this.ctx.tenantId, deploymentId: dep.id, workflowId: dep.workflowId, processId: p.id,
      status: 'running', variables: { ...seed, ...vars },
      tokens: (p as any).adHoc ? [] : [{ id: this.ctx.newId(), nodeId: startNode!.id!, state: 'active', enteredAt: now }],
      history: [], startedAt: now, startedBy: actor, parentInstanceId, parentTokenId,
      ...(independent ? { independent: true } : {}),
    };
    this.assertRequiredVars(p, child.variables);
    this.applyProcessProperties(p, child, now);
    this.emit({ kind: 'instance.started', instanceId: child.id });
    return this.runToQuiescence(child, dep);
  }

  /**
   * Run compensation handlers for successfully-completed activities in reverse (LIFO) order. `ref`
   * limits compensation to a single host activity; omitted → compensate everything recorded so far.
   * Handlers execute inline (they don't spawn into the main flow); each is recorded in history.
   */
  private async compensate(inst: Instance, p: EngineProcess, dep: Deployment, ref?: string): Promise<Record<string, unknown>> {
    const all = inst.compensations || [];
    const toRun = [...all].reverse().filter((c) => !ref || c.host === ref);
    const merged: Record<string, unknown> = {};
    const nodes = this.nodeMap(p);
    for (const entry of toRun) {
      const handler = nodes.get(entry.handler);
      if (!handler) continue;
      const visit: NodeVisit = { tokenId: 'compensation', nodeId: handler.id!, type: handler.type, enteredAt: this.ctx.clock() };
      inst.history.push(visit);
      this.emit({ kind: 'node.entered', instanceId: inst.id, nodeId: handler.id!, tokenId: 'compensation' });
      let res: HandlerResult;
      try { res = await this.handle(handler, inst, p, {}, dep, 'compensation'); }
      catch (e) { res = { error: (e as Error).message }; }
      if (res.vars) { Object.assign(inst.variables, res.vars); Object.assign(merged, res.vars); }
      visit.exitedAt = this.ctx.clock(); visit.outcome = res.error ? `compensation-error: ${res.error}` : 'compensated';
      this.emit({ kind: 'node.exited', instanceId: inst.id, nodeId: handler.id!, tokenId: 'compensation' });
    }
    // consume the entries we just compensated
    inst.compensations = all.filter((c) => (ref ? c.host !== ref : false));
    return merged;
  }

  /** Broadcast a signal/message to every waiting instance in the tenant (send/throw/end-throw), and
   *  also start a fresh instance of any deployed process whose start event listens for this exact
   *  name — the process-level counterpart to a mid-flow catch/boundary (real jBPM's signal-start /
   *  message-start event). `correlationValue`, when the thrower declares one (see `EventDef.
   *  correlationKey` — a $var reference resolved on the throwing side), narrows delivery to only the
   *  instance(s) whose OWN `correlationKey` (set at `start()`) matches — otherwise EVERY instance
   *  waiting on that name resumes, which is wrong the moment more than one instance of the same
   *  process is waiting on the same message type at once (e.g. N claims all waiting on
   *  "PaymentReceived" — without this, one payment webhook would incorrectly resume all N). Signal/
   *  message-START events are never correlation-scoped: a brand-new instance has no correlationKey
   *  yet to match against. */
  /** Broadcast a signal across all running/waiting instances in the tenant + trigger any matching signal-start events.
   *  Matches jBPM KIE-Server POST /server/containers/{id}/processes/instances/signal/{signalName}. */
  async broadcastSignal(name: string, payload?: unknown, correlationValue?: string): Promise<{ signaled: number }> {
    // only the instances that have a token waiting on this name — an indexed lookup, not a scan of every live instance's full row
    const others = await findRows<Instance>(this.ctx.store, Collections.instances, this.ctx.tenantId, {
      eq: { status: ['waiting', 'running'] }, contains: { path: 'tokens', value: [{ waitFor: { ref: name } }] },
    });
    let count = 0;
    for (const other of others) {
      if (correlationValue !== undefined && other.correlationKey !== correlationValue) continue;
      const hit = other.tokens.some((t) => t.state === 'waiting' && (t.waitFor?.kind === 'signal' || t.waitFor?.kind === 'message') && t.waitFor?.ref === name);
      if (!hit) continue;
      // each delivery under the instance's lock, on a FRESH copy (the one above may be stale by now); idempotent: it only acts if a token is still waiting
      const delivered = await withInstanceLock(this.ctx.tenantId, other.id, async () => {
        const fresh = await this.inst().get(other.id);
        if (!fresh || !fresh.tokens.some((t) => t.state === 'waiting' && (t.waitFor?.kind === 'signal' || t.waitFor?.kind === 'message') && t.waitFor?.ref === name)) return false;
        const dep = await this.deps().get(fresh.deploymentId);
        if (!dep) return false;
        await this.signalInstance(fresh, dep, name, payload);
        return true;
      });
      if (delivered) count++;
    }
    if (correlationValue === undefined) await this.startTriggeredProcesses(name);
    return { signaled: count };
  }

  private async broadcast(name: string, correlationValue?: string): Promise<void> {
    await this.broadcastSignal(name, undefined, correlationValue);
  }

  /** Signal/message-start events: begin a new instance of every active deployment's process whose
   *  start node's `on.signal`/`on.message` matches `name`. */
  private async startTriggeredProcesses(name: string): Promise<void> {
    const active = await this.deps().query((d) => d.tenantId === this.ctx.tenantId && d.status === 'active');
    for (const dep of active) {
      for (const p of dep.engine?.processes || []) {
        const startNode = p.nodes.find((n) => n.type === 'start') as any;
        const on = startNode?.on;
        const kind = on?.signal === name ? 'signal' : on?.message === name ? 'message' : undefined;
        if (kind) await this.start(dep, {}, kind, { processId: p.id });
        // an event-based gateway marked `instantiate` starts the process when ANY of the events after it arrives (one instance per event)
        const gw = (p.nodes as any[]).find((n) => n.type === 'gateway' && n.mode === 'event' && n.instantiate === true);
        if (gw) {
          for (const f of p.flows.filter((x) => x.from === gw.id)) {
            const t = p.nodes.find((n) => n.id === f.to) as any;
            const ev = t?.type === 'catch' ? t.event : undefined;
            if (ev && (ev.signal === name || ev.message === name)) { await this.start(dep, {}, ev.signal === name ? 'signal' : 'message', { processId: p.id, startAt: t.id }); break; }
          }
        }
      }
    }
  }

  /** Deliver a signal/message to an instance: resume every token waiting on that name. */
  async signalInstance(inst: Instance, dep: Deployment, name: string, payload?: unknown): Promise<Instance> {
    const targets = inst.tokens
      .filter((t) => t.state === 'waiting' && (t.waitFor?.kind === 'signal' || t.waitFor?.kind === 'message') && t.waitFor?.ref === name)
      .map((t) => t.id);
    for (const tid of targets) {
      if (inst.tokens.find((t) => t.id === tid && t.state === 'waiting')) {
        await this.resumeToken(inst, dep, tid, payload !== undefined ? { [name]: payload } : undefined);
      }
    }
    return inst;
  }

  /** Deliver a signal to ONE specific instance by id — matches real jBPM's targeted
   *  kcontext.getKieRuntime().signalEvent(type, event, processInstanceId), as opposed to broadcast()'s
   *  session-wide delivery. A no-op (not an error) if the id doesn't resolve within this tenant —
   *  matches how a script/condition kcontext call has no result to fail loudly against.
   *
   *  Self-targeted (the calling instance signaling itself) is special-cased to mutate `callerInst`
   *  directly rather than re-fetching by id: the store's `.get()` returns whatever was last `.put()`,
   *  a SEPARATE object from the one `runToQuiescence`'s loop is actively stepping through in memory.
   *  Mutating a fresh fetch would get silently overwritten when the loop persists its own reference
   *  at the end of its own processing — confirmed by a real test failure before this fix existed. */
  private async signalTargeted(callerInst: Instance, callerDep: Deployment, targetInstanceId: string, name: string, payload?: unknown): Promise<void> {
    if (targetInstanceId === callerInst.id) { await this.signalInstance(callerInst, callerDep, name, payload); return; }
    const target = await this.inst().get(targetInstanceId);
    if (!target || target.tenantId !== this.ctx.tenantId) return;
    const dep = await this.deps().get(target.deploymentId);
    if (dep) await this.signalInstance(target, dep, name, payload);
  }

  /** Abort ONE specific instance by id — matches real jBPM's kcontext.getKieRuntime().
   *  abortProcessInstance(id). Reuses the same public abortInstance() the REST abort endpoint already
   *  uses (aborts the whole subtree, cancels timers), so a script-triggered abort behaves identically
   *  to an operator-triggered one. A no-op if the id doesn't resolve within this tenant. Self-targeted
   *  case: see signalTargeted's comment — same reasoning, same fix. */
  private async abortTargeted(callerInst: Instance, targetInstanceId: string): Promise<void> {
    if (targetInstanceId === callerInst.id) { await this.abortInstance(callerInst); return; }
    const target = await this.inst().get(targetInstanceId);
    if (target && target.tenantId === this.ctx.tenantId) await this.abortInstance(target);
  }

  /** Re-trigger a node: drop a fresh active token onto it and run (retry a failed node or replay). */
  async retryNode(inst: Instance, dep: Deployment, nodeId: string): Promise<Instance> {
    inst.error = undefined;
    inst.tokens.push({ id: this.ctx.newId(), nodeId, state: 'active', enteredAt: this.ctx.clock() });
    inst.status = 'running';
    return this.runToQuiescence(inst, dep);
  }

  private removeToken(inst: Instance, tokenId: string) { inst.tokens = inst.tokens.filter((t) => t.id !== tokenId); }

  /** Remove a host token AND any sibling message/signal/escalation boundary tokens still waiting on
   *  it (see messageBoundaryHosts) — those are real entries in inst.tokens (unlike a timer boundary's
   *  wait, which lives in a separate TimerJob record already cleaned up via cancelTimersForToken), so
   *  leaving one behind after its host is gone for ANY reason — normal completion, a DIFFERENT
   *  boundary interrupting it, direct resumption — would permanently block the instance from ever
   *  settling out of 'waiting' (see runToQuiescence's settle check). */
  private removeHostToken(inst: Instance, p: EngineProcess, hostTokenId: string, hostNodeId: string): void {
    this.removeToken(inst, hostTokenId);
    const boundaryIds = new Set(boundaryHandler.messageBoundaryHosts(p.nodes, hostNodeId).map((b) => b.node.id!));
    if (boundaryIds.size) inst.tokens = inst.tokens.filter((t) => !(t.state === 'waiting' && boundaryIds.has(t.nodeId)));
  }

  // ---- timers ----
  private timerRepo() { return this.ctx.store.repo<TimerJob>(Collections.timers); }
  /** `cycle` (boundary timers only — see call site) lets TimerService reschedule this job for its next
   *  occurrence after firing, instead of the one-shot behavior every other timer kind wants. */
  private async scheduleTimer(inst: Instance, tokenId: string, nodeId: string, dueAt: string, cycle?: string) {
    const { maxActiveTimers } = (await effectiveLimitsFor(this.ctx)).effective;
    if (maxActiveTimers) {
      const active = await this.timerRepo().query((t) => t.tenantId === this.ctx.tenantId && t.status === 'scheduled');
      if (active.length >= maxActiveTimers) {
        throw quotaExceeded(`per-tenant active-timer quota exceeded (max ${maxActiveTimers})`, { quota: 'maxActiveTimers', max: maxActiveTimers, current: active.length });
      }
    }
    await this.timerRepo().put({ id: this.ctx.newId(), tenantId: this.ctx.tenantId, instanceId: inst.id, tokenId, nodeId, kind: 'duration', dueAt, cycle, fired: 0, status: 'scheduled' });
  }
  /** Queue the worker job that runs a parked node. `node` carries the author's `asyncRetries` / `asyncRetryDelay`; a background
   *  start passes none and gets the workspace defaults. Due immediately: the worker (or the in-process kick) picks it up. */
  private async scheduleAsync(inst: Instance, tokenId: string, nodeId: string, node: { asyncRetries?: unknown; asyncRetryDelay?: unknown; asyncDelay?: unknown } | undefined) {
    const settings = await new SettingsService(this.ctx).get().catch(() => null);
    const retries = Number.isInteger(node?.asyncRetries) ? Number(node!.asyncRetries) : (settings?.defaultJobRetries ?? 3);
    const retryDelayMs = node?.asyncRetryDelay !== undefined && node.asyncRetryDelay !== '' ? parseDuration(String(node.asyncRetryDelay)) || 10_000 : 10_000;
    await this.timerRepo().put({
      id: this.ctx.newId(), tenantId: this.ctx.tenantId, instanceId: inst.id, tokenId, nodeId, kind: 'async', dueAt: node?.asyncDelay ? new Date(Date.parse(this.ctx.clock()) + (parseDelay(String(node.asyncDelay)) || 0)).toISOString() : this.ctx.clock(), fired: 0, status: 'scheduled',
      attempts: 0, maxAttempts: Math.max(1, retries + 1), retryDelayMs: Math.max(1000, retryDelayMs),
    });
    kickWorker();
  }
  /** The worker releases a parked token: the node runs for real now, and the instance continues until it waits or ends. */
  async fireAsync(inst: Instance, dep: Deployment, tokenId: string): Promise<Instance> {
    if (inst.status === 'suspended') throw conflict('instance is suspended');
    const token = inst.tokens.find((t) => t.id === tokenId);
    if (!token || token.state !== 'waiting' || token.waitFor?.kind !== 'async') return inst;   // resolved some other way (abort, retry)
    for (let i = inst.history.length - 1; i >= 0; i--) if (inst.history[i]!.tokenId === tokenId && inst.history[i]!.outcome === 'queued') { inst.history.splice(i, 1); break; }                          // the queued visit is replaced by the real one
    token.state = 'active'; token.waitFor = undefined; token.asyncReady = true;
    inst.status = 'running';
    return this.runToQuiescence(inst, dep);
  }
  /** jBPM "SLA Due Date" (customSLADueDate): when a node waits (or is queued) with an SLA, start its clock — compliance is
   *  pending, becomes met when the node completes before dueAt, violated when the SLA job fires first. Nodes that finish inline
   *  have nothing to measure, so they never reach this. Armed once per token (an async hop keeps the same clock). */
  private async startSla(inst: Instance, token: Token, node: { slaDueDate?: unknown }, visit: NodeVisit): Promise<void> {
    if (token.sla || typeof node.slaDueDate !== 'string' || !node.slaDueDate.trim()) return;
    const dueAt = dueFrom(node.slaDueDate, this.ctx.clock(), inst.variables);
    if (!dueAt) return;                                        // an unreadable SLA never blocks the process (validation flags it)
    token.sla = { dueAt, status: 'pending' }; visit.sla = { ...token.sla };
    await this.timerRepo().put({ id: this.ctx.newId(), tenantId: this.ctx.tenantId, instanceId: inst.id, tokenId: token.id, nodeId: token.nodeId, kind: 'sla', dueAt, fired: 0, status: 'scheduled' });
  }
  /** the node finished (met) or its SLA timer fired (violated): record it on the token and on every visit of that token */
  private async settleSla(inst: Instance, tokenId: string, status: 'met' | 'violated'): Promise<boolean> {
    let changed = false;
    const at = this.ctx.clock();
    const tok = inst.tokens.find((t) => t.id === tokenId);
    if (tok?.sla?.status === 'pending') { tok.sla = { ...tok.sla, status, at }; changed = true; }
    for (const v of inst.history) if (v.tokenId === tokenId && v.sla?.status === 'pending') { v.sla = { ...v.sla, status, at }; changed = true; }
    return changed;
  }
  /** The worker fired a node's SLA job. Violation is recorded and announced; the process itself carries on untouched. */
  async fireSla(inst: Instance, dep: Deployment, tokenId: string): Promise<Instance> {
    if (!tokenId) {                                                         // the process-level SLA
      if (inst.sla?.status !== 'pending') return inst;
      inst.sla = { ...inst.sla, status: 'violated', at: this.ctx.clock() };
      await this.inst().put(inst);
      await this.ctx.audit({ actor: 'system', kind: 'instance.sla.violated', workflowId: inst.workflowId, instanceId: inst.id, data: { dueAt: inst.sla.dueAt } });
      this.emit({ kind: 'instance.updated', instanceId: inst.id });
      if (inst.startedBy && inst.startedBy !== 'system' && inst.startedBy !== 'timer') await new NotificationService(this.ctx).notify({ userId: inst.startedBy, kind: 'sla-breached', title: `SLA breached on instance ${inst.id}`, body: inst.description, link: `/instances/${inst.id}`, instanceId: inst.id }).catch(() => {});
      return inst;
    }
    if (!inst.tokens.some((t) => t.id === tokenId)) return inst;           // the node already ended another way
    if (!(await this.settleSla(inst, tokenId, 'violated'))) return inst;
    const node = this.nodeMap(this.proc(inst, dep)).get(inst.tokens.find((t) => t.id === tokenId)!.nodeId);
    await this.inst().put(inst);
    await this.ctx.audit({ actor: 'system', kind: 'node.sla.violated', workflowId: inst.workflowId, instanceId: inst.id, nodeId: node?.id, data: { node: (node as any)?.name ?? node?.id } });
    this.emit({ kind: 'instance.updated', instanceId: inst.id });
    if (inst.startedBy && inst.startedBy !== 'system' && inst.startedBy !== 'timer') {
      await new NotificationService(this.ctx).notify({ userId: inst.startedBy, kind: 'sla-breached', title: `SLA breached on "${(node as any)?.name ?? node?.id}"`, body: `Instance ${inst.id} is past the node's due time`, link: `/instances/${inst.id}`, instanceId: inst.id }).catch(() => {});
    }
    return inst;
  }
  /** An async job ran out of attempts: the instance fails at that node (shows up in Execution Errors like any other failure). */
  async failInstanceAt(inst: Instance, dep: Deployment, nodeId: string, message: string): Promise<Instance> {
    inst.tokens = inst.tokens.filter((t) => !(t.nodeId === nodeId && t.waitFor?.kind === 'async'));
    inst.status = 'failed'; inst.error = { nodeId, message, at: this.ctx.clock() };
    return this.runToQuiescence(inst, dep);
  }
  /** Cancel a token's pending timers (host completed/resumed → its boundary/catch timers no longer apply). */
  private async cancelTimersForToken(inst: Instance, tokenId: string) {
    const jobs = await this.timerRepo().query((t) => t.instanceId === inst.id && t.tokenId === tokenId && t.status === 'scheduled');
    for (const j of jobs) { j.status = 'cancelled'; await this.timerRepo().put(j); }
  }
  /** Cancel every pending timer for an instance (instance reached a terminal state). */
  private async cancelTimersForInstance(instanceId: string) {
    const jobs = await this.timerRepo().query((t) => t.instanceId === instanceId && t.status === 'scheduled');
    for (const j of jobs) { j.status = 'cancelled'; await this.timerRepo().put(j); }
  }

  /** Event-Based Gateway race: `resolvedNodeId` just resolved its wait (timer/message/signal fired) —
   *  if it's reached directly (single incoming flow) from a `mode:'event'` gateway, every OTHER branch
   *  forked from that same gateway loses the race — cancel their still-waiting tokens (and any timer
   *  jobs backing them) so they never also fire. Structural match by node id, like boundaryTimerHosts;
   *  doesn't disambiguate concurrent activations of the same event gateway (e.g. inside a loop), same
   *  simplification the join-count logic elsewhere in this engine already accepts. */
  private async cancelEventGatewaySiblings(inst: Instance, p: EngineProcess, resolvedNodeId: string): Promise<void> {
    const incoming = this.incoming(p, resolvedNodeId);
    if (incoming.length !== 1) return;
    const gateway = this.nodeMap(p).get(incoming[0]!.from);
    if (!gateway || gateway.type !== 'gateway' || (gateway as any).mode !== 'event') return;
    const siblingTargets = new Set(this.outgoing(p, gateway.id!).map((f) => f.to));
    siblingTargets.delete(resolvedNodeId);
    for (const s of inst.tokens.filter((t) => t.state === 'waiting' && siblingTargets.has(t.nodeId))) {
      await this.cancelTimersForToken(inst, s.id);
      this.removeToken(inst, s.id);
    }
  }
  /** Fire a due timer job: boundary timer → activate the boundary; else resume the (catch) token.
   *  Public — called externally from modules/instances/service.ts's timer-poll path. */
  async fireTimerJob(inst: Instance, dep: Deployment, nodeId: string, tokenId: string): Promise<Instance> {
    const node = this.nodeMap(this.proc(inst, dep)).get(nodeId);
    if (node?.type === 'boundary') return this.fireBoundary(inst, dep, node, tokenId);
    return this.resumeToken(inst, dep, tokenId);
  }
  /** A timer boundary fired: interrupting cancels the host token; then run the boundary's recovery flow. */
  private async fireBoundary(inst: Instance, dep: Deployment, boundary: EngineNode, hostTokenId: string): Promise<Instance> {
    const host = inst.tokens.find((t) => t.id === hostTokenId);
    if (!host) return inst;   // host already finished → stale timer
    if ((boundary as any).interrupting !== false) {
      this.removeHostToken(inst, this.proc(inst, dep), hostTokenId, host.nodeId); await this.cancelTimersForToken(inst, hostTokenId);
      await this.exitOpenTaskForToken(hostTokenId);   // e.g. a user task cancelled out from under its assignee
    }
    inst.tokens.push({ id: this.ctx.newId(), nodeId: boundary.id!, state: 'active', enteredAt: this.ctx.clock() });
    inst.status = 'running';
    this.emit({ kind: 'node.entered', instanceId: inst.id, nodeId: boundary.id!, tokenId: inst.tokens.at(-1)!.id });
    return this.runToQuiescence(inst, dep);
  }
  /** A message/signal/escalation boundary's own waiting token resolved (see messageBoundaryHosts) —
   *  same "interrupting cancels the host, then run the recovery flow" as fireBoundary, just resolved
   *  via broadcast()/resumeToken() instead of a fired TimerJob, so the host has to be found by its
   *  current waiting token rather than passed in directly (that's still the SAME host token id
   *  fireBoundary takes; this just discovers it a different way). */
  private async activateBoundary(inst: Instance, dep: Deployment, boundary: EngineNode, boundaryTokenId: string): Promise<Instance> {
    this.removeToken(inst, boundaryTokenId);
    const p = this.proc(inst, dep);
    const hostIds = boundaryHandler.onList(boundary);
    const host = inst.tokens.find((t) => t.state === 'waiting' && hostIds.includes(t.nodeId));
    if (host && (boundary as any).interrupting !== false) {
      this.removeHostToken(inst, p, host.id, host.nodeId); await this.cancelTimersForToken(inst, host.id);
      await this.exitOpenTaskForToken(host.id);
    }
    for (const t of this.defaultTargets(p, boundary, inst)) inst.tokens.push({ id: this.ctx.newId(), nodeId: t, state: 'active', enteredAt: this.ctx.clock() });
    inst.status = 'running';
    return inst;
  }  private async fireMessageBoundary(inst: Instance, dep: Deployment, boundary: EngineNode, boundaryTokenId: string): Promise<Instance> {
    await this.activateBoundary(inst, dep, boundary, boundaryTokenId);
    return this.runToQuiescence(inst, dep);
  }


  // ---- error handling: route a raised error to a matching error-catch (boundary, or an event
  // sub-process with an error start — jBPM's other common "global error handler" idiom) ----
  // WHICH node matches (isErrorCatch/catchErrorName/isGlobalCatch/isCatchAll/globalNameMatches/
  // findErrorHandler) is nodes/boundary/handler.ts's decision — see its own doc comment for the full
  // "why" (jBPM error-code naming vs. this runtime's fixed ENGINE_ERRORS vocabulary). Only the
  // orchestration that ACTS on a match (mutating instance/token state) stays here.

  /** Route an error to a matching error-catch; returns true if handled (a handler token was spawned). */
  private async raiseError(
    inst: Instance,
    p: EngineProcess,
    dep: Deployment,
    failingNodeId: string,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    rethrow?: boolean
  ): Promise<boolean> {
    const nodeDef = p.nodes.find((n) => n.id === failingNodeId);
    const errorInfo = {
      code,
      node: failingNodeId,
      nodeName: nodeDef?.name || failingNodeId,
      nodeType: nodeDef?.type || 'unknown',
      message,
      details: details || {},
      at: this.ctx.clock(),
    };
    inst.variables[ERROR_VAR] = errorInfo;

    // TIER 1 & 2: Local Boundary / Process-level Catch
    // If rethrow is false/undefined, we check local and process-level error handlers first.
    if (!rethrow) {
      const handler = boundaryHandler.findErrorHandler(p.nodes, failingNodeId, code);
      if (handler) {
        // a global catch (on: '*', or any event sub-process error-catch) is interrupting for the whole
        // instance → cancel all other tokens. A host-specific boundary only ever cancels its own host,
        // which the caller has already done before raiseError runs.
        if (boundaryHandler.isGlobalCatch(handler)) inst.tokens = [];
        inst.tokens.push({ id: this.ctx.newId(), nodeId: handler.id!, state: 'active', enteredAt: this.ctx.clock() });
        this.emit({ kind: 'node.entered', instanceId: inst.id, nodeId: handler.id!, tokenId: inst.tokens.at(-1)!.id });
        return true;
      }
    }

    // TIER 3 & 4: Project Global Error Handler
    // If no local or process catch handled it, check if the project has a global error handler configured.
    const geh = dep.globalErrorHandler;
    if (!geh || !geh.enabled) {
      return false;
    }

    // If this is a dependent child process instance (call activity child),
    // unhandled errors propagate up to the parent Call Activity first so the parent's
    // boundary error event can catch it before escalating to the project global handler.
    if (inst.parentInstanceId && !inst.independent) {
      return false;
    }

    // CIRCUIT BREAKER / LOOP PREVENTION:
    // If this instance itself is running as an error handler (isErrorHandler: true),
    // strictly PREVENT recursion! Recursion depth is capped at 1.
    if (inst.isErrorHandler) {
      return false;
    }

    let targetProcessId: string | undefined;
    let targetStrategy: 'spawn' | 'repair-and-resume' | 'compensate-and-abort' = 'repair-and-resume';
    let targetOutputMappings: Record<string, string> | undefined;

    if (geh.rules && geh.rules.length > 0) {
      // 1. Exact or comma-separated match by error code or HTTP status
      let matched = geh.rules.find((r) => {
        const types = (r.errorType || '').split(',').map((t) => t.trim().toUpperCase());
        if (types.includes(code.toUpperCase())) return true;
        if (details?.httpStatus && types.includes(String(details.httpStatus))) return true;
        return false;
      });
      // 2. Fallback to '*' or 'DEFAULT' or 'ANY'
      if (!matched) {
        matched = geh.rules.find((r) => {
          const types = (r.errorType || '').split(',').map((t) => t.trim().toUpperCase());
          return types.includes('*') || types.includes('DEFAULT') || types.includes('ANY');
        });
      }
      if (!matched || !matched.processId) {
        return false;
      }
      targetProcessId = matched.processId;
      targetStrategy = matched.strategy || 'repair-and-resume';
      targetOutputMappings = matched.outputMappings;
    } else if (geh.processId) {
      // Legacy single process configuration
      if (geh.filter && geh.filter.length > 0) {
        const filterMatches = geh.filter.some((f) => {
          if (f === '*' || f.toUpperCase() === 'ANY') return true;
          if (f === code) return true;
          if (details?.httpStatus && String(details.httpStatus) === f) return true;
          return false;
        });
        if (!filterMatches) {
          return false;
        }
      }
      targetProcessId = geh.processId;
      targetStrategy = geh.strategy || 'repair-and-resume';
      targetOutputMappings = geh.outputMappings;
    } else {
      return false;
    }

    // Resolve the error handler process definition
    const errorProc = dep.engine.processes.find((pr) => pr.id === targetProcessId);
    if (!errorProc) {
      return false;
    }
    const startNode = errorProc.nodes.find((n) => n.type === 'start');
    if (!startNode) {
      return false;
    }

    // Construct enriched error context payload
    const errorContext = {
      failedInstanceId: inst.id,
      workflowId: inst.workflowId,
      deploymentId: inst.deploymentId,
      processId: p.id,
      processName: p.name,
      nodeId: failingNodeId,
      nodeName: nodeDef?.name || failingNodeId,
      nodeType: nodeDef?.type || 'unknown',
      errorCode: code,
      errorMessage: message,
      details: details || {},
      failedVariables: { ...inst.variables },
      occurredAt: this.ctx.clock(),
    };

    const handlerVars: Record<string, unknown> = {
      ...inst.variables,
      errorInfo,
      errorContext,
      failedContext: JSON.stringify(errorContext),
      failedEndpoint: (details?.url as string) || '',
      failedPayload: (details?.responseBody != null ? (typeof details.responseBody === 'string' ? details.responseBody : JSON.stringify(details.responseBody)) : ''),
      failedMethod: (details?.method as string) || '',
      failedHeaders: details?.headers ? (typeof details.headers === 'string' ? details.headers : JSON.stringify(details.headers)) : '',
      errorCode: code,
      errorMessage: message,
      failedNodeId: failingNodeId,
    };

    // Spawn the Global Error Handler instance
    const handlerInst: Instance = {
      id: this.ctx.newId(),
      tenantId: inst.tenantId,
      deploymentId: inst.deploymentId,
      workflowId: inst.workflowId,
      processId: targetProcessId,
      status: 'running',
      variables: handlerVars,
      tokens: [{ id: this.ctx.newId(), nodeId: startNode.id!, state: 'active', enteredAt: this.ctx.clock() }],
      history: [],
      startedAt: this.ctx.clock(),
      startedBy: inst.startedBy || 'system',
      isErrorHandler: true, // CIRCUIT BREAKER
      handlingInstanceId: inst.id,
      parentInstanceId: inst.id,
    };

    await this.inst().put(handlerInst);
    this.emit({ kind: 'instance.started', instanceId: handlerInst.id });
    await this.runToQuiescence(handlerInst, dep);
    await this.inst().put(handlerInst);

    const strategy = targetStrategy || 'repair-and-resume';

    if (strategy === 'repair-and-resume') {
      if (handlerInst.status === 'completed') {
        // Apply output mappings
        if (targetOutputMappings && Object.keys(targetOutputMappings).length > 0) {
          for (const [k1, k2] of Object.entries(targetOutputMappings)) {
            if (k1 in handlerInst.variables) {
              inst.variables[k2] = handlerInst.variables[k1];
            } else if (k2 in handlerInst.variables) {
              inst.variables[k1] = handlerInst.variables[k2];
            }
          }
        } else {
          // Merge non-internal variables modified by the handler
          for (const [k, v] of Object.entries(handlerInst.variables)) {
            if (!['errorInfo', 'errorContext', 'failedContext', 'failedVariables', 'failedEndpoint', 'failedPayload', 'failedMethod', 'failedHeaders', 'errorCode', 'errorMessage', 'failedNodeId'].includes(k)) {
              inst.variables[k] = v;
            }
          }
        }
        delete inst.error;
        inst.variables['errorRepaired'] = true;

        // If the error handler specified retry, retry the failing node
        if (handlerInst.variables['errorHandlerAction'] === 'retry') {
          inst.tokens.push({ id: this.ctx.newId(), nodeId: failingNodeId, state: 'active', enteredAt: this.ctx.clock() });
        } else {
          // Default: advance to default targets of the failing node
          const targets = this.outgoing(p, failingNodeId).map((f) => f.to);
          for (const t of targets) {
            inst.tokens.push({ id: this.ctx.newId(), nodeId: t, state: 'active', enteredAt: this.ctx.clock() });
          }
        }
        return true; // Successfully repaired and resumed!
      } else if (handlerInst.status === 'waiting') {
        // Global error handler parked on a wait (e.g. IT admin review task or backoff timer)
        inst.tokens.push({ id: this.ctx.newId(), nodeId: failingNodeId, state: 'waiting', waitFor: { kind: 'child', ref: handlerInst.id }, enteredAt: this.ctx.clock() });
        return true;
      } else {
        // Handler did not complete successfully (e.g. failed or aborted)
        inst.error = { nodeId: failingNodeId, message: `Global error handler (${targetProcessId}) failed: ${handlerInst.error?.message || handlerInst.status}`, at: this.ctx.clock() };
        return false;
      }
    } else if (strategy === 'compensate-and-abort') {
      inst.status = 'aborted';
      inst.endedAt = this.ctx.clock();
      inst.error = { nodeId: failingNodeId, message: `Compensated and aborted by global error handler (${targetProcessId})`, at: this.ctx.clock() };
      return true;
    } else {
      // strategy === 'spawn' (fire-and-forget incident process)
      // Original instance fails normally
      return false;
    }
  }

  private defaultTargets(p: EngineProcess, node: EngineNode, _inst: Instance): string[] {
    return this.outgoing(p, node.id!).map((f) => f.to);
  }

  // ---- node dispatch ----
  // Each node type's backend logic lives in src/engine/nodes/<type>/handler.ts (see NODE_HANDLERS).
  // The engine builds a HandlerCtx (node + instance state + capabilities) and runs the handler.
  private buildCtx(node: EngineNode, inst: Instance, p: EngineProcess, joins: Record<string, Set<string>>, dep: Deployment, tokenId: string): HandlerCtx {
    return {
      node, inst, proc: p, dep, app: this.ctx, joins, tokenId,
      outgoing: (id) => this.outgoing(p, id),
      incoming: (id) => this.incoming(p, id),
      emit: (e) => this.emit(e),
      startChild: (d, pid, vars, tok, independent) => this.startChild(d, pid, vars, inst.startedBy, inst.id, tok, independent),
      broadcast: (name, correlationValue) => this.broadcast(name, correlationValue),
      signal: (targetInstanceId, name, payload) => this.signalTargeted(inst, dep, targetInstanceId, name, payload),
      abort: (targetInstanceId) => this.abortTargeted(inst, targetInstanceId),
      compensate: (ref) => this.compensate(inst, p, dep, ref),
      resolveCalled: this.resolveCalled,
    };
  }

  /** Real jBPM's generic onEntry-script/onExit-script action hooks (see bpmn-sdk's `WithLifecycle`) —
   *  any activity node type may carry `onEntry`/`onExit` (+ `onEntryLang`/`onExitLang`), executed with
   *  the exact same kcontext/vars/instance/node/meta-locals surface a script node gets (varTypesOf/
   *  kcontextInfoOf/onActionOf — see kcontext-info.ts). Mutates `inst.variables` directly (no merge
   *  step needed — same object reference `runScript` writes through). Returns an error message on
   *  failure, undefined on success; never throws (caller decides how to route the failure). */
  private async runLifecycle(node: EngineNode, kind: 'onEntry' | 'onExit', c: HandlerCtx): Promise<string | undefined> {
    const text = (node as any)[kind] as string | undefined;
    if (!text) return undefined;
    const lang = (node as any)[`${kind}Lang`] as string | undefined;
    try {
      const settings = await new SettingsService(c.app).get().catch(() => null);
      const timeoutMs = (settings?.scriptTimeoutSeconds && settings.scriptTimeoutSeconds > 0)
        ? settings.scriptTimeoutSeconds * 1000
        : config.scriptTimeoutMs;
      await runScript(text, c.inst.variables, timeoutMs, {
        ...kcontextInfoOf(c), ...(await scriptLimitsOf(c)), lang, varTypes: varTypesOf(c), onAction: onActionOf(c),
      });
      return undefined;
    } catch (e) {
      return `${kind} failed: ${(e as Error).message}`;
    }
  }

  private async handle(node: EngineNode, inst: Instance, p: EngineProcess, joins: Record<string, Set<string>>, dep: Deployment, tokenId: string): Promise<HandlerResult> {
    const h = NODE_HANDLERS[node.type];
    if (!h) return {};
    const mi = (node as any).multiInstance ? NODE_HANDLERS.forEach : undefined;   // e.g. 'boundary' — spawned by the error router, then follows its outgoing flow
    const tok = inst.tokens.find((t) => t.id === tokenId);
    if ((node as any).async === true && ASYNC_CAPABLE.has(node.type) && !tok?.asyncReady) return { wait: { kind: 'async', ref: node.id } };
    const c = this.buildCtx(node, inst, p, joins, dep, tokenId);
    const entryErr = await this.runLifecycle(node, 'onEntry', c);
    if (entryErr) return { error: entryErr, errorCode: 'SCRIPT_ERROR' };
    const result = mi ? await mi({ ...c, node: miView(node, p) }) : await h(c);
    // onExit fires exactly once, when the node instance actually completes — immediately here if it
    // didn't wait/error; if it DID wait (userTask/receive/etc.), onExit instead runs in resumeToken()
    // when the wait is actually over, matching real jBPM's onExit timing (never on error/abort paths).
    if (!result.wait && !result.error) {
      const exitErr = await this.runLifecycle(node, 'onExit', c);
      if (exitErr) return { ...result, error: exitErr, errorCode: 'SCRIPT_ERROR' };
    }
    return result;
  }

  // ---- resume (wait states) ----
  /** Complete a wait node (task/timer/message/signal) and continue the instance. */
  async resumeToken(inst: Instance, dep: Deployment, tokenId: string, vars?: Record<string, unknown>): Promise<Instance> {
    // Proper ApiErrors (not bare Error) so every caller — direct service guards already reject most of
    // these earlier, but this is the last line of defense for anything that reaches resumeToken without
    // one (e.g. a manually-triggered timer job on a suspended instance) — gets a clean 409 instead of
    // falling through to errorMiddleware's generic "Internal server error" 500.
    if (inst.status === 'suspended') throw conflict('instance is suspended');   // nothing advances a paused tree
    const token = inst.tokens.find((t) => t.id === tokenId);
    if (!token || token.state !== 'waiting') throw conflict('token is not waiting');
    if (vars) Object.assign(inst.variables, vars);
    if (token.listener) return this.fireEventSubprocess(inst, dep, token);       // an event sub-process trigger, not the completion of a wait
    await this.cancelTimersForToken(inst, tokenId);   // host resumed → drop its pending boundary/catch timers
    if (token.sla) await this.settleSla(inst, tokenId, 'met');
    const p = this.proc(inst, dep);
    const node = this.nodeMap(p).get(token.nodeId);
    // A message/signal/escalation boundary's own waiting token (see messageBoundaryHosts) resolving —
    // route through the same "cancel the host, then run the recovery flow" logic fireBoundary uses for
    // a timer boundary, rather than the generic wait-node completion logic below (which assumes the
    // RESUMED node itself is what was being waited on, true for a userTask/catch but not for a
    // boundary, whose real host is a DIFFERENT, still-separately-tracked token).
    if (node?.type === 'boundary') return this.fireMessageBoundary(inst, dep, node, tokenId);
    // exit the wait node, spawn successors, resume the loop
    if (node) this.removeHostToken(inst, p, tokenId, node.id!); else this.removeToken(inst, tokenId);
    if (node) await this.cancelEventGatewaySiblings(inst, p, node.id!);
    // A waiting node (userTask/receive/etc.) NOW actually completes — this is where its onExit fires
    // (handle() already ran onExit for anything that finished immediately; a waiting node never got
    // that chance, since it hadn't really "exited" yet when handle() first returned `wait`).
    if (node && (node as any).onExit) {
      const c = this.buildCtx(node, inst, p, {}, dep, tokenId);
      const exitErr = await this.runLifecycle(node, 'onExit', c);
      if (exitErr) {
        if (!(await this.raiseError(inst, p, dep, node.id!, 'SCRIPT_ERROR', exitErr))) {
          inst.status = 'failed';
          inst.error = { nodeId: node.id!, message: exitErr, at: this.ctx.clock() };
          return this.runToQuiescence(inst, dep);   // status !== 'running' → settles/persists/cleans up, no looping
        }
        inst.status = 'running';
        return this.runToQuiescence(inst, dep);
      }
    }
    if (node) for (const t of this.defaultTargets(p, node, inst)) inst.tokens.push({ id: this.ctx.newId(), nodeId: t, state: 'active', enteredAt: this.ctx.clock() });
    inst.status = 'running';
    return this.runToQuiescence(inst, dep);
  }

  /** Fail a waiting token (e.g. from TaskService.fail). Raises a TASK_FAILED error into the instance. */
  async failToken(inst: Instance, dep: Deployment, tokenId: string, errorMessage?: string, errorDetails?: Record<string, unknown>): Promise<Instance> {
    if (inst.status === 'suspended') throw conflict('instance is suspended');
    const token = inst.tokens.find((t) => t.id === tokenId);
    if (!token || token.state !== 'waiting') throw conflict('token is not waiting');
    await this.cancelTimersForToken(inst, tokenId);
    const p = this.proc(inst, dep);
    this.removeHostToken(inst, p, tokenId, token.nodeId);
    const msg = errorMessage || `Task on node ${token.nodeId} failed`;
    const handled = await this.raiseError(inst, p, dep, token.nodeId, 'TASK_FAILED', msg, errorDetails);
    if (!handled) {
      inst.status = 'failed';
      inst.error = { nodeId: token.nodeId, message: msg, at: this.ctx.clock() };
    }
    return this.runToQuiescence(inst, dep);
  }

  /** Diagram state for the live canvas highlight. */
  diagramState(inst: Instance) {
    const active = inst.tokens.map((t) => t.nodeId);
    const visited = [...new Set([...inst.history.map((h) => h.nodeId), ...Object.keys(inst.historyCompacted ?? {})])];
    return { activeNodeIds: active, visitedNodeIds: visited, status: inst.status };
  }
}
