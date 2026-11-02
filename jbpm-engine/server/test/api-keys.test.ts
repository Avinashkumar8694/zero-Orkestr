// API keys: a credential for server-to-server calls, accepted next to access tokens, scoped to one workspace and to the permissions chosen at creation.
import { test, after, before } from 'node:test';
import assert from 'node:assert';
import { boot } from './harness.ts';
import { Collections, type ApiKey } from '../src/domain.ts';

let h: Awaited<ReturnType<typeof boot>>;
let ws: Awaited<ReturnType<typeof h.workspace>>, other: Awaited<ReturnType<typeof h.workspace>>;
before(async () => { h = await boot(); ws = await h.workspace('keys-a', ['admin', 'viewer']); other = await h.workspace('keys-b', ['admin']); });
after(async () => { await h.close(); setTimeout(() => process.exit(0), 50).unref(); });

const make = (body: Record<string, unknown>, who = 'admin', w = ws) => h.call('POST', '/api-keys', { token: w.tokens[who], tenant: w.id, body });
const asKey = (key: string, path: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) => h.call(o.method ?? 'GET', path, { headers: { 'x-api-key': key, ...(o.headers ?? {}) }, body: o.body });

test('KEY-1 create: the secret is returned once, only a hash is stored, and lists never show it', async () => {
  const r = await make({ name: 'billing sync', permissions: ['workflow:view', 'query:read'], expiresInDays: 30 });
  assert.strictEqual(r.status, 201);
  assert.match(r.body.key, /^ork_[A-Za-z0-9]+\.[A-Za-z0-9_-]{40,}$/);
  const secret = r.body.key.split('.')[1];
  const row = await h.store.repo<ApiKey>(Collections.apiKeys).get(r.body.id);
  assert.ok(row && row.hash && !JSON.stringify(row).includes(secret), 'the secret is not in the stored row');
  assert.strictEqual(r.body.hash, undefined);
  const list = (await h.call('GET', '/api-keys', { token: ws.tokens.admin, tenant: ws.id })).body.items as any[];
  const mine = list.find((k) => k.id === r.body.id)!;
  assert.deepStrictEqual([mine.name, mine.permissions, !!mine.expiresAt, mine.hash, mine.key], ['billing sync', ['workflow:view', 'query:read'], true, undefined, undefined]);
  assert.strictEqual(mine.prefix, secret.slice(0, 6));
});

test('KEY-2 a key works next to tokens in all three forms, acts only with its permissions, and needs no workspace header', async () => {
  const { key } = (await make({ name: 'reader', permissions: ['workflow:view'] })).body;
  assert.strictEqual((await asKey(key, '/workflows')).status, 200, 'X-API-Key');
  assert.strictEqual((await h.call('GET', '/workflows', { headers: { authorization: `ApiKey ${key}` } })).status, 200, 'Authorization: ApiKey');
  assert.strictEqual((await h.call('GET', '/workflows', { headers: { authorization: `Bearer ${key}` } })).status, 200, 'Authorization: Bearer ork_…');
  const denied = await asKey(key, '/workflows', { method: 'POST', body: { name: 'nope' } });
  assert.strictEqual(denied.status, 403); assert.match(denied.body.error.message, /does not allow/);
  assert.strictEqual((await asKey(key, '/tasks')).status, 403, 'a permission it does not hold (task:manage)');
});

test('KEY-3 a key belongs to one workspace: it sees only that workspace, and naming another is refused', async () => {
  await h.call('POST', '/workflows', { token: ws.tokens.admin, tenant: ws.id, body: { name: 'only in a' } });
  await h.call('POST', '/workflows', { token: other.tokens.admin, tenant: other.id, body: { name: 'only in b' } });
  const { key } = (await make({ name: 'a only', permissions: ['workflow:view'] })).body;
  const names = ((await asKey(key, '/workflows')).body.items as any[]).map((w) => w.name);
  assert.ok(names.includes('only in a') && !names.includes('only in b'));
  const wrong = await asKey(key, '/workflows', { headers: { 'x-tenant-id': other.id } });
  assert.strictEqual(wrong.status, 403); assert.match(wrong.body.error.message, /another workspace/);
  assert.strictEqual((await asKey(key, '/workflows', { headers: { 'x-tenant-id': ws.id } })).status, 200, 'naming its own workspace is fine');
});

