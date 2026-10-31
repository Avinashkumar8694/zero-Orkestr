// In-memory store — used by tests and as the FileStore's cache layer.
import type { Entity, Repository, Store } from './repository.ts';

function cloneSafe<T>(val: T): T {
  try {
    return structuredClone(val);
  } catch {
    return JSON.parse(JSON.stringify(val));
  }
}

class MemoryRepo<T extends Entity> implements Repository<T> {
  private map = new Map<string, T>();
  async get(id: string) { return this.map.get(id); }
  async list() { return [...this.map.values()]; }
  async query(pred: (t: T) => boolean) { return [...this.map.values()].filter(pred); }
  async put(entity: T) { this.map.set(entity.id, cloneSafe(entity)); return entity; }
  async delete(id: string) { return this.map.delete(id); }
}

export class MemoryStore implements Store {
  private repos = new Map<string, MemoryRepo<any>>();
  repo<T extends Entity>(collection: string): Repository<T> {
    let r = this.repos.get(collection);
    if (!r) { r = new MemoryRepo<T>(); this.repos.set(collection, r); }
    return r as Repository<T>;
  }

  async claimDueTimers(tenantId: string, nowIso: string, limit: number): Promise<any[]> {
    const timerRepo = this.repo<any>('timers');
    const all = await timerRepo.query((t: any) =>
      (!tenantId || tenantId === '*' || t.tenantId === tenantId) &&
      t.status === 'scheduled' &&
      t.dueAt <= nowIso,
    );
    const claimed = all.slice(0, limit);
    for (const job of claimed) {
      job.status = 'fired';
      job.fired = (job.fired || 0) + 1;
      await timerRepo.put(job);
    }
    return claimed;
  }
}
