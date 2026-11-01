// Release 2.0.0 phase 1: small jBPM property gaps. Each gap: unset => unchanged (the golden test covers that), happy path, edge.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { kit, T0, at } from './flow-kit.ts';
import { WORKITEM_HANDLERS } from '../src/engine/workitems/registry.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import { InstanceService } from '../src/modules/instances/service.ts';
import { Collections, type Group, type User } from '../src/domain.ts';

const sc = (code: string, id = 'sc', extra: Record<string, unknown> = {}) => ({ id, type: 'script', lang: 'js', code, ...extra });
const V = [{ name: 'x', type: 'Number' }, { name: 'out', type: 'String' }, { name: 'n', type: 'Number' }];
const L = (k: ReturnType<typeof kit>, ...mid: any[]) => Object.values(k.line(...mid)) as [any[], any[]];

// ---- G06 flow priority
test('G06 flow priority: the lowest number is tried first; flows without one keep drawn order after prioritised ones', async () => {
  const k = kit();
  const mk = async (name: string, pri: Record<string, number | undefined>) => {
    const w = await k.deploy(name, [{ id: 's', type: 'start' }, { id: 'g', type: 'gateway', mode: 'exclusive' }, sc('vars.out="a"', 'a'), sc('vars.out="b"', 'b'), { id: 'e', type: 'end' }],
      [{ id: 'f0', from: 's', to: 'g' }, { id: 'fa', from: 'g', to: 'a', when: 'true', lang: 'js', priority: pri.a }, { id: 'fb', from: 'g', to: 'b', when: 'true', lang: 'js', priority: pri.b }, { id: 'f1', from: 'a', to: 'e' }, { id: 'f2', from: 'b', to: 'e' }], V);
    return (await k.start(w.wf.id)).variables.out;
  };
  assert.strictEqual(await mk('p0', {}), 'a', 'no priority: drawn order (unchanged)');
  assert.strictEqual(await mk('p1', { a: 5, b: 1 }), 'b', 'b has the lower number, so it wins');
  assert.strictEqual(await mk('p2', { b: 3 }), 'b', 'a prioritised flow beats an unprioritised one');
  assert.strictEqual(await mk('p3', { a: 2, b: 2 }), 'a', 'equal priority keeps drawn order');
});

// ---- G08 variable tags
test('G08 variable tags: required blocks the start; readonly can be set once and never changed', async () => {
  const k = kit();
  const tags = [{ name: 'claimId', type: 'String', tags: ['required'] }, { name: 'lockedAmt', type: 'Number', tags: ['readonly'] }, { name: 'free', type: 'Number' }];
  const ok = await k.deploy('tagsok', ...L(k, sc('vars.free = 1;')), tags);
  await assert.rejects(k.start(ok.wf.id, {}), /required variable missing: claimId/);
  await assert.rejects(k.start(ok.wf.id, { claimId: '' }), /required variable missing/);
  assert.strictEqual((await k.start(ok.wf.id, { claimId: 'C1' })).status, 'completed');
  const first = await k.deploy('rofirst', ...L(k, sc('vars.lockedAmt = 10;')), tags);
  assert.strictEqual((await k.start(first.wf.id, { claimId: 'C1' })).variables.lockedAmt, 10, 'setting it the first time is allowed');
  const again = await k.deploy('roagain', ...L(k, sc('vars.lockedAmt = 99;')), tags);
  const bad = await k.start(again.wf.id, { claimId: 'C1', lockedAmt: 5 });
  assert.strictEqual(bad.status, 'failed'); assert.match(bad.error!.message, /read-only/);
  assert.strictEqual(bad.variables.lockedAmt, 5, 'the change was undone');
  const wait = await k.deploy('rowait', ...L(k, { id: 'u', type: 'userTask', name: 'Wait', group: 'g' }), tags);
  const i = await k.start(wait.wf.id, { claimId: 'C1', lockedAmt: 7 });
  await assert.rejects(new InstanceService(k.ctx).updateVariables(i.id, { lockedAmt: 8 }, 'amy').catch((e) => { throw e; }), /read-only|readonly/);
});