test('KEY-4 revoked, expired, malformed and unknown keys are 401; revoking takes effect at once', async () => {
  const k1 = (await make({ name: 'to revoke', permissions: ['workflow:view'] })).body;
  assert.strictEqual((await asKey(k1.key, '/workflows')).status, 200);
  assert.strictEqual((await h.call('DELETE', `/api-keys/${k1.id}`, { token: ws.tokens.admin, tenant: ws.id })).status, 204);
  const rev = await asKey(k1.key, '/workflows'); assert.strictEqual(rev.status, 401); assert.match(rev.body.error.message, /revoked/);
  const k2 = (await make({ name: 'to expire', permissions: ['workflow:view'], expiresInDays: 1 })).body;
  const row = (await h.store.repo<ApiKey>(Collections.apiKeys).get(k2.id))!; row.expiresAt = '2000-01-01T00:00:00.000Z'; await h.store.repo<ApiKey>(Collections.apiKeys).put(row);
  const exp = await asKey(k2.key, '/workflows'); assert.strictEqual(exp.status, 401); assert.match(exp.body.error.message, /expired/);
  assert.strictEqual((await asKey('ork_nope', '/workflows')).status, 401);
  assert.strictEqual((await asKey(`ork_${k1.id}.${'x'.repeat(43)}`, '/workflows')).status, 401, 'right id, wrong secret');
});

test('KEY-5 what a key can be given: never admin rights or everything, nothing its creator does not hold, and only workspace admins create them', async () => {
  for (const p of ['*', 'admin:iam', 'admin:*', 'team:manage']) assert.strictEqual((await make({ name: 'x', permissions: [p] })).status, 422, p);
  assert.strictEqual((await make({ name: 'x', permissions: ['not a permission'] })).status, 422);
  assert.strictEqual((await make({ name: 'x', permissions: [] })).status, 422);
  assert.strictEqual((await make({ name: '', permissions: ['workflow:view'] })).status, 422);
  assert.strictEqual((await make({ name: 'x', permissions: ['workflow:view'], expiresInDays: 0 })).status, 422);
  assert.strictEqual((await make({ name: 'x', permissions: ['workflow:view'] }, 'viewer')).status, 403, 'a viewer cannot create keys');
  assert.strictEqual((await h.call('GET', '/api-keys', { token: ws.tokens.viewer, tenant: ws.id })).status, 403);
});

test('KEY-6 a key cannot manage keys, users or roles, and a person-only endpoint is not for keys', async () => {
  const { key } = (await make({ name: 'broad', permissions: ['workflow:view', 'workflow:run', 'task:manage', 'query:read'] })).body;
  assert.strictEqual((await asKey(key, '/api-keys')).status, 403);
  assert.strictEqual((await asKey(key, '/api-keys', { method: 'POST', body: { name: 'child', permissions: ['workflow:view'] } })).status, 403, 'a key cannot mint keys');
  const users = await asKey(key, '/users');
  assert.ok(!((users.body.items ?? []) as any[]).some((u) => 'passwordHash' in u || 'roles' in u), 'no admin view of users');
  assert.strictEqual((await asKey(key, '/platform/limits')).status, 403, 'not the platform admin API');
});

test('KEY-7 last use is recorded (at most once a minute) and the audit log records creation and revocation', async () => {
  const k = (await make({ name: 'tracked', permissions: ['workflow:view'] })).body;
  assert.strictEqual((await h.store.repo<ApiKey>(Collections.apiKeys).get(k.id))!.lastUsedAt, undefined);
  await asKey(k.key, '/workflows');
  const first = (await h.store.repo<ApiKey>(Collections.apiKeys).get(k.id))!.lastUsedAt; assert.ok(first);
  await asKey(k.key, '/workflows');
  assert.strictEqual((await h.store.repo<ApiKey>(Collections.apiKeys).get(k.id))!.lastUsedAt, first, 'not rewritten on every call');
  await h.call('DELETE', `/api-keys/${k.id}`, { token: ws.tokens.admin, tenant: ws.id });
  const kinds = (await h.store.repo<any>(Collections.audit).query((a: any) => a.data?.id === k.id)).map((a: any) => a.kind).sort();
  assert.deepStrictEqual(kinds, ['api-key.created', 'api-key.revoked']);
});

import { resetCoordinator } from '../src/infra/coordinator.ts';

test('KEY-8 guessing is stopped: after 10 wrong secrets for a key from one address that address is refused for that key (even with the right secret); other keys and the next minute are unaffected', async () => {
  resetCoordinator();
  const a = (await make({ name: 'guess target', permissions: ['workflow:view'] })).body;
  const b = (await make({ name: 'bystander', permissions: ['workflow:view'] })).body;
  const wrong = `ork_${a.id}.${'x'.repeat(43)}`;
  const codes: number[] = []; for (let i = 0; i < 10; i++) codes.push((await asKey(wrong, '/workflows')).status);
  assert.deepStrictEqual(new Set(codes), new Set([401]), 'ten wrong guesses are plain 401s');
  const locked = await asKey(a.key, '/workflows');
  assert.strictEqual(locked.status, 429, 'then even the right key from this address is refused');
  assert.match(locked.body.error.message, /too many invalid API keys/);
  assert.strictEqual((await asKey(b.key, '/workflows')).status, 200, 'a different key is not affected');
  assert.strictEqual((await asKey(`ork_unknown.${'y'.repeat(43)}`, '/workflows')).status, 401, 'unknown ids are counted on their own');
  resetCoordinator();                                              // the minute passes
  assert.strictEqual((await asKey(a.key, '/workflows')).status, 200);
});
