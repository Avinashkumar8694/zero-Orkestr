// Single sign-on + multi-tenant authorization, end to end against a FAKE identity server (discovery, JWKS,
// token endpoint): authorization code + PKCE, bearer verification (iss/aud/alg), claim-by-verified-email,
// workspace isolation, role→permission mapping, SSO-gated signup, and tenant-scoped WS subscriptions.
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { makeContext } from '../src/context.ts';
import { config } from '../src/infra/config.ts';
import { oidc } from '../src/infra/oidc.ts';
import { IamService } from '../src/modules/iam/service.ts';
import { TenantService } from '../src/modules/tenants/service.ts';
import { signToken } from '../src/infra/auth.ts';
import { PLATFORM_ADMIN_EMAIL } from '../src/infra/config.ts';
import { authorizeWsTenant, canSubscribe } from '../src/infra/ws-auth.ts';
import { Collections, type Instance, type TenantMember } from '../src/domain.ts';

const CLIENT_ID = 'zero-orkestr';
const CLIENT_SECRET = 'test-client-secret';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };

let idp: http.Server, idpUrl: string, api: http.Server, base: string, store: MemoryStore;
let lastTokenRequest: { auth?: string; body: URLSearchParams } | undefined;
let nextNonce = '';

const idToken = (claims: Record<string, unknown>, opts: jwt.SignOptions & { key?: crypto.KeyObject } = {}) =>
  jwt.sign({ sub: 'sub-1', ...claims }, opts.key ?? privateKey, { algorithm: 'RS256', keyid: 'k1', issuer: idpUrl, audience: CLIENT_ID, expiresIn: '1h', ...opts, ...(opts.key ? {} : {}) } as jwt.SignOptions);
const bearer = (claims: Record<string, unknown>, opts: jwt.SignOptions = {}) => idToken({ email_verified: true, ...claims }, opts);

const listen = (s: http.Server) => new Promise<string>((resolve) => s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as any).port}`)));

test.before(async () => {
  idp = http.createServer((req, res) => {
    const send = (o: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (req.url === '/oidc/.well-known/openid-configuration') return send({
      issuer: idpUrl, authorization_endpoint: `${idpUrl}/auth`, token_endpoint: `${idpUrl}/token`,
      jwks_uri: `${idpUrl}/jwks`, end_session_endpoint: `${idpUrl}/session/end`,
    });
    if (req.url === '/oidc/jwks') return send({ keys: [jwk] });
    if (req.url === '/oidc/token' && req.method === 'POST') {
      let raw = ''; req.on('data', (c) => raw += c); req.on('end', () => {
        lastTokenRequest = { auth: req.headers.authorization, body: new URLSearchParams(raw) };
        if (lastTokenRequest.body.get('code') !== 'good-code') { res.statusCode = 400; return send({ error: 'invalid_grant' }); }
        send({ access_token: bearer({ email: 'carol@example.com' }), id_token: idToken({ email: 'carol@example.com', nonce: nextNonce }), expires_in: 3600 });
      });
      return;
    }
    res.statusCode = 404; res.end();
  });
  idpUrl = await listen(idp);
  idpUrl += '/oidc';

  Object.assign(config.oidc, { issuer: idpUrl, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, audience: [CLIENT_ID], redirectUri: 'http://localhost:4000/api/auth/oidc/callback' });
  oidc.reset();

  store = new MemoryStore();
  const ctx = makeContext({ store, tenantId: config.defaultTenant });
  await new IamService(ctx).ensureSeeded('bootstrap-pw-123');
  await new TenantService(ctx).seedDefaultsIfEmpty();
  const { app } = createApp(store);
  api = http.createServer(app);
  base = (await listen(api)) + '/api';
});

test.after(async () => {
  Object.assign(config.oidc, { issuer: undefined, clientId: undefined, clientSecret: undefined });
  await Promise.all([new Promise((r) => api.close(r)), new Promise((r) => idp.close(r))]);
});

const get = (path: string, token?: string, tenant?: string) => fetch(`${base}${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { 'x-tenant-id': tenant } : {}) }, redirect: 'manual' });
const post = (path: string, body: unknown, token?: string, tenant?: string) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { 'x-tenant-id': tenant } : {}) }, body: JSON.stringify(body) });
const addMember = (m: Partial<TenantMember> & { tenantId: string; role: string }) =>
  store.repo<TenantMember>(Collections.tenantMembers).put({ id: `m_${Math.random().toString(36).slice(2)}`, userId: '', status: 'active', joinedAt: new Date().toISOString(), ...m } as TenantMember);

