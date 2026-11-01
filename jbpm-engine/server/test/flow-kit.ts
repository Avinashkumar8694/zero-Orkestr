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

export function kit(tenantId = 't1') {
  const store = new MemoryStore();
  let n = 0;
  const ctx = makeContext({ store, tenantId, clock: fakeClock(T0).clock, newId: () => `id${++n}` });
  const deploy = async (name: string, nodes: any[], flows: any[], vars: any[] = []) => {
    const wf = await new WorkflowService(ctx).create({ name }, 'a');
    const draft = await new VersionService(ctx).saveDraft(wf.defaultBranchId, { id: wf.key, name: wf.name, processes: [{ id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars, nodes, flows }] } as any, 'a');
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
