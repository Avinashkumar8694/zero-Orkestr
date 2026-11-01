// Release 2.0.0 phase 3: event sub-processes, ad-hoc scopes, transaction cancel, instantiating gateways, multi-instance on any task,
// complex joins, assignment strategies and swimlanes.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { kit } from './flow-kit.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import { InstanceService } from '../src/modules/instances/service.ts';
import { validateProcess } from '../src/modules/validation/rules.ts';
import { Collections, type Group, type TimerJob, type User } from '../src/domain.ts';

const sc = (code: string, id = 'sc', extra: Record<string, unknown> = {}) => ({ id, type: 'script', lang: 'js', code, ...extra });
const V = [{ name: 'x', type: 'Number' }, { name: 'out', type: 'String' }, { name: 'n', type: 'Number' }, { name: 'items', type: 'Object' }, { name: 'results', type: 'Object' }, { name: 'r', type: 'Number' }, { name: 'item', type: 'Number' }];
const L = (k: ReturnType<typeof kit>, ...mid: any[]) => Object.values(k.line(...mid)) as [any[], any[]];
const body = (code: string, extra: Record<string, unknown> = {}) => ({ nodes: [{ id: 'es', type: 'start' }, sc(code, 'eb'), { id: 'ee', type: 'end' }], flows: [{ id: 'ef1', from: 'es', to: 'eb' }, { id: 'ef2', from: 'eb', to: 'ee' }], ...extra });
const eventSub = (on: Record<string, unknown>, code: string, extra: Record<string, unknown> = {}) => ({ id: 'ev', type: 'subprocess', name: 'On event', on, ...body(code), ...extra });
const mainWithTask = (extra: any[]) => ({ nodes: [{ id: 's', type: 'start' }, { id: 'u', type: 'userTask', name: 'Main work', group: 'g' }, { id: 'e', type: 'end' }, ...extra], flows: [{ id: 'f0', from: 's', to: 'u' }, { id: 'f1', from: 'u', to: 'e' }] });
const broadcast = (k: ReturnType<typeof kit>, name: string) => new InstanceService(k.ctx).broadcast(name, undefined, 'amy');
const timers = (k: ReturnType<typeof kit>) => k.store.repo<TimerJob>(Collections.timers).query(() => true);

// ---------------------------------------------------------------------------------------------------------------- G27 / G28
test('G27/G28 event sub-process, non-interrupting: runs beside the main flow, can fire again, never keeps the instance alive', async () => {
  const k = kit();
  const m = mainWithTask([eventSub({ signal: 'ALERT' }, 'vars.n = (vars.n || 0) + 1;', { interrupting: false })]);
  const w = await k.deploy('evnon', m.nodes, m.flows, V);
  const i = await k.start(w.wf.id);
  assert.strictEqual(i.status, 'waiting');
  await broadcast(k, 'ALERT'); await broadcast(k, 'ALERT');
  const mid = await k.get(i.id);
  assert.strictEqual(mid.variables.n, 2, 'it fired for each signal'); assert.strictEqual(mid.status, 'waiting', 'the main flow is untouched');
  assert.strictEqual((await k.tasks(i.id))[0]!.status, 'created', 'the main task is still open');
  await k.completeTask((await k.tasks(i.id))[0]!.id);
  const done = await k.get(i.id);
  assert.strictEqual(done.status, 'completed', 'the listener did not keep it alive'); assert.deepStrictEqual(done.tokens, []);
});

test('G27/G28 event sub-process, interrupting (the default): stops the main flow, runs its body, ends the instance', async () => {
  const k = kit();
  const m = mainWithTask([eventSub({ signal: 'STOP' }, 'vars.out = "handled";')]);
  const w = await k.deploy('evint', m.nodes, m.flows, V);
  const i = await k.start(w.wf.id);
  await broadcast(k, 'STOP');
  const done = await k.get(i.id);
  assert.strictEqual(done.status, 'completed'); assert.strictEqual(done.variables.out, 'handled');
  assert.deepStrictEqual((await k.tasks(i.id)).map((t) => t.status), ['exited'], 'the interrupted task was closed');
  assert.ok(!done.history.some((h) => h.nodeId === 'e'), 'the main flow never reached its end');
});

