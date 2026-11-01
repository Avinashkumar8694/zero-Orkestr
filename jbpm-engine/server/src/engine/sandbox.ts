// Sandbox for script tasks and flow conditions. The `js` dialect runs in a real V8 isolate (isolated-vm):
// no Node APIs, no host objects, only JSON crosses the boundary — see runJsInIsolate below and
// isolate-runtime.ts for the in-isolate half (kcontext/instance/node builders + java/Jackson shims). `java` never runs as transpiled JavaScript — it's sent
// to the persistent JVM sidecar (java-sidecar.ts / jbpm-engine/java-runtime) and compiled+executed as
// real Java, so scripts converted unmodified from a real jBPM project behave exactly as they do there.
// Other dialects (e.g. mvel) are not evaluated.
//
// `js` scripts/conditions get THREE equivalent ways to read/write a process variable, all backed by
// the same underlying `vars` record (never three sources of truth):
//  1. `kcontext.getVariable(n)`/`.setVariable(n,v)` — real jBPM's own API, always available.
//  2. a bare name (`caseId`) — matches real jBPM's OWN convention: `JavaScriptAction`/
//     `JavaScriptReturnValueEvaluator` bind every process variable as a bare global via
//     `engine.put(key, value)`, in BOTH scripts and conditions (confirmed against jBPM source).
//  3. `vars.caseId` / `vars.caseId = v` — this engine's own, simpler, Node-idiomatic addition (not a
//     jBPM concept) for users who don't want to think in jBPM terms at all. Plain property access —
//     `vars` is literally the same object `kcontext.setVariable` mutates, so no Proxy/rehoming is
//     needed (unlike the Jackson-style accessor methods java-compat.ts had to be careful about).
//
// `kcontext.getProcessInstance()`/`.getNodeInstance()`/`.getKieRuntime()` mirror real jBPM's
// ProcessInstance/NodeInstance/KieRuntime surface (see java-runtime/src/bpmscript/KContext.java for
// the Java-dialect twin and the source citations backing each method) — same shape in both dialects,
// built from the same threaded-through data (see gateway/handler.ts, script/handler.ts).
//
// `instance` / `node` are this engine's OWN additive sugar over that same data (not jBPM concepts at
// all — no `kcontext` prefix, plain properties, this engine's own status vocabulary) for scripts that
// don't want to think in jBPM terms even for process/node introspection, not just variables. See
// buildInstanceGlobal/buildNodeGlobal below, and bpmn-sdk/src/engine.ts's jsInstanceNodePreamble for
// how a script using them still exports to plain, real-jBPM-runnable text.
import { withIsolate, effectiveOverflowMode, sandboxConfig } from './isolate-pool.ts';
import { executeJava, executeJavaCondition, type ActiveNodeInstance, type PendingAction } from './java-sidecar.ts';
import { ISOLATE_RUNTIME_SOURCE } from './isolate-runtime.ts';
import { acquireScriptSlot } from '../infra/quotas.ts';
import { coordinator } from '../infra/coordinator.ts';
import { quotaExceeded } from '../infra/errors.ts';

/** Cluster-wide script admission for the corner where more replicas share a workspace than it has script slots
 *  (a pool can't be split below 1 per replica): a shared Redis slot is taken around the run, waiting up to the queue
 *  timeout (or failing at once in reject mode) exactly like the local pool would. */
async function withClusterSlot<T>(tenantId: string | undefined, cap: number | undefined, mode: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!tenantId || !cap) return fn();
  const co = coordinator();
  const deadline = Date.now() + sandboxConfig().queueTimeoutMs;
  for (let delay = 5; ; delay = Math.min(delay * 2, 50)) {
    const release = await co.acquire('script', tenantId, cap);
    if (release) { try { return await fn(); } finally { await release(); } }
    if (effectiveOverflowMode(mode) === 'reject') throw quotaExceeded(`per-workspace concurrent script quota exceeded across replicas (max ${cap})`, { quota: 'maxConcurrentScripts', max: cap });
    if (Date.now() > deadline) throw quotaExceeded(`timed out waiting for a script slot in this workspace (max ${cap} across replicas)`, { quota: 'scriptQueueTimeout', timeoutMs: sandboxConfig().queueTimeoutMs });
    await new Promise((r) => setTimeout(r, delay));
  }
}

/** matches real jBPM's org.kie.api.runtime.process.ProcessInstance state constants — see
 *  KContext.ProcessInstance's STATE_* fields (java-runtime) for the Java-dialect twin. The JS-dialect
 *  mapping from this engine's status strings lives in isolate-runtime.ts (STATES). */
/** pool key for callers that carry no tenant (tests/tools) — still its own pool, never a real workspace's. */
const DEFAULT_POOL = '_no-tenant';

