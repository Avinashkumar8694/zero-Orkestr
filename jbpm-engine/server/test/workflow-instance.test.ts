// Workflow Instance Management module — create-case flow (incl. orphan-safety on BPM-start failure),
// schema validation on/off, delegation-aware ownership-timeline reconstruction, the generic query
// engine's tenant-isolation guarantee under an adversarial filter, and descendants()-based
// tasks-at-any-level aggregation. See docs/usage_docs/14-workflow-instance-management.md.
import { test } from 'node:test';
import assert from 'node:assert';
import { MemoryStore } from '../src/store/memory-store.ts';
import { fakeClock } from '../src/infra/ids.ts';
import { makeContext, type AppContext } from '../src/context.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import { resolveWorkflowServiceStore } from '../src/workflow-service/store/index.ts';
import { WorkflowDefinitionService } from '../src/workflow-service/services/workflow-definition-service.ts';
import { WorkflowInstanceService } from '../src/workflow-service/services/workflow-instance-service.ts';
import { WorkflowAnalyticsService } from '../src/workflow-service/services/workflow-analytics-service.ts';
import { QueryEngineService } from '../src/workflow-service/services/query-engine-service.ts';

function newCtx(tenantId = 't1') {
  let n = 0;
  const fc = fakeClock();
  const ctx = makeContext({ store: new MemoryStore(), tenantId, clock: fc.clock, newId: () => `${tenantId}-${++n}` });
  return { ctx, fc };
}

const REVIEW_PROCESS = (key: string) => ({
  id: key, name: key,
  processes: [{
    id: `${key}.process`, name: key, package: 'com.acme', vars: [{ name: 'amount', type: 'double' }],
    nodes: [{ id: 's', type: 'start' }, { id: 'review', type: 'userTask', name: 'Review', group: 'g1' }, { id: 'e', type: 'end' }],
    flows: [{ id: 'f1', from: 's', to: 'review' }, { id: 'f2', from: 'review', to: 'e' }],
  }],
});

async function deploy(ctx: AppContext, key: string, environment = 'prod') {
  const wf = await new WorkflowService(ctx).create({ name: key, key }, 'a');
  const draft = await new VersionService(ctx).saveDraft(wf.defaultBranchId, REVIEW_PROCESS(key) as any, 'a');
  const pub = await new VersionService(ctx).publish(draft.id, 'a');
  const dep = await new DeploymentService(ctx).deploy(pub.published.id, { environment, activate: true }, 'a');
  return { wf, dep };
}

test('create-case flow resolves the named definition, starts the BPM instance, and backfills piid', async () => {
  const { ctx } = newCtx();
  const { dep } = await deploy(ctx, 'claim-review');
  const store = resolveWorkflowServiceStore(ctx.store);
  const defs = new WorkflowDefinitionService(ctx, store);
  const insts = new WorkflowInstanceService(ctx, store);

  await defs.create({ name: 'claim-review-v1', deploymentId: dep.id }, 'admin');
  const caseRow = await insts.create({ workflowName: 'claim-review-v1', variables: { amount: 500 }, workflowData: { claimId: 'CL-1' } }, 'admin');

  assert.strictEqual(caseRow.status, 'active');
  assert.ok(caseRow.piid, 'piid was backfilled');
  assert.strictEqual((caseRow.data as any).claimId, 'CL-1');

  const agg = await insts.aggregate(caseRow.id);
  assert.strictEqual(agg.bpmInstance?.id, caseRow.piid);
  assert.strictEqual(agg.tasks.length, 1, 'the case aggregate finds its own BPM task');
  assert.deepStrictEqual(agg.signals, { processId: 'claim-review.process', listensFor: [], throws: [] });

  const audits = await insts.listAudits(caseRow.id);
  assert.ok(audits.some((a) => a.kind === 'workflowInstance.created'));
  assert.ok(audits.some((a) => a.kind === 'workflowInstance.bpmStarted'));
});