test('G27 event sub-process by timer: fires at its time; listeners are cancelled when the main flow finishes first', async () => {
  const k = kit();
  const m = mainWithTask([eventSub({ timer: { duration: 'PT1H' } }, 'vars.out = "timeout";')]);
  const w = await k.deploy('evtimer', m.nodes, m.flows, V);
  const i = await k.start(w.wf.id);
  assert.strictEqual((await timers(k)).filter((t) => t.status === 'scheduled').length, 1, 'one durable timer job for the listener');
  await k.tick(2 * 3600);
  assert.strictEqual((await k.get(i.id)).variables.out, 'timeout'); assert.strictEqual((await k.get(i.id)).status, 'completed');
  const j = await k.start(w.wf.id);                       // main flow finishes first
  await k.completeTask((await k.tasks(j.id))[0]!.id);
  assert.strictEqual((await k.get(j.id)).status, 'completed');
  assert.ok((await timers(k)).filter((t) => t.instanceId === j.id).every((t) => t.status !== 'scheduled'), 'the timer was cancelled with the scope');
  await k.tick(5 * 3600); assert.ok(!(await k.get(j.id)).variables.out, 'and never fired');
});

test('G27 event sub-process by condition fires once; and one whose body waits keeps the parent waiting until it finishes', async () => {
  const k = kit();
  const m = mainWithTask([eventSub({ condition: 'x > 5' }, 'vars.n = (vars.n || 0) + 1;', { interrupting: false })]);
  const w = await k.deploy('evcond', m.nodes, m.flows, V);
  const i = await k.start(w.wf.id, { x: 1 });
  await new InstanceService(k.ctx).updateVariables(i.id, { x: 9 }, 'amy');
  assert.strictEqual((await k.get(i.id)).variables.n, 1);
  await new InstanceService(k.ctx).updateVariables(i.id, { x: 10 }, 'amy');
  assert.strictEqual((await k.get(i.id)).variables.n, 1, 'a condition is an edge: it fires once');
  // a body with its own user task
  const slow = { id: 'ev', type: 'subprocess', name: 'Slow handler', on: { signal: 'HELP' }, interrupting: false, nodes: [{ id: 'es', type: 'start' }, { id: 'eu', type: 'userTask', name: 'Handle it', group: 'h' }, sc('vars.out = "helped";', 'eb'), { id: 'ee', type: 'end' }], flows: [{ id: 'a', from: 'es', to: 'eu' }, { id: 'b', from: 'eu', to: 'eb' }, { id: 'c', from: 'eb', to: 'ee' }] };
  const m2 = mainWithTask([slow]);
  const w2 = await k.deploy('evslow', m2.nodes, m2.flows, V);
  const j = await k.start(w2.wf.id);
  await broadcast(k, 'HELP');
  const handler = (await k.tasks()).find((t) => t.name === 'Handle it')!;          // the body runs as a nested instance, so its task belongs to that instance
  assert.ok(handler, 'the handler body created its task');
  await k.completeTask(handler.id);
  assert.strictEqual((await k.get(j.id)).variables.out, 'helped', 'the body finished and its variables merged back');
  assert.strictEqual((await k.get(j.id)).status, 'waiting', 'the main task is still open');
});

