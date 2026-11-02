// Automatic task assignment is done by the allocator runner (modules/allocation), never inline: rules per project / task, skills, limits, availability, the tracker,
// and how it behaves around swimlane auto-claim, "suspend until", deadlines and release.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { kit } from './flow-kit.ts';
import { AllocationService, resetRuleCache } from '../src/modules/allocation/service.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import { Collections, type User, type Task, type Role } from '../src/domain.ts';

after(() => setTimeout(() => process.exit(0), 50).unref());

const people = async (k: ReturnType<typeof kit>, group: string, spec: Record<string, Partial<User>>) => {
  for (const [name, extra] of Object.entries(spec)) await k.store.repo<User>(Collections.users).put({ id: name, tenantId: 't1', username: name, passwordHash: 'x', roles: [], groups: [group], active: true, createdAt: '2025-01-01T00:00:00.000Z', ...extra } as User);
};
const proc = (k: ReturnType<typeof kit>, name: string, task: Record<string, unknown>) =>
  k.deploy(name, [{ id: 's', type: 'start' }, { id: 'u', type: 'userTask', name: `Review ${name}`, ...task }, { id: 'e', type: 'end' }], [{ id: 'f0', from: 's', to: 'u' }, { id: 'f1', from: 'u', to: 'e' }]);
const run = (k: ReturnType<typeof kit>) => new AllocationService(k.ctx).runOnce(200, { force: true });
const who = async (k: ReturnType<typeof kit>, instId: string) => (await k.tasks(instId))[0]!;
const rule = (k: ReturnType<typeof kit>, r: Record<string, unknown>) => { resetRuleCache(); return new AllocationService(k.ctx).createRule({ name: 'r', ...r } as any, 'admin'); };

test('ALLOC-1 creating a task never assigns inline: it is flagged and the allocator runner assigns it by the rule', async () => {
  const k = kit(); resetRuleCache();
  await people(k, 'claims', { amy: {}, bob: {}, cat: {} });
  const w = await proc(k, 'a1', { group: 'claims' });
  await rule(k, { scope: { group: 'claims' }, strategy: 'roundRobin' });
  const i = await k.start(w.wf.id);
  const before = await who(k, i.id);
  assert.strictEqual(before.assignee, undefined); assert.strictEqual(before.allocation, 'pending');
  assert.deepStrictEqual(await run(k), { assigned: 1, queued: 0, more: false });
  const after1 = await who(k, i.id);
  assert.strictEqual(after1.assignee, 'amy'); assert.strictEqual(after1.status, 'reserved'); assert.strictEqual(after1.allocation, 'assigned');
});

test('ALLOC-2 a task nothing applies to, a named assignee and a swimlane auto-claim are left exactly as they are', async () => {
  const k = kit(); resetRuleCache();
  await people(k, 'g', { amy: {}, bob: {} });
  const plain = await proc(k, 'plain', { group: 'g' });
  const i = await k.start(plain.wf.id);
  assert.strictEqual((await who(k, i.id)).allocation, undefined, 'no rule, no strategy: not subject to allocation');
  await rule(k, { scope: { group: 'g' }, strategy: 'leastLoaded' });
  const lane = await k.deploy('lane', [{ id: 's', type: 'start' }, { id: 'u1', type: 'userTask', name: 'One', group: 'g', swimlane: 'L' }, { id: 'u2', type: 'userTask', name: 'Two', group: 'g', swimlane: 'L', autoClaim: true }, { id: 'e', type: 'end' }],
    [{ id: 'f0', from: 's', to: 'u1' }, { id: 'f1', from: 'u1', to: 'u2' }, { id: 'f2', from: 'u2', to: 'e' }]);
  const li = await k.start(lane.wf.id); await run(k);
  const svc = new TaskService(k.ctx); const t1 = (await k.tasks(li.id))[0]!;
  const first = (await who(k, li.id)).assignee!;                                    // step 1 was given to someone by the rule
  assert.ok(first);
  await svc.complete(t1.id, {}, first); await run(k);
  const t2 = (await k.tasks(li.id)).find((t) => t.name === 'Two')!;
  assert.strictEqual(t2.assignee, first, 'the swimlane auto-claim sends step 2 to whoever did step 1, whatever the rule would pick');
  assert.strictEqual(t2.allocation, undefined);
});