export { setPoolLimits, sandboxStats, configureSandbox, sandboxConfig, resetSandboxPeaks, effectiveScriptConcurrency, effectiveOverflowMode } from './isolate-pool.ts';

export const PROCESS_INSTANCE_STATE = { PENDING: 0, ACTIVE: 1, COMPLETED: 2, ABORTED: 3, SUSPENDED: 4 } as const;

/** everything about the calling instance/node a script/condition might read via kcontext — shared by
 *  ScriptOpts (scripts) and ConditionCtx (conditions) so the two don't drift out of sync. */
interface KContextInfo {
  env?: Record<string, string>;
  instanceId?: string | number;
  /** the current active token's id (node-*instance*-level id) — see HandlerCtx.tokenId. Distinct
   *  from `nodeId` below, the node *definition* id. */
  nodeInstanceId?: string;
  nodeId?: string;
  nodeName?: string;
  /** the node's free metadata attributes (jBPM metaData), readable in scripts as node.metaData / node.getMetaData(key) */
  nodeMeta?: Record<string, string>;
  /** every declared process variable name: one that has no value yet is still a name in scope (jBPM: null), not a ReferenceError */
  declaredVars?: string[];
  processId?: string;
  processName?: string;
  correlationKey?: string;
  parentInstanceId?: string;
  /** this engine's own instance status string; mapped via stateFor() above. */
  state?: string;
  /** currently-active node instances, for kcontext.getProcessInstance().getNodeInstances() — a
   *  snapshot built by the caller, not live-queried (matches real jBPM's own Collection-snapshot
   *  semantics for this same method). */
  activeNodeInstances?: ActiveNodeInstance[];
}

/** resolves queued signal/abort actions against the real engine, via the callbacks HandlerCtx already
 *  exposes (c.broadcast/c.signal/c.abort) — same shape for both dialects' pending-action lists. */
async function resolveActions(actions: PendingAction[], cb: { broadcast: (name: string) => Promise<void>; signal: (id: string, name: string, payload?: unknown) => Promise<void>; abort: (id: string) => Promise<void> }): Promise<void> {
  for (const a of actions) {
    if (a.kind === 'signal' && a.type) {
      if (a.targetInstanceId) await cb.signal(a.targetInstanceId, a.type, a.payload);
      else await cb.broadcast(a.type);
    } else if (a.kind === 'abort' && a.targetInstanceId) {
      await cb.abort(a.targetInstanceId);
    }
  }
}

export interface ScriptOpts extends KContextInfo {
  /** sink for console.log lines emitted by the script (default: drop) */
  log?: (line: string) => void;
  /** script dialect; defaults to 'js'. 'java' runs in the JVM sidecar (java-sidecar.ts) — real Java,
   *  compiled once per distinct script and cached, never transpiled to JavaScript. */
  lang?: string;
  /** resolves a kcontext signalEvent/abortProcessInstance call once the script returns — the caller
   *  (script/handler.ts) wires these to HandlerCtx.broadcast/.signal/.abort. Untargeted signalEvent
   *  uses `broadcast`; targeted signalEvent uses `signal`; abortProcessInstance uses `abort`. */
  onAction?: { broadcast: (name: string) => Promise<void>; signal: (id: string, name: string, payload?: unknown) => Promise<void>; abort: (id: string) => Promise<void> };
  /** declared process variable types (name -> structureRef) — `lang:'java'` only. Real jBPM's Java
   *  script/onEntry/onExit dialect ALSO binds declared process variables as bare identifiers, via the
   *  same unbound-identifier mechanism (JavaActionBuilder) conditions use — confirmed against jBPM's
   *  own build-time codegen; not an extension this engine invented. This map is what makes the
   *  binding possible on the JVM-sidecar side (see java-sidecar.ts's executeJava). */
  varTypes?: Record<string, string>;
  /** per-tenant concurrent-script quota (SystemSettings.maxConcurrentScripts; 0/undefined =
   *  unlimited) — checked here, the single choke point both dialects and both call sites (script
   *  task, HTTP task exit-script) funnel through, so it can't be bypassed by adding a new caller. */
  tenantId?: string;
  maxConcurrentScripts?: number;
  /** per-workspace override of SCRIPT_OVERFLOW_MODE ('queue' | 'reject'); unset = env default. */
  scriptOverflowMode?: string;
  /** max executions allowed to WAIT for a free isolate (resolved from the limits model); unset = pool default. */
  scriptQueueMax?: number;
  /** set only when more replicas share the workspace than it has script slots: the workspace-wide cap enforced through Redis */
  clusterScriptCap?: number;
  /** admission cap for the `java` dialect only (no pool there): the workspace's explicit request, undefined = unlimited. */
  javaMaxConcurrent?: number;
}