test('G27 aborting an instance removes its event listeners and their timers; the error-handling event sub-process still works', async () => {
  const k = kit();
  const m = mainWithTask([eventSub({ timer: { duration: 'PT1H' } }, 'vars.out = "late";')]);
  const w = await k.deploy('evabort', m.nodes, m.flows, V);
  const i = await k.start(w.wf.id);
  await new InstanceService(k.ctx).abort(i.id, 'amy');
  assert.ok((await timers(k)).every((t) => t.status !== 'scheduled'));
  await k.tick(3 * 3600); assert.strictEqual((await k.get(i.id)).status, 'aborted');
  const { validateProcess: v } = await import('../src/modules/validation/rules.ts');
  const problems = (await v({ id: 'p', name: 'p', package: 'x', vars: [], ...mainWithTask([eventSub({ signal: 'S' }, 'x=1')]) } as any)).problems.filter((p) => p.severity === 'error');
  assert.deepStrictEqual(problems, [], 'an unconnected event sub-process is valid');
  const bad = (await v({ id: 'p', name: 'p', package: 'x', vars: [], ...mainWithTask([{ id: 'ev', type: 'subprocess', name: 'No trigger', on: {}, ...body('x=1') }]) } as any)).problems.map((p) => p.message);
  assert.ok(bad.some((x) => /has no trigger/.test(x)));
});

// ---------------------------------------------------------------------------------------------------------------- G29
test('G29 ad-hoc sub-process: autoStart steps begin, others start on demand, it ends when the completion condition is true', async () => {
  const k = kit();
  const adhoc = { id: 'ah', type: 'subprocess', name: 'Ad-hoc', adHoc: true, completionCondition: 'completed >= 2', nodes: [sc('vars.n = 1;', 'a', { autoStart: true }), { id: 'b', type: 'userTask', name: 'On demand', group: 'g' }], flows: [] };
  const w = await k.deploy('adhoc', [{ id: 's', type: 'start' }, adhoc, sc('vars.out = "after";', 'after'), { id: 'e', type: 'end' }], [{ id: 'f0', from: 's', to: 'ah' }, { id: 'f1', from: 'ah', to: 'after' }, { id: 'f2', from: 'after', to: 'e' }], V);
  const i = await k.start(w.wf.id);
  assert.strictEqual(i.status, 'waiting');
  const child = (await k.instances()).find((x) => x.parentInstanceId === i.id)!;
  assert.strictEqual(child.variables.n, 1, 'the autoStart step ran'); assert.strictEqual(child.status, 'waiting', 'the scope stays open');
  assert.strictEqual((await k.tasks()).length, 0, 'the on-demand step has not started');
  await new InstanceService(k.ctx).retry(child.id, 'b', 'amy');                       // a person starts it
  await k.completeTask((await k.tasks())[0]!.id);
  assert.strictEqual((await k.get(child.id)).status, 'completed', 'two steps finished: the condition holds');
  const done = await k.get(i.id); assert.strictEqual(done.status, 'completed'); assert.strictEqual(done.variables.out, 'after');
});

// ---------------------------------------------------------------------------------------------------------------- G33
test('G33 transaction cancel: the cancel end compensates what completed, aborts the scope, and the parent can catch TRANSACTION_CANCELLED', async () => {
  const k = kit();
  const tx = { id: 'tx', type: 'subprocess', name: 'Payment', transaction: true,
    nodes: [{ id: 'ts', type: 'start' }, sc('vars.reserved = true;', 'a'), { id: 'bc', type: 'boundary', on: 'a', event: { compensation: true } }, sc('vars.undone = true;', 'undo'), { id: 'cancel', type: 'end', result: 'cancel' }, { id: 'tend', type: 'end' }],
    flows: [{ id: 't1', from: 'ts', to: 'a' }, { id: 't2', from: 'a', to: 'cancel' }, { id: 't3', from: 'bc', to: 'undo' }] };
  const w = await k.deploy('txcancel', [{ id: 's', type: 'start' }, tx, { id: 'be', type: 'boundary', on: 'tx', event: { error: '' } }, sc('vars.out = "rolled back";', 'rb'), { id: 'e', type: 'end' }, { id: 'e2', type: 'end' }],
    [{ id: 'f0', from: 's', to: 'tx' }, { id: 'f1', from: 'tx', to: 'e' }, { id: 'f2', from: 'be', to: 'rb' }, { id: 'f3', from: 'rb', to: 'e2' }], V);
  const i = await k.start(w.wf.id);
  assert.strictEqual(i.status, 'completed'); assert.strictEqual(i.variables.out, 'rolled back');
  const child = (await k.instances()).find((x) => x.parentInstanceId === i.id)!;
  assert.strictEqual(child.status, 'aborted'); assert.strictEqual(child.cancelled, true); assert.strictEqual(child.variables.undone, true, 'the compensation handler ran');
  assert.strictEqual((i.variables.errorInfo as any).code, 'TRANSACTION_CANCELLED');
});

