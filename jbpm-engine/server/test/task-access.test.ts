// Who may see, claim and hand over tasks. A person works on the tasks of their own groups, sees only those and their own, and may hand a task to someone in the
// same group; handing it outside the group (another person or another group) needs the permission `task:reassign`. Supervisors hold `task:viewAll`.
import { test, after, before } from 'node:test';
import assert from 'node:assert';
import { boot } from './harness.ts';
import { IamService } from '../src/modules/iam/service.ts';
import { makeContext } from '../src/context.ts';
import { signToken } from '../src/infra/auth.ts';
import { Collections, type Task } from '../src/domain.ts';

let h: Awaited<ReturnType<typeof boot>>;
let ws: Awaited<ReturnType<typeof h.workspace>>;
const tok: Record<string, string> = {};
const mkTask = async (id: string, extra: Partial<Task>) => h.store.repo<Task>(Collections.tasks).put({ id, tenantId: ws.id, instanceId: `i-${id}`, tokenId: `k-${id}`, nodeId: 'n', name: `Task ${id}`, status: 'created', inputs: { secret: id }, createdAt: new Date().toISOString(), ...extra } as Task);
const as = (who: string, m: string, p: string, body?: unknown) => h.call(m, p, { token: tok[who], tenant: ws.id, body });

before(async () => {
  h = await boot();
  ws = await h.workspace('task-access', ['admin']);
  const iam = new IamService(makeContext({ store: h.store, tenantId: ws.id }));
  await iam.createRole({ name: 'supervisor', permissions: ['task:manage', 'task:viewAll', 'task:reassign'] }, 'admin');
  await iam.createRole({ name: 'staff', permissions: ['task:manage'] }, 'admin');
  await iam.createGroup({ name: 'claims' }, 'admin'); await iam.createGroup({ name: 'billing' }, 'admin');
  for (const [name, role, groups] of [['alice', 'staff', ['claims']], ['amy', 'staff', ['claims']], ['bob', 'staff', ['billing']], ['sue', 'supervisor', ['claims']]] as const) {
    const u = await iam.createUser({ username: name, password: 'Str0ng-pass-123!', roles: [role], groups: [...groups] }, 'admin');
    tok[name] = signToken({ sub: u.id, username: name, roles: [role], groups: [...groups], source: 'local' } as any);
  }
  await mkTask('claims-open', { group: 'claims' });                                       // unassigned, offered to claims
  await mkTask('billing-open', { group: 'billing' });
  await mkTask('alice-own', { group: 'claims', assignee: 'alice', status: 'reserved' });
  await mkTask('alice-own2', { group: 'claims', assignee: 'alice', status: 'reserved' });
  await mkTask('amy-own', { group: 'claims', assignee: 'amy', status: 'reserved' });      // a colleague's task
  await mkTask('named-bob', { assignee: 'bob', status: 'reserved' });                      // assigned straight to bob
});
after(async () => { await h.close(); setTimeout(() => process.exit(0), 50).unref(); });

test('ACCESS-1 a person sees only their own tasks and the open tasks of their own groups; a supervisor sees everything', async () => {
  const names = async (who: string) => ((await as(who, 'GET', '/tasks')).body.items as any[]).map((t) => t.id).sort();
  assert.deepStrictEqual(await names('alice'), ['alice-own', 'alice-own2', 'claims-open'], 'alice: her own and her group\'s open work, not amy\'s, not billing\'s');
  assert.deepStrictEqual(await names('bob'), ['billing-open', 'named-bob']);
  assert.strictEqual((await names('sue')).length, 6, 'supervisor with task:viewAll sees all');
  assert.strictEqual((await as('alice', 'GET', '/tasks/billing-open')).status, 404, 'another group\'s task is not even visible by id');
  assert.strictEqual((await as('alice', 'GET', '/tasks/billing-open/inputs')).status, 404);
  assert.strictEqual((await as('alice', 'GET', '/tasks/billing-open/comments')).status, 404);
  assert.strictEqual((await as('alice', 'GET', '/tasks/claims-open')).status, 200);
  assert.strictEqual((await as('sue', 'GET', '/tasks/billing-open')).status, 200);
  assert.strictEqual((await as('alice', 'GET', '/tasks?assignee=amy')).body.items.length, 0, 'asking for a colleague\'s tasks by filter shows nothing');
});

test('ACCESS-2 claiming is limited to the person\'s own groups', async () => {
  assert.strictEqual((await as('alice', 'POST', '/tasks/billing-open/claim')).status, 404, 'cannot even see it');
  assert.strictEqual((await as('bob', 'POST', '/tasks/claims-open/claim')).status, 404);
  assert.strictEqual((await as('alice', 'POST', '/tasks/claims-open/claim')).status, 200);
});

test('ACCESS-3 handing a task over: to someone in the same group is the owner\'s call; outside the group needs task:reassign', async () => {
  const mine = 'alice-own';
  const toBob = await as('alice', 'POST', `/tasks/${mine}/delegate`, { to: 'bob' });
  assert.strictEqual(toBob.status, 403); assert.match(toBob.body.error.message, /task:reassign/);
  assert.strictEqual((await as('alice', 'POST', `/tasks/${mine}/forward`, { group: 'billing' })).status, 403, 'another group needs the permission too');
  assert.strictEqual((await as('alice', 'POST', `/tasks/${mine}/forward`, { user: 'bob' })).status, 403);
  assert.strictEqual((await as('alice', 'POST', `/tasks/${mine}/delegate`, { to: 'amy' })).status, 200, 'same group: fine');
  assert.strictEqual((await as('alice', 'POST', '/tasks/alice-own2/forward', { group: 'claims' })).status, 200, 'back to her own group: fine');
  // a colleague cannot hand over work that is not theirs
  assert.strictEqual((await as('bob', 'POST', '/tasks/amy-own/delegate', { to: 'bob' })).status, 404);
  // a supervisor with task:reassign can send work to another group or person
  assert.strictEqual((await as('sue', 'POST', '/tasks/claims-open/forward', { group: 'billing' })).status, 200);
  assert.strictEqual((await as('sue', 'POST', '/tasks/amy-own/delegate', { to: 'bob' })).status, 200);
});

test('ACCESS-4 callers with no local account: an API key sees tasks only with task:viewAll; a single-sign-on seat is held to the groups in its token', async () => {
  const { TaskService } = await import('../src/modules/tasks/service.ts');
  const svcFor = (viewer: any) => { const s = new TaskService(makeContext({ store: h.store, tenantId: ws.id })); s.viewer = viewer; return s; };
  const key = svcFor({ user: 'key:ork_1', perms: async () => ['task:manage'], apiKey: true });
  assert.deepStrictEqual(await key.list({}), [], 'an API key without task:viewAll sees nothing');
  await assert.rejects(() => key.get('claims-open'));
  const keyAll = svcFor({ user: 'key:ork_2', perms: async () => ['task:manage', 'task:viewAll'], apiKey: true });
  assert.strictEqual((await keyAll.list({})).length, 6);
  const sso = svcFor({ user: 'carl@corp.example', perms: async () => ['task:manage'], groups: ['billing'] });
  assert.deepStrictEqual((await sso.list({})).map((t) => t.id).sort(), ['billing-open', 'claims-open'], 'SSO seat sees its token groups\' open work only (claims-open was forwarded to billing above)');
  await assert.rejects(() => sso.claim('alice-own2', 'carl@corp.example'), 'a claims task is not his to claim');
});
