// Query / task-admin / analytics module (docs/17): process-definition catalog, per-user & per-group
// task inboxes, completed-by-user, related tasks, process signals, and TAT analytics. Deterministic.
import { test } from 'node:test';
import assert from 'node:assert';
import { MemoryStore } from '../src/store/memory-store.ts';
import { makeContext } from '../src/context.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { InstanceService } from '../src/modules/instances/service.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import { QueryService } from '../src/modules/queries/service.ts';
import { Collections, type Task } from '../src/domain.ts';

// A clock that advances 60s each read, so create→complete durations are non-zero and deterministic.
function steppingClock() {
  let t = Date.parse('2026-01-01T00:00:00.000Z');
  return () => { const iso = new Date(t).toISOString(); t += 60_000; return iso; };
}
function newCtx() {
  let n = 0;
  const store = new MemoryStore();
  return { store, ctx: makeContext({ store, tenantId: 't1', clock: steppingClock(), newId: () => `id${++n}` }) };
}

const engineOf = (key: string) => ({
  id: key, name: key,
  processes: [{
    id: `${key}.process`, name: 'Approval', package: 'com.acme', vars: [],
    nodes: [
      { id: 'start', type: 'start', name: 'Start', on: { signal: 'Kickoff' } },
      { id: 'review', type: 'userTask', name: 'Review', group: 'ops' },
      { id: 'ping', type: 'throw', name: 'Ping', event: { signal: 'Reviewed' } },
      { id: 'end', type: 'end', name: 'End' },
    ],
    flows: [{ from: 'start', to: 'review' }, { from: 'review', to: 'ping' }, { from: 'ping', to: 'end' }],
  }],
});

async function setup() {
  const { store, ctx } = newCtx();
  const wf = await new WorkflowService(ctx).create({ name: 'Approvals' }, 'alice');
  const verSvc = new VersionService(ctx);
  const draft = await verSvc.saveDraft(wf.defaultBranchId, { ...engineOf(wf.key), id: wf.key } as any, 'alice');
  const { published } = await verSvc.publish(draft.id, 'alice', 'v1');
  await new DeploymentService(ctx).deploy(published.id, { environment: 'prod', activate: true }, 'alice');
  const instSvc = new InstanceService(ctx);
  const taskSvc = new TaskService(ctx);
  const procId = `${wf.key}.process`;

  // two instances; complete one task (by carol), leave one open in the ops queue
  const i1 = await instSvc.start({ workflowId: wf.id, environment: 'prod' }, 'bob');
  const i2 = await instSvc.start({ workflowId: wf.id, environment: 'prod' }, 'bob');
  const openTasks = await store.repo<Task>(Collections.tasks).query((t) => t.status === 'created');
  await taskSvc.claim(openTasks[0]!.id, 'carol');
  await taskSvc.complete(openTasks[0]!.id, { decision: 'approve' }, 'carol');
  return { ctx, wf, procId, q: new QueryService(ctx), i1, i2 };
}

test('process-definition catalog reports live instance stats', async () => {
  const { q, procId } = await setup();
  const defs = await q.processDefinitions();
  const def = defs.find((d) => d.processId === procId)!;
  assert.ok(def, 'definition listed');
  assert.strictEqual(def.instances.total, 2);
  assert.strictEqual(def.instances.active, 1, 'one still waiting, one completed');
});

test('process signals: listens-for and throws are extracted from the definition', async () => {
  const { q, procId } = await setup();
  const sig = await q.processSignals(procId);
  assert.deepStrictEqual(sig.listensFor, ['Kickoff']);
  assert.deepStrictEqual(sig.throws, ['Reviewed']);
});

test('per-user / per-group task inboxes and completed-by', async () => {
  const { q } = await setup();
  assert.strictEqual((await q.tasksForGroup('ops', 'created')).length, 1, 'one task still queued for ops');
  assert.strictEqual((await q.tasksForUser('carol')).length, 1, 'carol owns the task she claimed');
  const done = await q.tasksCompletedByUser('carol');
  assert.strictEqual(done.length, 1);
  assert.strictEqual(done[0]!.completedBy, 'carol');
});