// ---------------------------------------------------------------------------------------------------------------- G32
test('G32 instantiating event gateway: the process starts on whichever event arrives, one instance each', async () => {
  const k = kit();
  const w = await k.deploy('instantiate', [{ id: 'gw', type: 'gateway', mode: 'event', instantiate: true }, { id: 'c1', type: 'catch', name: 'Order', event: { signal: 'ORDER' } }, { id: 'c2', type: 'catch', name: 'Cancel', event: { message: 'CANCEL' } },
    sc('vars.out = "order";', 'o'), sc('vars.out = "cancel";', 'x'), { id: 'e1', type: 'end' }, { id: 'e2', type: 'end' }],
    [{ id: 'f1', from: 'gw', to: 'c1' }, { id: 'f2', from: 'gw', to: 'c2' }, { id: 'f3', from: 'c1', to: 'o' }, { id: 'f4', from: 'c2', to: 'x' }, { id: 'f5', from: 'o', to: 'e1' }, { id: 'f6', from: 'x', to: 'e2' }], V);
  void w;
  assert.strictEqual((await k.instances()).length, 0);
  await broadcast(k, 'ORDER'); await broadcast(k, 'CANCEL'); await broadcast(k, 'UNRELATED');
  const all = await k.instances();
  assert.deepStrictEqual(all.map((x) => x.variables.out).sort(), ['cancel', 'order']);
  assert.ok(all.every((x) => x.status === 'completed'));
  assert.ok(all.find((x) => x.variables.out === 'order')!.history.some((h) => h.nodeId === 'c1' && h.outcome === 'triggered'));
});

// ---------------------------------------------------------------------------------------------------------------- G34
test('G34 multi-instance on any task: a user task and a script run once per item; early completion works', async () => {
  const k = kit();
  const mi = (extra: Record<string, unknown>) => ({ over: 'items', as: 'item', collectInto: 'results', itemResult: 'r', ...extra });
  const seq = await k.deploy('misc', ...L(k, sc('vars.r = vars.item * 2;', 'sc', { multiInstance: mi({ parallel: false }) })), V);
  const s = await k.start(seq.wf.id, { items: [1, 2, 3] });
  assert.strictEqual(s.status, 'completed'); assert.deepStrictEqual(s.variables.results, [2, 4, 6]);
  const par = await k.deploy('mipar', ...L(k, sc('vars.r = vars.item + 100;', 'sc', { multiInstance: mi({ parallel: true }) })), V);
  assert.deepStrictEqual((await k.start(par.wf.id, { items: [1, 2] })).variables.results, [101, 102]);
  const ut = await k.deploy('miuser', ...L(k, { id: 'u', type: 'userTask', name: 'Review item', group: 'g', inputs: { who: '$item' }, outputs: { r: 'r' }, multiInstance: mi({ parallel: true }) }, sc('vars.out = "all reviewed";')), V);
  const u = await k.start(ut.wf.id, { items: [10, 20, 30] });
  const open = (await k.tasks()).filter((t) => t.status === 'created');
  assert.strictEqual(open.length, 3); assert.deepStrictEqual(open.map((t) => t.inputs.who).sort(), [10, 20, 30], 'each task got its own item');
  for (const [n, t] of open.entries()) await k.completeTask(t.id, { r: n + 1 });
  const done = await k.get(u.id);
  assert.strictEqual(done.status, 'completed'); assert.strictEqual(done.variables.out, 'all reviewed'); assert.strictEqual((done.variables.results as number[]).length, 3);
  const early = await k.deploy('miearly', ...L(k, { id: 'u', type: 'userTask', name: 'First two', group: 'g', outputs: { r: 'r' }, multiInstance: mi({ parallel: true, completionCondition: 'completed >= 2' }) }), V);
  const e = await k.start(early.wf.id, { items: [1, 2, 3, 4] });
  const mine = (await k.tasks(undefined)).filter((t) => t.name === 'First two' && t.status === 'created');
  await k.completeTask(mine[0]!.id, { r: 1 }); await k.completeTask(mine[1]!.id, { r: 2 });
  assert.strictEqual((await k.get(e.id)).status, 'completed');
  assert.strictEqual((await k.tasks()).filter((t) => t.name === 'First two' && t.status === 'created').length, 0, 'the other two were abandoned');
  const bad = await validateProcess({ id: 'p', name: 'p', package: 'x', vars: [], ...k.line(sc('x=1', 'sc', { multiInstance: {} })) } as any);
  assert.ok(bad.problems.some((p) => /needs "over"/.test(p.message)));
});

