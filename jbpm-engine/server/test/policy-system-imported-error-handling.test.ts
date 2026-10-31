import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionEngine } from '../src/engine/execution-engine.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import type { AppContext } from '../src/context.ts';
import type { Deployment, Instance } from '../src/domain.ts';
import type { EngineProject } from '../src/sdk/index.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../../..');

function createMockApp(): AppContext {
  const store = new Map<string, Map<string, any>>();
  const getCollection = (c: string) => {
    if (!store.has(c)) store.set(c, new Map());
    return store.get(c)!;
  };

  let idCounter = 1;
  const fixedNow = new Date('2026-10-30T09:00:00.000Z');

  return {
    tenantId: 'prudential-tenant',
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
}

test('Policy System Parity: Local Error Handler takes precedence over Project Global Error Handler on rest-executor', async () => {
  const app = createMockApp();

  // Load the actual policy_system project imported from jBPM
  const projectPath = path.resolve(rootDir, 'policy_system_node_project.json');
  const projectData: EngineProject = JSON.parse(fs.readFileSync(projectPath, 'utf8'));

  // Configure Deployment with Project Global Error Handler enabled
  const dep: Deployment = {
    id: 'dep_policy_system',
    tenantId: app.tenantId,
    workflowId: 'wf_policy_system',
    versionId: 'ver_policy_system',
    branchId: 'br_policy_system',
    engine: projectData,
    env: {
      INTEGRATION_LAYER_URL: 'http://localhost:3010',
    },
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'policy_system.api-error-handler',
      strategy: 'repair-and-resume',
      outputMappings: {
        globalAudit: 'globalAuditRecorded',
      },
    },
  };

  await app.store.repo<Deployment>('deployments').put(dep);

  const resolveCalled = async (pid: string) => ({ dep, processId: pid });
  const engine = new ExecutionEngine(app, () => {}, resolveCalled);

  // In rest-executor:
  // _REST_TASK attempts to call a non-existent URL -> fails with SERVICE_ERROR
  // In real jBPM: global error handler would hijack and local boundary _B_ERROR would never fire!
  // In our engine: local boundary _B_ERROR takes precedence!
  const inst: Instance = {
    id: 'inst_rest_exec_local',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'policy_system.rest-executor',
    status: 'running',
    variables: {
      caseId: 'CASE-POL-2026-001',
      Url: 'http://localhost:59998/non-existent-policy-endpoint',
      Method: 'POST',
      ContentData: JSON.stringify({ policyNumber: 'POL-9922' }),
      Headers: JSON.stringify({ 'x-correlation-id': 'corr-101' }),
      HandleResponseErrors: 'false', // causes Rest task to throw error on network failure
      maxRetryCount: 1,
      adminDecision: 'SKIP',
    },
    tokens: [{ id: 'tok_start', nodeId: '_START', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await app.store.repo<Instance>('instances').put(inst);

  await engine.runToQuiescence(inst, dep);

  // 1. Verify local boundary event _B_ERROR was entered
  const enteredBoundary = inst.history.find((h) => h.nodeId === '_B_ERROR');
  assert.ok(enteredBoundary, 'Local boundary event _B_ERROR should have caught the REST failure');

  // 2. Verify _BUILD_CTX was executed, packing failedContext
  const enteredBuildCtx = inst.history.find((h) => h.nodeId === '_BUILD_CTX');
  assert.ok(enteredBuildCtx, 'Local script _BUILD_CTX should have executed');
  assert.ok(inst.variables.failedContext, 'failedContext should have been packed');

  // 3. Verify _CALL_ERR was executed (calling policy_system.api-error-handler locally)
  const enteredCallErr = inst.history.find((h) => h.nodeId === '_CALL_ERR');
  assert.ok(enteredCallErr, 'Call Activity _CALL_ERR should have run the error handler process locally');

  // 4. Verify Project Global Error Handler was NOT called directly to bypass the local boundary
  assert.equal(inst.variables.globalAuditRecorded, undefined, 'Project Global Error Handler should not have bypassed the local boundary');

  // 5. The error handler process is waiting on its 1-minute backoff timer (_TIMER_NODE)
  const children = await app.store.repo<Instance>('instances').query((i) => i.parentInstanceId === inst.id);
  assert.equal(children.length, 1);
  const child = children[0];
  assert.equal(child.processId, 'policy_system.api-error-handler');
  assert.equal(child.status, 'waiting');

  // 6. Fire the backoff timer job to advance the retry flow
  const timers = await app.store.repo<any>('timers').query((t) => t.instanceId === child.id);
  assert.equal(timers.length, 1);
  const timerJob = timers[0];
  await engine.fireTimerJob(child, dep, timerJob.nodeId, timerJob.tokenId);

  // 7. Retries exhausted -> child is now waiting on IT Admin Review userTask (_ADMIN_REVIEW)
  const taskService = new TaskService(app);
  const tasks = await taskService.list({});
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].nodeId, '_ADMIN_REVIEW');

  // 8. IT Admin completes the task choosing 'SKIP'
  await taskService.complete(tasks[0].id, { adminDecision: 'SKIP' }, 'admin');

  // 9. Child error handler completes and resumes parent rest-executor to _END_ERROR
  const updatedInst = await app.store.repo<Instance>('instances').get(inst.id);
  assert.equal(updatedInst?.status, 'completed');
  assert.equal(updatedInst?.variables.adminDecision, 'SKIP');
});

test('Policy System Parity: Unhandled node failure in policy_system bubbles up to Project Global Error Handler', async () => {
  const app = createMockApp();

  const projectPath = path.resolve(rootDir, 'policy_system_node_project.json');
  const projectData: EngineProject = JSON.parse(fs.readFileSync(projectPath, 'utf8'));

  // Create a process inside the policy_system project with NO local boundary handler
  const unhandledProc = {
    id: 'policy_system.unhandled_service_call',
    name: 'Unhandled Service Call Process',
    package: 'com.myspace.policy_system',
    vars: [],
    nodes: [
      { id: 'start', type: 'start' },
      {
        id: 'unhandled_script',
        type: 'script',
        code: `
          // Script task with no local boundary event that throws a fatal error
          throw new Error("Core Policy DB Connection Refused");
        `,
      },
      { id: 'post_step', type: 'script', code: 'vars.stepCompleted = true;' },
      { id: 'end', type: 'end' },
    ],
    flows: [
      { from: 'start', to: 'unhandled_script' },
      { from: 'unhandled_script', to: 'post_step' },
      { from: 'post_step', to: 'end' },
    ],
  };

  projectData.processes.push(unhandledProc as any);

  // Configure Project Global Error Handler
  const dep: Deployment = {
    id: 'dep_unhandled_policy',
    tenantId: app.tenantId,
    workflowId: 'wf_policy_system',
    versionId: 'ver_policy_system',
    branchId: 'br_policy_system',
    engine: projectData,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
    globalErrorHandler: {
      enabled: true,
      processId: 'policy_system.api-error-handler',
      strategy: 'repair-and-resume',
      outputMappings: {
        handledByGlobal: 'recoveredByGlobalHandler',
      },
    },
  };

  await app.store.repo<Deployment>('deployments').put(dep);

  const resolveCalled = async (pid: string) => ({ dep, processId: pid });
  const engine = new ExecutionEngine(app, () => {}, resolveCalled);

  const inst: Instance = {
    id: 'inst_unhandled',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'policy_system.unhandled_service_call',
    status: 'running',
    variables: {
      caseId: 'CASE-POL-GLOBAL-99',
      maxRetryCount: 1,
      adminDecision: 'SKIP',
    },
    tokens: [{ id: 'tok_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await app.store.repo<Instance>('instances').put(inst);

  await engine.runToQuiescence(inst, dep);

  // 1. The unhandled error was caught by the Project Global Error Handler, which is waiting on its backoff timer
  assert.equal(inst.status, 'waiting');

  const children = await app.store.repo<Instance>('instances').query((i) => i.parentInstanceId === inst.id);
  assert.equal(children.length, 1);
  const child = children[0];
  assert.equal(child.processId, 'policy_system.api-error-handler');

  // 2. Fire the timer to advance the global error handler
  const timers = await app.store.repo<any>('timers').query((t) => t.instanceId === child.id);
  assert.equal(timers.length, 1);
  await engine.fireTimerJob(child, dep, timers[0].nodeId, timers[0].tokenId);

  // 3. Complete the IT admin review task with recovery variables
  const taskService = new TaskService(app);
  const tasks = await taskService.list({});
  assert.equal(tasks.length, 1);
  await taskService.complete(tasks[0].id, {
    adminDecision: 'SKIP',
    recoveredByGlobalHandler: 'repaired_successfully',
  }, 'admin');

  // 4. Global error handler completed and resumed the main process
  const updatedInst = await app.store.repo<Instance>('instances').get(inst.id);
  assert.equal(updatedInst?.status, 'completed');
  assert.equal(updatedInst?.variables.errorRepaired, true);
  assert.equal(updatedInst?.variables.handledByGlobal, 'repaired_successfully');
  assert.equal(updatedInst?.variables.stepCompleted, true);
});

test('Policy System Parity: rest-executor escalation via TERMINATE_CASE error end event', async () => {
  const app = createMockApp();

  const projectPath = path.resolve(rootDir, 'policy_system_node_project.json');
  const projectData: EngineProject = JSON.parse(fs.readFileSync(projectPath, 'utf8'));

  const dep: Deployment = {
    id: 'dep_terminate_test',
    tenantId: app.tenantId,
    workflowId: 'wf_policy_system',
    versionId: 'ver_policy_system',
    branchId: 'br_policy_system',
    engine: projectData,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };

  await app.store.repo<Deployment>('deployments').put(dep);

  const resolveCalled = async (pid: string) => ({ dep, processId: pid });
  const engine = new ExecutionEngine(app, () => {}, resolveCalled);

  // In rest-executor:
  // When adminDecision is 'TERMINATE', the gateway takes _F_REST_TO_THROW_ERR to _END_ERROR_TERMINATE
  // which throws error: 'TERMINATE_CASE'
  const inst: Instance = {
    id: 'inst_terminate_case',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'policy_system.rest-executor',
    status: 'running',
    variables: {
      caseId: 'CASE-POL-TERM-001',
      Url: 'http://localhost:59998/fatal-endpoint',
      Method: 'POST',
      ContentData: JSON.stringify({ error: true }),
      Headers: '',
      HandleResponseErrors: 'false',
      maxRetryCount: 1,
      adminDecision: 'SKIP',
    },
    tokens: [{ id: 'tok_start', nodeId: '_START', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await app.store.repo<Instance>('instances').put(inst);

  await engine.runToQuiescence(inst, dep);

  // 1. Advance the error handler through the backoff timer
  const children = await app.store.repo<Instance>('instances').query((i) => i.parentInstanceId === inst.id);
  const child = children[0];
  const timers = await app.store.repo<any>('timers').query((t) => t.instanceId === child.id);
  await engine.fireTimerJob(child, dep, timers[0].nodeId, timers[0].tokenId);

  // 2. Complete the IT Admin review with TERMINATE decision
  const taskService = new TaskService(app);
  const tasks = await taskService.list({});
  await taskService.complete(tasks[0].id, { adminDecision: 'TERMINATE' }, 'admin');

  // 3. Verify rest-executor took _F_REST_TO_THROW_ERR to _END_ERROR_TERMINATE
  const updatedInst = await app.store.repo<Instance>('instances').get(inst.id);
  assert.equal(updatedInst?.status, 'failed');
  assert.ok(updatedInst?.error?.message.includes('TERMINATE_CASE'));

  const enteredTerminate = updatedInst?.history.find((h) => h.nodeId === '_END_ERROR_TERMINATE');
  assert.ok(enteredTerminate, '_END_ERROR_TERMINATE should have been entered when adminDecision is TERMINATE');
});
