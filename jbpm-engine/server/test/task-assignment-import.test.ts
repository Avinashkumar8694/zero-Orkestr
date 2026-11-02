// jBPM user mapping survives an import: potentialOwner / ActorId / GroupId become actors and groups, the report lists them and flags unknown names,
// and an actor entry that names a group admits that group's members (jBPM potential owners are users or groups).
import { test, after } from 'node:test';
import assert from 'node:assert';
import { kjarToEngine, buildImportReport } from '../src/modules/import/service.ts';
import { kit } from './flow-kit.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import { Collections } from '../src/domain.ts';

const bpmn = (tasks: string) => ({ 'src/main/resources/p/proc.bpmn': `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:drools="http://www.jboss.org/drools" id="d" targetNamespace="http://www.omg.org/bpmn20">
<bpmn2:process id="proc" drools:packageName="p" name="proc" isExecutable="true">
<bpmn2:startEvent id="s"><bpmn2:outgoing>f0</bpmn2:outgoing></bpmn2:startEvent>
${tasks}
<bpmn2:endEvent id="e"><bpmn2:incoming>f2</bpmn2:incoming></bpmn2:endEvent>
<bpmn2:sequenceFlow id="f0" sourceRef="s" targetRef="u1"/><bpmn2:sequenceFlow id="f1" sourceRef="u1" targetRef="u2"/><bpmn2:sequenceFlow id="f2" sourceRef="u2" targetRef="e"/>
</bpmn2:process></bpmn2:definitions>` });
const human = (id: string, owners: string, extra = '') => `<bpmn2:userTask id="${id}" name="${id}"><bpmn2:incoming>x</bpmn2:incoming><bpmn2:outgoing>y</bpmn2:outgoing>
<bpmn2:ioSpecification><bpmn2:dataInput id="${id}_TaskNameInputX" name="TaskName"/>${extra ? `<bpmn2:dataInput id="${id}_GroupIdInputX" name="GroupId"/>` : ''}<bpmn2:inputSet/><bpmn2:outputSet/></bpmn2:ioSpecification>
<bpmn2:dataInputAssociation><bpmn2:targetRef>${id}_TaskNameInputX</bpmn2:targetRef><bpmn2:assignment><bpmn2:from xsi:type="bpmn2:tFormalExpression"><![CDATA[Task]]></bpmn2:from><bpmn2:to xsi:type="bpmn2:tFormalExpression">${id}_TaskNameInputX</bpmn2:to></bpmn2:assignment></bpmn2:dataInputAssociation>
${extra ? `<bpmn2:dataInputAssociation><bpmn2:targetRef>${id}_GroupIdInputX</bpmn2:targetRef><bpmn2:assignment><bpmn2:from xsi:type="bpmn2:tFormalExpression"><![CDATA[${extra}]]></bpmn2:from><bpmn2:to xsi:type="bpmn2:tFormalExpression">${id}_GroupIdInputX</bpmn2:to></bpmn2:assignment></bpmn2:dataInputAssociation>` : ''}
${owners ? `<bpmn2:potentialOwner><bpmn2:resourceAssignmentExpression><bpmn2:formalExpression>${owners}</bpmn2:formalExpression></bpmn2:resourceAssignmentExpression></bpmn2:potentialOwner>` : ''}</bpmn2:userTask>`;

test('ASSIGN-1 potentialOwner and GroupId import as actors and groups; the report lists them and flags names the workspace does not have', () => {
  const files = bpmn(human('u1', 'krisv, Reviewers') + human('u2', '', 'Approvers'));
  const e = kjarToEngine(files);
  const [u1, u2] = e.processes[0]!.nodes.filter((n: any) => n.type === 'userTask') as any[];
  assert.deepStrictEqual(u1.actors, ['krisv', 'Reviewers']);
  assert.strictEqual(u2.group, 'Approvers');
  const rep = buildImportReport(e, files, { users: new Set(['alice']), groups: new Set(['Reviewers']) });
  assert.ok(rep.items.some((i) => i.code === 'task-assignment' && /krisv, Reviewers/.test(i.message)));
  const unknown = rep.items.filter((i) => i.code === 'task-assignee-unknown').map((i) => i.message).join(' | ');
  assert.ok(/"krisv"/.test(unknown) && /group "Approvers"/.test(unknown) && !/"Reviewers"/.test(unknown), unknown);
});

