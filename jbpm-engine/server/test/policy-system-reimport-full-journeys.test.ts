import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kjarToEngine, convertAssets } from '../src/modules/import/service.ts';
import { ValidationService } from '../src/modules/validation/service.ts';
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
  const fixedNow = new Date('2026-10-30T10:00:00.000Z');

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

function loadPolicySystemKjarFiles(): Record<string, string> {
  const basePath = path.resolve(rootDir, 'extracted_projects/policy_system');
  const files: Record<string, string> = {};
  function walk(dir: string, base: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, base);
      } else {
        const rel = path.relative(base, full);
        files[rel] = fs.readFileSync(full, 'utf8');
      }
    }
  }
  walk(basePath, basePath);
  return files;
}

test('Journey 1: Re-import Policy System kjar, convert assets, and validate all 23 processes', async () => {
  const files = loadPolicySystemKjarFiles();
  assert.ok(Object.keys(files).length >= 50, 'Should load all kjar files from extracted_projects/policy_system');

  // Reconstruct EngineProject from kjar
  const engine = kjarToEngine(files);
  assert.ok(engine.processes && engine.processes.length === 23, `Expected 23 processes, found ${engine.processes?.length}`);

  // Convert assets
  const assetReport = convertAssets(engine);
  assert.ok(assetReport, 'Asset report should be returned');

  // Run full project validation
  const valService = new ValidationService();
  const res = await valService.validateProject(engine);
  assert.equal(res.ok, true, 'Imported policy system project must pass validation with 0 errors');
  assert.equal(res.errors.length, 0, 'Must have zero validation errors');

  // Verify key orchestrator and error handling processes exist
  const processIds = engine.processes.map((p) => p.id);
  assert.ok(processIds.includes('policy_management_process'), 'Must include policy_management_process');
  assert.ok(processIds.includes('policy_system.rest-executor'), 'Must include rest-executor');
  assert.ok(processIds.includes('policy_system.api-error-handler'), 'Must include api-error-handler');
  assert.ok(processIds.includes('policy_system.certificate_resend'), 'Must include certificate_resend');
  assert.ok(processIds.includes('policy_system.policy_issue'), 'Must include policy_issue');
  assert.ok(processIds.includes('group-takeover-process'), 'Must include group-takeover-process');
  assert.ok(processIds.includes('policy-termination'), 'Must include policy-termination');
});

test('Journey 2: Policy Management Orchestrator routes scenarios to child subprocesses via Call Activity', async () => {
  const app = createMockApp();
  const files = loadPolicySystemKjarFiles();
  const engineProject = kjarToEngine(files);

  const dep: Deployment = {
    id: 'dep_policy_sys_reimport',
    tenantId: app.tenantId,
    workflowId: 'wf_policy_sys',
    versionId: 'ver_policy_sys',
    branchId: 'br_policy_sys',
    engine: engineProject,
    env: { INTEGRATION_LAYER_URL: 'http://localhost:3010' },
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };
  await app.store.repo<Deployment>('deployments').put(dep);

  const resolveCalled = async (pid: string) => ({ dep, processId: pid });
  const engine = new ExecutionEngine(app, () => {}, resolveCalled);

  const testScenarios = [
    { type: 'CERTIFICATE_RESEND', targetProcess: 'policy_system.certificate_resend' },
    { type: 'FILE_FEED', targetProcess: 'policy_system.file_feed' },
    { type: 'TAKEOVER', targetProcess: 'group-takeover-process' },
    { type: 'CLAIMS', targetProcess: 'policy_system.claims' },
    { type: 'POLICY_TERMINATION', targetProcess: 'policy-termination' },
    { type: 'ESCALATION', targetProcess: 'policy_system.Escalation' },
    { type: 'ENROLLMENT', targetProcess: 'policy_system.enrollment' },
  ];

  const pmpProc = engineProject.processes.find((p) => p.id === 'policy_management_process')!;
  const startNodeId = pmpProc.nodes.find((n) => n.type === 'start')!.id;

  for (const sc of testScenarios) {
    const instId = `inst_pmp_${sc.type}`;
    const inst: Instance = {
      id: instId,
      tenantId: app.tenantId,
      deploymentId: dep.id,
      workflowId: dep.workflowId,
      processId: 'policy_management_process',
      status: 'running',
      variables: {
        process_value_type: sc.type,
        caseId: `CASE-${sc.type}-101`,
        cid: 1001,
        party_id: 'PRT-99',
        group_id: 'GRP-10',
        broker_id: 'BRK-55',
        policy_number: `POL-${sc.type}-999`,
        policy_issuance_type: 'STANDARD',
        party_agreement_ids: JSON.stringify(['AGR-1']),
        reasonMode: 'NO_CHANGE',
        journeyType: 'RESEND',
        changeReason: 'NONE',
        commPurposeId: 'POLICY_ISSUED',
        current_user: 'admin',
        enrollment_reference_number: 'ENR-01',
        enrollment_review_group: 'REVIEWERS',
        enrollment_review_user: 'admin',
        billing_frequency: 'MONTHLY',
        valid_enrollment_change: true,
        baseUrl: 'http://localhost:3010',
        communicationSendUrl: 'http://localhost:3010/mock/api',
        communicationRetryUrl: 'http://localhost:3010/mock/api',
        saveUrl: 'http://localhost:3010/mock/api',
        sendSignalUrl: 'http://localhost:3010/mock/api',
        emailUrl: 'http://localhost:3010/mock/api',
        takoverUpdateUrl: 'http://localhost:3010/mock/api',
        updateTerminationUrl: 'http://localhost:3010/mock/api',
        failedEndpoint: 'http://localhost:3010/mock/api',
        isError: false,
        adminDecision: 'SKIP',
        generateDocumentDecision: 'Approve',
        maxRetryCount: 2,
      },
      tokens: [{ id: `tok_${instId}`, nodeId: startNodeId, state: 'active', enteredAt: app.clock() }],
      history: [],
      startedAt: app.clock(),
      startedBy: 'tester',
    };

    await app.store.repo<Instance>('instances').put(inst);
    await engine.runToQuiescence(inst, dep);

    // Verify child subprocess was spawned by Call Activity
    const children = await app.store.repo<Instance>('instances').query((i) => i.parentInstanceId === instId);
    const storedParent = await app.store.repo<Instance>('instances').get(instId);
    assert.ok(storedParent, `Parent instance for ${sc.type} should exist`);
    assert.ok(storedParent?.status === 'waiting' || storedParent?.status === 'completed', `Parent status was "${storedParent?.status}" for ${sc.type}`);

    assert.equal(children.length, 1, `Call Activity should spawn exactly 1 child for ${sc.type}`);
    assert.equal(children[0].processId, sc.targetProcess, `Spawned child should match target ${sc.targetProcess}`);
  }
});