test('ALLOC-3 skills: only people with every required skill are considered; with nobody the task waits in the group queue and is assigned once someone qualifies', async () => {
  const k = kit(); resetRuleCache();
  await people(k, 'uw', { amy: { skills: ['life'] }, bob: { skills: ['life', 'motor'] }, cat: {} });
  const w = await proc(k, 'skill', { group: 'uw', requiredSkills: ['motor'] });
  const i1 = await k.start(w.wf.id); await run(k);
  assert.strictEqual((await who(k, i1.id)).assignee, 'bob');
  const w2 = await proc(k, 'skill2', { group: 'uw', requiredSkills: ['marine'] });
  const i2 = await k.start(w2.wf.id); await run(k);
  const t = await who(k, i2.id);
  assert.strictEqual(t.assignee, undefined); assert.strictEqual(t.allocation, 'queued'); assert.match(t.allocationNote!, /skills marine/);
  await k.store.repo<User>(Collections.users).put({ ...(await k.store.repo<User>(Collections.users).get('cat'))!, skills: ['marine'] });
  await run(k);
  assert.strictEqual((await who(k, i2.id)).assignee, 'cat', 'picked up on a later pass');
});

test('ALLOC-4 limits: max open tasks and max tasks per day are respected, and a person who is away is skipped; everyone full = queued', async () => {
  const k = kit(); resetRuleCache();
  await people(k, 'g', { amy: { maxOpenTasks: 1 }, bob: { maxTasksPerDay: 2 }, cat: { available: false } });
  await rule(k, { scope: { group: 'g' }, strategy: 'leastLoaded' });
  const w = await proc(k, 'lim', { group: 'g' });
  const ids: string[] = []; for (let n = 0; n < 5; n++) ids.push((await k.start(w.wf.id)).id);
  await run(k);
  const owners = await Promise.all(ids.map(async (id) => (await who(k, id)).assignee ?? 'queued'));
  assert.deepStrictEqual(owners.filter((o) => o === 'amy').length, 1, 'amy: one open task at most');
  assert.deepStrictEqual(owners.filter((o) => o === 'bob').length, 2, 'bob: two a day at most');
  assert.ok(!owners.includes('cat'), 'cat is away');
  assert.deepStrictEqual(owners.filter((o) => o === 'queued').length, 2, 'nobody left with capacity: waits in the queue');
  const tr = await new AllocationService(k.ctx).tracker();
  assert.deepStrictEqual(tr.waiting, { pending: 0, queued: 2 });
  assert.deepStrictEqual(tr.people.map((p) => [p.username, p.open, p.assignedToday, p.available]), [['amy', 1, 1, true], ['bob', 2, 2, true], ['cat', 0, 0, false]]);
});

test('ALLOC-5 rules: the node beats the project beats a general rule; a node-level strategy beats every rule; priority orders equals', async () => {
  const k = kit(); resetRuleCache();
  await people(k, 'g', { amy: { skills: ['a'] }, bob: { skills: ['b'] }, cat: {} });
  const w = await proc(k, 'prec', { group: 'g' });
  await rule(k, { name: 'general', scope: { group: 'g' }, strategy: 'skills', requiredSkills: ['a'] });
  await rule(k, { name: 'this task', scope: { workflowId: w.wf.id, nodeId: 'u' }, strategy: 'skills', requiredSkills: ['b'] });
  const i = await k.start(w.wf.id); await run(k);
  assert.strictEqual((await who(k, i.id)).assignee, 'bob', 'the node-specific rule applied, not the general one');
  const nodeLevel = await proc(k, 'nodelevel', { group: 'g', assignmentStrategy: 'roundRobin' });
  const j = await k.start(nodeLevel.wf.id); await run(k);
  assert.ok((await who(k, j.id)).allocationNote!.startsWith('roundRobin'), 'a strategy set on the task itself wins');
});

test('ALLOC-6 "suspend until": a hidden task is not assigned early, and is assigned once it resumes', async () => {
  const k = kit(); resetRuleCache();
  await people(k, 'g', { amy: {} });
  await rule(k, { scope: { group: 'g' }, strategy: 'leastLoaded' });
  const w = await proc(k, 'susp', { group: 'g', suspendUntil: 'PT1H' });
  const i = await k.start(w.wf.id);
  assert.strictEqual((await who(k, i.id)).status, 'suspended');
  await run(k);
  assert.strictEqual((await who(k, i.id)).assignee, undefined, 'still hidden, still unassigned');
  await k.tick(2 * 3600);                                                          // the resume job fires
  assert.strictEqual((await who(k, i.id)).status, 'created');
  await run(k);
  const t = await who(k, i.id);
  assert.strictEqual(t.assignee, 'amy'); assert.strictEqual(t.status, 'reserved');
});

