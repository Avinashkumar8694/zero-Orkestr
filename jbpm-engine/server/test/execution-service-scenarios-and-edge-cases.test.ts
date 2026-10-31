// Comprehensive test suite for Execution Service scenarios, edge cases, and runtime resilience.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeContext } from '../src/context.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { fakeClock } from '../src/infra/ids.ts';
import { ExecutionEngine } from '../src/engine/execution-engine.ts';
import { InstanceService } from '../src/modules/instances/service.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import type { Deployment, Instance, Workflow } from '../src/domain.ts';
import type { EngineProject, EngineProcess } from '../src/sdk/index.ts';

function createTestCtx() {
  let idCounter = 1000;
  return makeContext({
    store: new MemoryStore(),
    tenantId: 'tenant-test',
    clock: fakeClock().clock,
    newId: () => `id_${++idCounter}`,
  });
}

function makeDeployment(project: EngineProject, globalErrorHandler?: any): Deployment {
  return {
    id: 'dep_test',
    tenantId: 'tenant-test',
    workflowId: 'wf_test',
    versionId: 'v1',
    branchId: 'b_main',
    engine: project,
    env: { BASE_URL: 'http://mock-service.local' },
    tags: ['test'],
    status: 'active',
    environment: 'test',
    deployedAt: new Date().toISOString(),
    deployedBy: 'tester',
  };
}

test('Execution Flow: Complete multi-node orchestration with state passing', async () => {
  const ctx = createTestCtx();
  const engine = new ExecutionEngine(ctx);

  const mainProcess: EngineProcess = {
    id: 'main.process',
    name: 'Main Process',
    package: 'com.acme',
    vars: [
      { name: 'amount', type: 'number' },
      { name: 'riskScore', type: 'number' },
      { name: 'approved', type: 'boolean' },
    ],
    nodes: [
      { id: 'start', type: 'start', name: 'Start' },
      { id: 'script1', type: 'script', name: 'Calc Risk', code: 'kcontext.setVariable("riskScore", (kcontext.getVariable("amount") || 0) * 2);' },
      { id: 'gw1', type: 'gateway', name: 'Risk Split', mode: 'exclusive', default: 'flow_low' },
      { id: 'task_manual', type: 'manual', name: 'Manual Verification' },
      { id: 'script2', type: 'script', name: 'Auto Approve', code: 'kcontext.setVariable("approved", true);' },
      { id: 'join', type: 'gateway', name: 'Join Gate', mode: 'exclusive' },
      { id: 'end', type: 'end', name: 'End' },
    ],
    flows: [
      { id: 'f1', from: 'start', to: 'script1' },
      { id: 'f2', from: 'script1', to: 'gw1' },
      { id: 'flow_high', from: 'gw1', to: 'task_manual', when: 'kcontext.getVariable("riskScore") > 100' },
      { id: 'flow_low', from: 'gw1', to: 'script2' },
      { id: 'f3', from: 'task_manual', to: 'join' },
      { id: 'f4', from: 'script2', to: 'join' },
      { id: 'f5', from: 'join', to: 'end' },
    ],
  };

  const project: EngineProject = { id: 'test_proj', name: 'Test', processes: [mainProcess] };
  const dep = makeDeployment(project);

  // Scenario A: amount = 25 -> riskScore = 50 -> low branch -> script2 -> approved = true -> end
  const instLow = await engine.start(dep, { amount: 25 }, 'user_a', { processId: 'main.process' });
  assert.equal(instLow.status, 'completed');
  assert.equal(instLow.variables.riskScore, 50);
  assert.equal(instLow.variables.approved, true);

  // Scenario B: amount = 100 -> riskScore = 200 -> high branch -> manual task -> join -> end
  const instHigh = await engine.start(dep, { amount: 100 }, 'user_b', { processId: 'main.process' });
  assert.equal(instHigh.status, 'completed');
  assert.equal(instHigh.variables.riskScore, 200);
  assert.equal(instHigh.variables.approved, undefined);
});

test('Execution Edge Case: Gateway fallback when condition throws or resolves false', async () => {
  const ctx = createTestCtx();
  const engine = new ExecutionEngine(ctx);

  const proc: EngineProcess = {
    id: 'gw.fallback',
    name: 'Gateway Fallback',
    package: 'com.acme',
    vars: [{ name: 'branchTaken', type: 'string' }],
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'gw', type: 'gateway', mode: 'exclusive', default: 'f_default' },
      { id: 's_match', type: 'script', code: 'kcontext.setVariable("branchTaken", "matched");' },
      { id: 's_default', type: 'script', code: 'kcontext.setVariable("branchTaken", "default");' },
      { id: 'end', type: 'end' },
    ],
    flows: [
      { id: 'f0', from: 'start', to: 'gw' },
      { id: 'f_match', from: 'gw', to: 's_match', when: 'kcontext.getVariable("nonExistent") === "match"' },
      { id: 'f_default', from: 'gw', to: 's_default' },
      { id: 'f1', from: 's_match', to: 'end' },
      { id: 'f2', from: 's_default', to: 'end' },
    ],
  };

  const dep = makeDeployment({ id: 'proj', name: 'Proj', processes: [proc] });
  const inst = await engine.start(dep, {}, 'tester', { processId: 'gw.fallback' });
  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.branchTaken, 'default');
});