test('a BPM-start failure marks the case failed with startError instead of leaving it orphaned at "initiated"', async () => {
  const { ctx } = newCtx();
  const { dep } = await deploy(ctx, 'claim-review-2');
  await new DeploymentService(ctx).archive(dep.id, 'a');   // start() will now refuse this deployment

  const store = resolveWorkflowServiceStore(ctx.store);
  const defs = new WorkflowDefinitionService(ctx, store);
  const insts = new WorkflowInstanceService(ctx, store);
  await defs.create({ name: 'broken', deploymentId: dep.id }, 'admin');

  const caseRow = await insts.create({ workflowName: 'broken' }, 'admin');
  assert.strictEqual(caseRow.status, 'failed');
  assert.strictEqual(caseRow.piid, null);
  assert.ok(caseRow.startError?.includes('archived'));

  const reread = await insts.get(caseRow.id);
  assert.strictEqual(reread.status, 'failed', 'the row is durably resolved, never stuck at "initiated"');
  const audits = await insts.listAudits(caseRow.id);
  assert.ok(audits.some((a) => a.kind === 'workflowInstance.startFailed'));
});

test('schema validation rejects invalid workflowData when enabled, and accepts anything when disabled', async () => {
  const { ctx } = newCtx();
  const { dep } = await deploy(ctx, 'strict-wf');
  const store = resolveWorkflowServiceStore(ctx.store);
  const defs = new WorkflowDefinitionService(ctx, store);
  const insts = new WorkflowInstanceService(ctx, store);
  const schema = { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] };

  await defs.create({ name: 'strict', deploymentId: dep.id, dataSchema: schema, schemaValidationEnabled: true }, 'admin');
  await assert.rejects(
    () => insts.create({ workflowName: 'strict', workflowData: { amount: 'not-a-number' } }, 'admin'),
    (e: any) => { assert.strictEqual(e.code, 'VALIDATION_FAILED'); return true; },
  );
  const ok = await insts.create({ workflowName: 'strict', workflowData: { amount: 42 } }, 'admin');
  assert.strictEqual((ok.data as any).amount, 42);

  await defs.create({ name: 'loose', deploymentId: dep.id, dataSchema: schema, schemaValidationEnabled: false }, 'admin');
  const loose = await insts.create({ workflowName: 'loose', workflowData: { anything: 'goes', amount: 'x' } }, 'admin');
  assert.strictEqual(loose.status, 'active', 'disabled validation applies the data as-is, no rejection');
});

test('ownership timeline reconstructs per-holder segments from the delegate/forward audit trail, summing to the task\'s full lifetime', async () => {
  const { ctx, fc } = newCtx();
  const { dep } = await deploy(ctx, 'timeline-wf');
  const store = resolveWorkflowServiceStore(ctx.store);
  const defs = new WorkflowDefinitionService(ctx, store);
  const insts = new WorkflowInstanceService(ctx, store);
  await defs.create({ name: 'timeline', deploymentId: dep.id }, 'admin');
  const caseRow = await insts.create({ workflowName: 'timeline' }, 'admin');
  const [task] = await insts.tasks(caseRow.id);
  const taskId = task!.id;

  const taskSvc = new TaskService(ctx);
  fc.advanceMs(60_000);
  await taskSvc.delegate(taskId, 'alice', 'admin');
  fc.advanceMs(120_000);
  await taskSvc.delegate(taskId, 'bob', 'alice');
  fc.advanceMs(30_000);
  await taskSvc.complete(taskId, {}, 'bob');

  const analytics = new WorkflowAnalyticsService(ctx, store);
  const timeline = await analytics.ownershipTimeline(taskId);

  assert.strictEqual(timeline.segments.length, 3);
  assert.strictEqual(timeline.segments[0]!.holder, 'g1', 'no prior holder recorded — falls back to the task\'s own group');
  assert.strictEqual(timeline.segments[1]!.holder, 'alice');
  assert.strictEqual(timeline.segments[2]!.holder, 'bob');
  assert.strictEqual(timeline.segments[0]!.durationMs, 60_000);
  assert.strictEqual(timeline.segments[1]!.durationMs, 120_000);
  assert.strictEqual(timeline.segments[2]!.durationMs, 30_000);

  const sum = timeline.segments.reduce((a, s) => a + s.durationMs, 0);
  assert.strictEqual(sum, timeline.totalMs, 'segments always sum to the reported total');

  const finalTask = await taskSvc.get(taskId);
  assert.strictEqual(timeline.segments[0]!.from, task!.createdAt);
  assert.strictEqual(timeline.segments.at(-1)!.to, finalTask.completedAt);
});