test('ASSIGN-2 an actor entry that names a group admits members of that group, and still refuses outsiders', async () => {
  const k = kit('t1');
  const w = await k.deploy('assign', [{ id: 's', type: 'start' }, { id: 'u', type: 'userTask', name: 'Review', actors: ['Reviewers'] }, { id: 'e', type: 'end' }], [{ id: 'f0', from: 's', to: 'u' }, { id: 'f1', from: 'u', to: 'e' }]);
  const inst = await k.start(w.wf.id);
  const task = (await k.tasks(inst.id))[0]!;
  const users = k.store.repo<any>(Collections.users);
  for (const [username, groups] of [['member', ['Reviewers']], ['outsider', ['Other']]] as const) await users.put({ id: username, tenantId: 't1', username, passwordHash: 'x', roles: [], groups, active: true, createdAt: new Date().toISOString() });
  const svc = new TaskService(k.ctx);
  await assert.rejects(svc.claim(task.id, 'outsider'), /not one of this task's actors/);
  assert.strictEqual((await svc.claim(task.id, 'member')).assignee, 'member');
});

test('ASSIGN-3 #{variable} in group / actors is filled from the instance variables when the task is created (jBPM GroupId: #{enrollment_review_group})', async () => {
  const k = kit('t1');
  const w = await k.deploy('assign3', [{ id: 's', type: 'start' }, { id: 'u', type: 'userTask', name: 'Review #{ref}', group: '#{reviewGroup}', actors: ['#{owners}', '${boss}'], businessAdminGroups: ['$adminGroup'] }, { id: 'e', type: 'end' }], [{ id: 'f0', from: 's', to: 'u' }, { id: 'f1', from: 'u', to: 'e' }],
    [{ name: 'reviewGroup', type: 'string' }, { name: 'owners', type: 'list' }, { name: 'boss', type: 'string' }, { name: 'adminGroup', type: 'string' }, { name: 'ref', type: 'string' }]);
  const inst = await k.start(w.wf.id, { reviewGroup: 'REVIEWERS', owners: ['amy', 'bob'], boss: 'cat', adminGroup: 'ADMINS', ref: 'ENR-9' });
  const t = (await k.tasks(inst.id))[0]!;
  assert.strictEqual(t.group, 'REVIEWERS');
  assert.deepStrictEqual(t.actors, ['amy', 'bob', 'cat']);
  assert.deepStrictEqual(t.businessAdminGroups, ['ADMINS']);
  assert.strictEqual(t.name, 'Review ENR-9');
});

// ---- auto-provisioning of the users and groups an import refers to ----
import { collectAssignees, provisionAssignees } from '../src/modules/import/assignees.ts';
import { boot } from './harness.ts';

test('ASSIGN-4 collectAssignees: groups from GroupId, users from actors, an actor entry that is also a group counts as the group, placeholders ignored', () => {
  const files = bpmn(human('u1', 'krisv, Reviewers') + human('u2', '', 'Reviewers'));
  const want = collectAssignees(kjarToEngine(files));
  assert.deepStrictEqual(want, { users: ['krisv'], groups: ['Reviewers'] });
  const dyn = collectAssignees({ processes: [{ id: 'p', nodes: [{ id: 'u', type: 'userTask', group: '#{g}', actors: ['${a}', 'real'] }], flows: [] }] } as any);
  assert.deepStrictEqual(dyn, { users: ['real'], groups: [] });
});

test('ASSIGN-5 import creates the missing users (disabled, viewer) and groups, never touches existing ones, and only for callers who may manage users', async () => {
  const h = await boot();
  const ws = await h.workspace('assign-ws', ['admin', 'author']);
  const files = bpmn(human('u1', 'krisv, Reviewers') + human('u2', '', 'Reviewers'));
  // an author (workflow:edit, but not admin:iam) imports: nothing is created, the report says why
  const noPerm = await h.call('POST', '/import/jbpm', { token: ws.tokens.author, tenant: ws.id, body: { files, name: 'a' } });
  assert.strictEqual(noPerm.status, 201);
  assert.ok(noPerm.body.report.items.some((i: any) => i.code === 'assignee-not-created'));
  const listOf = (b: any): any[] => (Array.isArray(b) ? b : b.items ?? b.users ?? b.groups ?? []);
  assert.strictEqual(listOf((await h.call('GET', '/groups', { token: ws.tokens.admin, tenant: ws.id })).body).some((g: any) => g.name === 'Reviewers'), false);
  // an administrator imports: both are created
  const ok = await h.call('POST', '/import/jbpm', { token: ws.tokens.admin, tenant: ws.id, body: { files, name: 'b' } });
  assert.strictEqual(ok.status, 201);
  const codes = ok.body.report.items.map((i: any) => i.code);
  assert.ok(codes.includes('assignee-group-created') && codes.includes('assignee-user-created'), codes.join());
  assert.ok(!codes.includes('task-assignee-unknown'), 'nothing is unknown any more');
  const users = (await h.call('GET', '/users', { token: ws.tokens.admin, tenant: ws.id })).body;
  const krisv = listOf(users).find((u: any) => u.username === 'krisv');
  assert.ok(krisv && krisv.active === false && krisv.roles.every((r: string) => r === 'viewer'), JSON.stringify(krisv));   // disabled, and at most the read-only viewer role (none when the workspace has no such role)
  const groups = (await h.call('GET', '/groups', { token: ws.tokens.admin, tenant: ws.id })).body;
  assert.ok(listOf(groups).some((g: any) => g.name === 'Reviewers'));
  // a second import creates nothing new and leaves the account as the administrator set it
  const again = await h.call('POST', '/import/jbpm', { token: ws.tokens.admin, tenant: ws.id, body: { files, name: 'c' } });
  assert.ok(!again.body.report.items.some((i: any) => /assignee-(user|group)-created/.test(i.code)));
  await h.close();
});
after(() => setTimeout(() => process.exit(0), 50).unref());   // the JVM sidecar / test server would otherwise keep this process alive

test('IMPORT-1 an import that fails to deploy leaves no project behind, so it can simply be retried; the instances list filters by parent and process', async () => {
  const h = await boot();
  const ws = await h.workspace('rollback-ws', ['admin']);
  const bad = { id: 'bad', name: 'bad', processes: [{ id: 'bad.p', name: 'p', package: 'x', vars: [], flows: [{ id: 'f0', from: 's', to: 'j' }, { id: 'f1', from: 'j', to: 'e' }],
    nodes: [{ id: 's', type: 'start' }, { id: 'j', type: 'script', name: 'j', lang: 'java', code: 'int x = ;' }, { id: 'e', type: 'end' }] }] };
  const call = (m: string, p: string, body?: unknown) => h.call(m, p, { token: ws.tokens.admin, tenant: ws.id, body });
  const r1 = await call('POST', '/import/jbpm/deploy', { files: bad, name: 'rollback project', environment: 'prod' });
  assert.strictEqual(r1.status, 422);
  const names = ((await call('GET', '/workflows')).body.items as any[]).map((w) => w.name);
  assert.ok(!names.includes('rollback project'), 'no empty project left behind');
  const good = JSON.parse(JSON.stringify(bad)); good.processes[0].nodes[1] = { id: 'j', type: 'script', name: 'j', lang: 'js', code: 'setVariable("a", 1)' };
  const r2 = await call('POST', '/import/jbpm/deploy', { files: good, name: 'rollback project', environment: 'prod' });
  assert.strictEqual(r2.status, 201, 'the same name can be imported again');
  const wf = r2.body.workflowId;
  const inst = (await call('POST', '/instances', { workflowId: wf, environment: 'prod' })).body;
  const byProc = (await call('GET', `/instances?processId=bad.p&workflowId=${wf}`)).body.items as any[];
  assert.ok(byProc.some((i) => i.id === inst.id));
  const byParent = (await call('GET', `/instances?parentInstanceId=${inst.id}`)).body.items as any[];
  assert.strictEqual(byParent.length, 0, 'a parent filter returns only that parent\'s children');
  await h.close();
});
