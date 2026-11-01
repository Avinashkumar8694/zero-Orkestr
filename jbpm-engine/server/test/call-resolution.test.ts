// Two active deployments carrying a process with the same id: a call activity must run its OWN deployment's sub-process.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { kit } from './flow-kit.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { InstanceService } from '../src/modules/instances/service.ts';

const project = async (k: ReturnType<typeof kit>, name: string, tag: string, environment = 'prod') => {
  const wf = await new WorkflowService(k.ctx).create({ name }, 'a');
  const procs = [
    { id: 'main', name: 'main', package: 'p', vars: [], nodes: [{ id: 's', type: 'start' }, { id: 'call', type: 'call', process: 'shared.child' }, { id: 'e', type: 'end' }], flows: [{ id: 'f0', from: 's', to: 'call' }, { id: 'f1', from: 'call', to: 'e' }] },
    { id: 'shared.child', name: 'child', package: 'p', vars: [], nodes: [{ id: 's', type: 'start' }, { id: 'sc', type: 'script', name: 'tag', code: `setVariable('from', '${tag}')` }, { id: 'e', type: 'end' }], flows: [{ id: 'f0', from: 's', to: 'sc' }, { id: 'f1', from: 'sc', to: 'e' }] },
  ];
  const d = await new VersionService(k.ctx).saveDraft(wf.defaultBranchId, { id: wf.key, name, processes: procs } as any, 'a');
  const pub = await new VersionService(k.ctx).publish(d.id, 'a');
  await new DeploymentService(k.ctx).deploy(pub.published.id, { environment, activate: true }, 'a');
  return wf;
};

test('CALL-1 the caller\'s own deployment supplies the sub-process, even when an older deployment with the same ids is active', async () => {
  const k = kit('t1');
  const oldWf = await project(k, 'oldproj', 'OLD');
  const newWf = await project(k, 'newproj', 'NEW');
  for (const [wf, tag] of [[newWf, 'NEW'], [oldWf, 'OLD']] as const) {
    const inst = await new InstanceService(k.ctx).start({ workflowId: wf.id, environment: 'prod', processId: 'main' } as any, 'a');
    const kids = await k.instances().then((all) => all.filter((i) => i.parentInstanceId === inst.id));
    assert.strictEqual(kids.length, 1);
    assert.strictEqual(kids[0]!.variables.from, tag, `${wf.name} must run its own child`);
  }
});
after(() => setTimeout(() => process.exit(0), 50).unref());   // the JVM sidecar / test server would otherwise keep this process alive

test('CALL-2 purging a project removes its deployments, instances and tasks (nothing keeps serving or lingers)', async () => {
  const k = kit('t1');
  const wf = await project(k, 'purgeme', 'P');
  const keep = await project(k, 'keepme', 'K');
  const inst = await new InstanceService(k.ctx).start({ workflowId: wf.id, environment: 'prod', processId: 'main' } as any, 'a');
  assert.ok(inst.id);
  const { WorkflowService: WS } = await import('../src/modules/workflows/service.ts');
  await new WS(k.ctx).purge(wf.id, 'a');
  const { Collections } = await import('../src/domain.ts');
  const left = async (col: string) => (await k.store.repo<any>(col).query((x: any) => x.workflowId === wf.id)).length;
  assert.strictEqual(await left(Collections.deployments), 0);
  assert.strictEqual(await left(Collections.instances), 0);
  await assert.rejects(new InstanceService(k.ctx).start({ workflowId: wf.id, environment: 'prod', processId: 'main' } as any, 'a'));
  assert.ok((await k.store.repo<any>(Collections.deployments).query((x: any) => x.workflowId === keep.id)).length >= 1, 'another project is untouched');
});
