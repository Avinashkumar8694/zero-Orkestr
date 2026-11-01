// Shared helpers for building the kcontext-facing data (declared variable types, active node
// instances, process/instance metadata) from a HandlerCtx — used identically by script/http/gateway
// handlers so these three don't drift out of sync with each other over time.
import { effectiveLimitsFor, replicaShare } from '../../modules/platform/limits.ts';
import type { HandlerCtx } from './types.ts';
import type { ActiveNodeInstance } from '../java-sidecar.ts';
import type { EngineNode } from '../../sdk/index.ts';

/** declared process variable types (name -> structureRef) — real jBPM's Java condition dialect (and,
 *  confirmed this session, its script/onEntry/onExit dialect too) binds every declared variable as a
 *  bare, typed local identifier; this is what makes that possible on the JVM-sidecar side. */
export function varTypesOf(c: HandlerCtx): Record<string, string> {
  const varTypes: Record<string, string> = {};
  for (const v of c.proc.vars || []) if (v.name) varTypes[v.name] = v.type;
  return varTypes;
}

/** node id -> name, walking into subprocess children too (a token active inside an embedded/event
 *  subprocess still needs its name resolved for getNodeInstances() below). */
function nodeNameIndex(nodes: EngineNode[] | undefined, out: Map<string, string | undefined>): void {
  for (const n of nodes || []) {
    if (n.id) out.set(n.id, n.name);
    const nested = (n as { nodes?: EngineNode[] }).nodes;
    if (Array.isArray(nested)) nodeNameIndex(nested, out);
  }
}

/** currently-active node instances, for kcontext.getProcessInstance().getNodeInstances() — a
 *  snapshot at call time (matches real jBPM's own Collection-snapshot semantics for this method). */
export function activeNodeInstancesOf(c: HandlerCtx): ActiveNodeInstance[] {
  const names = new Map<string, string | undefined>();
  nodeNameIndex(c.proc.nodes, names);
  return c.inst.tokens
    .filter((t) => t.state === 'active')
    .map((t) => ({ id: t.id, nodeId: t.nodeId, nodeName: names.get(t.nodeId) }));
}

/** the full kcontext-info bundle (everything ScriptOpts/ConditionCtx need beyond code/vars/lang) —
 *  see sandbox.ts's KContextInfo for what each field backs. */
export function kcontextInfoOf(c: HandlerCtx) {
  return {
    tenantId: c.app.tenantId, env: c.dep.env, instanceId: c.inst.id, nodeInstanceId: c.tokenId, nodeId: c.node.id, nodeName: c.node.name, declaredVars: (c.proc.vars || []).map((v) => v.name), nodeMeta: c.node.metaData && typeof c.node.metaData === 'object' ? c.node.metaData : undefined,
    processId: c.proc.id, processName: c.proc.name, correlationKey: c.inst.correlationKey,
    parentInstanceId: c.inst.parentInstanceId, state: c.inst.status, activeNodeInstances: activeNodeInstancesOf(c),
  };
}

/** resolves a kcontext signalEvent/abortProcessInstance call queued during script/condition
 *  execution — see sandbox.ts's ScriptOpts.onAction. */
export function onActionOf(c: HandlerCtx) {
  return { broadcast: c.broadcast, signal: c.signal, abort: c.abort };
}

/** the workspace's effective script limits (platform caps ∩ workspace settings, see modules/platform/limits.ts) for the
 *  isolate pool (js) and the java admission cap — read per execution so a change applies to the very next run. */
export async function scriptLimitsOf(c: HandlerCtx): Promise<{ maxConcurrentScripts: number; scriptQueueMax: number; scriptOverflowMode: 'queue' | 'reject'; javaMaxConcurrent: number | undefined; clusterScriptCap: number | undefined }> {
  const { effective, caps, settings } = await effectiveLimitsFor(c.app);
  const asked = settings.scriptPoolSize || settings.maxConcurrentScripts;
  // the limits above are for the whole workspace; this replica enforces its share of them (all replicas together = the limit)
  const share = replicaShare(c.app.tenantId, effective);
  const javaTotal = asked ? Math.min(asked, caps.scriptPoolMaxSize) : undefined;
  return {
    maxConcurrentScripts: share.size, scriptQueueMax: share.queueMax, scriptOverflowMode: effective.scriptOverflowMode,
    javaMaxConcurrent: javaTotal === undefined ? undefined : replicaShare(c.app.tenantId, { ...effective, scriptPoolSize: javaTotal }).size,
    clusterScriptCap: share.clusterCap,
  };
}
