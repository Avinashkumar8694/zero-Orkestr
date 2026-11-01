// Intermediate catch — waits for a timer / message / signal / escalation / condition, or (link) is simply where a link throw lands.
// Timers persist a TimerJob; a condition is re-checked by the engine whenever this instance's variables change (no polling).
import type { NodeHandler } from '../types.ts';
import { computeDue } from '../../duration.ts';
import { evalCondition } from '../../sandbox.ts';
import { varTypesOf, kcontextInfoOf, onActionOf, scriptLimitsOf } from '../kcontext-info.ts';

export const handler: NodeHandler = async (c) => {
  const ev = c.node.event || {};
  if (ev.link) return {};                                            // the landing point of a link throw: pass straight through
  if (ev.timer) return { wait: { kind: 'timer', ref: c.node.id, dueAt: computeDue(ev.timer, c.app.clock(), c.inst.variables) } };
  if (ev.message) return { wait: { kind: 'message', ref: ev.message } };
  // Escalation has no dedicated WaitSpec kind: bucketed into 'signal' so it resolves through the same broadcast matching a plain signal does.
  if (ev.signal || ev.escalation) return { wait: { kind: 'signal', ref: ev.signal || ev.escalation } };
  if (ev.condition) {
    // already true: pass at once; otherwise wait — the engine wakes this token when a variable change makes the condition true
    const ok = await evalCondition(String(ev.condition), ev.lang, c.inst.variables, undefined, varTypesOf(c), { ...kcontextInfoOf(c), ...(await scriptLimitsOf(c)), onAction: onActionOf(c) });
    if (ok) return { outcome: 'condition-true' };
  }
  return { wait: { kind: 'condition', ref: c.node.id } };
};
