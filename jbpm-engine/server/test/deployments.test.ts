// Cross-project deployment listing (DeploymentService.list) — powers the top-level Deployments page,
// which browses across every project the way GET /instances already does, rather than requiring one
// project to be picked first.
import { test } from 'node:test';
import assert from 'node:assert';
import { MemoryStore } from '../src/store/memory-store.ts';
import { fakeClock } from '../src/infra/ids.ts';
import { makeContext } from '../src/context.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { ProcessService } from '../src/modules/processes/service.ts';

const newCtx = () => { let n = 0; return makeContext({ store: new MemoryStore(), tenantId: 't1', clock: fakeClock().clock, newId: () => `id${++n}` }); };

async function deployedWorkflow(ctx: ReturnType<typeof newCtx>, name: string, environment: string) {
  const wf = await new WorkflowService(ctx).create({ name }, 'a');
  // the seeded default process is start-only (no end, unconnected) — replace it with a minimal valid
  // start->end flow so publish's validation gate doesn't reject it.
  await new ProcessService(ctx).saveProcess(wf.id, `${wf.key}.process`, {
    id: `${wf.key}.process`, name, package: 'com.acme', vars: [],
    nodes: [{ id: 's', type: 'start' }, { id: 'e', type: 'end' }],
    flows: [{ id: 'f1', from: 's', to: 'e' }],
  } as any, 'a');
  const versions = await new VersionService(ctx).listByBranch(wf.defaultBranchId);
  const head = versions.filter((v) => v.state === 'draft').at(-1)!;
  const pub = await new VersionService(ctx).publish(head.id, 'a');
  const dep = await new DeploymentService(ctx).deploy(pub.published.id, { environment, activate: true }, 'a');
  return { wf, dep };
}

test('DeploymentService.list: cross-project by default, filterable by workflowId/environment/status', async () => {
  const ctx = newCtx();
  const deployments = new DeploymentService(ctx);
  const { wf: wfA, dep: depA } = await deployedWorkflow(ctx, 'Alpha', 'dev');
  const { wf: wfB, dep: depB } = await deployedWorkflow(ctx, 'Beta', 'prod');

  const all = await deployments.list({});
  assert.strictEqual(all.length, 2, 'lists deployments across both projects with no filter');

  const onlyA = await deployments.list({ workflowId: wfA.id });
  assert.deepStrictEqual(onlyA.map((d) => d.id), [depA.id]);

  const onlyProd = await deployments.list({ environment: 'prod' });
  assert.deepStrictEqual(onlyProd.map((d) => d.id), [depB.id]);

  const onlyActive = await deployments.list({ status: 'active' });
  assert.strictEqual(onlyActive.length, 2, 'both were deployed with activate:true');

  await deployments.undeploy(depA.id, 'a');
  const stillActive = await deployments.list({ status: 'active' });
  assert.deepStrictEqual(stillActive.map((d) => d.id), [depB.id]);
});

test('DeploymentService: export snapshot, restore to project, and import snapshot', async () => {
  const ctx = newCtx();
  const deployments = new DeploymentService(ctx);
  const versions = new VersionService(ctx);
  const { wf, dep } = await deployedWorkflow(ctx, 'SnapshotDemo', 'prod');

  assert.strictEqual(dep.snapshot?.frozen, true, 'deployment carries frozen snapshot');

  // 1. Export snapshot
  const exported = await deployments.exportSnapshot(dep.id);
  assert.strictEqual(exported.format, 'jbpm-deployment-snapshot');
  assert.strictEqual(exported.deployment.id, dep.id);
  assert.strictEqual(exported.engine.processes.length, 1);

  // 2. Modify project draft after deployment
  const procSvc = new ProcessService(ctx);
  await procSvc.saveProcess(wf.id, `${wf.key}.process`, {
    id: `${wf.key}.process`, name: 'Modified Flow', package: 'com.acme', vars: [],
    nodes: [{ id: 's', type: 'start' }, { id: 'script1', type: 'script' }, { id: 'e', type: 'end' }],
    flows: [{ id: 'f1', from: 's', to: 'script1' }, { id: 'f2', from: 'script1', to: 'e' }],
  } as any, 'user1');

  // Verify draft now has 3 nodes
  const draftsBeforeRestore = await versions.listByBranch(wf.defaultBranchId);
  const currentHead = draftsBeforeRestore.filter((v) => v.state === 'draft').at(-1)!;
  assert.strictEqual(currentHead.engine.processes[0].nodes.length, 3);

  // 3. Restore to project from deployment snapshot
  const restoreRes = await deployments.restore(dep.id, 'admin');
  assert.strictEqual(restoreRes.ok, true);

  const draftsAfterRestore = await versions.listByBranch(wf.defaultBranchId);
  const restoredHead = draftsAfterRestore.filter((v) => v.state === 'draft').at(-1)!;
  assert.strictEqual(restoredHead.engine.processes[0].nodes.length, 2, 'restored to original 2 nodes from snapshot');

  // 4. Import snapshot to a new environment
  const imported = await deployments.importSnapshot({ snapshot: exported, environment: 'stage' }, 'admin');
  assert.strictEqual(imported.environment, 'stage');
  assert.strictEqual(imported.status, 'inactive');
  assert.strictEqual(imported.snapshot?.frozen, true);
  assert.strictEqual(imported.engine.processes[0].nodes.length, 2);
});
