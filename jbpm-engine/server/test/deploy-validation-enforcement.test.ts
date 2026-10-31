import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory-store.ts';
import { makeContext } from '../src/context.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { ProcessService } from '../src/modules/processes/service.ts';
import { Collections, type Version, type Workflow, type Branch } from '../src/domain.ts';
import type { EngineProject } from '../src/sdk/index.ts';

test('Deploy & Publish Validation Enforcement: blocks invalid & unsupported constructs', async () => {
  const store = new MemoryStore();
  const ctx = makeContext({ store, tenantId: 'test-tenant' });
  const wfService = new WorkflowService(ctx);
  const vService = new VersionService(ctx);
  const dService = new DeploymentService(ctx);
  const pService = new ProcessService(ctx);

  // 1. Create a project
  const wf = await wfService.create({ name: 'Validation Enforcement Project' }, 'tester');

  // 2. Save an invalid process draft (missing end node, unconnected start)
  const invalidEngine: EngineProject = {
    processes: [
      {
        id: 'p1',
        name: 'Invalid Process',
        package: 'com.acme',
        vars: [],
        nodes: [{ id: 'start', type: 'start', name: 'Start' } as any],
        flows: [],
      },
    ],
  };

  await vService.saveDraft(wf.defaultBranchId, invalidEngine, 'tester');

  // Verify that Workflow cached validationSummary records the error
  const updatedWf = await wfService.get(wf.id);
  assert.equal(updatedWf.validationSummary?.hasErrors, true);
  assert.ok(updatedWf.validationSummary?.errorCount! > 0);

  // Verify that ProcessService.list returns validation status
  const procList = await pService.list(wf.id);
  assert.equal(procList.length, 1);
  assert.equal(procList[0].hasErrors, true);
  assert.ok(procList[0].errorCount! > 0);
  assert.ok(procList[0].problems && procList[0].problems.length > 0);

  // 3. Publishing MUST fail on validation errors
  const branch = (await store.repo<Branch>(Collections.branches).get(wf.defaultBranchId))!;
  await assert.rejects(
    async () => {
      await vService.publish(branch.headVersionId!, 'tester', 'v1');
    },
    (err: any) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      assert.ok(err.message.includes('publish'));
      return true;
    }
  );

  // 4. Manually simulate a published version that was somehow corrupt or has an unsupported construct ('raw')
  const unsupportedEngine: EngineProject = {
    processes: [
      {
        id: 'p2',
        name: 'Unsupported Raw Node Process',
        package: 'com.acme',
        vars: [],
        nodes: [
          { id: 'start', type: 'start', name: 'Start' } as any,
          { id: 'raw1', type: 'raw', name: 'Ad-Hoc Unmodeled Construct' } as any,
          { id: 'end', type: 'end', name: 'End' } as any,
        ],
        flows: [
          { id: 'f1', from: 'start', to: 'raw1' },
          { id: 'f2', from: 'raw1', to: 'end' },
        ],
      },
    ],
  };

  const corruptPublishedVersion: Version = {
    id: 'corrupt-v1',
    tenantId: 'test-tenant',
    workflowId: wf.id,
    branchId: wf.defaultBranchId,
    number: 99,
    state: 'published',
    engine: unsupportedEngine,
    createdAt: new Date().toISOString(),
    createdBy: 'tester',
  };
  await store.repo<Version>(Collections.versions).put(corruptPublishedVersion);

  // 5. Deploying a version with unsupported constructs ('raw') or errors MUST be strictly blocked
  await assert.rejects(
    async () => {
      await dService.deploy('corrupt-v1', { environment: 'production' }, 'tester');
    },
    (err: any) => {
      assert.equal(err.code, 'VALIDATION_FAILED');
      assert.ok(err.message.includes('deploy'));
      assert.ok(err.details && Array.isArray(err.details));
      const hasUnsupported = err.details.some((d: any) => d.rule === 'unsupported-construct');
      assert.ok(hasUnsupported, 'Expected unsupported-construct rule error in details');
      return true;
    }
  );

  // 6. Now save a completely valid process
  const validEngine: EngineProject = {
    processes: [
      {
        id: 'p3',
        name: 'Clean Valid Process',
        package: 'com.acme',
        vars: [],
        nodes: [
          { id: 'start', type: 'start', name: 'Start' } as any,
          { id: 'end', type: 'end', name: 'End' } as any,
        ],
        flows: [{ id: 'f1', from: 'start', to: 'end' }],
      },
    ],
  };

  const cleanDraft = await vService.saveDraft(wf.defaultBranchId, validEngine, 'tester');
  const cleanWf = await wfService.get(wf.id);
  assert.equal(cleanWf.validationSummary?.hasErrors, false);
  assert.equal(cleanWf.validationSummary?.errorCount, 0);

  // 7. Publish clean draft succeeds
  const { published } = await vService.publish(cleanDraft.id, 'tester', 'v1.0.0');
  assert.equal(published.state, 'published');

  // 8. Deploy clean published version succeeds
  const dep = await dService.deploy(published.id, { environment: 'production', activate: true }, 'tester');
  assert.equal(dep.status, 'active');
  assert.equal(dep.environment, 'production');
});
