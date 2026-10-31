// End event — completes the path; terminate ends the whole instance; error-throw raises an error; a
// signal/message/escalation throw broadcasts to any waiting listener before completing (same delivery
// as an intermediate throw — see throw/handler.ts — but the path ends here instead of continuing); a
// compensation end event runs the recorded compensation handlers before completing the path.
import type { NodeHandler } from '../types.ts';
export const handler: NodeHandler = async (c) => {
  if (c.node.result === 'terminate') return { end: 'terminate' };
  // Presence check, not truthiness: the properties panel writes `throw: { error: '' }` the instant
  // "error" is picked from the dropdown, before a code is typed in — a truthy check here would treat
  // that as "no error configured" and silently fall through to a normal completion instead (the exact
  // bug this comment is here to stop from recurring). execution-engine.ts's own handling of the
  // resulting 'error' end (see runToQuiescence) already defaults an empty code to 'ERROR'.
  if (c.node.throw && 'error' in c.node.throw) {
    const rethrow = c.node.throw?.rethrow ?? c.node.rethrow;
    return { end: 'error', outcome: 'error-throw', rethrow: rethrow === true };
  }
  if (c.node.event?.compensation || c.node.result === 'compensate') {
    return { vars: await c.compensate(c.node.event?.ref), end: 'complete', outcome: 'compensated' };
  }
  const name = c.node.throw?.signal || c.node.throw?.message || c.node.throw?.escalation;
  if (name) {
    const ck = c.node.throw?.correlationKey;
    const correlationValue = typeof ck === 'string' && ck.startsWith('$') ? (c.inst.variables[ck.slice(1)] as string | undefined) : undefined;
    await c.broadcast(name, correlationValue);
    return { end: 'complete', outcome: `threw:${name}` };
  }
  return { end: 'complete' };
};