test('Journey 3: Local Error Handler takes precedence on rest-executor, invokes backoff timer and admin review', async () => {
  const app = createMockApp();
  const files = loadPolicySystemKjarFiles();
  const engineProject = kjarToEngine(files);

  const dep: Deployment = {
    id: 'dep_local_err_test',
    tenantId: app.tenantId,
    workflowId: 'wf_policy_sys',
    versionId: 'ver_policy_sys',
    branchId: 'br_policy_sys',
    engine: engineProject,
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
      outputMappings: { globalAudit: 'globalAuditRecorded' },
    },
  };
  await app.store.repo<Deployment>('deployments').put(dep);

  const resolveCalled = async (pid: string) => ({ dep, processId: pid });
  const engine = new ExecutionEngine(app, () => {}, resolveCalled);

  // In rest-executor:
  // _REST_TASK attempts call to non-existent endpoint with HandleResponseErrors: false -> fails
  // Boundary event _B_ERROR catches it -> runs _BUILD_CTX -> calls api-error-handler locally
  const inst: Instance = {
    id: 'inst_rest_local_err',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'policy_system.rest-executor',
    status: 'running',
    variables: {
      caseId: 'CASE-POL-ERR-001',
      Url: 'http://localhost:59998/non-existent-endpoint',
      Method: 'POST',
      ContentData: JSON.stringify({ policyNumber: 'POL-TEST-1' }),
      Headers: '',
      HandleResponseErrors: 'false',
      maxRetryCount: 1,
      adminDecision: 'SKIP',
    },
    tokens: [{ id: 'tok_start_local', nodeId: '_START', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await app.store.repo<Instance>('instances').put(inst);
  await engine.runToQuiescence(inst, dep);

  // 1. Check local boundary event entered
  const enteredBoundary = inst.history.find((h) => h.nodeId === '_B_ERROR');
  assert.ok(enteredBoundary, 'Local boundary event _B_ERROR must catch REST failure');

  // 2. Local call activity ran api-error-handler child
  const children = await app.store.repo<Instance>('instances').query((i) => i.parentInstanceId === inst.id);
  assert.equal(children.length, 1);
  const child = children[0];
  assert.equal(child.processId, 'policy_system.api-error-handler');
  assert.equal(child.status, 'waiting', 'Error handler must be waiting on backoff timer');

  // 3. Durable timer job is scheduled
  const timers = await app.store.repo<any>('timers').query((t) => t.instanceId === child.id);
  assert.equal(timers.length, 1, 'Backoff timer job must be registered in timer repository');
  const timerJob = timers[0];

  // 4. Fire the backoff timer
  await engine.fireTimerJob(child, dep, timerJob.nodeId, timerJob.tokenId);

  // 5. UserTask _ADMIN_REVIEW is created
  const taskService = new TaskService(app);
  const tasks = await taskService.list({});
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].nodeId, '_ADMIN_REVIEW');

  // 6. Complete task with SKIP decision
  await taskService.complete(tasks[0].id, { adminDecision: 'SKIP' }, 'admin');

  // 7. Verify parent rest-executor resumes and completes
  const updatedParent = await app.store.repo<Instance>('instances').get(inst.id);
  assert.equal(updatedParent?.status, 'completed');
  assert.equal(updatedParent?.variables.adminDecision, 'SKIP');
});