test('ALLOC-7 a reassign deadline is an explicit decision the allocator does not undo, and a released task is not handed straight back', async () => {
  const k = kit(); resetRuleCache();
  await people(k, 'g', { amy: {}, bob: {}, dee: {} });
  await rule(k, { scope: { group: 'g' }, strategy: 'leastLoaded' });
  const w = await proc(k, 'dl', { group: 'g' });
  const i = await k.start(w.wf.id);
  const tasks = new TaskService(k.ctx);
  const t0 = await who(k, i.id); assert.strictEqual(t0.allocation, 'pending');
  await tasks.fireDeadline({ id: 'j', tenantId: 't1', instanceId: i.id, tokenId: '', nodeId: 'u', kind: 'deadline', dueAt: '', fired: 0, taskId: t0.id, deadline: { type: 'notStartedReassign', action: { users: 'dee' } } } as any);
  await run(k);
  const t1 = await who(k, i.id);
  assert.strictEqual(t1.assignee, 'dee'); assert.strictEqual(t1.allocation, undefined);
  const w2 = await proc(k, 'rel', { group: 'g' });
  const j = await k.start(w2.wf.id); await run(k);
  const given = await who(k, j.id); assert.ok(given.assignee);
  await tasks.release(given.id, given.assignee!); await run(k);
  const back = await who(k, j.id);
  assert.strictEqual(back.assignee, undefined, 'released: back in the queue, not instantly reassigned'); assert.strictEqual(back.status, 'created');
});

test('ALLOC-8 many tasks created at the same moment are spread evenly by one pass (no replica race: the runner holds one lease per workspace)', async () => {
  const k = kit('t1', { copies: true }); resetRuleCache();
  await people(k, 'g', { ann: {}, bob: {}, cy: {} });
  await rule(k, { scope: { group: 'g' }, strategy: 'leastLoaded' });
  const w = await proc(k, 'burst', { group: 'g' });
  await Promise.all(Array.from({ length: 9 }, () => k.start(w.wf.id)));
  await run(k);
  const per = new Map<string, number>(); for (const t of await k.tasks()) per.set(String(t.assignee), (per.get(String(t.assignee)) || 0) + 1);
  assert.deepStrictEqual([...per.values()].sort(), [3, 3, 3], JSON.stringify([...per]));
});

test('ALLOC-9 rule validation, and the user fields (skills, limits, availability) are validated and stored', async () => {
  const k = kit(); resetRuleCache();
  const svc = new AllocationService(k.ctx);
  await assert.rejects(svc.createRule({ name: '' } as any, 'a'), /name/);
  await assert.rejects(svc.createRule({ name: 'x', strategy: 'magic' } as any, 'a'), /strategy/);
  await assert.rejects(svc.createRule({ name: 'x', strategy: 'skills' } as any, 'a'), /skill/);
  const r = await svc.createRule({ name: 'ok', strategy: 'leastLoaded', scope: { group: 'g' } }, 'a');
  assert.strictEqual((await svc.listRules()).length, 1);
  await svc.updateRule(r.id, { enabled: false }, 'a'); assert.strictEqual((await svc.updateRule(r.id, {}, 'a')).enabled, false);
  await svc.deleteRule(r.id, 'a'); assert.strictEqual((await svc.listRules()).length, 0);
  const { IamService } = await import('../src/modules/iam/service.ts');
  const iam = new IamService(k.ctx);
  const u = await iam.createUser({ username: 'sam', password: 'Str0ng-pass-123!' }, 'admin');
  const up = await iam.updateUser(u.id, { skills: [' motor ', 'life', 'life'], maxOpenTasks: 5, maxTasksPerDay: 20, available: false } as any, 'admin');
  assert.deepStrictEqual([up.skills, up.maxOpenTasks, up.maxTasksPerDay, up.available], [['motor', 'life'], 5, 20, false]);
  await assert.rejects(iam.updateUser(u.id, { maxOpenTasks: -1 } as any, 'admin'), /whole number/);
  assert.strictEqual((await iam.updateUser(u.id, { maxOpenTasks: null } as any, 'admin')).maxOpenTasks, undefined, 'empty = no limit');
});

