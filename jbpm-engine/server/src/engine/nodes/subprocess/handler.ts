// Embedded / transaction sub-process — runs the node's own nodes/flows as a nested instance that
// SHARES the parent's variable scope. The composite process id "<parentProcess>::<nodeId>" is resolved
// by the engine's pick() into a synthetic process. If the nested graph waits (user task/timer), the
// parent token waits for the child and resumes (merging all child vars back) on completion.
import type { NodeHandler } from '../types.ts';
import type { Instance } from '../../../domain.ts';

/** Shared-scope output mapping: ALL child variables merge back (unlike call's isolated-scope,
 *  declared-outputs-only mapping — see call/handler.ts's own mapChildOutputs). Exported so both
 *  completion paths — this handler's own sync branch below, and execution-engine.ts's
 *  tryResumeParent for the async/waiting-child case — use the identical logic; see nodes/index.ts's
 *  CHILD_OUTPUT_MAPPERS registry. */
export function mapChildOutputs(_n: any, child: Instance): Record<string, unknown> {
  return { ...child.variables };
}

export const handler: NodeHandler = async (c) => {
  const n = c.node;
  if (!Array.isArray(n.nodes) || n.nodes.length === 0) return {};   // empty sub-process → pass through
  const token = c.inst.tokens.find((t) => t.nodeId === n.id)!;
  const composite = `${c.proc.id}::${n.id}`;
  const child = await c.startChild(c.dep, composite, { ...c.inst.variables }, token.id);
  if (child.status === 'completed') return { vars: mapChildOutputs(n, child), outcome: `sub:${child.id}` };
  if (child.status === 'aborted' || child.status === 'failed') return { error: child.cancelled ? 'transaction cancelled' : 'sub-process failed', errorCode: child.cancelled ? 'TRANSACTION_CANCELLED' : 'SUBPROCESS_ERROR', outcome: `sub:${child.id}` };
  return { wait: { kind: 'child', ref: child.id }, outcome: `sub:${child.id}` };
};
