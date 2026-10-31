import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionEngine } from '../src/engine/execution-engine.ts';
import type { AppContext } from '../src/context.ts';
import type { Deployment, Instance } from '../src/domain.ts';
import type { EngineProject } from '../src/sdk/index.ts';

function createMockApp(): AppContext {
  const store = new Map<string, Map<string, any>>();
  const getCollection = (c: string) => {
    if (!store.has(c)) store.set(c, new Map());
    return store.get(c)!;
  };

  let idCounter = 1;
  const fixedNow = new Date('2026-10-30T10:00:00.000Z');

  const app = {
    tenantId: 'pru-tenant',
    actor: 'tester',
    clock: () => fixedNow.toISOString(),
    newId: () => `id_${idCounter++}`,
    audit: async () => {},
    emit: () => {},
    store: {
      repo: <T extends { id: string }>(collName: string) => ({
        get: async (id: string) => getCollection(collName).get(id) || null,
        put: async (item: T) => { getCollection(collName).set(item.id, JSON.parse(JSON.stringify(item))); },
        delete: async (id: string) => { getCollection(collName).delete(id); },
        query: async (predicate?: (item: T) => boolean) => {
          const all = Array.from(getCollection(collName).values());
          return predicate ? all.filter(predicate) : all;
        },
      }),
    },
  } as unknown as AppContext;

  // Pre-seed allowlist so 127.0.0.1 fails instantly with ECONNREFUSED instead of DNS timeout
  getCollection('settings').set('system', { id: 'system', tenantId: 'pru-tenant', outboundAllowlist: ['127.0.0.1'] });
  return app;
}

