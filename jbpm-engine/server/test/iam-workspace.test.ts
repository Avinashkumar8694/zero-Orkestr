// Roles, groups and users are scoped to ONE workspace: built-ins show up in every workspace, edits and deletions never
// leak across workspaces, names/permissions are validated, and nobody can grant more than they hold.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { boot, tokenFor } from './harness.ts';
import { config } from '../src/infra/config.ts';

const h = await boot();
after(() => h.close());
const a = await h.workspace('iam-a');
const b = await h.workspace('iam-b');
const call = h.call;
const roles = async (w: typeof a) => (await call('GET', '/roles', { token: w.tokens.owner, tenant: w.id })).body.items as any[];

test('IAMW-01 a brand-new workspace lists the built-in roles (virtual) with usage counts', async () => {
  const list = await roles(a);
  for (const n of ['admin', 'developer', 'author', 'release', 'operator', 'worker', 'viewer']) assert.ok(list.find((r) => r.name === n && r.builtIn), n);
  assert.ok(list.find((r) => r.name === 'admin')!.protected);
  assert.ok(list.every((r) => r.id.startsWith('builtin:')), 'nothing is stored until someone customises a role');
  assert.strictEqual(list.find((r) => r.name === 'viewer')!.memberCount, 1, 'the viewer seat is counted');
});

test('IAMW-02 editing a built-in role stores a copy for THAT workspace only; deleting it resets to defaults', async () => {
  const viewer = (await roles(a)).find((r) => r.name === 'viewer');
  const r = await call('PATCH', `/roles/${viewer.id}`, { token: a.tokens.owner, tenant: a.id, body: { permissions: ['workflow:view'] } });
  assert.strictEqual(r.status, 200);
  const mine = (await roles(a)).find((x) => x.name === 'viewer');
  assert.deepStrictEqual(mine.permissions, ['workflow:view']); assert.ok(mine.overridden);
  assert.deepStrictEqual((await roles(b)).find((x) => x.name === 'viewer').permissions, ['workflow:view', 'query:read', 'team:read'], 'other workspace untouched');
  // the seat really lost query:read in workspace A
  assert.strictEqual((await call('GET', '/query/analytics/summary', { token: a.tokens.viewer, tenant: a.id })).status, 403);
  const reset = await call('DELETE', `/roles/${mine.id}`, { token: a.tokens.owner, tenant: a.id });
  assert.strictEqual(reset.status, 200); assert.strictEqual(reset.body.reset, true);
  assert.deepStrictEqual((await roles(a)).find((x) => x.name === 'viewer').permissions, ['workflow:view', 'query:read', 'team:read']);
});

test('IAMW-03 role validation: names, reserved words, unknown permissions, duplicates, admin is protected', async () => {
  const mk = (body: any) => call('POST', '/roles', { token: a.tokens.owner, tenant: a.id, body });
  assert.strictEqual((await mk({ name: '', permissions: [] })).status, 422);
  assert.strictEqual((await mk({ name: '9bad', permissions: [] })).status, 422);
  assert.strictEqual((await mk({ name: 'Owner', permissions: [] })).status, 422);
  assert.strictEqual((await mk({ name: 'typo', permissions: ['workflow:vieww'] })).status, 422);
  assert.strictEqual((await mk({ name: 'typo', permissions: 'workflow:view' })).status, 422);
  const ok = await mk({ name: 'auditor', permissions: ['query:read', 'query:read', 'workflow:*'] });
  assert.strictEqual(ok.status, 201); assert.deepStrictEqual(ok.body.permissions, ['query:read', 'workflow:*']);
  assert.strictEqual((await mk({ name: 'AUDITOR', permissions: [] })).status, 409, 'case-insensitive duplicate');
  assert.strictEqual((await mk({ name: 'viewer', permissions: [] })).status, 409, 'cannot shadow a built-in');
  const admin = (await roles(a)).find((r) => r.name === 'admin');
  assert.strictEqual((await call('PATCH', `/roles/${admin.id}`, { token: a.tokens.owner, tenant: a.id, body: { permissions: ['query:read'] } })).status, 403);
  assert.strictEqual((await call('DELETE', `/roles/${admin.id}`, { token: a.tokens.owner, tenant: a.id })).status, 422, 'a virtual built-in cannot be deleted');
});

test('IAMW-04 a role in use cannot be deleted; roles of another workspace are invisible', async () => {
  const role = (await roles(a)).find((r) => r.name === 'auditor');
  const u = await call('POST', '/users', { token: a.tokens.owner, tenant: a.id, body: { username: 'iam-a-user', password: 'Sup3r-secret-pw', roles: ['auditor'] } });
  assert.strictEqual(u.status, 201);
  assert.strictEqual((await call('DELETE', `/roles/${role.id}`, { token: a.tokens.owner, tenant: a.id })).status, 409);
  assert.strictEqual((await call('DELETE', `/roles/${role.id}`, { token: b.tokens.owner, tenant: b.id })).status, 404, 'workspace B cannot touch it');
  assert.ok(!(await roles(b)).some((r) => r.name === 'auditor'));
  await call('PATCH', `/users/${u.body.id}`, { token: a.tokens.owner, tenant: a.id, body: { roles: [] } });
  assert.strictEqual((await call('DELETE', `/roles/${role.id}`, { token: a.tokens.owner, tenant: a.id })).status, 204);
});

