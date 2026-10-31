import test from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionEngine } from '../src/engine/execution-engine.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import type { AppContext } from '../src/context.ts';
import type { Deployment, Instance, Workflow } from '../src/domain.ts';
import type { EngineProject } from '../src/sdk/index.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';

function createMockApp(): AppContext {
  const store = new MemoryStore();
  let idGen = 1000;
  return {
    tenantId: 'tenant-test',
    store,
    clock: () => new Date().toISOString(),
    newId: () => `id_${++idGen}`,
    audit: async () => {},
  };
}

test('Hierarchical Error Handling: Local boundary error takes precedence over project global error handler', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'test-wf',
    name: 'Test Workflow',
    processes: [
      {
        id: 'main-process',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'failing_node', type: 'script', code: 'throw new Error("failing locally");' },
          { id: 'local_boundary', type: 'boundary', on: 'failing_node', event: { error: 'SCRIPT_ERROR' } },
          { id: 'local_recovery', type: 'script', code: 'vars.handledBy = "local";' },
          { id: 'end_ok', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'failing_node' },
          { from: 'local_boundary', to: 'local_recovery' },
          { from: 'local_recovery', to: 'end_ok' },
        ],
      },
      {
        id: 'global-error-proc',
        name: 'Global Error Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'err_start', type: 'start' },
          { id: 'err_script', type: 'script', code: 'vars.handledBy = "global";' },
          { id: 'err_end', type: 'end' },
        ],
        flows: [
          { from: 'err_start', to: 'err_script' },
          { from: 'err_script', to: 'err_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_1',
    tenantId: app.tenantId,
    workflowId: 'wf_1',
    versionId: 'ver_1',
    branchId: 'br_1',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'global-error-proc',
      strategy: 'repair-and-resume',
    },
  };

  const inst: Instance = {
    id: 'inst_1',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-process',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_1', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  // Local boundary handled it!
  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.handledBy, 'local');
  assert.ok(inst.variables.errorInfo);
  assert.equal((inst.variables.errorInfo as any).code, 'SCRIPT_ERROR');
  assert.equal((inst.variables.errorInfo as any).node, 'failing_node');
});

test('Hierarchical Error Handling: Unhandled node error invokes Global Error Handler with repair-and-resume', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'test-wf',
    name: 'Test Workflow',
    processes: [
      {
        id: 'main-process',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'failing_task', type: 'script', code: 'throw new Error("unhandled failure");' },
          { id: 'success_node', type: 'script', code: 'vars.step = "resumed_successfully";' },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'failing_task' },
          { from: 'failing_task', to: 'success_node' },
          { from: 'success_node', to: 'end' },
        ],
      },
      {
        id: 'global-repair-proc',
        name: 'Global Repair Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'err_start', type: 'start' },
          {
            id: 'err_repair_script',
            type: 'script',
            code: `
              vars.recoveredPayload = "fixed_data";
              vars.seenFailedNode = failedNodeId;
              vars.seenErrorMessage = errorMessage;
            `,
          },
          { id: 'err_end', type: 'end' },
        ],
        flows: [
          { from: 'err_start', to: 'err_repair_script' },
          { from: 'err_repair_script', to: 'err_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_2',
    tenantId: app.tenantId,
    workflowId: 'wf_2',
    versionId: 'ver_2',
    branchId: 'br_2',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'global-repair-proc',
      strategy: 'repair-and-resume',
      outputMappings: {
        recoveredPayload: 'repairedData',
      },
    },
  };

  const inst: Instance = {
    id: 'inst_2',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-process',
    status: 'running',
    variables: { initialData: 123 },
    tokens: [{ id: 'tok_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  // The global handler repaired the state, mapped recoveredPayload -> repairedData, and resumed past failing_task
  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.step, 'resumed_successfully');
  assert.equal(inst.variables.repairedData, 'fixed_data');
  assert.equal(inst.variables.errorRepaired, true);
  assert.equal(inst.variables.initialData, 123);
});