test('derived user directory counts initiators and task work', async () => {
  const { q } = await setup();
  const users = await q.users();
  const bob = users.find((u) => u.user === 'bob')!;
  const carol = users.find((u) => u.user === 'carol')!;
  assert.strictEqual(bob.startedInstances, 2, 'bob started both instances');
  assert.strictEqual(carol.completedTasks, 1);
});

test('instance tasks + TAT analytics', async () => {
  const { q, i1, i2 } = await setup();
  const forOne = (await q.instanceTasks(i1.id)).concat(await q.instanceTasks(i2.id));
  assert.strictEqual(forOne.length, 2, 'each instance produced one task');

  const ta = await q.taskAnalytics();
  const review = ta.byTask.find((x) => x.name === 'Review')!;
  assert.strictEqual(review.count, 1);
  assert.ok(review.avgMs > 0, 'task duration measured');

  const pa = await q.processAnalytics();
  assert.strictEqual(pa.byStatus.completed, 1);
  assert.strictEqual(pa.byStatus.waiting, 1);
});

test('extended analytics: projects, users, groups, task-definitions, and process-definitions', async () => {
  const { q, wf, procId } = await setup();

  // 1. Project analytics
  const proj = await q.projectAnalytics();
  assert.strictEqual(proj.summary.totalProjects, 1);
  assert.strictEqual(proj.summary.totalInstances, 2);
  assert.strictEqual(proj.summary.completedTasks, 1);
  assert.strictEqual(proj.byProject[0]?.workflowId, wf.id);
  assert.strictEqual(proj.byProject[0]?.instances.total, 2);
  assert.strictEqual(proj.byProject[0]?.tasks.completed, 1);

  // Filter by workflowId
  const projFiltered = await q.projectAnalytics({ workflowId: wf.id });
  assert.strictEqual(projFiltered.byProject.length, 1);

  // 2. User analytics
  const users = await q.userAnalytics() as any[];
  assert.ok(Array.isArray(users));
  const carolStats = users.find((u) => u.user === 'carol');
  assert.ok(carolStats);
  assert.strictEqual(carolStats.tasksCompleted, 1);
  assert.ok(carolStats.tat.avgMs > 0);
  assert.strictEqual(carolStats.byTaskName[0]?.taskName, 'Review');

  // Single user query
  const carolSingle = await q.userAnalytics({ user: 'carol' }) as any;
  assert.strictEqual(carolSingle.user, 'carol');
  assert.strictEqual(carolSingle.tasksCompleted, 1);

  // 3. Group analytics
  const groups = await q.groupAnalytics() as any[];
  assert.ok(Array.isArray(groups));
  const opsGroup = groups.find((g) => g.group === 'ops');
  assert.ok(opsGroup);
  assert.strictEqual(opsGroup.tasksCompleted, 1);
  assert.strictEqual(opsGroup.tasksOpen, 1);
  assert.strictEqual(opsGroup.tasksUnassigned, 1);

  // Single group query
  const opsSingle = await q.groupAnalytics({ group: 'ops' }) as any;
  assert.strictEqual(opsSingle.group, 'ops');
  assert.strictEqual(opsSingle.tasksCompleted, 1);

  // 4. Task definitions analytics
  const taskDefs = await q.taskDefinitionsAnalytics();
  assert.strictEqual(taskDefs.length, 1);
  const reviewDef = taskDefs[0]!;
  assert.strictEqual(reviewDef.taskName, 'Review');
  assert.strictEqual(reviewDef.totalCount, 2);
  assert.strictEqual(reviewDef.completedCount, 1);
  assert.strictEqual(reviewDef.openCount, 1);
  assert.ok(reviewDef.tat.avgMs > 0);
  assert.strictEqual(reviewDef.byAssignee[0]?.user, 'carol');
  assert.strictEqual(reviewDef.byGroup[0]?.group, 'ops');

  // 5. Process definitions analytics
  const procDefs = await q.processDefinitionsAnalytics();
  assert.ok(procDefs.length >= 1);
  const pDef = procDefs.find((p) => p.processId === procId);
  assert.ok(pDef);
  assert.strictEqual(pDef.instances.total, 2);
  assert.strictEqual(pDef.instances.completed, 1);
  assert.strictEqual(pDef.totalTasks, 2);
  assert.strictEqual(pDef.tasksCompleted, 1);
});