export async function runScript(code: string, vars: Record<string, unknown>, timeoutMs: number, opts: ScriptOpts = {}): Promise<void> {
  // js: concurrency is governed by the tenant's isolate pool + bounded queue (isolate-pool.ts), which already
  // enforces maxConcurrentScripts as parallelism. java has no pool (one shared JVM sidecar), so it keeps the
  // hard-reject admission cap.
  const release = opts.lang === 'java' && opts.tenantId ? acquireScriptSlot(opts.tenantId, opts.javaMaxConcurrent) : undefined;
  try {
    if (opts.lang === 'java') await withClusterSlot(opts.tenantId, opts.clusterScriptCap, opts.scriptOverflowMode, () => runScriptBody(code, vars, timeoutMs, opts));
    else await runScriptBody(code, vars, timeoutMs, opts);
  } finally {
    release?.();
  }
}

async function runScriptBody(code: string, vars: Record<string, unknown>, timeoutMs: number, opts: ScriptOpts): Promise<void> {
  if (opts.lang === 'java') {
    const result = await executeJava({
      code, vars, env: opts.env, instanceId: opts.instanceId, varTypes: opts.varTypes,
      nodeInstanceId: opts.nodeInstanceId, nodeId: opts.nodeId, nodeName: opts.nodeName,
      processId: opts.processId, processName: opts.processName, correlationKey: opts.correlationKey,
      parentInstanceId: opts.parentInstanceId, state: opts.state, activeNodeInstances: opts.activeNodeInstances,
    });
    Object.assign(vars, result.vars);
    if (result.logs) {
      const log = opts.log || (() => {});
      for (const line of result.logs.split('\n')) if (line) log(line);
    }
    if (opts.onAction) await resolveActions(result.pendingActions, opts.onAction);
    return;
  }
  const log = opts.log || (() => {});
  const r = await runJsInIsolate(code, 'script', vars, opts, timeoutMs, opts.env, log);
  for (const line of r.logs) log(line);
  if (opts.onAction) await resolveActions(r.actions, opts.onAction);
}

/** Evaluates a single JS expression with `params` as bare-name globals in the same isolate sandbox (used by the
 *  `Compute` work item). Returns the JSON-serialisable result. */
export async function evalExpression(expr: string, params: Record<string, unknown>, timeoutMs = 1000, tenantId?: string): Promise<unknown> {
  const r = await runJsInIsolate(expr, 'expression', { ...params }, { tenantId }, timeoutMs);
  return typeof r.value === 'string' ? JSON.parse(r.value) : undefined;
}

interface IsolateResult { value: unknown; logs: string[]; actions: PendingAction[] }

const MAX_RESULT_BYTES = 8 * 1024 * 1024;

/** Runs js `code` in a pooled, tenant-private isolate (isolate-pool.ts) with a FRESH context per call, so no
 *  cross-tenant or cross-run state survives:
 *  vars/env/info go in as JSON text, the new vars / console lines / queued signal-abort actions come back as
 *  JSON text. Synchronous script semantics are unchanged; the isolate has no Node APIs at all, so
 *  `this.constructor.constructor('return process')()` etc. simply resolve to `undefined`.
 *  mode 'script' runs `code` as a statement body (bare-name writes sync back into `vars`);
 *  mode 'condition' evaluates it as a boolean expression / body with `return`. */