// ---- G09 G10 G12 process-level
test('G09/G10/G12 process SLA, instance description, ad-hoc autostart', async () => {
  const k = kit();
  const base = L(k, { id: 'u', type: 'userTask', name: 'Wait', group: 'g' });
  const w = await k.deploy('procsla', ...base, [{ name: 'claimId', type: 'String' }], { description: 'Claim #{claimId} for #{who.name}', slaDueDate: 'PT1H' });
  const i = await k.start(w.wf.id, { claimId: 'C-9', who: { name: 'Ann' } });
  assert.strictEqual(i.description, 'Claim C-9 for Ann'); assert.strictEqual(i.sla?.status, 'pending');
  await k.tick(2 * 3600);
  const late = await k.get(i.id);
  assert.strictEqual(late.sla?.status, 'violated'); assert.strictEqual(late.status, 'waiting', 'the process carries on');
  const fast = await k.start(w.wf.id, { claimId: 'C-10' });
  await k.completeTask((await k.tasks(fast.id))[0]!.id);
  assert.strictEqual((await k.get(fast.id)).sla?.status, 'met');
  // ad-hoc: an unconnected autoStart node starts with the instance
  const adhoc = await k.deploy('adhoc', [{ id: 's', type: 'start' }, sc('vars.out="main"', 'm'), { id: 'e', type: 'end' }, sc('vars.x = 7;', 'side', { autoStart: true })], [{ id: 'f0', from: 's', to: 'm' }, { id: 'f1', from: 'm', to: 'e' }], V, { adHoc: true });
  assert.strictEqual((await k.start(adhoc.wf.id)).variables.x, 7);
  await assert.rejects(k.deploy('notadhoc', [{ id: 's', type: 'start' }, sc('vars.out="main"', 'm'), { id: 'e', type: 'end' }, sc('vars.x = 7;', 'side', { autoStart: true })], [{ id: 'f0', from: 's', to: 'm' }, { id: 'f1', from: 'm', to: 'e' }], V), /not connected/, 'without the ad-hoc flag an unconnected node is still an error');
});

// ---- G05 / G05b called-process failure policy + by name
test('G05 call: fail (default) | continue | abort when the called process fails; G05b: find the process by name', async () => {
  const k = kit();
  const child = await k.deploy('failing child', ...L(k, sc('throw new Error("child broke")')), V);
  const parent = (name: string, props: Record<string, unknown>) => k.deploy(name, ...L(k, { id: 'c', type: 'call', process: child.processId, ...props }, sc('vars.out="after"')), V);
  const dflt = await k.start((await parent('callfail', {})).wf.id);
  assert.strictEqual(dflt.status, 'failed', 'default unchanged'); assert.match(dflt.error!.message, /called process failed/);
  const cont = await k.start((await parent('callcont', { onChildFailure: 'continue' })).wf.id);
  assert.strictEqual(cont.status, 'completed'); assert.strictEqual(cont.variables.out, 'after');
  assert.strictEqual((cont.variables.callError as any).childStatus, 'failed');
  const named = await k.start((await parent('callcont2', { onChildFailure: 'continue', errorVar: 'why' })).wf.id);
  assert.ok((named.variables.why as any).childInstanceId);
  const abort = await k.start((await parent('callabort', { onChildFailure: 'abort' })).wf.id);
  assert.strictEqual(abort.status, 'aborted'); assert.ok(!abort.variables.out, 'the parent stopped at once');
  // by name instead of id
  const waiting = await k.deploy('named child', ...L(k, { id: 'u', type: 'userTask', name: 'Child', group: 'g' }), V);
  const byName = await k.deploy('callbyname', ...L(k, { id: 'c', type: 'call', process: 'named child' }), V);
  assert.strictEqual((await k.start(byName.wf.id)).status, 'waiting', 'resolved the called process by its name');
  void waiting;
});
test('G05 call: the same policies when the child fails LATER (it was waiting first)', async () => {
  const k = kit();
  const child = await k.deploy('late child', ...L(k, { id: 'u', type: 'userTask', name: 'Child task', group: 'g' }, sc('throw new Error("late")')), V);
  for (const [pol, expect] of [['continue', 'completed'], ['abort', 'aborted'], [undefined, 'failed']] as const) {
    const p = await k.deploy(`late parent ${pol}`, ...L(k, { id: 'c', type: 'call', process: child.processId, ...(pol ? { onChildFailure: pol } : {}) }, sc('vars.out="parent done"')), V);
    const i = await k.start(p.wf.id);
    const t = (await k.tasks()).filter((x) => x.status === 'created').at(-1)!;
    await k.completeTask(t.id).catch(() => undefined);
    assert.strictEqual((await k.get(i.id)).status, expect, String(pol));
  }
});

