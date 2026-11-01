// Call activity — starts a child instance of the called process, maps inputs in; on completion maps
// outputs back; if the child waits, the parent token waits for it (resumed on child completion) —
// unless `independent: true` (see below), in which case the parent never waits.
import type { NodeHandler } from '../types.ts';
import type { Instance } from '../../../domain.ts';

/** Isolated-scope output mapping: only the DECLARED `outputs` cross back into the parent, unlike
 *  subprocess's full shared-scope merge (see subprocess/handler.ts's own mapChildOutputs). Exported
 *  so BOTH completion paths use the identical logic — this handler's own sync branch below (the child
 *  happens to finish inside startChild's own call) AND execution-engine.ts's tryResumeParent (the
 *  child instead waited, and completes later via a separate resume) — see nodes/index.ts's
 *  CHILD_OUTPUT_MAPPERS registry. Previously this logic was written twice, independently. */
export function mapChildOutputs(n: any, child: Instance): Record<string, unknown> {
  const vars: Record<string, unknown> = {};
  for (const [pv, cv] of Object.entries(n.outputs || {})) vars[pv] = child.variables[cv as string];
  return vars;
}

export const handler: NodeHandler = async (c) => {
  const n = c.node;
  if (!c.resolveCalled || !n.process) return {};
  const resolved = await c.resolveCalled(n.process, c.dep);
  if (!resolved) return { outcome: 'called-process-not-deployed' };
  const token = c.inst.tokens.find((t) => t.nodeId === n.id)!;
  const childVars: Record<string, unknown> = {};
  for (const [cv, spec] of Object.entries(n.inputs || {})) {
    childVars[cv] = typeof spec === 'string' && spec.startsWith('$') ? c.inst.variables[spec.slice(1)] : spec;
  }
  const independent = n.independent === true;
  // jBPM keeps two switches apart: `independent` (the child outlives the parent) and `waitForCompletion` (the parent waits for it).
  // `waitForCompletion: false` makes the parent continue at once. For flows written before it existed, `independent: true` alone
  // still means fire-and-forget; setting waitForCompletion explicitly always wins.
  const wait = n.waitForCompletion !== undefined ? n.waitForCompletion !== false : !independent;
  const child = await c.startChild(resolved.dep, resolved.processId, childVars, token.id, independent);
  // no wait = fire-and-forget — the parent continues immediately whether or not the child
  // has finished (with independent:true the child's lifecycle is also fully decoupled: it keeps running standalone even past
  // this parent's own completion/abort (see Instance.independent / abortDescendants). Default
  // (unset/false) preserves the normal wait-for-completion behavior below.
  if (!wait) return { vars: child.status === 'completed' ? mapChildOutputs(n, child) : {}, outcome: `called:${child.id}` };
  if (child.status === 'completed') return { vars: mapChildOutputs(n, child), outcome: `called:${child.id}` };
  // A dependent child that already finished (aborted/failed) synchronously — inside this very
  // startChild() call, never having parked in a wait — must be raised here; falling through to the
  // wait-on-child branch below would park the parent on a child that will never complete or resume.
  if (child.status === 'aborted' || child.status === 'failed') {
    // "when the called process fails": fail (default, below) | continue | abort the parent at once
    if (n.onChildFailure === 'continue') return { vars: { [n.errorVar || 'callError']: { childInstanceId: child.id, childStatus: child.status, childError: child.error ?? null } }, outcome: `called:${child.id} (child ${child.status}, continued)` };
    if (n.onChildFailure === 'abort') return { abort: true, outcome: `called:${child.id} (child ${child.status}, parent aborted)` };
    return {
      error: `called process ${child.status}`,
      errorCode: 'CALL_ERROR',
      errorDetails: {
        childProcessId: resolved.processId,
        childInstanceId: child.id,
        childStatus: child.status,
        childError: child.error,
      },
      outcome: `called:${child.id}`,
    };
  }
  return { wait: { kind: 'child', ref: child.id }, outcome: `called:${child.id}` };
};
