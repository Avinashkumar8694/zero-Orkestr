// An instance's history is stored inside its row and grows with every node visit, so a long loop would make the row (and every load of it)
// arbitrarily large. Past the cap the MIDDLE is dropped (the start and the most recent visits stay), and a per-node count of what was
// dropped is kept so parallel-join counting and the diagram's "visited" set stay exactly right. INSTANCE_MAX_HISTORY=0 turns it off.
import type { Instance } from '../domain.ts';

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
export const historyCap = { max: num(process.env.INSTANCE_MAX_HISTORY, 5000), keepFirst: 50 };

/** how many times a node has been visited, including visits already compacted away */
export const visitCount = (inst: Pick<Instance, 'history' | 'historyCompacted'>, nodeId: string): number =>
  inst.history.reduce((n, h) => (h.nodeId === nodeId ? n + 1 : n), 0) + (inst.historyCompacted?.[nodeId] ?? 0);

export function compactHistory(inst: Instance): void {
  const { max, keepFirst } = historyCap;
  if (!max || inst.history.length <= max) return;
  const head = Math.min(keepFirst, Math.floor(max / 2));
  const tail = max - head;
  const dropped = inst.history.slice(head, inst.history.length - tail);
  const counts = (inst.historyCompacted ??= {});
  for (const v of dropped) counts[v.nodeId] = (counts[v.nodeId] ?? 0) + 1;
  inst.history = [...inst.history.slice(0, head), ...inst.history.slice(inst.history.length - tail)];
}
