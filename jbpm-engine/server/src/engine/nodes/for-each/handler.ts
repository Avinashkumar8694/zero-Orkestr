// Multi-instance (forEach) — runs the child process once per item in `over`, passing pass-through
// vars + the item; collects each `itemResult` into `collectInto`. `parallel:true` starts all items at
// once; sequential starts only the first here and execution-engine.ts's tryResumeParent starts each
// next item as the previous one actually finishes (which may be later, if it waits — see below).
//
// A child that WAITS (e.g. a per-item human task) is no longer treated as a failure: this node's own
// token parks in a 'multiInstance' wait (see WaitSpec in domain.ts) until every sibling child settles.
// Siblings are found by Instance.parentTokenId, not stored on the token — see execution-engine.ts's
// tryResumeParent/tryFailParent, which own the rest of this node type's lifecycle from here. A child
// that fails/aborts still fails the whole node immediately (real MI default semantics) instead of
// silently dropping that item's result.
import type { NodeHandler, HandlerResult } from '../types.ts';
import type { Instance } from '../../../domain.ts';
import { evalCondition } from '../../sandbox.ts';

export function buildMultiInstanceResult(children: Instance[], total: number, n: any): HandlerResult {
  const failed = children.find((child) => child.status === 'failed' || child.status === 'aborted');
  if (failed) return { error: `multi-instance item did not complete (${failed.status}): ${failed.id}`, errorCode: 'MULTIINSTANCE_ERROR', outcome: `multiInstance:${total}` };
  if (children.length < total || children.some((child) => child.status !== 'completed')) return { wait: { kind: 'multiInstance' }, outcome: `multiInstance:${children.length}/${total}` };
  const results = n.itemResult ? children.map((child) => child.variables[n.itemResult]) : [];
  return { vars: n.collectInto ? { [n.collectInto]: results } : {}, outcome: `multiInstance:${total}` };
}

/** jBPM "completion condition": true once the items finished so far satisfy the expression — the rest are not needed.
 *  The expression sees `completed`, `total`, `results` (itemResult of each finished item) and the process variables. */
export async function completionReached(n: any, children: Instance[], total: number, vars: Record<string, unknown>): Promise<boolean> {
  if (!n.completionCondition) return false;
  const done = children.filter((child) => child.status === 'completed');
  if (!done.length) return false;
  const results = n.itemResult ? done.map((child) => child.variables[n.itemResult]) : [];
  return evalCondition(String(n.completionCondition), 'js', { ...vars, completed: done.length, total, results });
}
/** the variables a multi-instance node writes, from the items that finished */
export function collectCompleted(children: Instance[], n: any): Record<string, unknown> {
  const done = children.filter((child) => child.status === 'completed');
  return n.collectInto ? { [n.collectInto]: n.itemResult ? done.map((child) => child.variables[n.itemResult]) : [] } : {};
}

export const handler: NodeHandler = async (c) => {
  const n = c.node;
  if (!n.miInline && (!c.resolveCalled || !n.process)) return {};
  const resolved = n.miInline ? { dep: c.dep, processId: n.process as string } : await c.resolveCalled!(n.process);
  if (!resolved) return { outcome: 'mi-process-not-deployed' };
  const items = Array.isArray(c.inst.variables[n.over]) ? (c.inst.variables[n.over] as any[]) : [];
  if (!items.length) return { vars: n.collectInto ? { [n.collectInto]: [] } : {}, outcome: 'multiInstance:0' };
  const parentToken = c.inst.tokens.find((t) => t.nodeId === n.id)!;
  const runOne = (item: unknown) => {
    const childVars: Record<string, unknown> = n.miInline ? { ...c.inst.variables } : {};   // an inline activity sees every process variable
    for (const v of (n.pass || [])) childVars[v] = c.inst.variables[v];
    if (n.as) childVars[n.as] = item;
    return c.startChild(resolved.dep, resolved.processId, childVars, parentToken.id);
  };
  // early finish: enough items are done — abort the rest and move on with what we have (their abort cannot disturb this node: it is still running)
  const finishEarly = async (kids: Instance[]): Promise<HandlerResult | undefined> => {
    if (kids.some((k) => k.status === 'failed' || k.status === 'aborted') || !(await completionReached(n, kids, items.length, c.inst.variables))) return undefined;
    for (const k of kids) if (k.status === 'running' || k.status === 'waiting' || k.status === 'suspended') await c.abort(k.id);
    return { vars: collectCompleted(kids, n), outcome: `multiInstance:early ${kids.filter((k) => k.status === 'completed').length}/${items.length}` };
  };
  if (n.parallel) { const kids = await Promise.all(items.map(runOne)); return (await finishEarly(kids)) ?? buildMultiInstanceResult(kids, items.length, n); }
  // Sequential: keep starting the next item synchronously as long as each one keeps completing —
  // the common case (no per-item wait) then behaves exactly as before, settling in this same call.
  // Stop the moment one doesn't finish outright (waits or fails); execution-engine.ts's
  // settleMultiInstance takes over starting any remaining items from there once that one settles.
  const started: Instance[] = [];
  for (const item of items) {
    started.push(await runOne(item));
    if (started.at(-1)!.status !== 'completed') break;
    if (n.completionCondition) { const early = await finishEarly(started); if (early) return early; }
  }
  return buildMultiInstanceResult(started, items.length, n);
};