test('Hierarchical Error Handling: Global Error Handler with retry action', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'test-wf',
    name: 'Test Workflow',
    processes: [
      {
        id: 'main-process',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'conditional_fail_task',
            type: 'script',
            code: `
              if (!vars.authorized) {
                throw new Error("Unauthorized 401");
              }
              vars.data = "authorized_access";
            `,
          },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'conditional_fail_task' },
          { from: 'conditional_fail_task', to: 'end' },
        ],
      },
      {
        id: 'auth-fix-handler',
        name: 'Auth Fix Handler',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'err_start', type: 'start' },
          {
            id: 'err_fix',
            type: 'script',
            code: `
              vars.authorized = true;
              vars.errorHandlerAction = "retry";
            `,
          },
          { id: 'err_end', type: 'end' },
        ],
        flows: [
          { from: 'err_start', to: 'err_fix' },
          { from: 'err_fix', to: 'err_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_3',
    tenantId: app.tenantId,
    workflowId: 'wf_3',
    versionId: 'ver_3',
    branchId: 'br_3',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'auth-fix-handler',
      strategy: 'repair-and-resume',
      outputMappings: {
        authorized: 'authorized',
      },
    },
  };

  const inst: Instance = {
    id: 'inst_3',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-process',
    status: 'running',
    variables: { authorized: false },
    tokens: [{ id: 'tok_3', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  // failing node was retried after auth repair and completed
  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.data, 'authorized_access');
  assert.equal(inst.variables.authorized, true);
});

test('Hierarchical Error Handling: Circuit Breaker prevents recursion if Global Error Handler itself throws', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'test-wf',
    name: 'Test Workflow',
    processes: [
      {
        id: 'main-process',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'fail_node', type: 'script', code: 'throw new Error("primary fail");' },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'fail_node' },
          { from: 'fail_node', to: 'end' },
        ],
      },
      {
        id: 'broken-handler',
        name: 'Broken Handler',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'err_start', type: 'start' },
          { id: 'err_fail', type: 'script', code: 'throw new Error("handler internal fail");' },
          { id: 'err_end', type: 'end' },
        ],
        flows: [
          { from: 'err_start', to: 'err_fail' },
          { from: 'err_fail', to: 'err_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_4',
    tenantId: app.tenantId,
    workflowId: 'wf_4',
    versionId: 'ver_4',
    branchId: 'br_4',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'broken-handler',
      strategy: 'repair-and-resume',
    },
  };

  const inst: Instance = {
    id: 'inst_4',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-process',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_4', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  // Must not throw step budget loop error or stack overflow
  await engine.runToQuiescence(inst, dep);

  assert.equal(inst.status, 'failed');
  assert.ok(inst.error);
});

test('Environment Variables: Workflow.env merges into Deployment.env and is accessible in runtime sandbox', async () => {
  const app = createMockApp();
  const wfService = new WorkflowService(app);
  const verService = new VersionService(app);
  const depService = new DeploymentService(app);
  const engine = new ExecutionEngine(app);

  const wf = await wfService.create({ name: 'Env Project', key: 'env-project' }, 'tester');
  await wfService.update(
    wf.id,
    {
      env: {
        INTEGRATION_LAYER_URL: 'https://pru-integration.internal',
        CUSTOM_API_KEY: 'pru_secret_key_999',
      },
    },
    'tester'
  );

  const draftVer = (await verService.listByBranch(wf.defaultBranchId))[0];
  const proc = draftVer.engine.processes[0];
  proc.nodes = [
    { id: 'start', type: 'start' },
    {
      id: 'env_reader_script',
      type: 'script',
      code: `
        vars.readKey = env.CUSTOM_API_KEY;
        vars.readUrl = System.getenv("INTEGRATION_LAYER_URL");
      `,
    },
    { id: 'end', type: 'end' },
  ];
  proc.flows = [
    { from: 'start', to: 'env_reader_script' },
    { from: 'env_reader_script', to: 'end' },
  ];
  const savedDraft = await verService.saveDraft(wf.defaultBranchId, draftVer.engine, 'tester');
  const pub = await verService.publish(savedDraft.id, 'tester');

  // Deploy
  const dep = await depService.deploy(pub.published.id, { environment: 'prod', activate: true }, 'tester');

  // Deployment inherited project environment variables!
  assert.equal(dep.env['INTEGRATION_LAYER_URL'], 'https://pru-integration.internal');
  assert.equal(dep.env['CUSTOM_API_KEY'], 'pru_secret_key_999');

  const inst: Instance = {
    id: 'inst_env_test',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: proc.id,
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_env', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.readKey, 'pru_secret_key_999');
  assert.equal(inst.variables.readUrl, 'https://pru-integration.internal');
});

test('Hierarchical Error Handling: Local boundary with rethrow bubbles to Global Error Handler', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'test-wf',
    name: 'Test Workflow',
    processes: [
      {
        id: 'main-process',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'failing_node', type: 'script', code: 'throw new Error("local initial err");' },
          { id: 'local_boundary', type: 'boundary', on: 'failing_node', event: { error: 'SCRIPT_ERROR' } },
          { id: 'local_step', type: 'script', code: 'vars.localAudit = "logged_locally";' },
          // Error end with rethrow: true
          { id: 'rethrow_end', type: 'end', throw: { error: 'FATAL_ERROR', rethrow: true } },
        ],
        flows: [
          { from: 'start', to: 'failing_node' },
          { from: 'local_boundary', to: 'local_step' },
          { from: 'local_step', to: 'rethrow_end' },
        ],
      },
      {
        id: 'global-escalation-proc',
        name: 'Global Escalation Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'err_start', type: 'start' },
          { id: 'err_script', type: 'script', code: 'vars.handledBy = "global_after_rethrow";' },
          { id: 'err_end', type: 'end' },
        ],
        flows: [
          { from: 'err_start', to: 'err_script' },
          { from: 'err_script', to: 'err_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_rethrow',
    tenantId: app.tenantId,
    workflowId: 'wf_rethrow',
    versionId: 'ver_rethrow',
    branchId: 'br_rethrow',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'global-escalation-proc',
      strategy: 'repair-and-resume',
      outputMappings: {
        handledBy: 'handledBy',
      },
    },
  };

  const inst: Instance = {
    id: 'inst_rethrow',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-process',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_rethrow', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.localAudit, 'logged_locally');
  assert.equal(inst.variables.handledBy, 'global_after_rethrow');
});

