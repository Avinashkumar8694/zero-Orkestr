// Picking an owner for a user task (leastLoaded / roundRobin) reads "who has the fewest open tasks / who got one longest ago" and then saves the task.
// Two tasks created at the same moment, in this process or on two replicas, would both read the same answer and pick the same person. This serialises just
// that read-then-save step per workspace: a FIFO queue in this process, then the cluster-wide lock (Redis) when replicas share state. The critical
// section is a handful of indexed reads and one write, so it does not slow task creation in any way you would notice.
import { coordinator } from '../infra/coordinator.ts';

const tails = new Map<string, Promise<unknown>>();

export async function withAssignLock<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  const key = `assign:${tenantId}`;
  const prev = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => (release = r));
  const tail = prev.then(() => mine);
  tails.set(key, tail);
  await prev.catch(() => {});
  try { return await coordinator().mutex(key, fn); }
  finally { release(); if (tails.get(key) === tail) tails.delete(key); }
}