test('Multi-Type Global Error Handlers: Routes SERVICE_ERROR to api-error-handler and SCRIPT_ERROR to script-error-handler', async () => {
  const app = createMockApp();

  const project: EngineProject = {
    schemaVersion: 1,
    id: 'proj_multi_err',
    name: 'Multi Error Project',
    processes: [
      // 1. Business Process with both REST and Script steps
      {
        id: 'main-flow',
        name: 'Main Business Flow',
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'rest_task',
            type: 'http',
            name: 'Call Core API',
            url: 'http://127.0.0.1:59999/down-endpoint',
            method: 'POST',
            throwError: true,
          },
          {
            id: 'script_task',
            type: 'script',
            name: 'Compute Risk',
            code: 'throw new Error("Script calculation failed");',
          },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { id: 'f1', from: 'start', to: 'rest_task' },
          { id: 'f2', from: 'rest_task', to: 'script_task' },
          { id: 'f3', from: 'script_task', to: 'end' },
        ],
      },
      // 2. Error Handler 1: Dedicated to REST / Service Errors
      {
        id: 'api-error-handler',
        name: 'API Error Recovery Handler',
        nodes: [
          { id: 's_api', type: 'start' },
          {
            id: 'fix_api',
            type: 'script',
            code: `
              kcontext.setVariable("apiRecovered", true);
              kcontext.setVariable("handledBy", "api-error-handler");
            `,
          },
          { id: 'e_api', type: 'end' },
        ],
        flows: [
          { id: 'fa1', from: 's_api', to: 'fix_api' },
          { id: 'fa2', from: 'fix_api', to: 'e_api' },
        ],
      },
      // 3. Error Handler 2: Dedicated to Script / Calculation Errors
      {
        id: 'script-error-handler',
        name: 'Script Error Recovery Handler',
        nodes: [
          { id: 's_scr', type: 'start' },
          {
            id: 'fix_scr',
            type: 'script',
            code: `
              kcontext.setVariable("scriptRecovered", true);
              kcontext.setVariable("handledBy", "script-error-handler");
            `,
          },
          { id: 'e_scr', type: 'end' },
        ],
        flows: [
          { id: 'fs1', from: 's_scr', to: 'fix_scr' },
          { id: 'fs2', from: 'fix_scr', to: 'e_scr' },
        ],
      },
      // 4. Error Handler 3: Default Catch-All Handler for all other unhandled faults
      {
        id: 'default-error-handler',
        name: 'Default Fallback Handler',
        nodes: [
          { id: 's_def', type: 'start' },
          {
            id: 'fix_def',
            type: 'script',
            code: `
              kcontext.setVariable("defaultRecovered", true);
              kcontext.setVariable("handledBy", "default-error-handler");
            `,
          },
          { id: 'e_def', type: 'end' },
        ],
        flows: [
          { id: 'fd1', from: 's_def', to: 'fix_def' },
          { id: 'fd2', from: 'fix_def', to: 'e_def' },
        ],
      },
    ],
  };

  const dep: Deployment = {
    id: 'dep_multi_err',
    tenantId: app.tenantId,
    workflowId: 'wf_multi_err',
    versionId: 'ver_1',
    branchId: 'br_main',
    engine: project,
    env: {},
    tags: ['test'],
    status: 'active',
    environment: 'test',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      rules: [
        {
          id: 'rule_service',
          errorType: 'SERVICE_ERROR',
          processId: 'api-error-handler',
          strategy: 'repair-and-resume',
          outputMappings: {
            apiHandled: 'apiRecovered',
            routedTo: 'handledBy',
          },
        },
        {
          id: 'rule_script',
          errorType: 'SCRIPT_ERROR',
          processId: 'script-error-handler',
          strategy: 'repair-and-resume',
          outputMappings: {
            scriptHandled: 'scriptRecovered',
            routedTo: 'handledBy',
          },
        },
        {
          id: 'rule_default',
          errorType: '*',
          processId: 'default-error-handler',
          strategy: 'repair-and-resume',
          outputMappings: {
            defaultHandled: 'defaultRecovered',
            routedTo: 'handledBy',
          },
        },
      ],
    },
  };

  await app.store.repo<Deployment>('deployments').put(dep);
  const resolveCalled = async (pid: string) => ({ dep, processId: pid });
  const engine = new ExecutionEngine(app, () => {}, resolveCalled);

  // --- TEST A: SERVICE_ERROR routes specifically to api-error-handler ---
  const instA: Instance = {
    id: 'inst_service_test',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-flow',
    status: 'running',
    variables: { caseId: 'CASE-001' },
    tokens: [{ id: 'tok_start_a', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };
  await app.store.repo<Instance>('instances').put(instA);

  await engine.runToQuiescence(instA, dep);

  // rest_task failed with SERVICE_ERROR, which should route to api-error-handler!
  assert.equal(instA.variables['apiHandled'], true);
  assert.equal(instA.variables['routedTo'], 'api-error-handler');

  // --- TEST B: SCRIPT_ERROR routes specifically to script-error-handler ---
  const instB: Instance = {
    id: 'inst_script_test',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-flow',
    status: 'running',
    variables: { caseId: 'CASE-002' },
    // Start directly on script_task
    tokens: [{ id: 'tok_script_b', nodeId: 'script_task', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };
  await app.store.repo<Instance>('instances').put(instB);

  await engine.runToQuiescence(instB, dep);

  // script_task failed with SCRIPT_ERROR, which should route to script-error-handler!
  assert.equal(instB.variables['scriptHandled'], true);
  assert.equal(instB.variables['routedTo'], 'script-error-handler');
  assert.equal(instB.status, 'completed');
});

test('Multi-Type Global Error Handlers: Custom unhandled error falls back to Catch-All (*) handler', async () => {
  const app = createMockApp();

  const project: EngineProject = {
    schemaVersion: 1,
    id: 'proj_fallback',
    name: 'Fallback Project',
    processes: [
      {
        id: 'rule-failing-flow',
        name: 'Rule Flow',
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'rule_node', type: 'rule', name: 'Execute Rule', dmn: 'NonExistentTable' },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { id: 'f1', from: 'start', to: 'rule_node' },
          { id: 'f2', from: 'rule_node', to: 'end' },
        ],
      },
      {
        id: 'api-error-handler',
        name: 'API Error Handler',
        nodes: [
          { id: 's_api', type: 'start' },
          { id: 'e_api', type: 'end' },
        ],
        flows: [{ id: 'fa1', from: 's_api', to: 'e_api' }],
      },
      {
        id: 'catch-all-handler',
        name: 'Catch All Handler',
        nodes: [
          { id: 's_catch', type: 'start' },
          {
            id: 'scr_catch',
            type: 'script',
            code: `
              kcontext.setVariable("caughtByCatchAll", true);
              kcontext.setVariable("failedCode", kcontext.getVariable("errorCode"));
            `,
          },
          { id: 'e_catch', type: 'end' },
        ],
        flows: [
          { id: 'fc1', from: 's_catch', to: 'scr_catch' },
          { id: 'fc2', from: 'scr_catch', to: 'e_catch' },
        ],
      },
    ],
  };

  const dep: Deployment = {
    id: 'dep_fallback',
    tenantId: app.tenantId,
    workflowId: 'wf_fallback',
    versionId: 'ver_1',
    branchId: 'br_main',
    engine: project,
    env: {},
    tags: ['test'],
    status: 'active',
    environment: 'test',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      rules: [
        {
          id: 'rule_1',
          errorType: 'SERVICE_ERROR',
          processId: 'api-error-handler',
          strategy: 'repair-and-resume',
        },
        {
          id: 'rule_catch_all',
          errorType: '*',
          processId: 'catch-all-handler',
          strategy: 'repair-and-resume',
          outputMappings: {
            recoveredGlobally: 'caughtByCatchAll',
            interceptedError: 'failedCode',
          },
        },
      ],
    },
  };

  await app.store.repo<Deployment>('deployments').put(dep);
  const resolveCalled = async (pid: string) => ({ dep, processId: pid });
  const engine = new ExecutionEngine(app, () => {}, resolveCalled);

  const inst: Instance = {
    id: 'inst_rule_test',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'rule-failing-flow',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };
  await app.store.repo<Instance>('instances').put(inst);

  await engine.runToQuiescence(inst, dep);

  // RULE_ERROR had no specific rule, so it routed to the '*' catch-all handler!
  assert.equal(inst.variables['recoveredGlobally'], true);
  assert.equal(inst.variables['interceptedError'], 'RULE_ERROR');
  assert.equal(inst.status, 'completed');
});

