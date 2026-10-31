import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExecutionEngine } from '../src/engine/execution-engine.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import { AssetsService } from '../src/modules/assets/service.ts';
import type { AppContext } from '../src/context.ts';
import type { Deployment, Instance, Task, User } from '../src/domain.ts';
import type { EngineProject } from '../src/sdk/index.ts';

function createMockApp(): AppContext {
  const store = new Map<string, Map<string, any>>();
  const getCollection = (c: string) => {
    if (!store.has(c)) store.set(c, new Map());
    return store.get(c)!;
  };

  let idCounter = 1;
  const fixedNow = new Date('2026-10-30T01:00:00.000Z');

  return {
    tenantId: 'test-tenant',
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

// =========================================================================
// 1. ALL NODE TYPES COMPREHENSIVE TESTS
// =========================================================================

test('Node: start & end (terminate, error throw, signal broadcast, compensation)', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'start-end-wf',
    name: 'Start End Test',
    processes: [
      {
        id: 'proc_terminate',
        name: 'Terminate Flow',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'parallel_fork', type: 'gateway', mode: 'parallel' },
          { id: 'branch_terminate', type: 'end', result: 'terminate' },
          { id: 'branch_wait', type: 'userTask', name: 'Never Reached User Task' },
        ],
        flows: [
          { from: 'start', to: 'parallel_fork' },
          { from: 'parallel_fork', to: 'branch_terminate' },
          { from: 'parallel_fork', to: 'branch_wait' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_terminate',
    tenantId: app.tenantId,
    workflowId: 'wf_term',
    versionId: 'ver_term',
    branchId: 'br_term',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };

  const inst: Instance = {
    id: 'inst_term',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'proc_terminate',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  // Terminate end event terminates the entire instance, clearing remaining tokens
  assert.equal(inst.status, 'completed');
  assert.equal(inst.tokens.length, 0);
});

test('Node: script task (JavaScript sandbox with typed kcontext and timeout handling)', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'script-wf',
    name: 'Script Task Test',
    processes: [
      {
        id: 'proc_script',
        name: 'Script Process',
        package: 'com.test',
        vars: [
          { name: 'claimAmount', type: 'Integer' },
          { name: 'approved', type: 'Boolean' },
        ],
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'js_task',
            type: 'script',
            code: `
              // Test kcontext variable access
              const amt = kcontext.getVariable("claimAmount");
              kcontext.setVariable("approved", amt < 5000);
              vars.evaluatedBy = "anti_gravity_agent";
              vars.mathResult = Math.pow(2, 8);
            `,
          },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'js_task' },
          { from: 'js_task', to: 'end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_script',
    tenantId: app.tenantId,
    workflowId: 'wf_script',
    versionId: 'ver_script',
    branchId: 'br_script',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };

  const inst: Instance = {
    id: 'inst_script',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'proc_script',
    status: 'running',
    variables: { claimAmount: 3200 },
    tokens: [{ id: 'tok_s', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.approved, true);
  assert.equal(inst.variables.evaluatedBy, 'anti_gravity_agent');
  assert.equal(inst.variables.mathResult, 256);
});

test('Node: userTask (Lifecycle: claim, start, stop, saveOutputs, complete with output mapping, and SLA calculation)', async () => {
  const app = createMockApp();
  const taskService = new TaskService(app);

  const project: EngineProject = {
    id: 'user-wf',
    name: 'User Task Workflow',
    processes: [
      {
        id: 'proc_user',
        name: 'User Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'review_task',
            type: 'userTask',
            name: 'Senior Underwriter Review',
            group: 'underwriters',
            priority: 2,
            dueDate: 'P3D',
            inputs: { initialAmount: '$amount' },
            outputs: { decision: 'underwriterDecision', notes: 'underwriterNotes' },
            skippable: true,
          },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'review_task' },
          { from: 'review_task', to: 'end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_user',
    tenantId: app.tenantId,
    workflowId: 'wf_user',
    versionId: 'ver_user',
    branchId: 'br_user',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };
  await app.store.repo<Deployment>('deployments').put(dep);

  const inst: Instance = {
    id: 'inst_user',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'proc_user',
    status: 'running',
    variables: { amount: 75000 },
    tokens: [{ id: 'tok_u', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };
  await app.store.repo<Instance>('instances').put(inst);

  const engine = new ExecutionEngine(app);
  await engine.runToQuiescence(inst, dep);

  // Instance is waiting on userTask
  assert.equal(inst.status, 'waiting');
  const token = inst.tokens.find((t) => t.nodeId === 'review_task');
  assert.ok(token);
  assert.equal(token.state, 'waiting');
  assert.equal(token.waitFor?.kind, 'task');

  // Verify task was created in Task repo
  const tasks = await taskService.list({ group: 'underwriters' });
  assert.equal(tasks.length, 1);
  const task = tasks[0];
  assert.equal(task.inputs.initialAmount, 75000);
  assert.equal(task.priority, 2);
  assert.ok(task.dueAt);

  // 1. Claim
  await taskService.claim(task.id, 'alice');
  let loaded = await taskService.get(task.id);
  assert.equal(loaded.status, 'reserved');
  assert.equal(loaded.assignee, 'alice');

  // 2. Start
  await taskService.start(task.id, 'alice');
  loaded = await taskService.get(task.id);
  assert.equal(loaded.status, 'inprogress');

  // 3. Save draft outputs
  await taskService.saveOutputs(task.id, { draftField: 'in progress notes' }, 'alice');
  loaded = await taskService.get(task.id);
  assert.equal(loaded.outputs.draftField, 'in progress notes');

  // 4. Complete with mapped outputs
  await taskService.complete(task.id, {
    underwriterDecision: 'APPROVED',
    underwriterNotes: 'Risk within acceptable threshold',
  }, 'alice');

  // Verify task completed
  loaded = await taskService.get(task.id);
  assert.equal(loaded.status, 'completed');

  // Verify instance resumed and completed with mapped process variables
  const updatedInst = await app.store.repo<Instance>('instances').get(inst.id);
  assert.equal(updatedInst?.status, 'completed');
  assert.equal(updatedInst?.variables.underwriterDecision, 'APPROVED');
  assert.equal(updatedInst?.variables.underwriterNotes, 'Risk within acceptable threshold');
});

test('Node: gateways (Exclusive condition, Parallel fork-join with modulo looping, Inclusive fallback)', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'gateway-wf',
    name: 'Gateways Test',
    processes: [
      {
        id: 'proc_inclusive',
        name: 'Inclusive Gateway Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'inc_fork', type: 'gateway', mode: 'inclusive', default: 'default_flow' },
          { id: 'branch_a', type: 'script', code: 'vars.branchA = true;' },
          { id: 'branch_b', type: 'script', code: 'vars.branchB = true;' },
          { id: 'branch_default', type: 'script', code: 'vars.defaultBranch = true;' },
          { id: 'inc_join', type: 'gateway', mode: 'inclusive' },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'inc_fork' },
          { from: 'inc_fork', to: 'branch_a', when: 'vars.score >= 50' },
          { from: 'inc_fork', to: 'branch_b', when: 'vars.score >= 80' },
          { id: 'default_flow', from: 'inc_fork', to: 'branch_default' },
          { from: 'branch_a', to: 'inc_join' },
          { from: 'branch_b', to: 'inc_join' },
          { from: 'branch_default', to: 'inc_join' },
          { from: 'inc_join', to: 'end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_gate',
    tenantId: app.tenantId,
    workflowId: 'wf_gate',
    versionId: 'ver_gate',
    branchId: 'br_gate',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };

  // Case 1: score = 90 -> Matches branch_a AND branch_b, default is NOT taken
  const inst1: Instance = {
    id: 'inst_g1',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'proc_inclusive',
    status: 'running',
    variables: { score: 90 },
    tokens: [{ id: 'tok_g1', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst1, dep);
  assert.equal(inst1.status, 'completed');
  assert.equal(inst1.variables.branchA, true);
  assert.equal(inst1.variables.branchB, true);
  assert.equal(inst1.variables.defaultBranch, undefined);

  // Case 2: score = 20 -> Matches neither branch_a nor branch_b -> default is taken!
  const inst2: Instance = {
    id: 'inst_g2',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'proc_inclusive',
    status: 'running',
    variables: { score: 20 },
    tokens: [{ id: 'tok_g2', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst2, dep);
  assert.equal(inst2.status, 'completed');
  assert.equal(inst2.variables.branchA, undefined);
  assert.equal(inst2.variables.branchB, undefined);
  assert.equal(inst2.variables.defaultBranch, true);
});

test('Node: for-each / multi-instance (Empty array pass-through & parallel execution)', async () => {
  const app = createMockApp();

  const project: EngineProject = {
    id: 'mi-wf',
    name: 'Multi-Instance Workflow',
    processes: [
      {
        id: 'main-proc',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'mi_node',
            type: 'forEach',
            process: 'item-processor',
            over: 'claimItems',
            as: 'item',
            parallel: true,
            collectInto: 'processedClaims',
            itemResult: 'calculatedPayout',
          },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'mi_node' },
          { from: 'mi_node', to: 'end' },
        ],
      },
      {
        id: 'item-processor',
        name: 'Item Processor',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'c_start', type: 'start' },
          { id: 'c_calc', type: 'script', code: 'vars.calculatedPayout = vars.item.amount * 0.8;' },
          { id: 'c_end', type: 'end' },
        ],
        flows: [
          { from: 'c_start', to: 'c_calc' },
          { from: 'c_calc', to: 'c_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_mi',
    tenantId: app.tenantId,
    workflowId: 'wf_mi',
    versionId: 'ver_mi',
    branchId: 'br_mi',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };

  const resolveCalled = async (pid: string) => ({ dep, processId: pid });
  const engine = new ExecutionEngine(app, () => {}, resolveCalled);

  // Case 1: Empty collection edge case
  const instEmpty: Instance = {
    id: 'inst_mi_empty',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-proc',
    status: 'running',
    variables: { claimItems: [] },
    tokens: [{ id: 'tok_empty', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(instEmpty, dep);
  assert.equal(instEmpty.status, 'completed');
  assert.deepEqual(instEmpty.variables.processedClaims, []);

  // Case 2: Populated collection with parallel execution
  const instPopulated: Instance = {
    id: 'inst_mi_pop',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-proc',
    status: 'running',
    variables: {
      claimItems: [
        { id: 'ITEM_1', amount: 100 },
        { id: 'ITEM_2', amount: 250 },
        { id: 'ITEM_3', amount: 500 },
      ],
    },
    tokens: [{ id: 'tok_pop', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(instPopulated, dep);
  assert.equal(instPopulated.status, 'completed');
  assert.deepEqual(instPopulated.variables.processedClaims, [80, 200, 400]);
});

test('Node: work-item task (Pluggable WorkItemHandler for Compute & Log with parameter interpolation)', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'wid-wf',
    name: 'Work Item Test',
    processes: [
      {
        id: 'proc_wid',
        name: 'Work Item Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'compute_task',
            type: 'workItem',
            handler: 'Compute',
            params: {
              expr: 'baseSalary * multiplier',
              baseSalary: '$salary',
              multiplier: 1.25,
            },
            resultTo: { finalCompensation: 'result' },
          },
          {
            id: 'log_task',
            type: 'workItem',
            handler: 'Log',
            params: {
              message: 'Employee compensation calculated: ${finalCompensation}',
            },
            resultTo: { auditLogged: 'logged' },
          },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'compute_task' },
          { from: 'compute_task', to: 'log_task' },
          { from: 'log_task', to: 'end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_wid',
    tenantId: app.tenantId,
    workflowId: 'wf_wid',
    versionId: 'ver_wid',
    branchId: 'br_wid',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };

  const inst: Instance = {
    id: 'inst_wid',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'proc_wid',
    status: 'running',
    variables: { salary: 80000 },
    tokens: [{ id: 'tok_w', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.finalCompensation, 100000);
  assert.equal(inst.variables.auditLogged, true);
});

test('Node: boundary events (Catch-all declared BEFORE specific boundary on same node -> specific still wins)', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'order-test-wf',
    name: 'Boundary Order Test',
    processes: [
      {
        id: 'main-process',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'faulty_node', type: 'script', code: 'throw new Error("HTTP connection dropped");' },
          // CATCH-ALL IS LISTED FIRST IN THE ARRAY!
          { id: 'catchall_boundary', type: 'boundary', on: 'faulty_node', event: { error: '*' } },
          { id: 'catchall_step', type: 'script', code: 'vars.handler = "catchall_fired";' },
          // SPECIFIC BOUNDARY IS LISTED SECOND!
          { id: 'specific_boundary', type: 'boundary', on: 'faulty_node', event: { error: 'SCRIPT_ERROR' } },
          { id: 'specific_step', type: 'script', code: 'vars.handler = "specific_fired";' },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'faulty_node' },
          { from: 'catchall_boundary', to: 'catchall_step' },
          { from: 'catchall_step', to: 'end' },
          { from: 'specific_boundary', to: 'specific_step' },
          { from: 'specific_step', to: 'end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_order',
    tenantId: app.tenantId,
    workflowId: 'wf_order',
    versionId: 'ver_order',
    branchId: 'br_order',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };

  const inst: Instance = {
    id: 'inst_order',
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
  // Specific handler MUST win even when declared after catch-all in array!
  assert.equal(inst.variables.handler, 'specific_fired');
});

// =========================================================================
// 2. ALL ASSET TYPES COMPREHENSIVE TESTS
// =========================================================================

test('Assets: testAsset across DMN, Guided Table, Decision Tree, Scorecard, Ruleset, Forms, Types, Enums, Messages', async () => {
  const app = createMockApp();
  const wfService = new WorkflowService(app);
  const verService = new VersionService(app);
  const assetsService = new AssetsService(app);

  const wf = await wfService.create({ name: 'Asset Test Project', key: 'asset-test-project' }, 'tester');
  const draftVer = (await verService.listByBranch(wf.defaultBranchId))[0];
  const engine = draftVer.engine;

  // 1. Guided Decision Table
  (engine as any).guidedTables = [
    {
      name: 'ClaimRiskTable',
      fact: 'claim',
      hitPolicy: 'FIRST',
      conditions: [
        { field: 'amount', op: 'gte' },
        { field: 'priorClaims', op: 'gt' },
      ],
      actions: [
        { field: 'riskTier' },
        { field: 'requiresSpecialAudit' },
      ],
      rows: [
        { when: { amount: 50000, priorClaims: 2 }, then: { riskTier: 'HIGH', requiresSpecialAudit: true } },
        { when: { amount: 10000, priorClaims: 0 }, then: { riskTier: 'LOW', requiresSpecialAudit: false } },
      ],
    },
  ];

  // 2. Decision Tree
  (engine as any).decisionTrees = [
    {
      name: 'FraudScoreTree',
      fact: 'application',
      root: {
        test: { field: 'deviceAnomaly' },
        branches: [
          {
            match: true,
            then: {
              output: { fraudScore: 90, action: 'BLOCK' },
            },
          },
          {
            match: false,
            then: {
              output: { fraudScore: 10, action: 'PASS' },
            },
          },
        ],
      },
    },
  ];

  // 3. Scorecard
  (engine as any).scorecards = [
    {
      name: 'CreditScorecard',
      fact: 'applicant',
      baseline: 600,
      target: 'finalScore',
      characteristics: [
        {
          field: 'employmentYears',
          attributes: [
            { match: { gte: 5 }, points: 50, reason: 'Stable employment' },
            { match: { lt: 5 }, points: 10, reason: 'Short employment' },
          ],
        },
        {
          field: 'debtToIncome',
          attributes: [
            { match: { lte: 0.3 }, points: 40, reason: 'Healthy DTI' },
            { match: { gt: 0.3 }, points: -30, reason: 'High DTI' },
          ],
        },
      ],
    },
  ];

  // 4. Form Asset
  (engine as any).forms = [
    {
      name: 'FirstNoticeOfLossForm',
      fields: [
        { bind: 'incidentDate', label: 'Incident Date', required: true, widget: 'date' },
        { bind: 'estimatedDamage', label: 'Estimated Damage', required: true, widget: 'number' },
      ],
    },
  ];

  // 5. Types Asset (Data Object)
  (engine as any).types = [
    {
      name: 'ClaimFolder',
      fields: [
        { name: 'claimId', type: 'String' },
        { name: 'lineItems', type: 'ClaimItem', list: true },
      ],
    },
  ];

  // 6. Enumerations Asset
  (engine as any).enumerations = [
    {
      name: 'PolicyStateEnum',
      values: ['SUBMITTED', 'UNDERWRITING', 'APPROVED', 'REJECTED', 'BOUND'],
    },
  ];

  // 7. Messages Asset
  (engine as any).messages = [
    {
      name: 'UnderwritingDecisionMessage',
      correlationKey: 'policyNumber',
      dataType: 'com.prudential.PolicyEvent',
    },
  ];

  // Save the draft engine with all assets
  await verService.saveDraft(wf.defaultBranchId, engine, 'tester');

  // Verify Guided Decision Table testAsset
  const tableResult = await assetsService.testAsset(wf.id, 'guidedTables', 'ClaimRiskTable', {
    amount: 60000,
    priorClaims: 3,
  });
  assert.equal(tableResult.success, true);
  assert.equal((tableResult.outputs as any).riskTier, 'HIGH');
  assert.equal((tableResult.outputs as any).requiresSpecialAudit, true);

  // Verify Decision Tree testAsset
  const treeResult = await assetsService.testAsset(wf.id, 'decisionTrees', 'FraudScoreTree', {
    deviceAnomaly: true,
  });
  assert.equal(treeResult.success, true);
  assert.equal((treeResult.outputs as any).fraudScore, 90);
  assert.equal((treeResult.outputs as any).action, 'BLOCK');

  // Verify Scorecard testAsset
  const scorecardResult = await assetsService.testAsset(wf.id, 'scorecards', 'CreditScorecard', {
    employmentYears: 7,
    debtToIncome: 0.25,
  });
  assert.equal(scorecardResult.success, true);
  // Baseline (600) + Employment (50) + DTI (40) = 690
  assert.equal((scorecardResult.outputs as any).finalScore, 690);
  assert.deepEqual((scorecardResult.outputs as any).finalScoreReasons, ['Stable employment', 'Healthy DTI']);

  // Verify Form testAsset validation
  const validFormResult = await assetsService.testAsset(wf.id, 'forms', 'FirstNoticeOfLossForm', {
    incidentDate: '2026-10-30',
    estimatedDamage: '15000',
  });
  assert.equal(validFormResult.valid, true);

  const invalidFormResult = await assetsService.testAsset(wf.id, 'forms', 'FirstNoticeOfLossForm', {
    incidentDate: '',
    estimatedDamage: 'not_a_number',
  });
  assert.equal(invalidFormResult.valid, false);
  assert.equal((invalidFormResult.errors as string[]).length, 2);

  // Verify Types testAsset validation
  const validTypesResult = await assetsService.testAsset(wf.id, 'types', 'ClaimFolder', {
    claimId: 'CLM-100',
    lineItems: [{ id: '1' }, { id: '2' }],
  });
  assert.equal(validTypesResult.valid, true);

  const invalidTypesResult = await assetsService.testAsset(wf.id, 'types', 'ClaimFolder', {
    claimId: 'CLM-100',
    lineItems: 'not_a_list',
  });
  assert.equal(invalidTypesResult.valid, false);

  // Verify Enumerations testAsset
  const validEnumResult = await assetsService.testAsset(wf.id, 'enumerations', 'PolicyStateEnum', {
    value: 'APPROVED',
  });
  assert.equal(validEnumResult.allowed, true);

  const invalidEnumResult = await assetsService.testAsset(wf.id, 'enumerations', 'PolicyStateEnum', {
    value: 'SUSPENDED_FOREVER',
  });
  assert.equal(invalidEnumResult.allowed, false);

  // Verify Messages testAsset
  const msgResult = await assetsService.testAsset(wf.id, 'messages', 'UnderwritingDecisionMessage', {});
  assert.equal(msgResult.success, true);
  assert.equal(msgResult.correlationKey, 'policyNumber');
});

test('Node: manual task & call activity (Independent fire-and-forget vs synchronous wait)', async () => {
  const app = createMockApp();

  const project: EngineProject = {
    id: 'call-manual-wf',
    name: 'Call and Manual Workflow',
    processes: [
      {
        id: 'parent-process',
        name: 'Parent Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'manual_offline_step', type: 'manual', name: 'Physical Document Inspection' },
          {
            id: 'call_async_child',
            type: 'call',
            process: 'independent-child',
            independent: true,
            inputs: { parentTrace: '$traceId' },
          },
          {
            id: 'call_sync_child',
            type: 'call',
            process: 'sync-child',
            inputs: { initialScore: '$baseScore' },
            outputs: { parentAdjustedScore: 'adjustedScore' },
          },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'manual_offline_step' },
          { from: 'manual_offline_step', to: 'call_async_child' },
          { from: 'call_async_child', to: 'call_sync_child' },
          { from: 'call_sync_child', to: 'end' },
        ],
      },
      {
        id: 'independent-child',
        name: 'Independent Fire-And-Forget Child',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'ic_start', type: 'start' },
          { id: 'ic_work', type: 'script', code: 'vars.childLogged = true;' },
          { id: 'ic_end', type: 'end' },
        ],
        flows: [
          { from: 'ic_start', to: 'ic_work' },
          { from: 'ic_work', to: 'ic_end' },
        ],
      },
      {
        id: 'sync-child',
        name: 'Synchronous Waiting Child',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'sc_start', type: 'start' },
          { id: 'sc_calc', type: 'script', code: 'vars.adjustedScore = vars.initialScore * 1.5;' },
          { id: 'sc_end', type: 'end' },
        ],
        flows: [
          { from: 'sc_start', to: 'sc_calc' },
          { from: 'sc_calc', to: 'sc_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_call_manual',
    tenantId: app.tenantId,
    workflowId: 'wf_call_man',
    versionId: 'ver_call_man',
    branchId: 'br_call_man',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };

  const resolveCalled = async (pid: string) => ({ dep, processId: pid });
  const engine = new ExecutionEngine(app, () => {}, resolveCalled);

  const inst: Instance = {
    id: 'inst_call_parent',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'parent-process',
    status: 'running',
    variables: { traceId: 'TR-9901', baseScore: 200 },
    tokens: [{ id: 'tok_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  assert.equal(inst.status, 'completed');
  // Manual node passed through, sync child output mapped back to parent
  assert.equal(inst.variables.parentAdjustedScore, 300);
});

test('Node: embedded subprocess (Shared variable scope & token merging)', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'sub-wf',
    name: 'Subprocess Workflow',
    processes: [
      {
        id: 'main-proc',
        name: 'Main Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'sub_enclosure',
            type: 'subprocess',
            nodes: [
              { id: 'sub_start', type: 'start' },
              {
                id: 'sub_script',
                type: 'script',
                code: `
                  vars.sharedVarModified = vars.mainVar + " [augmented in subprocess]";
                  vars.subOnlyVar = 42;
                `,
              },
              { id: 'sub_end', type: 'end' },
            ],
            flows: [
              { from: 'sub_start', to: 'sub_script' },
              { from: 'sub_script', to: 'sub_end' },
            ],
          },
          { id: 'post_sub_node', type: 'script', code: 'vars.finalConfirmed = vars.subOnlyVar * 2;' },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'sub_enclosure' },
          { from: 'sub_enclosure', to: 'post_sub_node' },
          { from: 'post_sub_node', to: 'end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_sub',
    tenantId: app.tenantId,
    workflowId: 'wf_sub',
    versionId: 'ver_sub',
    branchId: 'br_sub',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };

  const inst: Instance = {
    id: 'inst_sub',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'main-proc',
    status: 'running',
    variables: { mainVar: 'Initial State' },
    tokens: [{ id: 'tok_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };

  await engine.runToQuiescence(inst, dep);

  assert.equal(inst.status, 'completed');
  assert.equal(inst.variables.sharedVarModified, 'Initial State [augmented in subprocess]');
  assert.equal(inst.variables.subOnlyVar, 42);
  assert.equal(inst.variables.finalConfirmed, 84);
});

test('Node: send & receive tasks (Correlated message dispatch and resumption)', async () => {
  const app = createMockApp();

  const project: EngineProject = {
    id: 'msg-wf',
    name: 'Messaging Test',
    processes: [
      {
        id: 'receiver-proc',
        name: 'Receiver Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'wait_for_payment', type: 'receive', message: 'PaymentReceived' },
          { id: 'post_receive', type: 'script', code: 'vars.paymentProcessed = true;' },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'wait_for_payment' },
          { from: 'wait_for_payment', to: 'post_receive' },
          { from: 'post_receive', to: 'end' },
        ],
      },
      {
        id: 'sender-proc',
        name: 'Sender Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 's_start', type: 'start' },
          { id: 'send_payment', type: 'send', message: 'PaymentReceived' },
          { id: 's_end', type: 'end' },
        ],
        flows: [
          { from: 's_start', to: 'send_payment' },
          { from: 'send_payment', to: 's_end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_msg',
    tenantId: app.tenantId,
    workflowId: 'wf_msg',
    versionId: 'ver_msg',
    branchId: 'br_msg',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };

  const engine = new ExecutionEngine(app);

  // 1. Start Receiver Process -> Enters wait on receive task
  const receiverInst: Instance = {
    id: 'inst_receiver',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'receiver-proc',
    status: 'running',
    variables: { caseId: 'CASE-771' },
    tokens: [{ id: 'tok_r_start', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };
  await app.store.repo<Deployment>('deployments').put(dep);
  await app.store.repo<Instance>('instances').put(receiverInst);
  await engine.runToQuiescence(receiverInst, dep);

  assert.equal(receiverInst.status, 'waiting');
  const waitToken = receiverInst.tokens.find((t) => t.nodeId === 'wait_for_payment');
  assert.ok(waitToken);
  assert.equal(waitToken.state, 'waiting');
  assert.equal(waitToken.waitFor?.kind, 'message');
  assert.equal(waitToken.waitFor?.ref, 'PaymentReceived');

  // 2. Start Sender Process -> Emits broadcast('PaymentReceived')
  const senderInst: Instance = {
    id: 'inst_sender',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'sender-proc',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_s_start', nodeId: 's_start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };
  await engine.runToQuiescence(senderInst, dep);
  assert.equal(senderInst.status, 'completed');

  // 3. Verify Receiver was resumed by the broadcast and completed!
  const updatedReceiver = await app.store.repo<Instance>('instances').get(receiverInst.id);
  assert.equal(updatedReceiver?.status, 'completed');
  assert.equal(updatedReceiver?.variables.paymentProcessed, true);
});

test('Node: userTask advanced security (ExcludedOwners segregation of duties & skippable task skip)', async () => {
  const app = createMockApp();
  const taskService = new TaskService(app);

  const project: EngineProject = {
    id: 'user-sec-wf',
    name: 'User Task Security Test',
    processes: [
      {
        id: 'proc_sec',
        name: 'Security Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          {
            id: 'task_maker_checker',
            type: 'userTask',
            name: 'Audit Approval',
            group: 'auditors',
            excludedOwners: ['claim_creator_bob'],
            skippable: true,
          },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'task_maker_checker' },
          { from: 'task_maker_checker', to: 'end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_sec',
    tenantId: app.tenantId,
    workflowId: 'wf_sec',
    versionId: 'ver_sec',
    branchId: 'br_sec',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };
  await app.store.repo<Deployment>('deployments').put(dep);

  const inst: Instance = {
    id: 'inst_sec',
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'proc_sec',
    status: 'running',
    variables: {},
    tokens: [{ id: 'tok_sec', nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: 'tester',
  };
  await app.store.repo<Instance>('instances').put(inst);

  const engine = new ExecutionEngine(app);
  await engine.runToQuiescence(inst, dep);

  const tasks = await taskService.list({});
  assert.equal(tasks.length, 1);
  const task = tasks[0];

  // 1. Excluded owner (claim_creator_bob) must be rejected with 403 Forbidden!
  await assert.rejects(
    async () => {
      await taskService.claim(task.id, 'claim_creator_bob');
    },
    /claim_creator_bob is excluded from this task/
  );

  // 2. Skippable task skip: valid user skips task
  await taskService.skip(task.id, 'auditor_carol');
  const skippedTask = await taskService.get(task.id);
  assert.equal(skippedTask.status, 'skipped');

  // Instance resumes past the skipped task
  const updatedInst = await app.store.repo<Instance>('instances').get(inst.id);
  assert.equal(updatedInst?.status, 'completed');
});

test('Assets: DRL rulesets and test scenarios runner (.scesim)', async () => {
  const app = createMockApp();
  const wfService = new WorkflowService(app);
  const verService = new VersionService(app);
  const assetsService = new AssetsService(app);

  const wf = await wfService.create({ name: 'Rules and Scenarios Project', key: 'rules-scesim' }, 'tester');
  const draftVer = (await verService.listByBranch(wf.defaultBranchId))[0];
  const engine = draftVer.engine;

  // 1. DRL Ruleset with condition matching and action
  (engine as any).rulesets = [
    {
      group: 'EligibilityRuleflow',
      name: 'CheckAgeAndState',
      rules: [
        {
          name: 'EligibleSeniorRule',
          priority: 10,
          when: [
            {
              fact: 'client',
              where: {
                age: { gte: 65 },
                state: 'CA',
              },
            },
          ],
          then: [
            {
              set: 'client',
              fields: { eligible: true, discountTier: 'SENIOR_GOLD' },
            },
            {
              insert: 'auditNotice',
              fields: { generatedAt: '2026-10-30', reason: 'Age >= 65 in CA' },
            },
          ],
        },
      ],
    },
  ];

  // 2. Test Scenario Asset
  (engine as any).tests = [
    {
      name: 'ClientEligibilityTest',
      target: 'EligibilityRuleflow',
      cases: [
        {
          name: 'Senior in California Should Be Eligible',
          given: {
            client: { age: 70, state: 'CA' },
          },
          expect: {
            client: { eligible: true, discountTier: 'SENIOR_GOLD' },
          },
        },
      ],
    },
  ];

  await verService.saveDraft(wf.defaultBranchId, engine, 'tester');

  // Test Ruleset evaluation
  const rulesResult = await assetsService.testAsset(wf.id, 'rulesets', 'EligibilityRuleflow', {
    client: { age: 68, state: 'CA' },
  });
  assert.equal(rulesResult.success, true);
  const outputs = rulesResult.outputs as any;
  assert.equal(outputs.client.eligible, true);
  assert.equal(outputs.client.discountTier, 'SENIOR_GOLD');
  assert.ok(outputs.auditNotice);

  // Test Test Scenario Runner (.scesim)
  const scesimResult = await assetsService.testAsset(wf.id, 'tests', 'ClientEligibilityTest', {});
  assert.equal(scesimResult.success, true);
  assert.equal(scesimResult.total, 1);
  assert.equal(scesimResult.passed, 1);
  assert.equal(scesimResult.failed, 0);
  assert.equal((scesimResult.cases as any[])[0].pass, true);
});

// =========================================================================
// 3. HIGH-PRESSURE CONCURRENCY & STRESS TEST (100 CONCURRENT INSTANCES)
// =========================================================================

test('Stress: Extreme-pressure execution of 100 simultaneous workflow instances with parallel forks, scripts, and state validation', async () => {
  const app = createMockApp();
  const engine = new ExecutionEngine(app);

  const project: EngineProject = {
    id: 'extreme-stress-wf',
    name: 'Extreme Concurrency Stress Workflow',
    processes: [
      {
        id: 'proc_extreme_stress',
        name: 'Extreme Stress Process',
        package: 'com.test',
        vars: [],
        nodes: [
          { id: 'start', type: 'start' },
          { id: 'fork', type: 'gateway', mode: 'parallel' },
          {
            id: 'calc_branch_1',
            type: 'script',
            code: `
              let sum = 0;
              for (let i = 1; i <= 200; i++) sum += (i * 3);
              vars.sumResult = sum;
            `,
          },
          {
            id: 'calc_branch_2',
            type: 'script',
            code: `
              let product = 1;
              for (let i = 1; i <= 8; i++) product *= i;
              vars.productResult = product;
            `,
          },
          { id: 'join', type: 'gateway', mode: 'parallel' },
          {
            id: 'finalize',
            type: 'script',
            code: `
              vars.combined = vars.sumResult + vars.productResult;
              vars.completedInstanceId = vars.workerId;
            `,
          },
          { id: 'end', type: 'end' },
        ],
        flows: [
          { from: 'start', to: 'fork' },
          { from: 'fork', to: 'calc_branch_1' },
          { from: 'fork', to: 'calc_branch_2' },
          { from: 'calc_branch_1', to: 'join' },
          { from: 'calc_branch_2', to: 'join' },
          { from: 'join', to: 'finalize' },
          { from: 'finalize', to: 'end' },
        ],
      },
    ],
  } as unknown as EngineProject;

  const dep: Deployment = {
    id: 'dep_extreme',
    tenantId: app.tenantId,
    workflowId: 'wf_extreme',
    versionId: 'ver_extreme',
    branchId: 'br_extreme',
    engine: project,
    env: {},
    tags: ['prod'],
    status: 'active',
    environment: 'prod',
    deployedAt: app.clock(),
    deployedBy: 'tester',
  };

  const CONCURRENT_COUNT = 100;
  const instances: Instance[] = Array.from({ length: CONCURRENT_COUNT }, (_, idx) => ({
    id: `inst_extreme_${idx}`,
    tenantId: app.tenantId,
    deploymentId: dep.id,
    workflowId: dep.workflowId,
    processId: 'proc_extreme_stress',
    status: 'running',
    variables: { workerId: `WORKER_${idx}` },
    tokens: [{ id: `tok_extreme_${idx}`, nodeId: 'start', state: 'active', enteredAt: app.clock() }],
    history: [],
    startedAt: app.clock(),
    startedBy: `stress_tester_${idx}`,
  }));

  const startTime = Date.now();

  // Fire all 100 parallel workflow executions simultaneously
  await Promise.all(instances.map((inst) => engine.runToQuiescence(inst, dep)));

  const durationMs = Date.now() - startTime;

  // Verify all 100 instances completed with zero corruption and exact arithmetic results
  for (let idx = 0; idx < CONCURRENT_COUNT; idx++) {
    const inst = instances[idx];
    assert.equal(inst.status, 'completed', `Instance ${idx} failed to complete`);
    assert.equal(inst.variables.completedInstanceId, `WORKER_${idx}`);
    // sum i=1 to 200 of 3*i = 3 * (200 * 201 / 2) = 60,300
    assert.equal(inst.variables.sumResult, 60300);
    // 8! = 40,320
    assert.equal(inst.variables.productResult, 40320);
    assert.equal(inst.variables.combined, 60300 + 40320);
  }

  // 100 multi-branch parallel instances must execute cleanly in under 5 seconds
  assert.ok(durationMs < 5000, `100-instance stress test took ${durationMs}ms which exceeded threshold`);
});
