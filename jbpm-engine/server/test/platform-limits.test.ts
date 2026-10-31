// 3-level platform-governed limits: effective = min(workspace setting, per-workspace cap, global cap).
// Only the fixed platform administrator may write the caps; workspace admins stay inside them.
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { boot, ROLE_NAMES } from './harness.ts';
import { config, PLATFORM_ADMIN_EMAIL } from '../src/infra/config.ts';
import { oidc } from '../src/infra/oidc.ts';
import { runScript, sandboxStats, configureSandbox, sandboxConfig } from '../src/engine/sandbox.ts';
import { resolveLimits, capsOf, effectiveLimitsFor, PlatformLimitsService, type PlatformLimits } from '../src/modules/platform/limits.ts';
import { Collections, type AuditEvent } from '../src/domain.ts';

// ---- a fake identity server so the platform administrator can sign in with a real (verified) SSO token ----
const CLIENT_ID = 'zero-orkestr';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
let idp: http.Server, idpUrl = '';
const sso = (email: string) => jwt.sign({ sub: `sub-${email}`, email, email_verified: true }, privateKey, { algorithm: 'RS256', keyid: 'k1', issuer: idpUrl, audience: CLIENT_ID, expiresIn: '1h' });

let h: Awaited<ReturnType<typeof boot>>;
let ws: Awaited<ReturnType<Awaited<ReturnType<typeof boot>>['workspace']>>;
let ws2: typeof ws;
let ROOT = '';
const savedSandbox = { ...sandboxConfig() };