test('ALLOC-10 a disabled account NAMED on the task, an away person, a timed absence and someone who cannot work tasks are never picked', async () => {
  const k = kit(); resetRuleCache();
  await people(k, 'g', { amy: { active: false }, bob: { available: false }, cat: { awayUntil: '2999-01-01T00:00:00.000Z' }, dee: {} });
  await rule(k, { scope: { group: 'g' }, strategy: 'leastLoaded' });
  const w = await proc(k, 'elig', { group: 'g', actors: ['amy', 'bob', 'cat', 'dee'] });
  const ids: string[] = []; for (let n = 0; n < 3; n++) ids.push((await k.start(w.wf.id)).id);
  await run(k);
  assert.deepStrictEqual((await Promise.all(ids.map(async (id) => (await who(k, id)).assignee))), ['dee', 'dee', 'dee'], 'only the one available, enabled person');
  // nobody left: waits, with the reason
  await k.store.repo<User>(Collections.users).put({ ...(await k.store.repo<User>(Collections.users).get('dee'))!, active: false });
  const j = await k.start(w.wf.id); await run(k);
  const t = await who(k, j.id); assert.strictEqual(t.assignee, undefined); assert.match(t.allocationNote!, /disabled|away/);
  // the permission to work tasks: judged once the workspace has roles
  const k2 = kit(); resetRuleCache();
  await k2.store.repo<Role>(Collections.roles).put({ id: 'r1', tenantId: 't1', name: 'worker', permissions: ['task:manage'] } as Role);
  await k2.store.repo<Role>(Collections.roles).put({ id: 'r2', tenantId: 't1', name: 'viewer', permissions: ['workflow:view'] } as Role);
  await people(k2, 'g', { vic: { roles: ['viewer'] }, wil: { roles: ['worker'] } });
  await rule(k2, { scope: { group: 'g' }, strategy: 'leastLoaded' });
  const w2 = await proc(k2, 'perm', { group: 'g' });
  const i2 = await k2.start(w2.wf.id); await run(k2);
  assert.strictEqual((await who(k2, i2.id)).assignee, 'wil', 'a viewer cannot work tasks, so is not given one');
});

test('ALLOC-11 a person marks themselves away: no new tasks, their unstarted ones go back to the pool and to someone else; back = eligible again; a timed absence ends by itself', async () => {
  const k = kit(); resetRuleCache();
  await people(k, 'g', { amy: {}, bob: {} });
  await rule(k, { scope: { group: 'g' }, strategy: 'leastLoaded' });
  const w = await proc(k, 'away', { group: 'g' });
  const a = await k.start(w.wf.id), b = await k.start(w.wf.id); await run(k);
  assert.deepStrictEqual([(await who(k, a.id)).assignee, (await who(k, b.id)).assignee].sort(), ['amy', 'bob']);
  const svc = new AllocationService(k.ctx);
  const started = await who(k, b.id); const mine = started.assignee === 'amy' ? b : a;           // the instance whose task amy holds
  const res = await svc.setAvailability('amy', { available: false }, 'amy');
  assert.deepStrictEqual([res.available, res.released], [false, 1]);
  assert.strictEqual((await who(k, mine.id)).allocation, 'pending');
  await run(k);
  assert.strictEqual((await who(k, mine.id)).assignee, 'bob', 'given to the person who is there');
  const c = await k.start(w.wf.id); await run(k);
  assert.strictEqual((await who(k, c.id)).assignee, 'bob', 'amy gets nothing new while away');
  await svc.setAvailability('amy', { available: true }, 'amy');
  const d = await k.start(w.wf.id); await run(k);
  assert.strictEqual((await who(k, d.id)).assignee, 'amy', 'back: the least loaded again');
  // keepTasks leaves their work alone; an absence in the past is refused; a timed one needs no switching back
  const r2 = await svc.setAvailability('bob', { available: false, keepTasks: true }, 'bob'); assert.strictEqual(r2.released, 0);
  await assert.rejects(svc.setAvailability('bob', { available: false, awayUntil: '2000-01-01T00:00:00.000Z' }, 'bob'), /future/);
  const r3 = await svc.setAvailability('bob', { available: false, awayUntil: '2999-01-01T00:00:00.000Z' }, 'bob'); assert.strictEqual(r3.available, false); assert.ok(r3.awayUntil);
  await assert.rejects(svc.setAvailability('nobody', { available: false }, 'x'), /not found|User/i);
});