test('Journey 4: Unhandled failure in policy system bubbles to Project Global Error Handler and recovers', async () => {
  const app = createMockApp();
  const files = loadPolicySystemKjarFiles();
  const engineProject = kjarToEngine(files);

  // Add an unhandled process to project
  const unhandledProc = {
    id: 'policy_system.unhandled_policy_step',
    name: 'Unhandled Policy Step',
    package: 'com.myspace.policy_system',
    vars: [],
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'failing_step', type: 'script', code: 'throw new Error("Simulated Database Timeout");' },
      { id: 'post_step', type: 'script', code: 'vars.recovered = true;' },
      { id: 'end', type: 'end' },
    ],
    flows: [
      { from: 'start', to: 'failing_step' },
      { from: 'failing_step', to: 'post_step' },
      { from: 'post_step', to: 'end' },
    ],
  };
  engineProject.processes.push(unhandledProc as any);

  const dep: Deployment = {
    id: 'dep_global_err_test',
    tenantId: app.tenantId,
    workflowId: 'wf_policy_sys',
    versionId: 'ver_policy_sys',
    branchId: 'br_policy_sys',
    engine: engineProject,
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
      outputMappings: { globalRepairedStatus: 'globalAuditFlag' },
    },
  };
  await app.store.repo<Deployment>('deployments').put(dep);

  const resolveCalled = async (pid: string) => ({ dep, processId: pid });
  const engine = new ExecutionEngine(app, () => {}, resolveCalled);

  const inst: Instance = {
    id: 'inst_unhandled_journey',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'policy_system.unhandled_policy_step',
    status: 'running',
    variables: { caseId: 'CASE-POL-UNHANDLED-9', maxRetryCount: 1 },
    tokens: [{ id: 'tok_unhandled', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await app.store.repo<Instance>('instances').put(inst);
  await engine.runToQuiescence(inst, dep);

  // Unhandled error caught by global error handler
  assert.equal(inst.status, 'waiting');
  const children = await app.store.repo<Instance>('instances').query((i) => i.parentInstanceId === inst.id);
  assert.equal(children.length, 1);
  const child = children[0];
  assert.equal(child.processId, 'policy_system.api-error-handler');

  // Fire backoff timer in global error handler
  const timers = await app.store.repo<any>('timers').query((t) => t.instanceId === child.id);
  assert.equal(timers.length, 1);
  await engine.fireTimerJob(child, dep, timers[0].nodeId, timers[0].tokenId);

  // Admin completes review task with recovery flag
  const taskService = new TaskService(app);
  const tasks = await taskService.list({});
  assert.equal(tasks.length, 1);
  await taskService.complete(tasks[0].id, {
    adminDecision: 'SKIP',
    globalAuditFlag: 'audit_ok_resumed',
  }, 'admin');

  // Verify process resumed and reached completion
  const updatedInst = await app.store.repo<Instance>('instances').get(inst.id);
  assert.equal(updatedInst?.status, 'completed');
  assert.equal(updatedInst?.variables.errorRepaired, true);
  assert.equal(updatedInst?.variables.globalRepairedStatus, 'audit_ok_resumed');
  assert.equal(updatedInst?.variables.recovered, true);
});

test('Journey 5: Error Escalation via TERMINATE decision throws TERMINATE_CASE and stops instance', async () => {
  const app = createMockApp();
  const files = loadPolicySystemKjarFiles();
  const engineProject = kjarToEngine(files);

  const dep: Deployment = {
    id: 'dep_term_journey',
    tenantId: app.tenantId,
    workflowId: 'wf_policy_sys',
    versionId: 'ver_policy_sys',
    branchId: 'br_policy_sys',
    engine: engineProject,
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

  const inst: Instance = {
    id: 'inst_term_case_journey',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'policy_system.rest-executor',
    status: 'running',
    variables: {
      caseId: 'CASE-TERM-77',
      Url: 'http://localhost:59998/fatal-outage',
      Method: 'POST',
      ContentData: JSON.stringify({ fatal: true }),
      Headers: '',
      HandleResponseErrors: 'false',
      maxRetryCount: 1,
    },
    tokens: [{ id: 'tok_term_start', nodeId: '_START', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await app.store.repo<Instance>('instances').put(inst);
  await engine.runToQuiescence(inst, dep);

  // Advance child error handler past timer
  const children = await app.store.repo<Instance>('instances').query((i) => i.parentInstanceId === inst.id);
  const child = children[0];
  const timers = await app.store.repo<any>('timers').query((t) => t.instanceId === child.id);
  await engine.fireTimerJob(child, dep, timers[0].nodeId, timers[0].tokenId);

  // Admin completes task choosing 'TERMINATE'
  const taskService = new TaskService(app);
  const tasks = await taskService.list({});
  await taskService.complete(tasks[0].id, { adminDecision: 'TERMINATE' }, 'admin');

  // Verify rest-executor took gateway branch to _END_ERROR_TERMINATE and marked status failed
  const updatedInst = await app.store.repo<Instance>('instances').get(inst.id);
  assert.equal(updatedInst?.status, 'failed');
  assert.ok(updatedInst?.error?.message.includes('TERMINATE_CASE'));
});
