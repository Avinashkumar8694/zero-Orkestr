// Intermediate throw — a compensation throw runs the recorded compensation handlers (optionally for a single activity via event.ref);
// a link throw jumps to the catch with the same link name; otherwise it broadcasts a signal / message / escalation (workspace-wide, or
// only inside this instance with scope: 'instance'), then continues.
import type { NodeHandler } from '../types.ts';
export const handler: NodeHandler = async (c) => {
  const ev = c.node.event || {};
  if (ev.compensation || ev.compensate) return { vars: await c.compensate(ev.ref), outcome: 'compensated' };
  if (ev.link) {
    const target = c.proc.nodes.find((n: any) => n.type === 'catch' && n.event?.link === ev.link);
    if (!target) return { error: `link "${ev.link}" has no matching catch in this process`, errorCode: 'RUNTIME_ERROR' };
    return { next: [target.id!], outcome: `link:${ev.link}` };
  }
  const name = ev.signal || ev.message || ev.escalation;
  // event.correlationKey: a $var reference — narrows delivery to only the instance(s) whose OWN correlationKey matches
  const correlationValue = typeof ev.correlationKey === 'string' && ev.correlationKey.startsWith('$')
    ? (c.inst.variables[ev.correlationKey.slice(1)] as string | undefined) : undefined;
  if (name && ev.scope === 'instance') return { outcome: `threw:${name} (this instance)`, signalLocal: name };
  if (name) await c.broadcast(name, correlationValue);
  return { outcome: name ? `threw:${name}` : 'throw' };
};