test.before(async () => {
  idp = http.createServer((req, res) => {
    const send = (o: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/oidc/.well-known/openid-configuration') return send({ issuer: idpUrl, authorization_endpoint: `${idpUrl}/auth`, token_endpoint: `${idpUrl}/token`, jwks_uri: `${idpUrl}/jwks` });
    if (req.url === '/oidc/jwks') return send({ keys: [jwk] });
    res.statusCode = 404; res.end();
  });
  await new Promise<void>((r) => idp.listen(0, '127.0.0.1', r));
  idpUrl = `http://127.0.0.1:${(idp.address() as any).port}/oidc`;
  Object.assign(config.oidc, { issuer: idpUrl, clientId: CLIENT_ID, clientSecret: 's', audience: [CLIENT_ID], redirectUri: 'http://localhost:4000/cb' });
  oidc.reset();
  h = await boot();
  ws = await h.workspace('plim-a');
  ws2 = await h.workspace('plim-b', ['admin']);
  ROOT = sso(PLATFORM_ADMIN_EMAIL);
});
test.after(async () => { configureSandbox(savedSandbox); await h.close(); await new Promise<void>((r) => idp.close(() => r())); });

const platformCall = (method: string, path: string, body?: unknown, token = ROOT) => h.call(method, `/platform${path}`, { token, body });
const putSettings = (w: typeof ws, body: unknown, role = 'owner') => h.call('PUT', '/settings/system', { token: w.tokens[role], tenant: w.id, body });
const getSettings = (w: typeof ws, role = 'owner') => h.call('GET', '/settings/system', { token: w.tokens[role], tenant: w.id });

test('PLIM-1 every platform route is 403 for every workspace role (owner/admin included) and for the local admin; 200 only for the platform admin', async () => {
  const routes: Array<[string, string, unknown?]> = [
    ['GET', '/limits'], ['PUT', '/limits', { scriptPoolMaxSize: 16 }], ['GET', '/limits/usage'],
    ['GET', `/workspaces/${ws.id}/limits`], ['PUT', `/workspaces/${ws.id}/limits`, {}],
    ['GET', '/plans'], ['PUT', '/plans/qa-plan', { limits: { maxWorkflows: 5 } }], ['PUT', `/workspaces/${ws.id}/plan`, { plan: 'enterprise' }],
  ];
  const local = (await h.call('POST', '/auth/login', { body: { username: 'admin', password: 'bootstrap-pw-123' } })).body.token;
  await h.call('POST', '/platform/plans', { token: ROOT, body: { key: 'qa-plan', name: 'QA plan' } });   // PUT updates an existing plan; creating is POST
  for (const [m, p, b] of routes) {
    assert.strictEqual((await h.call(m, `/platform${p}`, { body: b })).status, 401, `${m} ${p} anonymous`);
    for (const role of ['owner', ...ROLE_NAMES]) assert.strictEqual((await h.call(m, `/platform${p}`, { token: ws.tokens[role], tenant: ws.id, body: b })).status, 403, `${m} ${p} as ${role}`);
    assert.strictEqual((await h.call(m, `/platform${p}`, { token: local, body: b })).status, 403, `${m} ${p} as local admin`);
    assert.strictEqual((await h.call(m, `/platform${p}`, { token: sso('someone-else@example.com'), body: b })).status, 403, `${m} ${p} as another SSO user`);
    assert.strictEqual((await h.call(m, `/platform${p}`, { token: ROOT, body: b })).status, 200, `${m} ${p} as platform admin`);
  }
});

test('PLIM-2 privilege escalation is closed: a workspace owner cannot exceed a cap, cannot pick unlimited when capped, cannot write platform-only fields', async () => {
  assert.strictEqual((await platformCall('PUT', '/limits', { scriptPoolMaxSize: 6, scriptPoolDefaultSize: 2, scriptQueueMaxCap: 50, scriptQueueDefaultMax: 10, maxActiveInstancesCap: 100, maxActiveTimersCap: 40 })).status, 200);
  let r = await putSettings(ws, { scriptPoolSize: 7 });
  assert.strictEqual(r.status, 422); assert.match(JSON.stringify(r.body), /cap of 6/);
  assert.strictEqual((await putSettings(ws, { maxConcurrentScripts: 7 })).status, 422, 'the deprecated alias is capped too');
  r = await putSettings(ws, { scriptQueueMax: 51 }); assert.strictEqual(r.status, 422); assert.match(JSON.stringify(r.body), /cap of 50/);
  r = await putSettings(ws, { maxActiveInstances: 0 }); assert.strictEqual(r.status, 422); assert.match(JSON.stringify(r.body), /unlimited.*capped at 100/);
  assert.strictEqual((await putSettings(ws, { maxActiveInstances: 101 })).status, 422);
  assert.strictEqual((await putSettings(ws, { maxActiveTimers: 0 })).status, 422);
  assert.strictEqual((await putSettings(ws, { maxActiveTimers: 41 })).status, 422);
  for (const k of ['scriptPoolMaxSize', 'scriptQueueMaxCap', 'scriptMaxIsolates', 'maxActiveInstancesCap', 'lockedOverflowMode', 'tenantId_override', 'limitCapsX']) {
    assert.strictEqual((await putSettings(ws, { [k]: 99999 })).status, 422, `platform-only/unknown field ${k}`);
  }
  // lower values are always fine, as is echoing the whole GET response back (read-only parts are dropped)
  assert.strictEqual((await putSettings(ws, { scriptPoolSize: 3, scriptQueueMax: 20, maxActiveInstances: 50, maxActiveTimers: 10, scriptOverflowMode: 'reject' })).status, 200);
  const echoed = (await getSettings(ws)).body;
  assert.strictEqual((await putSettings(ws, echoed)).status, 200, 'GET → PUT round trip');
  // a non-admin role cannot write settings at all
  assert.strictEqual((await putSettings(ws, { scriptPoolSize: 1 }, 'viewer')).status, 403);
  // and the effective view shows the caps read-only
  const g = (await getSettings(ws)).body;
  assert.strictEqual(g.limitCaps.scriptPoolMaxSize, 6);
  assert.strictEqual(g.effectiveLimits.scriptPoolSize, 3);
  assert.strictEqual(g.effectiveLimits.maxActiveInstances, 50);
  // workspaces do not clobber each other's settings
  assert.strictEqual((await getSettings(ws2, 'owner')).body.scriptPoolSize, undefined);
});

test('PLIM-3 min-chain resolution: global cap < workspace cap < workspace value; unset → default; override beats global default but never the global cap', () => {
  const g: PlatformLimits = { scriptPoolDefaultSize: 2, scriptPoolMaxSize: 8, scriptQueueDefaultMax: 100, scriptQueueMaxCap: 500, scriptQueueTimeoutMs: 5000, scriptMaxIsolates: 64, scriptOverflowModeDefault: 'queue', maxActiveInstancesCap: 0, maxActiveTimersCap: 0, maxReplicasCap: 0 };
  assert.strictEqual(resolveLimits(g, {}, {}).scriptPoolSize, 2, 'unset → default');
  assert.strictEqual(resolveLimits(g, {}, { scriptPoolSize: 5 }).scriptPoolSize, 5, 'workspace value inside the cap');
  assert.strictEqual(resolveLimits(g, {}, { scriptPoolSize: 50 }).scriptPoolSize, 8, 'global cap wins');
  assert.strictEqual(resolveLimits(g, { scriptPoolMaxSize: 4 }, { scriptPoolSize: 6 }).scriptPoolSize, 4, 'workspace cap < workspace value');
  assert.strictEqual(resolveLimits(g, { scriptPoolMaxSize: 100 }, { scriptPoolSize: 50 }).scriptPoolSize, 8, 'workspace cap can never exceed the global cap');
  assert.strictEqual(resolveLimits(g, { scriptPoolDefaultSize: 6 }, {}).scriptPoolSize, 6, 'per-workspace default beats the global default');
  assert.strictEqual(resolveLimits(g, { scriptPoolDefaultSize: 50 }, {}).scriptPoolSize, 8, '…but is still clamped to the cap');
  assert.strictEqual(resolveLimits(g, {}, { maxConcurrentScripts: 3 }).scriptPoolSize, 3, 'deprecated alias');
  assert.strictEqual(resolveLimits(g, {}, { maxConcurrentScripts: 3, scriptPoolSize: 6 }).scriptPoolSize, 6, 'scriptPoolSize beats the alias');
  assert.strictEqual(resolveLimits(g, {}, {}).scriptQueueMax, 100);
  assert.strictEqual(resolveLimits(g, { scriptQueueMaxCap: 30 }, { scriptQueueMax: 400 }).scriptQueueMax, 30);
  assert.strictEqual(resolveLimits(g, {}, { scriptOverflowMode: 'reject' }).scriptOverflowMode, 'reject');
  assert.strictEqual(resolveLimits(g, { lockedOverflowMode: 'queue' }, { scriptOverflowMode: 'reject' }).scriptOverflowMode, 'queue', 'lock wins');
  assert.strictEqual(resolveLimits({ ...g, maxActiveInstancesCap: 100 }, {}, { maxActiveInstances: 0 }).maxActiveInstances, 100, 'unlimited under a cap = the cap');
  assert.strictEqual(resolveLimits({ ...g, maxActiveInstancesCap: 100 }, { maxActiveInstancesCap: 20 }, { maxActiveInstances: 70 }).maxActiveInstances, 20);
  assert.strictEqual(resolveLimits(g, {}, { maxActiveInstances: 0 }).maxActiveInstances, 0, 'unlimited only when the cap is unlimited');
  assert.strictEqual(capsOf(g, { scriptPoolMaxSize: 3 }).scriptPoolMaxSize, 3);
});

test('PLIM-4 per-workspace platform override + lock apply through the API; a workspace override above the global cap is refused', async () => {
  await platformCall('PUT', '/limits', { scriptPoolMaxSize: 6, scriptQueueMaxCap: 50, scriptPoolDefaultSize: 2 });
  let r = await platformCall('PUT', `/workspaces/${ws2.id}/limits`, { scriptPoolMaxSize: 3, lockedOverflowMode: 'reject', maxActiveInstancesCap: 7 });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.data.caps.scriptPoolMaxSize, 3);
  assert.strictEqual((await platformCall('PUT', `/workspaces/${ws2.id}/limits`, { scriptPoolMaxSize: 99 })).status, 422, 'cannot lift the global cap');
  assert.strictEqual((await putSettings(ws2, { scriptPoolSize: 4 })).status, 422);
  assert.strictEqual((await putSettings(ws2, { scriptOverflowMode: 'queue' })).status, 422, 'mode is locked');
  assert.strictEqual((await putSettings(ws2, { scriptOverflowMode: 'reject', scriptPoolSize: 3, maxActiveInstances: 7 })).status, 200);
  assert.strictEqual((await getSettings(ws2)).body.effectiveLimits.scriptOverflowMode, 'reject');
  assert.strictEqual((await platformCall('GET', `/workspaces/nope/limits`)).status, 404);
  // clearing the override (null) restores the global caps
  await platformCall('PUT', `/workspaces/${ws2.id}/limits`, { scriptPoolMaxSize: null, lockedOverflowMode: null, maxActiveInstancesCap: null });
  assert.strictEqual((await platformCall('GET', `/workspaces/${ws2.id}/limits`)).body.data.caps.scriptPoolMaxSize, 6);
});