test('/auth/config advertises SSO and local login', async () => {
  const body = await (await get('/auth/config')).json() as any;
  assert.strictEqual(body.sso, true);
  assert.strictEqual(body.localLogin, true);
});

test('login redirects to the IdP with PKCE S256 + state + nonce and a signed HttpOnly transaction cookie', async () => {
  const res = await get('/auth/oidc/login?redirect=/projects');
  assert.strictEqual(res.status, 302);
  const loc = new URL(res.headers.get('location')!);
  assert.strictEqual(loc.origin + loc.pathname, `${idpUrl}/auth`);
  assert.strictEqual(loc.searchParams.get('client_id'), CLIENT_ID);
  assert.strictEqual(loc.searchParams.get('response_type'), 'code');
  assert.strictEqual(loc.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(loc.searchParams.get('scope'), 'openid email profile');
  assert.strictEqual(loc.searchParams.get('redirect_uri'), 'http://localhost:4000/api/auth/oidc/callback');
  assert.ok(loc.searchParams.get('state') && loc.searchParams.get('nonce') && loc.searchParams.get('code_challenge'));
  const cookie = res.headers.get('set-cookie')!;
  assert.match(cookie, /oidc_tx=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
});

async function startLogin(returnTo = '/projects') {
  const res = await get(`/auth/oidc/login?redirect=${encodeURIComponent(returnTo)}`);
  const loc = new URL(res.headers.get('location')!);
  nextNonce = loc.searchParams.get('nonce')!;
  return { state: loc.searchParams.get('state')!, cookie: res.headers.get('set-cookie')!.split(';')[0] };
}
const callback = (qs: string, cookie?: string) => fetch(`${base}/auth/oidc/callback?${qs}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
const fragmentOf = (res: Response) => new URLSearchParams(new URL(res.headers.get('location')!).hash.slice(1));

test('callback exchanges the code with client_secret_basic + PKCE verifier and returns tokens in the URL fragment', async () => {
  const { state, cookie } = await startLogin('/projects');
  const res = await callback(`code=good-code&state=${state}`, cookie);
  assert.strictEqual(res.status, 302);
  const loc = new URL(res.headers.get('location')!);
  assert.strictEqual(loc.origin + loc.pathname, `${config.dashboardUrl}/auth/callback`);
  assert.strictEqual(loc.search, '', 'tokens must never be in the query string');
  const frag = fragmentOf(res);
  assert.ok(frag.get('access_token') && frag.get('id_token'));
  assert.strictEqual(frag.get('return_to'), '/projects');
  assert.strictEqual(lastTokenRequest!.auth, `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`);
  assert.ok(lastTokenRequest!.body.get('code_verifier'));
  assert.strictEqual(lastTokenRequest!.body.get('redirect_uri'), 'http://localhost:4000/api/auth/oidc/callback');
  assert.match(res.headers.get('set-cookie')!, /oidc_tx=;.*Max-Age=0/, 'transaction cookie is single use');
});

test('callback rejects a missing cookie, a wrong state, a bad code and an open-redirect return_to', async () => {
  const noCookie = await callback('code=good-code&state=x');
  assert.match(fragmentOf(noCookie).get('error')!, /Session expired/);

  const a = await startLogin();
  assert.match(fragmentOf(await callback('code=good-code&state=WRONG', a.cookie)).get('error')!, /Session expired/);

  const b = await startLogin();
  assert.match(fragmentOf(await callback(`code=bad&state=${b.state}`, b.cookie)).get('error')!, /expired or already used/);

  const c = await startLogin('//evil.example.com');
  assert.strictEqual(fragmentOf(await callback(`code=good-code&state=${c.state}`, c.cookie)).get('return_to'), null);
});

test('a forged transaction cookie (wrong signature) is refused', async () => {
  const { state } = await startLogin();
  const forged = `oidc_tx=${Buffer.from(JSON.stringify({ v: 'v', s: state, n: nextNonce, exp: Date.now() + 1e6 })).toString('base64url')}.AAAA`;
  assert.match(fragmentOf(await callback(`code=good-code&state=${state}`, forged)).get('error')!, /Session expired/);
});

test('logout goes to the IdP end-session endpoint', async () => {
  const res = await get('/auth/oidc/logout?id_token_hint=abc');
  const loc = new URL(res.headers.get('location')!);
  assert.strictEqual(loc.origin + loc.pathname, `${idpUrl}/session/end`);
  assert.strictEqual(loc.searchParams.get('id_token_hint'), 'abc');
  assert.strictEqual(loc.searchParams.get('post_logout_redirect_uri'), config.dashboardUrl);
});

test('bearer verification: only tokens signed by the issuer, for this client, unexpired, asymmetric', async () => {
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const cases: Array<[string, string]> = [
    ['signed with a foreign key', jwt.sign({ sub: 's', email_verified: true }, other.privateKey, { algorithm: 'RS256', keyid: 'k1', issuer: idpUrl, audience: CLIENT_ID })],
    ['wrong audience', bearer({}, { audience: 'someone-else' })],
    ['wrong issuer', bearer({}, { issuer: 'https://evil.example.com/oidc' })],
    ['expired', bearer({}, { expiresIn: -120 })],
    ['alg none', `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'x', iss: idpUrl, aud: CLIENT_ID })).toString('base64url')}.`],
    ['HS256 keyed with the public JWKS material (algorithm confusion)', jwt.sign({ sub: 'x', iss: idpUrl, aud: CLIENT_ID }, JSON.stringify(jwk), { algorithm: 'HS256' })],
  ];
  for (const [name, token] of cases) assert.strictEqual((await get('/workflows', token)).status, 401, name);
});

test('an authenticated identity with NO membership gets 403, not data', async () => {
  const res = await get('/workflows', bearer({ sub: 'nobody', email: 'nobody@example.com' }));
  assert.strictEqual(res.status, 403);
});

test('a membership pre-created for an email is claimed on first VERIFIED sign-in only', async () => {
  await addMember({ tenantId: config.defaultTenant, userId: 'dave@example.com', email: 'dave@example.com', role: 'viewer' });
  const unverified = jwt.sign({ sub: 'sub-dave', email: 'dave@example.com', email_verified: false }, privateKey, { algorithm: 'RS256', keyid: 'k1', issuer: idpUrl, audience: CLIENT_ID });
  assert.strictEqual((await get('/workflows', unverified)).status, 403, 'unverified email must not claim a seat');
  assert.strictEqual((await get('/workflows', bearer({ sub: 'sub-dave', email: 'dave@example.com' }))).status, 200);
  const bound = (await store.repo<TenantMember>(Collections.tenantMembers).query((m) => m.email === 'dave@example.com'))[0];
  assert.strictEqual(bound.userId, 'sub-dave');
  // an already-bound seat can't be taken over by another identity presenting the same email
  assert.strictEqual((await get('/workflows', bearer({ sub: 'sub-mallory', email: 'dave@example.com' }))).status, 403);
});

test('workspace isolation: members only reach their own workspace; x-tenant-id cannot escalate', async () => {
  const ctx = makeContext({ store, tenantId: config.defaultTenant });
  const ts = new TenantService(ctx);
  const t1 = await ts.signup({ name: 'Alpha', slug: 'alpha', ownerEmail: 'a@example.com' }, { sub: 'sub-a', username: 'a@example.com', email: 'a@example.com', emailVerified: true, source: 'oidc' });
  const t2 = await ts.signup({ name: 'Beta', slug: 'beta', ownerEmail: 'b@example.com' }, { sub: 'sub-b', username: 'b@example.com', email: 'b@example.com', emailVerified: true, source: 'oidc' });
  const a = bearer({ sub: 'sub-a', email: 'a@example.com' });
  assert.strictEqual((await get('/workflows', a, t1.id)).status, 200);
  assert.strictEqual((await get('/workflows', a, t2.id)).status, 403);
  assert.strictEqual((await get('/workflows', a, 'all')).status, 403);
  assert.strictEqual((await get('/workflows', a, config.defaultTenant)).status, 403);
  const cur = await get('/tenants/current', a, t2.id);
  assert.strictEqual(cur.status, 403, 'tenant details (plan, owner email) are not readable cross-tenant');
  assert.strictEqual((await get('/me/profile', a, t2.id)).status, 403, 'no invented viewer profile for non-members');
  const mine = await (await get('/me/tenants', a)).json() as any;
  assert.deepStrictEqual(mine.data.map((t: any) => t.id), [t1.id]);
  assert.strictEqual((await get('/system/stats', a)).status, 403);
});

test('roles map to permissions inside a brand-new workspace (no Role rows needed)', async () => {
  const t = await new TenantService(makeContext({ store, tenantId: config.defaultTenant })).signup({ name: 'Gamma', slug: 'gamma', ownerEmail: 'o@example.com' }, { sub: 'sub-o', username: 'o@example.com', email: 'o@example.com', emailVerified: true, source: 'oidc' });
  await addMember({ tenantId: t.id, userId: 'sub-viewer', email: 'v@example.com', role: 'viewer' });
  await addMember({ tenantId: t.id, userId: 'sub-dev', email: 'dv@example.com', role: 'developer' });
  const v = bearer({ sub: 'sub-viewer', email: 'v@example.com' }), d = bearer({ sub: 'sub-dev', email: 'dv@example.com' }), o = bearer({ sub: 'sub-o', email: 'o@example.com' });
  assert.strictEqual((await get('/workflows', v, t.id)).status, 200);
  assert.strictEqual((await post('/workflows', { name: 'x' }, v, t.id)).status, 403, 'viewer cannot edit');
  assert.notStrictEqual((await post('/workflows', { name: 'x' }, d, t.id)).status, 403, 'developer can edit');
  // a developer (task:manage) may list assignees, but only a minimal projection — and is not an IAM admin otherwise
  const assignees = await get('/users', d, t.id);
  assert.strictEqual(assignees.status, 200);
  assert.ok(((await assignees.json()) as any).items.every((u: any) => u.email === undefined && u.roles === undefined), 'no e-mail/roles for non-admins');
  assert.strictEqual((await post('/users', { username: 'x', password: 'Sup3r-secret-pw' }, d, t.id)).status, 403, 'developer is not an IAM admin');
  assert.strictEqual((await get('/users', o, t.id)).status, 200, 'owner is');
  const profile = await (await get('/me/profile', d, t.id)).json() as any;
  assert.ok(profile.data.member.permissions.includes('workflow:edit'), 'UI profile reflects the role');
});

test('the platform admin email is seeded as system_admin, and it is the ONLY platform admin', async () => {
  const seeded = (await store.repo<TenantMember>(Collections.tenantMembers).query((m) => m.email === PLATFORM_ADMIN_EMAIL))[0];
  assert.strictEqual(seeded.role, 'system_admin');
  assert.strictEqual(seeded.tenantId, config.defaultTenant);

  const gamma = (await store.repo<any>(Collections.tenants).query((t: any) => t.slug === 'gamma'))[0];
  const root = bearer({ sub: 'sub-root', email: PLATFORM_ADMIN_EMAIL });
  assert.strictEqual((await get('/workflows', root, gamma.id)).status, 200);
  assert.strictEqual((await get('/workflows', root, 'all')).status, 200);
  assert.strictEqual((await get('/system/stats', root)).status, 200);

  // a system_admin ROLE on someone else's membership, the first member, and the local admin confer nothing platform-wide
  await addMember({ tenantId: config.defaultTenant, userId: 'sub-fake', email: 'fake@example.com', role: 'system_admin', permissions: ['*'] });
  const fake = bearer({ sub: 'sub-fake', email: 'fake@example.com' });
  assert.strictEqual((await get('/workflows', fake, gamma.id)).status, 403);
  assert.strictEqual((await get('/workflows', fake, 'all')).status, 403);
  assert.strictEqual((await get('/system/stats', fake)).status, 403);
  const localAdmin = await (await post('/auth/login', { username: 'admin', password: 'bootstrap-pw-123' })).json() as any;
  assert.strictEqual((await get('/workflows', localAdmin.token, gamma.id)).status, 403);
  assert.strictEqual((await get('/system/stats', localAdmin.token)).status, 403);
  assert.strictEqual((await get('/workflows', localAdmin.token)).status, 200, 'local admin still works in the default workspace');
  // an unverified email never counts
  const unverified = jwt.sign({ sub: 'sub-x', email: PLATFORM_ADMIN_EMAIL, email_verified: false }, privateKey, { algorithm: 'RS256', keyid: 'k1', issuer: idpUrl, audience: CLIENT_ID });
  assert.strictEqual((await get('/system/stats', unverified)).status, 403);
});

test('SSO workspace signup needs a sign-in and ignores a free-text owner email', async () => {
  const anon = await post('/tenants/signup', { name: 'Squat', slug: 'squat', ownerEmail: 'victim@example.com' });
  assert.strictEqual(anon.status, 401);
  const res = await post('/tenants/signup', { name: 'Delta', slug: 'delta', ownerEmail: 'victim@example.com' }, bearer({ sub: 'sub-c', email: 'carol@example.com' }));
  assert.strictEqual(res.status, 201);
  const t = (await res.json() as any).data;
  assert.strictEqual(t.ownerEmail, 'carol@example.com');
  const m = (await store.repo<TenantMember>(Collections.tenantMembers).query((x) => x.tenantId === t.id))[0];
  assert.strictEqual(m.userId, 'sub-c');
  assert.strictEqual(m.role, 'owner');
  const unverified = jwt.sign({ sub: 'sub-u', email: 'u@example.com', email_verified: false }, privateKey, { algorithm: 'RS256', keyid: 'k1', issuer: idpUrl, audience: CLIENT_ID });
  assert.strictEqual((await post('/tenants/signup', { name: 'Eps', slug: 'epsilon', ownerEmail: 'u@example.com' }, unverified)).status, 403);
});

test('local login keeps working alongside SSO, and an SSO user cannot change a local password', async () => {
  const res = await post('/auth/login', { username: 'admin', password: 'bootstrap-pw-123' });
  assert.strictEqual(res.status, 200);
  const pw = await post('/auth/me/password', { currentPassword: 'x', newPassword: 'yyyyyyyy' }, bearer({ sub: 'sub-c', email: 'carol@example.com' }));
  assert.strictEqual(pw.status, 403);
});

test('WebSocket: a socket is bound to a workspace it belongs to and only sees that workspace\'s instances', async () => {
  const ctx = makeContext({ store, tenantId: config.defaultTenant });
  const t1 = (await store.repo<any>(Collections.tenants).query((t: any) => t.slug === 'alpha'))[0];
  const t2 = (await store.repo<any>(Collections.tenants).query((t: any) => t.slug === 'beta'))[0];
  await store.repo<Instance>(Collections.instances).put({ id: 'inst-alpha', tenantId: t1.id } as Instance);
  await store.repo<Instance>(Collections.instances).put({ id: 'inst-beta', tenantId: t2.id } as Instance);
  const claims = { sub: 'sub-a', username: 'a@example.com', email: 'a@example.com', emailVerified: true, source: 'oidc' as const, roles: [], groups: [] };
  const req = (tenant: string) => ({ url: `/ws?tenant=${tenant}` } as http.IncomingMessage);
  assert.strictEqual(await authorizeWsTenant(store, claims, req(t2.id)), null, 'cannot attach to another workspace');
  assert.strictEqual(await authorizeWsTenant(store, claims, req('all')), null);
  const s = (await authorizeWsTenant(store, claims, req(t1.id)))!;
  assert.ok(s);
  assert.strictEqual(await canSubscribe(store, s, 'instance:inst-alpha'), true);
  assert.strictEqual(await canSubscribe(store, s, 'instance:inst-beta'), false);
  assert.strictEqual(await canSubscribe(store, s, 'instance:nope'), false);
  assert.strictEqual(await canSubscribe(store, s, 'whatever'), false);
  void ctx; void signToken;
});