async function runJsInIsolate(code: string, mode: 'script' | 'condition' | 'expression', vars: Record<string, unknown>, info: KContextInfo & { tenantId?: string; maxConcurrentScripts?: number; scriptOverflowMode?: string; scriptQueueMax?: number; clusterScriptCap?: number }, timeoutMs: number, hostEnv?: Record<string, string>, onLog?: (line: string) => void): Promise<IsolateResult> {
  const { env, tenantId, maxConcurrentScripts, scriptOverflowMode, scriptQueueMax, clusterScriptCap, ...rest } = info;
  const input = JSON.stringify({ vars, env: env || {}, info: rest });
  return withClusterSlot(tenantId, clusterScriptCap, scriptOverflowMode, () => withIsolate(tenantId || DEFAULT_POOL, maxConcurrentScripts, effectiveOverflowMode(scriptOverflowMode), scriptQueueMax, async (isolate, context) => {
    await context.global.set('__input', input);
    await (await isolate.compileScript('__setup(__input); delete globalThis.__input;')).run(context, { timeout: timeoutMs });
    // IIFE so var/let/const stay local while a bare assignment still lands on the global (see bare-name sync).
    const body = mode === 'condition' ? (/return\b/.test(code) ? code : `return (${code});`) : code;
    // only a boolean / string / undefined ever crosses back (never an object), so `copy` can't be abused.
    const wrapped = mode === 'expression' ? `JSON.stringify((function(){ return (${body}\n); })())`
      : mode === 'condition' ? `!!(function(){\n${body}\n})()` : `void (function(){\n${body}\n})()`;
    let value: unknown;
    try {
      value = await (await isolate.compileScript(wrapped)).run(context, { timeout: timeoutMs, copy: true });
    } catch (e) {
      // best effort: surface console output produced before the failure (not possible after an OOM disposal)
      try {
        const lines = JSON.parse(await (await isolate.compileScript('__logs()')).run(context, { timeout: 100 })) as string[];
        for (const l of lines) onLog?.(l);
      } catch { /* isolate gone */ }
      throw e;
    }
    const raw = await (await isolate.compileScript('__collect()')).run(context, { timeout: timeoutMs });
    if (typeof raw !== 'string' || raw.length > MAX_RESULT_BYTES) throw new Error('script result missing or too large');
    const out = JSON.parse(raw) as { vars: Record<string, unknown>; logs: string[]; actions: PendingAction[]; env: Record<string, string> };
    // write back in place (callers hold the `vars` object): replace content, honoring deletions.
    for (const k of Object.keys(vars)) if (!(k in out.vars)) delete vars[k];
    Object.assign(vars, out.vars);
    if (hostEnv) Object.assign(hostEnv, out.env);
    return { value, logs: out.logs, actions: out.actions };
  }));
}

/** deployment/instance context for a condition — same shape ScriptOpts carries for scripts, kept
 *  separate since a condition doesn't take the full ScriptOpts bag (no log sink). Conditions CAN
 *  queue signal/abort actions too (kcontext is the same object either way) — pass `onAction` if the
 *  caller wants those resolved; a gateway condition ignoring it just means an unusual side-effecting
 *  condition silently drops the queued action, matching how the java-dialect condition path already
 *  behaves (conditions aren't expected to have side effects, but nothing stops a script author). */
export interface ConditionCtx extends KContextInfo {
  /** workspace whose isolate pool runs the condition (never shared across tenants). */
  tenantId?: string;
  maxConcurrentScripts?: number;
  scriptOverflowMode?: string;
  scriptQueueMax?: number;
  clusterScriptCap?: number;
  onAction?: ScriptOpts['onAction'];
}

/** Evaluate a boolean flow condition. `js` runs natively; `java` runs in the JVM sidecar (real Java,
 *  never transpiled); other dialects (e.g. mvel) → false. Any failure (bad script, sidecar down,
 *  timeout) evaluates to false rather than throwing, matching this function's existing contract.
 *  `varTypes` (declared process variable types, name -> structureRef) lets a `java` condition bind
 *  every process variable as a bare, typed local identifier, matching real jBPM's Java condition
 *  dialect (see java-sidecar.ts's executeJavaCondition) — irrelevant for `js`, which binds bare names
 *  unconditionally (matching real jBPM's own JS convention, no static typing involved either way). */
export async function evalCondition(expr: string | undefined, lang: string | undefined, vars: Record<string, unknown>, timeoutMs = 500, varTypes?: Record<string, string>, ctx: ConditionCtx = {}): Promise<boolean> {
  if (!expr) return true;
  if (lang && lang !== 'js' && lang !== 'java') return false;
  if (lang === 'java') {
    try {
      const result = await executeJavaCondition({
        code: expr, vars, varTypes, env: ctx.env, instanceId: ctx.instanceId,
        nodeInstanceId: ctx.nodeInstanceId, nodeId: ctx.nodeId, nodeName: ctx.nodeName,
        processId: ctx.processId, processName: ctx.processName, correlationKey: ctx.correlationKey,
        parentInstanceId: ctx.parentInstanceId, state: ctx.state, activeNodeInstances: ctx.activeNodeInstances,
      });
      return result;
    } catch { return false; }
  }
  // kcontext was previously missing from JS conditions entirely — a real gap, since real jBPM's
  // ProcessContext is available in every script/condition, not just scripts.
  try {
    const { onAction, ...info } = ctx;
    // conditions get a throwaway copy of vars: a condition is not expected to have side effects on process state.
    const r = await runJsInIsolate(expr, 'condition', { ...vars }, info, timeoutMs, undefined);
    const result = !!r.value;
    if (onAction) await resolveActions(r.actions, onAction);
    return result;
  } catch (e) {
    // a full/slow script queue is an infrastructure condition, not a 'false' — don't silently misroute the flow
    if ((e as { code?: string }).code === 'QUOTA_EXCEEDED') throw e;
    return false;
  }
}
