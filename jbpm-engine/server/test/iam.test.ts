// IAM service: seeding, login, user/group/role CRUD, permission resolution.
import { test } from 'node:test';
import assert from 'node:assert';
import { MemoryStore } from '../src/store/memory-store.ts';
import { fakeClock } from '../src/infra/ids.ts';
import { makeContext } from '../src/context.ts';
import { IamService, DEFAULT_ROLES } from '../src/modules/iam/service.ts';

const newCtx = () => { let n = 0; return makeContext({ store: new MemoryStore(), tenantId: 't1', clock: fakeClock().clock, newId: () => `id${++n}` }); };

test('ensureSeeded creates the default roles and a bootstrap admin user exactly once', async () => {
  const ctx = newCtx();
  const iam = new IamService(ctx);
  const first = await iam.ensureSeeded('bootstrap-pw-123');
  assert.strictEqual(first.seededAdmin, true);

  const roles = await iam.listRoles();
  assert.deepStrictEqual(roles.map((r) => r.name).sort(), Object.keys(DEFAULT_ROLES).sort());

  const users = await iam.listUsers();
  assert.deepStrictEqual(users.map((u) => u.username), ['admin']);
  assert.deepStrictEqual(users[0]!.roles, ['admin']);

  // idempotent: calling again with users already present does not reseed/duplicate
  const second = await iam.ensureSeeded('bootstrap-pw-123');
  assert.strictEqual(second.seededAdmin, false);
  assert.strictEqual((await iam.listUsers()).length, 1);
  assert.strictEqual((await iam.listRoles()).length, Object.keys(DEFAULT_ROLES).length);
});

test('login succeeds with the right password and fails with the wrong one or an unknown user', async () => {
  const ctx = newCtx();
  const iam = new IamService(ctx);
  await iam.ensureSeeded('correct-horse-battery');

  const ok = (await iam.login('admin', 'correct-horse-battery')) as { token: string; user: any };
  assert.ok(ok.token.split('.').length === 3, 'looks like a JWT');
  assert.strictEqual(ok.user.username, 'admin');
  assert.strictEqual((ok.user as any).passwordHash, undefined, 'never leaks the hash');

  await assert.rejects(() => iam.login('admin', 'wrong-password'), /invalid/i);
  await assert.rejects(() => iam.login('nobody', 'whatever'), /invalid/i);
});

test('a deactivated user cannot log in', async () => {
  const ctx = newCtx();
  const iam = new IamService(ctx);
  const u = await iam.createUser({ username: 'carol', password: 'password123', roles: ['worker'] }, 'admin');
  await iam.login('carol', 'password123');   // works while active
  await iam.updateUser(u.id, { active: false }, 'admin');
  await assert.rejects(() => iam.login('carol', 'password123'), /invalid/i);
});

test('authorize() resolves a user\'s roles to their union of permissions, including wildcards', async () => {
  const ctx = newCtx();
  const iam = new IamService(ctx);
  await iam.ensureSeeded('bootstrap-pw-123');
  await iam.createRole({ name: 'custom', permissions: ['workflow:*'] }, 'admin');

  assert.strictEqual(await iam.authorize(['admin'], 'anything:at:all'), true, "admin's '*' grants everything");
  assert.strictEqual(await iam.authorize(['viewer'], 'workflow:view'), true);
  assert.strictEqual(await iam.authorize(['viewer'], 'workflow:edit'), false);
  assert.strictEqual(await iam.authorize(['custom'], 'workflow:deploy'), true, "workflow:* covers workflow:deploy");
  assert.strictEqual(await iam.authorize(['custom'], 'task:manage'), false);
  assert.strictEqual(await iam.authorize([], 'workflow:view'), false, 'no roles -> no permissions');
  assert.strictEqual(await iam.authorize(['does-not-exist'], 'workflow:view'), false, 'unknown role name grants nothing');
});

test('the built-in admin role cannot be modified or deleted', async () => {
  const ctx = newCtx();
  const iam = new IamService(ctx);
  await iam.ensureSeeded('bootstrap-pw-123');
  const adminRole = (await iam.listRoles()).find((r) => r.name === 'admin')!;
  await assert.rejects(() => iam.updateRole(adminRole.id, ['only:this'], 'admin'), /admin role/);
  await assert.rejects(() => iam.deleteRole(adminRole.id, 'admin'), /admin role/);
});

test('user/group CRUD: duplicate names rejected, groups deletable, users updatable', async () => {
  const ctx = newCtx();
  const iam = new IamService(ctx);
  await iam.createUser({ username: 'dave', password: 'password123' }, 'admin');
  await assert.rejects(() => iam.createUser({ username: 'dave', password: 'password123' }, 'admin'), /already exists/);
  await assert.rejects(() => iam.createUser({ username: 'eve', password: 'short' }, 'admin'), /at least 8/);

  const g = await iam.createGroup({ name: 'ops', description: 'Operations' }, 'admin');
  await assert.rejects(() => iam.createGroup({ name: 'ops' }, 'admin'), /already exists/);
  await iam.deleteGroup(g.id, 'admin');
  assert.strictEqual((await iam.listGroups()).length, 0);

  const dave = (await iam.listUsers()).find((u) => u.username === 'dave')!;
  await assert.rejects(() => iam.updateUser(dave.id, { groups: ['ops'] }, 'admin'), /unknown group/, 'a deleted group cannot be assigned');
  await iam.createGroup({ name: 'ops' }, 'admin');
  const updated = await iam.updateUser(dave.id, { roles: ['worker'], groups: ['ops'] }, 'admin');
  assert.deepStrictEqual(updated.roles, ['worker']);
  assert.deepStrictEqual(updated.groups, ['ops']);
});

test('changeOwnPassword: requires the correct current password, enforces min length, actually changes it', async () => {
  const ctx = newCtx();
  const iam = new IamService(ctx);
  const dave = await iam.createUser({ username: 'dave', password: 'password123' }, 'admin');
  await assert.rejects(() => iam.changeOwnPassword(dave.id, 'wrong-password', 'newpassword123'), /current password is incorrect/);
  await assert.rejects(() => iam.changeOwnPassword(dave.id, 'password123', 'short'), /at least 8/);
  await iam.changeOwnPassword(dave.id, 'password123', 'newpassword123');
  await assert.rejects(() => iam.login('dave', 'password123'), /invalid/);
  const { user } = (await iam.login('dave', 'newpassword123')) as { token: string; user: any };
  assert.strictEqual(user.username, 'dave');
});