test('ALLOC-12 disabling an account returns the tasks it had not started', async () => {
  const k = kit(); resetRuleCache();
  const { IamService } = await import('../src/modules/iam/service.ts');
  const iam = new IamService(k.ctx);
  const u = await iam.createUser({ username: 'sam', password: 'Str0ng-pass-123!', groups: [] }, 'admin');
  await k.store.repo<User>(Collections.users).put({ ...(await k.store.repo<User>(Collections.users).get(u.id))!, groups: ['g'] });
  await people(k, 'g', { tim: {} });
  await rule(k, { scope: { group: 'g' }, strategy: 'roundRobin' });
  const w = await proc(k, 'dis', { group: 'g' });
  const i = await k.start(w.wf.id); await run(k);
  const first = (await who(k, i.id)).assignee!;
  if (first === 'sam') {
    await iam.updateUser(u.id, { active: false }, 'admin');
    assert.strictEqual((await who(k, i.id)).allocation, 'pending');
    await run(k); assert.strictEqual((await who(k, i.id)).assignee, 'tim');
  } else {
    const i2 = await k.start(w.wf.id); await run(k);
    assert.strictEqual((await who(k, i2.id)).assignee, 'sam');
    await iam.updateUser(u.id, { active: false }, 'admin');
    assert.strictEqual((await who(k, i2.id)).allocation, 'pending');
    await run(k); assert.strictEqual((await who(k, i2.id)).assignee, 'tim');
  }
});

test('ALLOC-13 a task nobody could take is retried after a pause, not on every pass (a pass over queued tasks must stay cheap); "run now" retries at once', async () => {
  const k = kit(); resetRuleCache();
  await people(k, 'g', { amy: { available: false } });
  await rule(k, { scope: { group: 'g' }, strategy: 'leastLoaded' });
  const w = await proc(k, 'backoff', { group: 'g' });
  const i = await k.start(w.wf.id);
  const svc = new AllocationService(k.ctx);
  assert.deepStrictEqual(await svc.runOnce(), { assigned: 0, queued: 1, more: false }, 'first look: queued');
  await k.store.repo<User>(Collections.users).put({ ...(await k.store.repo<User>(Collections.users).get('amy'))!, available: true });
  assert.deepStrictEqual(await svc.runOnce(), { assigned: 0, queued: 0, more: false }, 'a moment later it is not even looked at');
  assert.strictEqual((await who(k, i.id)).assignee, undefined);
  assert.deepStrictEqual(await svc.runOnce(200, { force: true }), { assigned: 1, queued: 0, more: false }, 'run now (or the retry interval passing) picks it up');
  assert.strictEqual((await who(k, i.id)).assignee, 'amy');
});

test('ALLOC-14 a backlog is worked in bounded batches, and two runners working at once never decide the same task', async () => {
  const k = kit(); resetRuleCache();
  await people(k, 'g', { amy: {}, bob: {}, cat: {}, dan: {} });
  await rule(k, { scope: { group: 'g' }, strategy: 'leastLoaded' });
  const w = await proc(k, 'burst', { group: 'g' });
  const ids: string[] = [];
  for (let n = 0; n < 40; n++) ids.push((await k.start(w.wf.id)).id);
  const a = new AllocationService(k.ctx), b = new AllocationService(k.ctx);
  const first = await a.runOnce(10);
  assert.deepStrictEqual(first, { assigned: 10, queued: 0, more: true }, 'a pass takes at most the batch size and says there is more');
  // two runners (as if two replicas lost the workspace lease at the same time) race over the rest, in batches of 10
  const rounds = await Promise.all([a.runOnce(10), b.runOnce(10), a.runOnce(10), b.runOnce(10)]);
  assert.ok(rounds.every((r) => r.assigned <= 10));
  for (let n = 0; n < 5; n++) await a.runOnce(10);
  const all = (await k.store.repo<Task>(Collections.tasks).query((t) => t.tenantId === 't1'));
  assert.strictEqual(all.length, 40);
  assert.ok(all.every((t) => t.assignee && t.allocation === 'assigned'), 'every task assigned exactly once');
  const per = new Map<string, number>(); for (const t of all) per.set(t.assignee!, (per.get(t.assignee!) ?? 0) + 1);
  assert.deepStrictEqual([...per.values()].sort(), [10, 10, 10, 10], 'and spread evenly, whichever runner decided');
});