// ---- G07 multi-instance completion condition
test('G07 for-each completion condition: stop when satisfied and abort the rest (parallel and sequential)', async () => {
  const k = kit();
  const child = await k.deploy('mi child', ...L(k, { id: 'u', type: 'userTask', name: 'MI task', group: 'g' }, sc('vars.r = vars.item * 10;')), [{ name: 'item', type: 'Number' }, { name: 'r', type: 'Number' }]);
  const mk = (name: string, props: Record<string, unknown>) => k.deploy(name, ...L(k, { id: 'f', type: 'forEach', process: child.processId, over: 'items', as: 'item', collectInto: 'results', itemResult: 'r', ...props }, sc('vars.out="done"')), [{ name: 'items', type: 'Object' }, { name: 'results', type: 'Object' }, { name: 'out', type: 'String' }]);
  const par = await mk('mi par', { parallel: true, completionCondition: 'completed >= 2' });
  const i = await k.start(par.wf.id, { items: [1, 2, 3, 4] });
  const open = (await k.tasks(undefined)).filter((t) => t.status === 'created');
  assert.strictEqual(open.length, 4);
  await k.completeTask(open[0]!.id); assert.strictEqual((await k.get(i.id)).status, 'waiting', 'one of two is not enough');
  await k.completeTask(open[1]!.id);
  const done = await k.get(i.id);
  assert.strictEqual(done.status, 'completed'); assert.strictEqual(done.variables.out, 'done');
  assert.deepStrictEqual((done.variables.results as number[]).sort((a, b) => a - b).length, 2, 'results of the two finished items');
  const left = (await k.tasks()).filter((t) => t.instanceId !== undefined && ['created', 'reserved'].includes(t.status));
  assert.strictEqual(left.filter((t) => t.name === 'MI task').length, 0, 'the remaining items were aborted (their tasks are gone)');
  const none = await mk('mi nocond', { parallel: true });
  const j = await k.start(none.wf.id, { items: [1, 2] });
  assert.strictEqual(j.status, 'waiting', 'without a condition it waits for every item (unchanged)');
});