test('Multi-Type Global Error Handlers: Local Boundary takes precedence over Multi-Type rules', async () => {
  const app = createMockApp();

  const project: EngineProject = {
    schemaVersion: 1,
    id: 'proj_local_prec',
    name: 'Local Precedence Project',
    processes: [
      {
        id: 'main-with-boundary',
        name: 'Main Process with Boundary',
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'risky_rest',
            type: 'http',
            name: 'Risky REST Task',
            url: 'http://127.0.0.1:59999/down-endpoint',
            method: 'POST',
            throwError: true,
          },
          {
            id: 'b_err',
            type: 'boundary',
            on: ['risky_rest'],
            event: { error: 'SERVICE_ERROR' },
          },
          {
            id: 'local_fix',
            type: 'script',
            code: 'kcontext.setVariable("handledLocally", true);',
          },
          { id: 'end_ok', type: 'end' },
          { id: 'end_local_recovery', type: 'end' },
        ],
        flows: [
          { id: 'f1', from: 'start', to: 'risky_rest' },
          { id: 'f2', from: 'risky_rest', to: 'end_ok' },
          { id: 'fb', from: 'b_err', to: 'local_fix' },
          { id: 'fl', from: 'local_fix', to: 'end_local_recovery' },
        ],
      },
      {
        id: 'global-api-handler',
        name: 'Global API Handler',
        nodes: [
          { id: 's_g', type: 'start' },
          { id: 'scr_g', type: 'script', code: 'kcontext.setVariable("handledGlobally", true);' },
          { id: 'e_g', type: 'end' },
        ],
        flows: [
          { id: 'fg1', from: 's_g', to: 'scr_g' },
          { id: 'fg2', from: 'scr_g', to: 'e_g' },
        ],
      },
    ],
  };

  const dep: Deployment = {
    id: 'dep_local_prec',
    tenantId: app.tenantId,
    workflowId: 'wf_local_prec',
    versionId: 'ver_1',
    branchId: 'br_main',
    engine: project,
    env: {},
    tags: ['test'],
    status: 'active',
    environment: 'test',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      rules: [
        {
          id: 'rule_service',
          errorType: 'SERVICE_ERROR',
          processId: 'global-api-handler',
          strategy: 'repair-and-resume',
          outputMappings: {
            handledGlobally: 'handledGlobally',
          },
        },
      ],
    },
  };

  await app.store.repo<Deployment>('deployments').put(dep);
  const resolveCalled = async (pid: string) => ({ dep, processId: pid });
  const engine = new ExecutionEngine(app, () => {}, resolveCalled);

  const inst: Instance = {
    id: 'inst_boundary_test',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-with-boundary',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };
  await app.store.repo<Instance>('instances').put(inst);

  await engine.runToQuiescence(inst, dep);

  // Local boundary caught it, global error handler was NOT invoked!
  assert.equal(inst.variables['handledLocally'], true);
  assert.equal(inst.variables['handledGlobally'], undefined);
  assert.equal(inst.status, 'completed');
});