// ---------------------------------------------------------------------------------------------------------------- G35
test('G35 complex gateway: the join fires as soon as the activation condition holds, once per round', async () => {
  const k = kit();
  const w = await k.deploy('complex', [{ id: 's', type: 'start' }, { id: 'fork', type: 'gateway', mode: 'parallel' }, sc('vars.x=(vars.x||0)+1', 'a'), sc('vars.x=(vars.x||0)+1', 'b'), sc('vars.x=(vars.x||0)+1', 'c'),
    { id: 'join', type: 'gateway', mode: 'complex', activationCondition: 'arrived >= 2' }, sc('vars.n = (vars.n || 0) + 1;', 'after'), { id: 'e', type: 'end' }],
    [{ id: 'f0', from: 's', to: 'fork' }, { id: 'f1', from: 'fork', to: 'a' }, { id: 'f2', from: 'fork', to: 'b' }, { id: 'f3', from: 'fork', to: 'c' }, { id: 'f4', from: 'a', to: 'join' }, { id: 'f5', from: 'b', to: 'join' }, { id: 'f6', from: 'c', to: 'join' }, { id: 'f7', from: 'join', to: 'after' }, { id: 'f8', from: 'after', to: 'e' }], V);
  const i = await k.start(w.wf.id);
  assert.strictEqual(i.status, 'completed'); assert.strictEqual(i.variables.x, 3, 'all three branches ran');
  assert.strictEqual(i.variables.n, 1, 'the join fired once, on the second arrival; the third was absorbed');
  assert.deepStrictEqual(i.history.filter((h) => h.nodeId === 'join').map((h) => h.outcome), ['complex 1/3', 'complex-fired', 'complex 3/3']);
});

