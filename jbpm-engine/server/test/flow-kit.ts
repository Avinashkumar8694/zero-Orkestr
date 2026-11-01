// Shared test kit: deploy a process from compact node/flow lists and record a deterministic trace of what happened.
import { MemoryStore } from '../src/store/memory-store.ts';
import { fakeClock } from '../src/infra/ids.ts';
import { makeContext } from '../src/context.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { InstanceService } from '../src/modules/instances/service.ts';
import { TimerService } from '../src/modules/timers/service.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import { Collections, type Instance, type Task } from '../src/domain.ts';

export const T0 = '2025-01-01T00:00:00.000Z';
export const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

export function kit(tenantId = 't1', opts: { copies?: boolean } = {}) {
  const raw = new MemoryStore();
  const store = opts.copies ? cloningStore(raw) : raw;
  let n = 0;
  const ctx = makeContext({ store, tenantId, clock: fakeClock(T0).clock, newId: () => `id${++n}` });
  const deploy = async (name: string, nodes: any[], flows: any[], vars: any[] = [], procProps: Record<string, unknown> = {}) => {
    const wf = await new WorkflowService(ctx).create({ name }, 'a');
    const draft = await new VersionService(ctx).saveDraft(wf.defaultBranchId, { id: wf.key, name: wf.name, processes: [{ id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars, nodes, flows, ...procProps }] } as any, 'a');
    const pub = await new VersionService(ctx).publish(draft.id, 'a');
    await new DeploymentService(ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'a');
    return { wf, processId: `${wf.key}.process` };
  };
  const line = (...mid: any[]) => ({
    nodes: [{ id: 's', type: 'start' }, ...mid, { id: 'e', type: 'end' }],
    flows: [{ id: 'f0', from: 's', to: mid[0].id }, ...mid.slice(1).map((m, i) => ({ id: `f${i + 1}`, from: mid[i].id, to: m.id })), { id: 'fe', from: mid.at(-1).id, to: 'e' }],
  });
  const start = (wfId: string, variables: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => new InstanceService(ctx).start({ workflowId: wfId, environment: 'prod', variables, ...extra }, 'amy');
  const get = (id: string) => new InstanceService(ctx).get(id);
  const tick = (sec: number) => new TimerService(ctx).tick(at(sec));
  const tasks = (instanceId?: string) => store.repo<Task>(Collections.tasks).query((t) => !instanceId || t.instanceId === instanceId);
  const completeTask = async (id: string, outputs: Record<string, unknown> = {}) => { const t = new TaskService(ctx); await t.claim(id, 'amy'); await t.complete(id, outputs, 'amy'); };
  const instances = () => store.repo<Instance>(Collections.instances).query(() => true);
  /** the part of an instance a behaviour change would alter: no ids, no timestamps */
  const trace = (i: Instance) => ({
    status: i.status,
    visits: i.history.map((h) => `${h.nodeId}:${h.outcome ?? ''}`.replace(/called:[^ ]+|sub:[^ ]+/g, (m) => m.split(':')[0] + ':*')),
    vars: Object.fromEntries(Object.entries(i.variables).filter(([k]) => !k.startsWith('_')).sort(([a], [b]) => a.localeCompare(b))),
    waiting: i.tokens.filter((t) => t.state === 'waiting').map((t) => `${t.nodeId}:${t.waitFor?.kind}`).sort(),
    error: i.error?.message ?? null,
  });
  return { store, ctx, deploy, line, start, get, tick, tasks, completeTask, instances, trace };
}

/** A store that hands out COPIES like a real database does (the plain MemoryStore shares object references, which hides lost updates). */
export function cloningStore(inner: MemoryStore) {
  const c = <T>(v: T): T => (v === undefined ? v : structuredClone(v));
  // a real database yields to other work on every round trip; a seeded jitter reproduces the interleavings deterministically enough
  let seed = 7;
  const io = async () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; for (let n = seed % 4; n >= 0; n--) await new Promise((r) => setImmediate(r)); };
  return new Proxy(inner, {
    get(target, prop, recv) {
      if (prop !== 'repo') return Reflect.get(target, prop, recv);
      return (name: string) => {
        const r = target.repo<any>(name);
        return {
          get: async (id: string) => { await io(); return c(await r.get(id)); },
          list: async () => c(await r.list()),
          query: async (pred: (t: any) => boolean) => { await io(); return c(await r.query(pred)); },
          put: async (e: any) => { await io(); return r.put(c(e)); },
          delete: (id: string) => r.delete(id),
        };
      };
    },
  }) as MemoryStore;
}
