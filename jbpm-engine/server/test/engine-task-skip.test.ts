// User task `skippable: true` — TaskService.skip() lets the instance continue past the task with no
// output mapped, matching real jBPM's TaskService.skip(). Declared on the type/UI but previously had
// no backing API at all; a task on a non-skippable node must reject the request.
import { test } from 'node:test';
import assert from 'node:assert';
import { MemoryStore } from '../src/store/memory-store.ts';
import { fakeClock } from '../src/infra/ids.ts';
import { makeContext, type AppContext } from '../src/context.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { InstanceService } from '../src/modules/instances/service.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import { IamService } from '../src/modules/iam/service.ts';
import { Collections, type Task } from '../src/domain.ts';

const newCtx = () => { let n = 0; return makeContext({ store: new MemoryStore(), tenantId: 't1', clock: fakeClock().clock, newId: () => `id${++n}` }); };

async function run(ctx: AppContext, userTaskExtra: any) {
  const wf = await new WorkflowService(ctx).create({ name: 'Skip WF' }, 'a');
  const draft = await new VersionService(ctx).saveDraft(wf.defaultBranchId, { id: wf.key, name: wf.name, processes: [{ id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars: [],
    nodes: [{ id: 's', type: 'start' }, { id: 't', type: 'userTask', name: 'Review', group: 'ops', ...userTaskExtra }, { id: 'e', type: 'end' }],
    flows: [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }] }] } as any, 'a');
  const pub = await new VersionService(ctx).publish(draft.id, 'a');
  await new DeploymentService(ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'a');
  return new InstanceService(ctx).start({ workflowId: wf.id, environment: 'prod' }, 'bob');
}

test('a skippable:true task can be skipped — the instance continues with no output mapped', async () => {
  const ctx = newCtx();
  const inst = await run(ctx, { skippable: true });
  const task = (await ctx.store.repo<Task>(Collections.tasks).query((t) => t.instanceId === inst.id))[0]!;

  const skipped = await new TaskService(ctx).skip(task.id, 'carol');
  assert.strictEqual(skipped.status, 'skipped');
  assert.strictEqual(skipped.completedBy, 'carol');

  const done = await new InstanceService(ctx).get(inst.id);
  assert.strictEqual(done.status, 'completed', 'instance continued past the skipped task');
});

test('a task on a node WITHOUT skippable:true rejects skip()', async () => {
  const ctx = newCtx();
  const inst = await run(ctx, {});
  const task = (await ctx.store.repo<Task>(Collections.tasks).query((t) => t.instanceId === inst.id))[0]!;

  await assert.rejects(() => new TaskService(ctx).skip(task.id, 'carol'), /not skippable/);
  assert.strictEqual((await new TaskService(ctx).get(task.id)).status, 'created', 'task untouched');
  assert.strictEqual((await new InstanceService(ctx).get(inst.id)).status, 'waiting', 'instance still waiting');
});

test('an already-completed task cannot be skipped', async () => {
  const ctx = newCtx();
  const inst = await run(ctx, { skippable: true });
  const task = (await ctx.store.repo<Task>(Collections.tasks).query((t) => t.instanceId === inst.id))[0]!;
  await new TaskService(ctx).complete(task.id, {}, 'carol');

  await assert.rejects(() => new TaskService(ctx).skip(task.id, 'dave'), /already completed/);
});

test('dueDate populates Task.dueAt, which drives the overdue filter', async () => {
  const ctx = newCtx();
  const inst = await run(ctx, { dueDate: 'PT1H' });
  const task = (await ctx.store.repo<Task>(Collections.tasks).query((t) => t.instanceId === inst.id))[0]!;
  assert.strictEqual(task.dueAt, new Date(Date.parse(task.createdAt) + 60 * 60 * 1000).toISOString());

  const svc = new TaskService(ctx);
  assert.strictEqual((await svc.list({ overdue: true })).length, 0, 'not due yet');
  // advance the fake clock past the due date, then re-check
  const later = new Date(Date.parse(task.dueAt!) + 1000).toISOString();
  const ctx2 = makeContext({ store: ctx.store, tenantId: 't1', clock: () => later });
  assert.strictEqual((await new TaskService(ctx2).list({ overdue: true })).length, 1, 'now overdue');
  assert.strictEqual((await new TaskService(ctx2).list({ overdue: true }))[0]!.id, task.id);
});