test('PLIM-5 live apply: changing the platform limits resizes live pools without a restart and without dropping queued work', async () => {
  configureSandbox({ queueTimeoutMs: 20_000, idleMs: 60_000 });
  await platformCall('PUT', '/limits', { scriptPoolMaxSize: 8, scriptPoolDefaultSize: 1, scriptQueueDefaultMax: 100, scriptQueueMaxCap: 1000, scriptQueueTimeoutMs: 20_000 });
  await platformCall('PUT', `/workspaces/${ws.id}/limits`, { scriptPoolDefaultSize: 1, scriptPoolMaxSize: 8 });
  const rs = await putSettings(ws, { scriptPoolSize: null, maxConcurrentScripts: 0, scriptQueueMax: 100, scriptOverflowMode: 'queue' });
  assert.strictEqual(rs.status, 200, JSON.stringify(rs.body));
  const ctx = ws.ctx;
  const burn = (ms: number) => `var t = Date.now(); while (Date.now() - t < ${ms}) {} vars.done = true`;
  const run = async (code: string) => {
    const { effective } = await effectiveLimitsFor(ctx);
    const vars: Record<string, unknown> = {};
    await runScript(code, vars, 5000, { tenantId: ctx.tenantId, maxConcurrentScripts: effective.scriptPoolSize, scriptQueueMax: effective.scriptQueueMax, scriptOverflowMode: effective.scriptOverflowMode });
    return vars;
  };
  const t0 = performance.now();
  const hog = run(burn(400));
  await new Promise((r) => setTimeout(r, 30));
  const waiters = Array.from({ length: 4 }, () => run(burn(150)));
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(sandboxStats().effectiveConcurrency[ws.id], 1);
  assert.strictEqual(sandboxStats().queued[ws.id], 4, 'four are waiting behind the single isolate');
  // the platform admin raises the workspace's default pool size → the live pool grows, queued work starts at once
  await platformCall('PUT', `/workspaces/${ws.id}/limits`, { scriptPoolDefaultSize: 4 });
  assert.strictEqual(sandboxStats().effectiveConcurrency[ws.id], 4, 'resized live');
  const done = await Promise.all(waiters);
  const elapsed = performance.now() - t0;
  assert.ok(done.every((v) => v.done === true), 'no queued execution was dropped');
  assert.ok(elapsed < 400 + 4 * 150 - 150, `queued work ran in parallel after the resize (${elapsed.toFixed(0)}ms)`);
  await hog;
  // shrinking: idle isolates are drained, busy ones retired after their run
  await platformCall('PUT', `/workspaces/${ws.id}/limits`, { scriptPoolDefaultSize: 1 });
  assert.strictEqual(sandboxStats().effectiveConcurrency[ws.id], 1);
  assert.ok((sandboxStats().isolatesAlive[ws.id] ?? 0) <= 1, `pool shrank (alive ${sandboxStats().isolatesAlive[ws.id]})`);
  assert.strictEqual((await run('vars.ok = 1')).ok, 1, 'still works after shrinking');
});