// ---- G14 http auth + content type
test('G14 http: content type and basic / bearer auth built for you; an explicit header still wins', async () => {
  const seen: any[] = [];
  const server = (await import('node:http')).createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { seen.push({ h: req.headers, b }); res.end('{}'); }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/x`;
  const prev = process.env.OUTBOUND_ALLOWLIST; 
  try {
    const k = kit();
    await k.store.repo<any>('settings').put({ id: 'system:t1', tenantId: 't1', outboundAllowlist: '127.0.0.1' });
    const run = async (props: Record<string, unknown>) => { const w = await k.deploy(`h${seen.length}`, ...L(k, { id: 'h', type: 'http', method: 'POST', url, body: { a: 'b' }, ...props }), V); return k.start(w.wf.id, { user: 'ann', pw: 's3cret', tok: 'T0K' }); };
    await run({ authType: 'basic', username: '$user', password: '$pw' });
    assert.strictEqual(seen.at(-1).h.authorization, 'Basic ' + Buffer.from('ann:s3cret').toString('base64'));
    await run({ authType: 'bearer', token: '$tok', contentType: 'application/x-www-form-urlencoded' });
    assert.strictEqual(seen.at(-1).h.authorization, 'Bearer T0K'); assert.match(seen.at(-1).h['content-type'], /form-urlencoded/); assert.strictEqual(seen.at(-1).b, 'a=b');
    await run({ authType: 'bearer', token: '$tok', headers: { Authorization: 'Custom z' } });
    assert.strictEqual(seen.at(-1).h.authorization, 'Custom z', 'explicit header wins');
    await run({});
    assert.strictEqual(seen.at(-1).h.authorization, undefined); assert.match(seen.at(-1).h['content-type'], /json/);
  } finally { server.close(); if (prev === undefined) delete process.env.OUTBOUND_ALLOWLIST; }
});

// ---- G15 async delay
test('G15 async delay: the background run waits for its delay', async () => {
  const k = kit();
  const w = await k.deploy('adel', ...L(k, sc('vars.out="bg"', 'sc', { async: true, asyncDelay: 'PT10M' })), V);
  const i = await k.start(w.wf.id);
  await k.tick(60); assert.strictEqual((await k.get(i.id)).status, 'waiting', 'not before the delay');
  await k.tick(11 * 60); assert.strictEqual((await k.get(i.id)).status, 'completed');
});

// ---- G16 compensation handler validation + G13 metadata
test('G16/G13 a compensation handler is not flagged unreachable; node.metaData is readable from a script', async () => {
  const k = kit();
  const { validateProcess } = await import('../src/modules/validation/rules.ts');
  const proc = (flag: boolean) => ({ id: 'p', name: 'p', package: 'x', vars: [], nodes: [{ id: 's', type: 'start' }, sc('x=1', 'a', { name: 'A' }), { id: 'e', type: 'end' }, sc('x=2', 'undo', { name: 'Undo', ...(flag ? { isForCompensation: true } : {}) })], flows: [{ id: 'f0', from: 's', to: 'a' }, { id: 'f1', from: 'a', to: 'e' }] } as any);
  assert.ok((await validateProcess(proc(false))).problems.some((p) => p.nodeId === 'undo'), 'a floating node is reported');
  assert.ok(!(await validateProcess(proc(true))).problems.some((p) => p.nodeId === 'undo'), 'unless it is a compensation handler');
  const w = await k.deploy('meta', ...L(k, sc('vars.out = node.metaData.team + ":" + node.getMetaData("tier") + ":" + node.getMetaData("nope");', 'sc', { metaData: { team: 'claims', tier: 'gold' } })), V);
  assert.strictEqual((await k.start(w.wf.id)).variables.out, 'claims:gold:null');
});

// ---- G01 G02 G03 user task owners and fields
test('G01-G03 user task: several actors and groups, admin groups, comment / content / locale / createdBy; nobody gains access they did not have', async () => {
  const k = kit();
  const users = k.store.repo<User>(Collections.users), groups = k.store.repo<Group>(Collections.groups);
  const mkUser = (username: string, gs: string[]) => users.put({ id: username, tenantId: 't1', username, groups: gs, active: true } as any);
  await mkUser('amy', ['claims']); await mkUser('bob', ['audit']); await mkUser('cat', ['ops']); await mkUser('dan', []); await mkUser('eve', ['boss']);
  for (const g of ['claims', 'audit', 'ops', 'boss']) await groups.put({ id: g, tenantId: 't1', name: g } as any);
  const w = await k.deploy('owners', ...L(k, { id: 'u', type: 'userTask', name: 'Review', actors: ['dan', 'zed'], groups: ['claims', 'audit'], businessAdminGroups: ['boss'], stakeholders: ['cat'],
    comment: 'Please review #1', content: '$note', locale: 'en-GB', createdBy: 'system-bot' }, sc('vars.out="done"')), [{ name: 'note', type: 'String' }, ...V]);
  const i = await k.start(w.wf.id, { note: 'see attachment' });
  const t = (await k.tasks(i.id))[0]!;
  assert.deepStrictEqual([t.actors, t.groups, t.stakeholders, t.locale, t.createdBy], [['dan', 'zed'], ['claims', 'audit'], ['cat'], 'en-GB', 'system-bot']);
  assert.strictEqual(t.inputs.Content, 'see attachment');
  const comments = await k.store.repo<any>(Collections.comments).query((c: any) => c.taskId === t.id);
  assert.ok(JSON.stringify(comments).includes('Please review #1'));
  const svc = () => new TaskService(k.ctx);
  await assert.rejects(svc().claim(t.id, 'cat'), /not one of this task's actors|not a member/, 'a stakeholder (group ops) cannot claim');
  await assert.rejects(svc().claim(t.id, 'ghost'), /not one of this task's actors/, 'an unregistered stranger cannot claim a task offered to named actors');
  await svc().claim(t.id, 'bob');                        // member of the 2nd listed group
  await svc().release(t.id, 'bob').catch(() => undefined);
  const r = await svc().claim(t.id, 'dan');              // a named actor (in no group)
  assert.strictEqual(r.assignee, 'dan');
  assert.ok((await svc().list({ group: 'audit' })).some((x) => x.id === t.id), 'the inbox for group audit shows it');
  // legacy single-group tasks behave exactly as before
  const legacy = await k.deploy('legacyg', ...L(k, { id: 'u', type: 'userTask', name: 'Old', group: 'claims' }), V);
  const li = await k.start(legacy.wf.id); const lt = (await k.tasks(li.id))[0]!;
  await assert.rejects(svc().claim(lt.id, 'bob'), /not a member of group "claims"/);
  assert.strictEqual((await svc().claim(lt.id, 'amy')).assignee, 'amy');
  assert.strictEqual((await svc().claim((await k.tasks((await k.start(legacy.wf.id)).id))[0]!.id, 'unregistered-actor')).status, 'reserved', 'pre-IAM actor strings keep working on group-only tasks');
});
after(() => setTimeout(() => process.exit(0), 50).unref());