test('excludedOwners blocks claim/complete/skip for that user; businessAdmin overrides it', async () => {
  const ctx = newCtx();
  const inst = await run(ctx, { skippable: true, excludedOwners: ['eve'], businessAdmin: 'admin-al' });
  const task = (await ctx.store.repo<Task>(Collections.tasks).query((t) => t.instanceId === inst.id))[0]!;
  const svc = new TaskService(ctx);

  await assert.rejects(() => svc.claim(task.id, 'eve'), /excluded/);
  await assert.rejects(() => svc.complete(task.id, {}, 'eve'), /excluded/);
  await assert.rejects(() => svc.skip(task.id, 'eve'), /excluded/);
  assert.strictEqual((await svc.get(task.id)).status, 'created', 'eve never touched it');

  // the business admin overrides the exclusion
  const done = await svc.skip(task.id, 'admin-al');
  assert.strictEqual(done.status, 'skipped');
});

test('group membership is enforced ONLY for real registered IAM users — ad-hoc actor strings (e.g. every other test in this suite) are unaffected', async () => {
  const ctx = newCtx();
  const inst = await run(ctx, {});   // group: 'ops', per the run() helper
  const task = (await ctx.store.repo<Task>(Collections.tasks).query((t) => t.instanceId === inst.id))[0]!;
  const svc = new TaskService(ctx);

  // 'random-caller' isn't a registered User at all — falls back to the old permissive behavior
  const claimed = await svc.claim(task.id, 'random-caller');
  assert.strictEqual(claimed.assignee, 'random-caller');
});

test('a registered user NOT in the task\'s group is rejected; a member of the group (or the assignee) succeeds', async () => {
  const ctx = newCtx();
  const iam = new IamService(ctx);
  await iam.createGroup({ name: 'finance' }, 'admin'); await iam.createGroup({ name: 'ops' }, 'admin');
  await iam.createUser({ username: 'outsider', password: 'password123', groups: ['finance'] }, 'admin');
  await iam.createUser({ username: 'ops-carol', password: 'password123', groups: ['ops'] }, 'admin');

  const inst = await run(ctx, {});   // group: 'ops'
  const task = (await ctx.store.repo<Task>(Collections.tasks).query((t) => t.instanceId === inst.id))[0]!;
  const svc = new TaskService(ctx);

  await assert.rejects(() => svc.claim(task.id, 'outsider'), /not a member of group "ops"/);
  const claimed = await svc.claim(task.id, 'ops-carol');
  assert.strictEqual(claimed.assignee, 'ops-carol');

  // now that ops-carol is the assignee, she can complete it even though complete() re-checks group
  // membership (assignee-equals-user short-circuits the group check)
  const done = await svc.complete(task.id, {}, 'ops-carol');
  assert.strictEqual(done.status, 'completed');
});

test('list() sorts by priority (highest first), then newest-first within the same priority', async () => {
  const ctx = newCtx();
  const wf = await new WorkflowService(ctx).create({ name: 'Priority WF' }, 'a');
  const draft = await new VersionService(ctx).saveDraft(wf.defaultBranchId, { id: wf.key, name: wf.name, processes: [{ id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars: [],
    nodes: [
      { id: 's', type: 'start' }, { id: 'g', type: 'gateway', mode: 'parallel' },
      { id: 'low', type: 'userTask', name: 'Low', group: 'ops', priority: 1 },
      { id: 'high', type: 'userTask', name: 'High', group: 'ops', priority: 9 },
      { id: 'none', type: 'userTask', name: 'None', group: 'ops' },
      { id: 'j', type: 'gateway', mode: 'parallel' }, { id: 'e', type: 'end' },
    ],
    flows: [
      { from: 's', to: 'g' }, { from: 'g', to: 'low' }, { from: 'g', to: 'high' }, { from: 'g', to: 'none' },
      { from: 'low', to: 'j' }, { from: 'high', to: 'j' }, { from: 'none', to: 'j' }, { from: 'j', to: 'e' },
    ] }] } as any, 'a');
  const pub = await new VersionService(ctx).publish(draft.id, 'a');
  await new DeploymentService(ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'a');
  await new InstanceService(ctx).start({ workflowId: wf.id, environment: 'prod' }, 'bob');

  const items = await new TaskService(ctx).list({ group: 'ops' });
  assert.deepStrictEqual(items.map((t) => t.name), ['High', 'Low', 'None']);
});
