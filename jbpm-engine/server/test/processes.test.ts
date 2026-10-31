// A project holds multiple processes; each can be started independently by processId and shares the
// deployed version. Deterministic (MemoryStore + fake clock + counting ids).
import { test } from 'node:test';
import assert from 'node:assert';
import { MemoryStore } from '../src/store/memory-store.ts';
import { fakeClock } from '../src/infra/ids.ts';
import { makeContext } from '../src/context.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { InstanceService } from '../src/modules/instances/service.ts';
import { ProcessService } from '../src/modules/processes/service.ts';

const newCtx = () => { let n = 0; return makeContext({ store: new MemoryStore(), tenantId: 't1', clock: fakeClock().clock, newId: () => `id${++n}` }); };
const P = (id: string, name: string, nodes: any[], flows: any[], vars: any[] = []) => ({ id, name, package: 'com.acme', vars, nodes, flows });

test('project with multiple processes: start each by processId; shared deployment', async () => {
  const ctx = newCtx();
  const wf = await new WorkflowService(ctx).create({ name: 'Multi' }, 'a');   // key "multi", seed process "multi.process"
  const ps = new ProcessService(ctx);

  // process A (manual) and a second process B (script)
  await ps.saveProcess(wf.id, 'multi.process', P('multi.process', 'A',
    [{ id: 's', type: 'start' }, { id: 'a', type: 'manual', name: 'Do A' }, { id: 'e', type: 'end' }],
    [{ id: 'f1', from: 's', to: 'a' }, { id: 'f2', from: 'a', to: 'e' }]), 'a');
  const p2 = await ps.add(wf.id, 'Second', 'a');
  await ps.saveProcess(wf.id, p2.id, P(p2.id, 'B',
    [{ id: 's', type: 'start' }, { id: 'sc', type: 'script', name: 'Mark', code: 'kcontext.setVariable("ran", true);' }, { id: 'e', type: 'end' }],
    [{ id: 'f1', from: 's', to: 'sc' }, { id: 'f2', from: 'sc', to: 'e' }], [{ name: 'ran', type: 'bool' }]), 'a');

  const list = await ps.list(wf.id);
  assert.strictEqual(list.length, 2, 'project has two processes');
  assert.deepStrictEqual(list.map((p) => p.id).sort(), ['multi.process', 'multi.second'].sort());

  // publish (validates ALL processes) + deploy + activate
  const versions = await new VersionService(ctx).listByBranch(wf.defaultBranchId);
  const head = versions.filter((v) => v.state === 'draft').at(-1)!;
  const pub = await new VersionService(ctx).publish(head.id, 'a');
  assert.strictEqual(pub.published.engine.processes!.length, 2, 'both processes deployed together');
  await new DeploymentService(ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'a');

  const inst = new InstanceService(ctx);
  // start process B by id
  const b = await inst.start({ workflowId: wf.id, processId: p2.id, environment: 'prod' }, 'bob');
  assert.strictEqual(b.status, 'completed');
  assert.strictEqual(b.processId, p2.id, 'instance pinned to the chosen process');
  assert.strictEqual(b.variables.ran, true, 'process B script ran');
  assert.ok(b.history.some((h) => h.nodeId === 'sc'));

  // start the default (first) process
  const a = await inst.start({ workflowId: wf.id, environment: 'prod' }, 'bob');
  assert.strictEqual(a.processId, 'multi.process');
  assert.strictEqual(a.status, 'completed');
  assert.ok(a.history.some((h) => h.nodeId === 'a'));
});

test('WorkflowService: archive, restore, and purge lifecycle', async () => {
  const ctx = newCtx();
  const wfSvc = new WorkflowService(ctx);

  const wf1 = await wfSvc.create({ name: 'Project 1' }, 'admin');
  const wf2 = await wfSvc.create({ name: 'Project 2' }, 'admin');

  assert.strictEqual((await wfSvc.list()).length, 2);
  assert.strictEqual((await wfSvc.listArchived()).length, 0);

  // Archive wf1
  await wfSvc.archive(wf1.id, 'admin');
  assert.strictEqual((await wfSvc.list()).length, 1);
  assert.strictEqual((await wfSvc.listArchived()).length, 1);
  assert.strictEqual((await wfSvc.list(true)).length, 2);

  // Restore wf1
  await wfSvc.restore(wf1.id, 'admin');
  assert.strictEqual((await wfSvc.list()).length, 2);
  assert.strictEqual((await wfSvc.listArchived()).length, 0);

  // Archive both and purge wf1
  await wfSvc.archive(wf1.id, 'admin');
  await wfSvc.archive(wf2.id, 'admin');
  assert.strictEqual((await wfSvc.listArchived()).length, 2);

  await wfSvc.purge(wf1.id, 'admin');
  assert.strictEqual((await wfSvc.listArchived()).length, 1);
  assert.strictEqual((await wfSvc.list(true)).length, 1);

  // Purge all remaining archived
  const res = await wfSvc.purgeAllArchived('admin');
  assert.strictEqual(res.purgedCount, 1);
  assert.strictEqual((await wfSvc.listArchived()).length, 0);
  assert.strictEqual((await wfSvc.list(true)).length, 0);
});