// ---------------------------------------------------------------------------------------------------------------- G30 / G31
test('G30 assignment strategies: leastLoaded and roundRobin pick an owner among the group members, deterministically', async () => {
  const k = kit();
  const users = k.store.repo<User>(Collections.users), groups = k.store.repo<Group>(Collections.groups);
  const team = async (group: string, names: string[]) => { await groups.put({ id: group, tenantId: 't1', name: group } as any); for (const n of names) await users.put({ id: n, tenantId: 't1', username: n, groups: [group], active: true } as any); };
  await team('claims', ['amy', 'bob', 'cat']); await team('claims2', ['dev', 'eli', 'fay']); await team('claims3', ['gus', 'hal', 'ivy']);
  const mk = (name: string, group: string, strategy: string, extra: Record<string, unknown> = {}) => k.deploy(name, ...L(k, { id: 'u', type: 'userTask', name: `T ${name}`, group, assignmentStrategy: strategy, ...extra }), V);
  const owners = async (wfId: string, n: number) => { const out: string[] = []; for (let c = 0; c < n; c++) { const i = await k.start(wfId); out.push((await k.tasks(i.id))[0]!.assignee ?? '-'); } return out; };
  const rr = await mk('rr', 'claims', 'roundRobin');
  assert.deepStrictEqual(await owners(rr.wf.id, 4), ['amy', 'bob', 'cat', 'amy'], 'each member in turn');
  const ll = await mk('ll', 'claims2', 'leastLoaded');
  assert.deepStrictEqual(await owners(ll.wf.id, 4), ['dev', 'eli', 'fay', 'dev'], 'the person with the fewest open tasks (ties alphabetical)');
  const eliTask = (await k.tasks()).find((x) => x.assignee === 'eli' && x.name === 'T ll')!;
  await new TaskService(k.ctx).complete(eliTask.id, {}, 'eli');                // eli is free again: now the least loaded
  assert.strictEqual((await owners(ll.wf.id, 1))[0], 'eli');
  const ex = await mk('ex', 'claims3', 'leastLoaded', { excludedOwners: ['gus', 'hal'] });
  assert.deepStrictEqual(await owners(ex.wf.id, 1), ['ivy'], 'excluded owners are never picked');
  const none = await k.deploy('none', ...L(k, { id: 'u', type: 'userTask', name: 'Nobody', group: 'empty-group', assignmentStrategy: 'leastLoaded' }), V);
  const ni = await k.start(none.wf.id); assert.strictEqual((await k.tasks(ni.id))[0]!.assignee, undefined, 'no candidates: it stays in the queue');
  const plain = await k.deploy('plainq', ...L(k, { id: 'u', type: 'userTask', name: 'Queue', group: 'claims' }), V);
  const pi = await k.start(plain.wf.id); assert.strictEqual((await k.tasks(pi.id))[0]!.assignee, undefined, 'unset: unchanged');
});

test('G31 swimlane auto-claim: the next task of the lane goes to whoever completed the previous one', async () => {
  const k = kit();
  const users = k.store.repo<User>(Collections.users);
  for (const u of ['amy', 'bob']) await users.put({ id: u, tenantId: 't1', username: u, groups: ['g'], active: true } as any);
  const mk = (name: string, second: Record<string, unknown> = {}) => k.deploy(name, ...L(k, { id: 'u1', type: 'userTask', name: 'Step 1', group: 'g', swimlane: 'uw' }, { id: 'u2', type: 'userTask', name: 'Step 2', group: 'g', swimlane: 'uw', autoClaim: true, ...second }), V);
  const w = await mk('lane');
  const i = await k.start(w.wf.id);
  const svc = new TaskService(k.ctx); const t1 = (await k.tasks(i.id))[0]!;
  await svc.claim(t1.id, 'bob'); await svc.complete(t1.id, {}, 'bob');
  const t2 = (await k.tasks(i.id)).find((t) => t.name === 'Step 2')!;
  assert.strictEqual(t2.assignee, 'bob'); assert.strictEqual(t2.status, 'reserved'); assert.strictEqual(t2.swimlane, 'uw');
  const w2 = await mk('lane2', { excludedOwners: ['bob'] });
  const j = await k.start(w2.wf.id); const a1 = (await k.tasks(j.id))[0]!;
  await svc.claim(a1.id, 'bob'); await svc.complete(a1.id, {}, 'bob');
  assert.strictEqual((await k.tasks(j.id)).find((t) => t.name === 'Step 2')!.assignee, undefined, 'an excluded owner is not auto-claimed');
});
after(() => setTimeout(() => process.exit(0), 50).unref());