test('the generic query engine cannot be made to return another tenant\'s rows, even via a crafted filter matching that data exactly', async () => {
  const store = new MemoryStore();   // ONE store shared by both tenants, same as one real Postgres/file backend would be
  let n = 0;
  const ctxA = makeContext({ store, tenantId: 'tenantA', clock: fakeClock().clock, newId: () => `a${++n}` });
  const ctxB = makeContext({ store, tenantId: 'tenantB', clock: fakeClock().clock, newId: () => `b${++n}` });
  const wfStore = resolveWorkflowServiceStore(store);

  const { dep: depA } = await deploy(ctxA, 'iso-a');
  const { dep: depB } = await deploy(ctxB, 'iso-b');
  const defsA = new WorkflowDefinitionService(ctxA, wfStore);
  const defsB = new WorkflowDefinitionService(ctxB, wfStore);
  await defsA.create({ name: 'iso-a', deploymentId: depA.id }, 'admin');
  await defsB.create({ name: 'iso-b', deploymentId: depB.id }, 'admin');
  const instsA = new WorkflowInstanceService(ctxA, wfStore);
  const instsB = new WorkflowInstanceService(ctxB, wfStore);
  await instsA.create({ workflowName: 'iso-a', workflowData: { secret: 'tenantA-secret' } }, 'admin');
  await instsB.create({ workflowName: 'iso-b', workflowData: { secret: 'tenantB-secret' } }, 'admin');

  const qeA = new QueryEngineService(ctxA, wfStore);
  const qeB = new QueryEngineService(ctxB, wfStore);

  // tenant B queries for tenant A's exact known secret value — must see nothing.
  const leak = await qeB.run({ entity: 'workflowInstance', filters: [{ field: 'data.secret', op: 'eq', value: 'tenantA-secret' }] });
  assert.strictEqual((leak.rows || []).length, 0, 'tenant B must never see tenant A\'s row regardless of what the filter matches');

  // sanity: the SAME filter shape against tenant A's own data actually finds it — proves the filter
  // mechanism itself works and the empty result above isn't just "everything returns nothing."
  const found = await qeA.run({ entity: 'workflowInstance', filters: [{ field: 'data.secret', op: 'eq', value: 'tenantA-secret' }] });
  assert.strictEqual((found.rows || []).length, 1);

  // also try smuggling a `tenantId` filter that explicitly asks for rows NOT equal to tenant B's own
  // id — if isolation were broken at the fetch layer, this negation would surface tenant A's row
  // (which genuinely has tenantId !== 'tenantB'); since the fetch is already scoped to tenant B
  // BEFORE this filter ever runs, there is structurally nothing in the working set for it to match.
  const smuggle = await qeB.run({ entity: 'workflowInstance', filters: [{ field: 'tenantId', op: 'ne', value: 'tenantB' }] });
  assert.strictEqual((smuggle.rows || []).length, 0, 'nothing in tenant B\'s already-scoped working set has a foreign tenantId to find');
});