test('Hierarchical Error Handling: Global Error Handler filter skips non-matching errors', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'test-wf',
    name: 'Test Workflow',
    processes: [
      {
        id: 'main-process',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'failing_node', type: 'script', code: 'throw new Error("unfiltered script error");' },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'failing_node' },
          { from: 'failing_node', to: 'end' },
        ],
      },
      {
        id: 'service-only-handler',
        name: 'Service Only Handler',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'err_start', type: 'start' },
          { id: 'err_script', type: 'script', code: 'vars.handlerRan = true;' },
          { id: 'err_end', type: 'end' },
        ],
        flows: [
          { from: 'err_start', to: 'err_script' },
          { from: 'err_script', to: 'err_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_filter',
    tenantId: app.tenantId,
    workflowId: 'wf_filter',
    versionId: 'ver_filter',
    branchId: 'br_filter',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'service-only-handler',
      filter: ['SERVICE_ERROR'], // only SERVICE_ERROR is filtered in, so SCRIPT_ERROR fails
      strategy: 'repair-and-resume',
    },
  };

  const inst: Instance = {
    id: 'inst_filter',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-process',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_filter', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  // Filter bypassed SCRIPT_ERROR, so the instance failed as unhandled
  assert.equal(inst.status, 'failed');
  assert.equal(inst.variables.handlerRan, undefined);
});

test('Hierarchical Error Handling: Specific error catch matches before catch-all on the same node', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'test-wf',
    name: 'Test Workflow',
    processes: [
      {
        id: 'main-process',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'http_task', type: 'script', code: 'throw new Error("HTTP connection refused");' },
          // Specific boundary catch for SCRIPT_ERROR
          { id: 'specific_catch', type: 'boundary', on: 'http_task', event: { error: 'SCRIPT_ERROR' } },
          { id: 'specific_step', type: 'script', code: 'vars.matched = "specific";' },
          // Catch-all boundary on the same node
          { id: 'catchall_catch', type: 'boundary', on: 'http_task', event: { error: '*' } },
          { id: 'catchall_step', type: 'script', code: 'vars.matched = "catchall";' },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'http_task' },
          { from: 'specific_catch', to: 'specific_step' },
          { from: 'specific_step', to: 'end' },
          { from: 'catchall_catch', to: 'catchall_step' },
          { from: 'catchall_step', to: 'end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_specific',
    tenantId: app.tenantId,
    workflowId: 'wf_specific',
    versionId: 'ver_specific',
    branchId: 'br_specific',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };

  const inst: Instance = {
    id: 'inst_specific',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-process',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.matched, 'specific');
});