test('PLIM-6 validation: non-integers, negatives, wrong types and bad enums are refused (platform + workspace level)', async () => {
  for (const body of [{ scriptPoolMaxSize: 1.5 }, { scriptPoolMaxSize: 0 }, { scriptPoolMaxSize: -3 }, { scriptPoolMaxSize: '8' }, { scriptQueueMaxCap: -1 }, { scriptOverflowModeDefault: 'drop' }, { bogus: 1 }, { scriptPoolDefaultSize: 99, scriptPoolMaxSize: 4 }]) {
    assert.strictEqual((await platformCall('PUT', '/limits', body)).status, 422, JSON.stringify(body));
  }
  for (const body of [{ scriptPoolSize: 1.5 }, { scriptPoolSize: -1 }, { scriptPoolSize: '2' }, { scriptQueueMax: -5 }, { scriptQueueMax: 2.5 }, { scriptOverflowMode: 'drop' }, { maxActiveInstances: -1 }]) {
    assert.strictEqual((await putSettings(ws, body)).status, 422, JSON.stringify(body));
  }
  for (const body of [{ scriptPoolMaxSize: 0 }, { lockedOverflowMode: 'x' }, { nope: 1 }, { scriptQueueMaxCap: 1.2 }]) {
    assert.strictEqual((await platformCall('PUT', `/workspaces/${ws.id}/limits`, body)).status, 422, JSON.stringify(body));
  }
  assert.strictEqual((await platformCall('PUT', '/limits', { scriptPoolMaxSize: 16, scriptPoolDefaultSize: 2, scriptQueueMaxCap: 1000 })).status, 200);
});