test('Multi-Type Global Error Handlers: Comma-separated error types and asynchronous retry resolution', async () => {
  const app = createMockApp();

  let attempt = 0;
  const project: EngineProject = {
    schemaVersion: 1,
    id: 'proj_async_retry',
    name: 'Async Retry Project',
    processes: [
      {
        id: 'flaky-service-process',
        name: 'Flaky Service Flow',
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'flaky_script',
            type: 'script',
            code: `
              const current = Number(kcontext.getVariable("retries") || 0);
              if (current < 1) {
                throw new Error("Temporary service outage 503");
              }
              kcontext.setVariable("flakySuccess", true);
            `,
          },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { id: 'f1', from: 'start', to: 'flaky_script' },
          { id: 'f2', from: 'flaky_script', to: 'end' },
        ],
      },
      {
        id: 'backoff-retry-handler',
        name: 'Backoff Retry Handler',
        nodes: [
          { id: 's_retry', type: 'start' },
          {
            id: 'scr_retry',
            type: 'script',
            code: `
              const current = Number(kcontext.getVariable("retries") || 0);
              kcontext.setVariable("retries", current + 1);
              kcontext.setVariable("errorHandlerAction", "retry");
            `,
          },
          { id: 'e_retry', type: 'end' },
        ],
        flows: [
          { id: 'fr1', from: 's_retry', to: 'scr_retry' },
          { id: 'fr2', from: 'scr_retry', to: 'e_retry' },
        ],
      },
    ],
  };

  const dep: Deployment = {
    id: 'dep_async_retry',
    tenantId: app.tenantId,
    workflowId: 'wf_async_retry',
    versionId: 'ver_1',
    branchId: 'br_main',
    engine: project,
    env: {},
    tags: ['test'],
    status: 'active',
    environment: 'test',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      rules: [
        {
          id: 'rule_multi_code',
          errorType: 'SCRIPT_ERROR, 503, SERVICE_ERROR', // comma-separated codes!
          processId: 'backoff-retry-handler',
          strategy: 'repair-and-resume',
          outputMappings: {
            retries: 'retries',
          },
        },
      ],
    },
  };

  await app.store.repo<Deployment>('deployments').put(dep);
  const resolveCalled = async (pid: string) => ({ dep, processId: pid });
  const engine = new ExecutionEngine(app, () => {}, resolveCalled);

  const inst: Instance = {
    id: 'inst_retry_test',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'flaky-service-process',
    status: 'running',
    variables: { retries: 0 },
    tokens: [{ id: 'tok_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };
  await app.store.repo<Instance>('instances').put(inst);

  await engine.runToQuiescence(inst, dep);

  // Attempt 0 failed -> backoff-retry-handler matched via comma-separated list 'SCRIPT_ERROR, 503, SERVICE_ERROR'
  // -> requested retry with retries = 1 -> node flaky_script executed second time with retries = 1 -> succeeded!
  assert.equal(inst.variables['retries'], 1);
  assert.equal(inst.variables['flakySuccess'], true);
  assert.equal(inst.status, 'completed');
});