test('Hierarchical Error Handling: Call Activity child failure is caught by Parent Error Boundary before Global Handler', async () => {
  const app = createMockApp();

  const project: EngineProject = {
    id: 'test-wf',
    name: 'Test Workflow',
    processes: [
      {
        id: 'parent-process',
        name: 'Parent Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'call_child', type: 'call', process: 'child-process' },
          // Parent error boundary on call activity
          { id: 'parent_boundary', type: 'boundary', on: 'call_child', event: { error: 'CALL_ERROR' } },
          { id: 'parent_recovery', type: 'script', code: 'vars.handledBy = "parent_boundary";' },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'call_child' },
          { from: 'parent_boundary', to: 'parent_recovery' },
          { from: 'parent_recovery', to: 'end' },
        ],
      },
      {
        id: 'child-process',
        name: 'Child Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'c_start', type: 'start' },
          { id: 'c_fail', type: 'script', code: 'throw new Error("child failed fatally");' },
          { id: 'c_end', type: 'end' },
        ],
        flows: [
          { from: 'c_start', to: 'c_fail' },
          { from: 'c_fail', to: 'c_end' },
        ],
      },
      {
        id: 'global-err-proc',
        name: 'Global Error Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'g_start', type: 'start' },
          { id: 'g_script', type: 'script', code: 'vars.handledBy = "global";' },
          { id: 'g_end', type: 'end' },
        ],
        flows: [
          { from: 'g_start', to: 'g_script' },
          { from: 'g_script', to: 'g_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_parent_call',
    tenantId: app.tenantId,
    workflowId: 'wf_parent_call',
    versionId: 'ver_parent_call',
    branchId: 'br_parent_call',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'global-err-proc',
      strategy: 'repair-and-resume',
    },
  };

  const resolveCalled = async (pid: string) => ({ dep, processId: pid });
  const engine = new ExecutionEngine(app, () => {}, resolveCalled);

  const inst: Instance = {
    id: 'inst_parent',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'parent-process',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_p_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  // Caught by the parent's boundary handler!
  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.handledBy, 'parent_boundary');
});

test('Hierarchical Error Handling: Call Activity child failure without Parent Boundary bubbles to Global Handler', async () => {
  const app = createMockApp();

  const project: EngineProject = {
    id: 'test-wf',
    name: 'Test Workflow',
    processes: [
      {
        id: 'parent-process-noboundary',
        name: 'Parent Process Without Boundary',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'call_child_unhandled', type: 'call', process: 'failing-child' },
          { id: 'post_child_step', type: 'script', code: 'vars.step = "post_child_ok";' },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'call_child_unhandled' },
          { from: 'call_child_unhandled', to: 'post_child_step' },
          { from: 'post_child_step', to: 'end' },
        ],
      },
      {
        id: 'failing-child',
        name: 'Failing Child Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'c_start', type: 'start' },
          { id: 'c_fail', type: 'script', code: 'throw new Error("child crash");' },
          { id: 'c_end', type: 'end' },
        ],
        flows: [
          { from: 'c_start', to: 'c_fail' },
          { from: 'c_fail', to: 'c_end' },
        ],
      },
      {
        id: 'global-child-recovery',
        name: 'Global Child Recovery',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'g_start', type: 'start' },
          {
            id: 'g_script',
            type: 'script',
            code: `
              vars.recoveredChild = true;
              vars.seenFailedNode = failedNodeId;
            `,
          },
          { id: 'g_end', type: 'end' },
        ],
        flows: [
          { from: 'g_start', to: 'g_script' },
          { from: 'g_script', to: 'g_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_child_bubble',
    tenantId: app.tenantId,
    workflowId: 'wf_child_bubble',
    versionId: 'ver_child_bubble',
    branchId: 'br_child_bubble',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'global-child-recovery',
      strategy: 'repair-and-resume',
      outputMappings: {
        recoveredChild: 'childFixed',
      },
    },
  };

  const resolveCalled = async (pid: string) => ({ dep, processId: pid });
  const engine = new ExecutionEngine(app, () => {}, resolveCalled);

  const inst: Instance = {
    id: 'inst_parent_bubble',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'parent-process-noboundary',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_start_bubble', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.childFixed, true);
  assert.equal(inst.variables.step, 'post_child_ok');
});

test('Hierarchical Error Handling: Global Error Handler compensate-and-abort marks original instance aborted', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'test-wf',
    name: 'Test Workflow',
    processes: [
      {
        id: 'main-process',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'failing_node', type: 'script', code: 'throw new Error("fatal fault");' },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'failing_node' },
          { from: 'failing_node', to: 'end' },
        ],
      },
      {
        id: 'compensation-proc',
        name: 'Compensation Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'comp_start', type: 'start' },
          { id: 'comp_script', type: 'script', code: 'vars.cleanedUp = true;' },
          { id: 'comp_end', type: 'end' },
        ],
        flows: [
          { from: 'comp_start', to: 'comp_script' },
          { from: 'comp_script', to: 'comp_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_comp',
    tenantId: app.tenantId,
    workflowId: 'wf_comp',
    versionId: 'ver_comp',
    branchId: 'br_comp',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'compensation-proc',
      strategy: 'compensate-and-abort',
    },
  };

  const inst: Instance = {
    id: 'inst_comp',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-process',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_comp', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  assert.equal(inst.status, 'aborted');
  assert.ok(inst.endedAt);
  assert.ok(inst.error?.message.includes('Compensated and aborted'));
});