test('PLIM-7 every platform change is audited; usage endpoint reflects live pool load', async () => {
  const audits = await h.store.repo<AuditEvent>(Collections.audit).query((a) => a.kind.startsWith('platform.'));
  assert.ok(audits.some((a) => a.kind === 'platform.limits.updated'), 'global change audited');
  assert.ok(audits.some((a) => a.kind === 'platform.workspace-limits.updated' && (a.data as any)?.workspaceId === ws.id), 'workspace change audited');
  assert.ok(audits.every((a) => a.actor === PLATFORM_ADMIN_EMAIL), 'with the acting platform admin');
  assert.ok((await h.store.repo<AuditEvent>(Collections.audit).query((a) => a.kind === 'settings.updated')).length > 0, 'workspace settings change audited too');

  await platformCall('PUT', `/workspaces/${ws.id}/limits`, { scriptPoolDefaultSize: 1 });
  const { effective } = await effectiveLimitsFor(ws.ctx);
  const opts = { tenantId: ws.id, maxConcurrentScripts: effective.scriptPoolSize, scriptQueueMax: 100, scriptOverflowMode: 'queue' };
  const busy = `var t = Date.now(); while (Date.now() - t < 200) {}`;
  const runs = [runScript(busy, {}, 3000, opts), runScript(busy, {}, 3000, opts), runScript(busy, {}, 3000, opts)];
  await new Promise((r) => setTimeout(r, 40));
  const u = (await platformCall('GET', '/limits/usage')).body.data;
  const row = u.workspaces.find((w: any) => w.workspaceId === ws.id);
  assert.strictEqual(row.pool.running, 1);
  assert.strictEqual(row.pool.queued, 2);
  assert.ok(row.pool.created >= 1 && row.pool.isolatesAlive >= 1);
  assert.strictEqual(row.effective.scriptPoolSize, effective.scriptPoolSize);
  assert.ok(row.caps.scriptPoolMaxSize >= 1);
  assert.ok(u.server.totalIsolates >= 1 && u.server.maxIsolates >= 1);
  await Promise.all(runs);
  assert.strictEqual((await platformCall('GET', '/limits/usage')).body.data.workspaces.find((w: any) => w.workspaceId === ws.id).pool.queued, 0);
  const svc = new PlatformLimitsService(h.store);
  assert.ok((await svc.getGlobal()).overriddenFields.length > 0);
});