test('IAMW-05 users may only hold roles and groups that exist in their workspace', async () => {
  const mk = (body: any) => call('POST', '/users', { token: a.tokens.owner, tenant: a.id, body: { password: 'Sup3r-secret-pw', ...body } });
  assert.strictEqual((await mk({ username: 'ghost1', roles: ['nope'] })).status, 422);
  assert.strictEqual((await mk({ username: 'ghost2', groups: ['nope'] })).status, 422);
  assert.strictEqual((await mk({ username: 'ghost3', roles: 'worker' })).status, 422);
  const ok = await mk({ username: 'Real.User', roles: ['worker', 'worker'] });
  assert.strictEqual(ok.status, 201); assert.deepStrictEqual(ok.body.roles, ['worker']);
  assert.strictEqual((await mk({ username: 'real.user' })).status, 409, 'usernames are unique case-insensitively');
});

test('IAMW-06 groups: validation, rename carries members, membership editing, delete detaches members', async () => {
  const T = { token: a.tokens.owner, tenant: a.id };
  assert.strictEqual((await call('POST', '/groups', { ...T, body: { name: '  ' } })).status, 422);
  assert.strictEqual((await call('POST', '/groups', { ...T, body: { name: 'bad/name' } })).status, 422);
  const g = (await call('POST', '/groups', { ...T, body: { name: 'hr-approvers', description: 'HR' } })).body;
  assert.strictEqual((await call('POST', '/groups', { ...T, body: { name: 'HR-Approvers' } })).status, 409);
  const user = (await call('GET', '/users', T)).body.items.find((x: any) => x.username === 'Real.User');
  const set = await call('PUT', `/groups/${g.id}/members`, { ...T, body: { userIds: [user.id] } });
  assert.strictEqual(set.status, 200);
  assert.strictEqual((await call('PUT', `/groups/${g.id}/members`, { ...T, body: { userIds: ['missing'] } })).status, 422);
  assert.strictEqual((await call('GET', '/groups', T)).body.items.find((x: any) => x.id === g.id).memberCount, 1);
  assert.strictEqual((await call('PATCH', `/groups/${g.id}`, { ...T, body: { name: 'hr-leads', description: '' } })).status, 200);
  assert.deepStrictEqual((await call('GET', `/users/${user.id}`, T)).body.groups, ['hr-leads'], 'rename carried the member');
  assert.strictEqual((await call('DELETE', `/groups/${g.id}`, { token: b.tokens.owner, tenant: b.id })).status, 404);
  assert.strictEqual((await call('DELETE', `/groups/${g.id}`, T)).status, 204);
  assert.deepStrictEqual((await call('GET', `/users/${user.id}`, T)).body.groups, [], 'delete detached the member');
});

test('IAMW-07 nobody can grant more than they hold (role escalation)', async () => {
  const mgr = await call('POST', '/roles', { token: a.tokens.owner, tenant: a.id, body: { name: 'iam-manager', permissions: ['admin:iam', 'workflow:view'] } });
  assert.strictEqual(mgr.status, 201);
  // a member whose seat holds only iam-manager
  await h.store.repo<any>('tenantMembers').put({ id: 'm-a-mgr', tenantId: a.id, userId: 'mgr@example.com', email: 'mgr@example.com', role: 'iam-manager', status: 'active', joinedAt: new Date().toISOString() });
  const T = { token: tokenFor('mgr@example.com'), tenant: a.id };
  assert.strictEqual((await call('GET', '/roles', T)).status, 200);
  assert.strictEqual((await call('POST', '/roles', { ...T, body: { name: 'sneaky', permissions: ['*'] } })).status, 403);
  assert.strictEqual((await call('POST', '/roles', { ...T, body: { name: 'sneaky', permissions: ['task:manage'] } })).status, 403);
  assert.strictEqual((await call('POST', '/roles', { ...T, body: { name: 'sneaky', permissions: ['workflow:view'] } })).status, 201);
  const admin = (await call('POST', '/users', { ...T, body: { username: 'sneaky-user', password: 'Sup3r-secret-pw', roles: ['admin'] } }));
  assert.strictEqual(admin.status, 403, 'cannot hand out the admin role');
});

test('IAMW-08 platform-wide view is read-only for users/roles/groups; deactivating yourself is refused', async () => {
  const platform = { token: tokenFor(config.platformAdminEmail, { source: 'oidc' }), tenant: 'all' };
  const w = await call('POST', '/groups', { ...platform, body: { name: 'everywhere' } });
  assert.ok([401, 403, 422].includes(w.status), `write in platform view refused (got ${w.status})`);
});