test('Hierarchical Error Handling: Global Error Handler failure records descriptive error on original instance', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'test-wf',
    name: 'Test Workflow',
    processes: [
      {
        id: 'main-process',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'fail_primary', type: 'script', code: 'throw new Error("primary task failure");' },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'fail_primary' },
          { from: 'fail_primary', to: 'end' },
        ],
      },
      {
        id: 'aborting-handler',
        name: 'Aborting Handler',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'err_start', type: 'start' },
          { id: 'err_fail', type: 'script', code: 'throw new Error("handler script broke");' },
          { id: 'err_end', type: 'end' },
        ],
        flows: [
          { from: 'err_start', to: 'err_fail' },
          { from: 'err_fail', to: 'err_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_fail_handler',
    tenantId: app.tenantId,
    workflowId: 'wf_fail_handler',
    versionId: 'ver_fail_handler',
    branchId: 'br_fail_handler',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'aborting-handler',
      strategy: 'repair-and-resume',
    },
  };

  const inst: Instance = {
    id: 'inst_fail_handler',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-process',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  assert.equal(inst.status, 'failed');
  assert.ok(inst.error);
  assert.ok(inst.error.message.includes('Global error handler (aborting-handler) failed'));
});

test('Hierarchical Error Handling: Jackson-style JSON parsing of failedContext in Global Error Handler', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'test-wf',
    name: 'Test Workflow',
    processes: [
      {
        id: 'main-process',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'failing_node', type: 'script', code: 'throw new Error("Connection timed out to Core Policy Service");' },
          { id: 'post_step', type: 'script', code: 'vars.done = true;' },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'failing_node' },
          { from: 'failing_node', to: 'post_step' },
          { from: 'post_step', to: 'end' },
        ],
      },
      {
        id: 'api-error-handler',
        name: 'API Error Handler (Policy System Parity)',
        package: 'com.myspace.policy_system',
        vars: [],
        nodes: [
          { id: 'err_start', type: 'start' },
          {
            id: 'parse_context',
            type: 'script',
            code: `
              // Unpack the JSON context sent from the main process (mirrors api-error-handler.bpmn)
              const ctxStr = failedContext;
              const parsed = JSON.parse(ctxStr);
              vars.extractedNodeId = parsed.nodeId;
              vars.extractedErrorCode = parsed.errorCode;
              vars.extractedInstanceId = parsed.failedInstanceId;
              vars.recoveredResult = "policy_service_fallback_acknowledged";
            `,
          },
          { id: 'err_end', type: 'end' },
        ],
        flows: [
          { from: 'err_start', to: 'parse_context' },
          { from: 'parse_context', to: 'err_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_api_err',
    tenantId: app.tenantId,
    workflowId: 'wf_api_err',
    versionId: 'ver_api_err',
    branchId: 'br_api_err',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'api-error-handler',
      strategy: 'repair-and-resume',
      outputMappings: {
        recoveredResult: 'policyStatus',
      },
    },
  };

  const inst: Instance = {
    id: 'inst_api_err',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-process',
    status: 'running',
    variables: { caseId: 'CASE-2026-991' },
    tokens: [{ id: 'tok_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.policyStatus, 'policy_service_fallback_acknowledged');
  assert.equal(inst.variables.done, true);
  assert.equal(inst.variables.caseId, 'CASE-2026-991');
});

test('Environment Variables: Deployment-time env overrides workflow.env while inheriting non-overridden keys', async () => {
  const app = createMockApp();
  const wfService = new WorkflowService(app);
  const verService = new VersionService(app);
  const depService = new DeploymentService(app);

  const wf = await wfService.create({ name: 'Multi Env Project', key: 'multi-env' }, 'tester');
  await wfService.update(
    wf.id,
    {
      env: {
        INTEGRATION_LAYER_URL: 'http://default-base:8080',
        TIMEOUT_SECONDS: '15',
        SHARED_SECRET: 'project-secret-value',
      },
    },
    'tester'
  );

  const draftVer = (await verService.listByBranch(wf.defaultBranchId))[0];
  const p = draftVer.engine.processes[0];
  p.nodes = [
    { id: 'start', type: 'start' },
    { id: 'end', type: 'end' },
  ];
  p.flows = [{ from: 'start', to: 'end' }];
  const savedDraft = await verService.saveDraft(wf.defaultBranchId, draftVer.engine, 'tester');
  const pub = await verService.publish(savedDraft.id, 'tester');

  // Deploy with an override for INTEGRATION_LAYER_URL only
  const dep = await depService.deploy(
    pub.published.id,
    {
      environment: 'prod',
      activate: true,
      env: {
        INTEGRATION_LAYER_URL: 'https://prod-api.prudential.com',
      },
    },
    'tester'
  );

  // Overridden key matches deployment input
  assert.equal(dep.env['INTEGRATION_LAYER_URL'], 'https://prod-api.prudential.com');
  // Non-overridden keys are inherited from workflow.env!
  assert.equal(dep.env['TIMEOUT_SECONDS'], '15');
  assert.equal(dep.env['SHARED_SECRET'], 'project-secret-value');
});

test('Hierarchical Error Handling: throwError=false on task produces soft-failure without raising engine error', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'test-wf',
    name: 'Test Workflow',
    processes: [
      {
        id: 'main-process',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'soft_http_task',
            type: 'http',
            url: 'http://127.0.0.1:59999/non-existent-endpoint',
            throwError: false,
            errorVar: 'myServiceError',
          },
          {
            id: 'gateway_check',
            type: 'script',
            code: `
              if (vars.myServiceError) {
                vars.softHandled = true;
                vars.failedUrl = vars.myServiceError.url;
              }
            `,
          },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'soft_http_task' },
          { from: 'soft_http_task', to: 'gateway_check' },
          { from: 'gateway_check', to: 'end' },
        ],
      },
      {
        id: 'global-never-called',
        name: 'Global Handler Should Not Run',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'err_start', type: 'start' },
          { id: 'err_flag', type: 'script', code: 'vars.globalInvoked = true;' },
          { id: 'err_end', type: 'end' },
        ],
        flows: [
          { from: 'err_start', to: 'err_flag' },
          { from: 'err_flag', to: 'err_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_soft',
    tenantId: app.tenantId,
    workflowId: 'wf_soft',
    versionId: 'ver_soft',
    branchId: 'br_soft',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'global-never-called',
      strategy: 'repair-and-resume',
    },
  };

  const inst: Instance = {
    id: 'inst_soft',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-process',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  // Completed without engine error, softHandled set to true, global handler was NOT invoked
  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.softHandled, true);
  assert.equal(inst.variables.globalInvoked, undefined);
  assert.ok(inst.variables.myServiceError);
});

