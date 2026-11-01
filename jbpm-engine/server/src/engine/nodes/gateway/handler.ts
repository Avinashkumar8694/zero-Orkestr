// Gateway — exclusive/parallel/inclusive/event/complex branching + join.
import type { NodeHandler, HandlerResult } from '../types.ts';
import { evalCondition } from '../../sandbox.ts';
import { visitCount } from '../../history-cap.ts';
import { varTypesOf, kcontextInfoOf, onActionOf, scriptLimitsOf } from '../kcontext-info.ts';

/** sequential (not Promise.all) so a 'java' condition's sidecar round trip for flow N doesn't race
 *  the one for flow N+1 — gateway fan-out is small and not a hot path, so this costs nothing real. */
async function filterAsync<T>(items: T[], pred: (item: T) => Promise<boolean>): Promise<T[]> {
  const out: T[] = [];
  for (const item of items) if (await pred(item)) out.push(item);
  return out;
}
async function findAsync<T>(items: T[], pred: (item: T) => Promise<boolean>): Promise<T | undefined> {
  for (const item of items) if (await pred(item)) return item;
  return undefined;
}

export const handler: NodeHandler = async (c): Promise<HandlerResult> => {
  const node = c.node;
  const outs = c.outgoing(node.id);
  const ins = c.incoming(node.id);
  const converging = ins.length > 1 && outs.length <= 1;
  // real jBPM's Java condition dialect binds every DECLARED process variable as a bare, typed local
  // identifier (e.g. `return retryCount < maxRetryCount;`), not just via kcontext.getVariable — see
  // sandbox.ts evalCondition / java-sidecar.ts executeJavaCondition. Unused by `js` conditions (bare
  // names there aren't statically typed), but harmless to pass either way.
  const varTypes = varTypesOf(c);
  const condCtx = { ...kcontextInfoOf(c), ...(await scriptLimitsOf(c)), onAction: onActionOf(c) };

  if (converging && (node.mode === 'parallel' || node.mode === 'inclusive')) {
    // join: wait until a token has arrived via each incoming flow (supports cyclic looping paths via modulo)
    const arrived = visitCount(c.inst, node.id);
    if (arrived % ins.length !== 0) return { consume: true, outcome: `join ${arrived % ins.length}/${ins.length}` };
    c.joins[node.id] = new Set();
    return { next: outs.map((f) => f.to), outcome: 'join-complete' };
  }

  switch (node.mode) {
    case 'parallel': return { next: outs.map((f) => f.to), outcome: 'fork' };
    case 'inclusive': {
      // The default flow is a FALLBACK — taken only if nothing else matched — same as exclusive
      // below, not an always-taken flow alongside whatever else matches. (A previous version of this
      // included it in `matched` unconditionally, a real bug: the default fired on every execution
      // regardless of any other flow's condition, confirmed via a real reproduction.) Only flows that
      // actually carry a `when` are eligible for the primary match; a flow with no condition that
      // isn't the explicit default is fallback-only, matching exclusive's convention below.
      const matched = await filterAsync(outs, async (f) => !!f.when && evalCondition(f.when, f.lang, c.inst.variables, undefined, varTypes, condCtx));
      const chosen = matched.length ? matched : outs.filter((f) => f.id === node.default || !f.when);
      return { next: chosen.map((f) => f.to), outcome: matched.length ? 'inclusive' : 'default' };
    }
    // Event-based gateway: fork a token onto EVERY downstream catch (message/signal/timer/condition) —
    // real BPMN semantics is a race, not a fan-out: whichever catch fires first wins, and
    // execution-engine.ts's resumeToken (via cancelEventGatewaySiblings) cancels the rest at that point.
    case 'event': return { next: outs.map((f) => f.to), outcome: 'event-gateway-fork' };
    case 'complex':
    case 'exclusive':
    default: {
      const match = await findAsync(outs, async (f) => !!f.when && evalCondition(f.when, f.lang, c.inst.variables, undefined, varTypes, condCtx));
      const def = outs.find((f) => f.id === node.default) || outs.find((f) => !f.when);
      const chosen = match || def;
      return { next: chosen ? [chosen.to] : [], outcome: match ? 'conditional' : 'default' };
    }
  }
};