test('descendants()-based tasks-and-processes finds a task nested inside a call activity, at any level, active or completed', async () => {
  const { ctx } = newCtx();
  const wfChild = await new WorkflowService(ctx).create({ name: 'child-proc', key: 'child-proc' }, 'a');
  const draftChild = await new VersionService(ctx).saveDraft(wfChild.defaultBranchId, {
    id: 'child-proc', name: 'child-proc',
    processes: [{ id: 'child-proc.process', name: 'child-proc', package: 'com.acme', vars: [],
      nodes: [{ id: 's', type: 'start' }, { id: 'work', type: 'userTask', name: 'Do work', group: 'g2' }, { id: 'e', type: 'end' }],
      flows: [{ id: 'f1', from: 's', to: 'work' }, { id: 'f2', from: 'work', to: 'e' }] }],
  } as any, 'a');
  const pubChild = await new VersionService(ctx).publish(draftChild.id, 'a');
  await new DeploymentService(ctx).deploy(pubChild.published.id, { environment: 'prod', activate: true }, 'a');

  const wfParent = await new WorkflowService(ctx).create({ name: 'parent-proc', key: 'parent-proc' }, 'a');
  const draftParent = await new VersionService(ctx).saveDraft(wfParent.defaultBranchId, {
    id: 'parent-proc', name: 'parent-proc',
    processes: [{ id: 'parent-proc.process', name: 'parent-proc', package: 'com.acme', vars: [],
      nodes: [{ id: 's', type: 'start' }, { id: 'call', type: 'call', process: 'child-proc.process' }, { id: 'e', type: 'end' }],
      flows: [{ id: 'f1', from: 's', to: 'call' }, { id: 'f2', from: 'call', to: 'e' }] }],
  } as any, 'a');
  const pubParent = await new VersionService(ctx).publish(draftParent.id, 'a');
  const depParent = await new DeploymentService(ctx).deploy(pubParent.published.id, { environment: 'prod', activate: true }, 'a');

  const store = resolveWorkflowServiceStore(ctx.store);
  const defs = new WorkflowDefinitionService(ctx, store);
  const insts = new WorkflowInstanceService(ctx, store);
  await defs.create({ name: 'parent', deploymentId: depParent.id }, 'admin');
  const caseRow = await insts.create({ workflowName: 'parent' }, 'admin');

  const analytics = new WorkflowAnalyticsService(ctx, store);
  const { instances, tasks } = await analytics.tasksAndProcesses(caseRow.piid!);
  assert.strictEqual(instances.length, 2, 'root + one nested child instance');
  assert.strictEqual(tasks.length, 1, 'the child instance\'s own task is found even though it\'s not a task of the root piid directly');
  assert.strictEqual(tasks[0]!.group, 'g2');

  // same task must also be reachable through the WorkflowInstanceService's own tasks() aggregation
  const viaCase = await insts.tasks(caseRow.id);
  assert.strictEqual(viaCase.length, 1);
  assert.strictEqual(viaCase[0]!.id, tasks[0]!.id);
});

test('security: terminal or completed cases reject updateData, updateStatus, and addComment', async () => {
  const { ctx } = newCtx();
  const { dep } = await deploy(ctx, 'terminal-test');
  const store = resolveWorkflowServiceStore(ctx.store);
  const defs = new WorkflowDefinitionService(ctx, store);
  const insts = new WorkflowInstanceService(ctx, store);

  await defs.create({ name: 'term-v1', deploymentId: dep.id }, 'admin');
  const caseRow = await insts.create({ workflowName: 'term-v1', workflowData: { note: 'initial' } }, 'admin');

  // Mark the case as completed / settled
  await insts.updateStatus(caseRow.id, 'completed', 'admin');

  // Verify updating data is blocked
  await assert.rejects(
    () => insts.updateData(caseRow.id, { note: 'tampered' }, 'admin'),
    /closed and read-only/
  );

  // Verify updating status is blocked
  await assert.rejects(
    () => insts.updateStatus(caseRow.id, 'active', 'admin'),
    /closed and read-only/
  );

  // Verify adding comments is blocked
  await assert.rejects(
    () => insts.addComment(caseRow.id, 'late comment', 'admin'),
    /closed and read-only/
  );
});