test('Hierarchical Error Handling: Sequential retry tracking in Global Error Handler up to limit', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'test-wf',
    name: 'Test Workflow',
    processes: [
      {
        id: 'main-process',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'flaky_service',
            type: 'script',
            code: `
              const currentRetries = vars.retryAttempts || 0;
              if (currentRetries < 2) {
                throw new Error("Flaky Service Transient Failure (attempt " + currentRetries + ")");
              }
              vars.serviceResult = "success_on_attempt_3";
            `,
          },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'flaky_service' },
          { from: 'flaky_service', to: 'end' },
        ],
      },
      {
        id: 'retry-manager',
        name: 'Retry Manager Handler',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'err_start', type: 'start' },
          {
            id: 'manage_retry',
            type: 'script',
            code: `
              const retriesSoFar = vars.retryAttempts || 0;
              vars.retryAttempts = retriesSoFar + 1;
              vars.errorHandlerAction = "retry";
            `,
          },
          { id: 'err_end', type: 'end' },
        ],
        flows: [
          { from: 'err_start', to: 'manage_retry' },
          { from: 'manage_retry', to: 'err_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_flaky',
    tenantId: app.tenantId,
    workflowId: 'wf_flaky',
    versionId: 'ver_flaky',
    branchId: 'br_flaky',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'retry-manager',
      strategy: 'repair-and-resume',
      outputMappings: {
        retryAttempts: 'retryAttempts',
      },
    },
  };

  const inst: Instance = {
    id: 'inst_flaky',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-process',
    status: 'running',
    variables: { retryAttempts: 0 },
    tokens: [{ id: 'tok_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.serviceResult, 'success_on_attempt_3');
  assert.equal(inst.variables.retryAttempts, 2);
  assert.equal(inst.variables.errorRepaired, true);
});