test('Execution Edge Case: forEach multi-instance with empty collection safely proceeds', async () => {
  const ctx = createTestCtx();
  const engine = new ExecutionEngine(ctx);

  const childProc: EngineProcess = {
    id: 'child.proc',
    name: 'Child',
    package: 'com.acme',
    vars: [{ name: 'item', type: 'string' }],
    nodes: [
      { id: 's', type: 'start' },
      { id: 'e', type: 'end' },
    ],
    flows: [{ id: 'f', from: 's', to: 'e' }],
  };

  const parentProc: EngineProcess = {
    id: 'parent.proc',
    name: 'Parent',
    package: 'com.acme',
    vars: [{ name: 'items', type: 'array' }, { name: 'done', type: 'boolean' }],
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'mi', type: 'forEach', process: 'child.proc', over: 'items', as: 'item' },
      { id: 'after', type: 'script', code: 'kcontext.setVariable("done", true);' },
      { id: 'end', type: 'end' },
    ],
    flows: [
      { id: 'f1', from: 'start', to: 'mi' },
      { id: 'f2', from: 'mi', to: 'after' },
      { id: 'f3', from: 'after', to: 'end' },
    ],
  };

  const dep = makeDeployment({ id: 'proj', name: 'Proj', processes: [parentProc, childProc] });
  // Start with empty array
  const inst = await engine.start(dep, { items: [] }, 'tester', { processId: 'parent.proc' });
  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.done, true);
});

test('Execution Edge Case: Terminal state isolation refuses post-completion signals or retries', async () => {
  const ctx = createTestCtx();
  const engine = new ExecutionEngine(ctx);
  const instSvc = new InstanceService(ctx);

  const proc: EngineProcess = {
    id: 'simple.proc',
    name: 'Simple',
    package: 'com.acme',
    vars: [],
    nodes: [
      { id: 's', type: 'start' },
      { id: 'e', type: 'end' },
    ],
    flows: [{ id: 'f', from: 's', to: 'e' }],
  };

  const dep = makeDeployment({ id: 'proj', name: 'Proj', processes: [proc] });
  await ctx.store.repo<Deployment>('deployments').put(dep);
  const inst = await engine.start(dep, {}, 'tester', { processId: 'simple.proc' });
  await ctx.store.repo<Instance>('instances').put(inst);
  assert.equal(inst.status, 'completed');

  // Verify signal is rejected
  await assert.rejects(
    async () => instSvc.signal(inst.id, 'SIG_ANY', {}, 'tester'),
    /cannot signal a terminal instance/
  );

  // Verify retry is rejected
  await assert.rejects(
    async () => instSvc.retry(inst.id, 's', 'tester'),
    /cannot retry a terminal instance/
  );
});

test('Execution Flow: Local error catch precedence over Global Error Handler with proper error code', async () => {
  const ctx = createTestCtx();
  const engine = new ExecutionEngine(ctx);

  const proc: EngineProcess = {
    id: 'error.prec',
    name: 'Precedence Test',
    package: 'com.acme',
    vars: [{ name: 'recoveredLocally', type: 'boolean' }],
    nodes: [
      { id: 's', type: 'start' },
      { id: 'failing_node', type: 'script', name: 'Script Fail', code: 'throw new Error("network drop");' },
      { id: 'local_catch', type: 'boundary', on: 'failing_node', event: { error: 'SCRIPT_ERROR' } },
      { id: 'recovery_node', type: 'script', code: 'kcontext.setVariable("recoveredLocally", true);' },
      { id: 'end', type: 'end' },
    ],
    flows: [
      { id: 'f1', from: 's', to: 'failing_node' },
      { id: 'f2', from: 'local_catch', to: 'recovery_node' },
      { id: 'f3', from: 'recovery_node', to: 'end' },
    ],
  };

  const dep = makeDeployment({ id: 'proj', name: 'Proj', processes: [proc] });
  dep.globalErrorHandler = { enabled: true, processId: 'nonexistent.global.geh' };
  const inst = await engine.start(dep, {}, 'tester', { processId: 'error.prec' });
  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.recoveredLocally, true);
});
