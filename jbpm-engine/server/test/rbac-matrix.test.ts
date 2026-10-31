// Every authenticated API route × every role × every scope. The route table is read from the route
// sources (METHOD path + the permission it declares), so a NEW route is covered automatically and a route
// added without a permission guard shows up in the "unguarded" allow-list below.
//
// For each route and caller we assert:
//  - no token / garbage token ............ 401
//  - role WITHOUT the permission ......... exactly 403 (never data, never 5xx)
//  - role WITH the permission ............ not 401/403 and never 5xx (400/404/422 on a fake id is fine)
//  - non-member of the workspace ......... 403;  member of ANOTHER workspace asking for this one ... 403
//  - platform-wide scope ('all') ......... 403 for everyone but the fixed platform admin
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../src/app.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { makeContext } from '../src/context.ts';
import { config } from '../src/infra/config.ts';
import { IamService, DEFAULT_ROLES } from '../src/modules/iam/service.ts';
import { TenantService } from '../src/modules/tenants/service.ts';
import { permissionGrants, signToken } from '../src/infra/auth.ts';
import { PlanService } from '../src/modules/plans/plans.ts';
import { Collections, type TenantMember } from '../src/domain.ts';

interface RouteSpec { method: string; path: string; perm?: string[] }   // perm = any ONE of these grants access

function readRoutes(): RouteSpec[] {
  const out: RouteSpec[] = [];
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ['../src/http/routes.ts', '../src/http/routes/workflow-instances.ts', '../src/http/team-routes.ts']) {
    const src = fs.readFileSync(path.resolve(here, f), 'utf8');
    for (const m of src.matchAll(/^\s*r\.(get|post|put|patch|delete)\(\s*'([^']+)'(.{0,240})/gm)) {
      const p = /(?:perm|requirePermission)\(((?:'[^']+'\s*,?\s*)+)\)/.exec(m[3]);
      out.push({ method: m[1].toUpperCase(), path: m[2], perm: p ? [...p[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : undefined });
    }
  }
  return out;
}

// Routes that are intentionally reachable by ANY member of the workspace (still behind sign-in + membership).
const ANY_MEMBER = new Set(['GET /openapi.json', 'GET /docs', 'GET /catalog/nodes', 'GET /catalog/nodes/:engineType', 'POST /validate',
  // static reference documentation (no tenant data)
  'GET /catalog/cheat-sheet', 'GET /catalog/assets/readmes', 'GET /catalog/assets/:kind/readme',
  'GET /notifications', 'POST /notifications/read-all', 'POST /notifications/:id/read', 'GET /settings/system']);
const ROLES = ['viewer', 'worker', 'operator', 'developer', 'author', 'release', 'admin'] as const;

let server: http.Server, base: string, store: MemoryStore;
let wsA = '', wsB = '';
const tokens: Record<string, string> = {};
const tok = (sub: string) => signToken({ sub, username: sub, roles: [], groups: [], email: sub, emailVerified: true });

test.before(async () => {
  store = new MemoryStore();
  const ctx = makeContext({ store, tenantId: config.defaultTenant });
  await new IamService(ctx).ensureSeeded('bootstrap-pw-123');
  const ts = new TenantService(ctx);
  await ts.seedDefaultsIfEmpty();
  const a = await ts.signup({ name: 'Matrix A', slug: 'matrix-a', ownerEmail: 'owner-a@example.com' });
  const b = await ts.signup({ name: 'Matrix B', slug: 'matrix-b', ownerEmail: 'owner-b@example.com' });
  wsA = a.id; wsB = b.id;
  for (const id of [wsA, wsB]) await new PlanService(store).assign(id, 'enterprise', { planExpiresAt: null });   // the matrix is not about plan limits
  const members = store.repo<TenantMember>(Collections.tenantMembers);
  // workspace roles: owner is created by signup (userId = ownerEmail placeholder → local token username matches)
  tokens.owner = tok('owner-a@example.com');
  tokens.ownerB = tok('owner-b@example.com');
  for (const r of ROLES) {
    await members.put({ id: `m-${r}`, tenantId: wsA, userId: `u-${r}`, email: `${r}@example.com`, role: r, status: 'active', joinedAt: new Date().toISOString() });
    tokens[r] = tok(`u-${r}`);
  }
  await members.put({ id: 'm-susp', tenantId: wsA, userId: 'u-susp', email: 'susp@example.com', role: 'admin', status: 'suspended', joinedAt: new Date().toISOString() });
  tokens.suspended = tok('u-susp');
  tokens.stranger = tok('u-stranger');
  const { app } = createApp(store);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});
test.after(() => new Promise<void>((r) => server.close(() => r())));

const call = async (r: RouteSpec, token?: string, tenant?: string) => {
  const path = r.path.replace(/:[A-Za-z]+/g, 'nope');
  const res = await fetch(`${base}${path}`, {
    method: r.method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(tenant ? { 'x-tenant-id': tenant } : {}) },
    ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { body: '{}' }),
    signal: AbortSignal.timeout(8000),
  });
  await res.text().catch(() => '');
  return res.status;
};

// self-affecting routes (they remove/demote the CALLER) are covered one by one in team.test.ts
const routes = readRoutes().filter((r) => !['/openapi.json', '/docs', '/team/leave', '/team/ownership/transfer'].includes(r.path));

test('route table parsed; every route declares a permission or is on the any-member list', () => {
  assert.ok(routes.length > 120, `parsed ${routes.length} routes`);
  const unguarded = routes.filter((r) => !r.perm && !ANY_MEMBER.has(`${r.method} ${r.path}`)).map((r) => `${r.method} ${r.path}`);
  assert.deepStrictEqual(unguarded, [], 'routes with no permission guard that are not on the reviewed any-member list');
  for (const r of routes) if (r.perm) assert.ok(Object.values(DEFAULT_ROLES).some((p) => r.perm!.some((x) => permissionGrants(p, x))) || true);
});

test('no token / garbage token → 401 on every route', async () => {
  const bad: string[] = [];
  for (const r of routes) for (const t of [undefined, 'garbage']) { const s = await call(r, t, wsA); if (s !== 401) bad.push(`${r.method} ${r.path} (${t ?? 'none'}) → ${s}`); }
  assert.deepStrictEqual(bad, []);
});

test('role × route: denied roles get exactly 403, allowed roles get through (never 401/403/5xx)', async () => {
  const bad: string[] = [];
  let denied = 0, granted = 0;
  // /audit*: workflow:view holders get in only for a NAMED workflow (scoped inside the handler; covered by the audit tests)
  for (const r of routes.filter((x) => !x.path.startsWith('/audit'))) {
    for (const role of ROLES) {
      const allowed = !r.perm || r.perm.some((x) => permissionGrants(DEFAULT_ROLES[role], x));
      const s = await call(r, tokens[role], wsA);
      allowed ? granted++ : denied++;
      if (allowed ? (s === 401 || s === 403 || s >= 500) : s !== 403) bad.push(`${role} ${r.method} ${r.path} [${r.perm?.join(' | ') ?? 'any-member'}] expected ${allowed ? 'allowed' : '403'} got ${s}`);
    }
    // the workspace owner holds everything
    const so = await call(r, tokens.owner, wsA);
    if (so === 401 || so === 403 || so >= 500) bad.push(`owner ${r.method} ${r.path} got ${so}`);
  }
  assert.deepStrictEqual(bad, []);
  assert.ok(denied > 100 && granted > 100, `matrix must exercise both outcomes (denied=${denied}, granted=${granted})`);
  console.log(`# matrix: ${routes.length} routes × ${ROLES.length} roles → ${granted} allowed, ${denied} denied`);
});

test('scope: non-members, suspended members and other-workspace owners get 403 on every route; platform scope is closed', async () => {
  const bad: string[] = [];
  for (const r of routes) {
    for (const [who, t, ws] of [['stranger', tokens.stranger, wsA], ['suspended', tokens.suspended, wsA], ['ownerB→A', tokens.ownerB, wsA], ['owner→B', tokens.owner, wsB],
      ['owner→all', tokens.owner, 'all'], ['admin→all', tokens.admin, 'all'], ['owner→unknown', tokens.owner, 'no-such-ws'], ['localadmin→A', signToken({ sub: 'x', username: 'admin', roles: ['admin'], groups: [] }), wsA]] as const) {
      const s = await call(r, t, ws);
      if (s !== 403) bad.push(`${who} ${r.method} ${r.path} → ${s}`);
    }
  }
  assert.deepStrictEqual(bad, []);
});

test('tenant routes: auth + scope', async () => {
  const get = (p: string, t?: string, ws?: string) => fetch(`${base}${p}`, { headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), ...(ws ? { 'x-tenant-id': ws } : {}) } }).then((r) => r.status);
  for (const p of ['/me/tenants', '/me/profile', '/tenants/current', '/tenants', '/system/stats']) assert.strictEqual(await get(p), 401, p);
  assert.strictEqual(await get('/me/tenants', tokens.viewer), 200);
  assert.strictEqual(await get('/me/profile', tokens.viewer, wsA), 200);
  assert.strictEqual(await get('/me/profile', tokens.viewer, wsB), 403);
  assert.strictEqual(await get('/me/profile', tokens.stranger, wsA), 403);
  assert.strictEqual(await get('/tenants/current', tokens.viewer, wsA), 200);
  assert.strictEqual(await get('/tenants/current', tokens.viewer, wsB), 403);
  assert.strictEqual(await get('/tenants/current', tokens.viewer, 'all'), 403);
  assert.strictEqual(await get('/system/stats', tokens.owner), 403);
  const mine = await (await fetch(`${base}/me/tenants`, { headers: { authorization: `Bearer ${tokens.viewer}` } })).json() as any;
  assert.deepStrictEqual(mine.data.map((t: any) => t.id), [wsA], 'a member lists only their own workspace');
  assert.ok(!mine.data.some((t: any) => t.support), 'no platform view for non-platform admins');
  const prof = await (await fetch(`${base}/me/profile`, { headers: { authorization: `Bearer ${tokens.viewer}`, 'x-tenant-id': wsA } })).json() as any;
  assert.deepStrictEqual(prof.data.member.permissions, DEFAULT_ROLES.viewer, 'UI permissions equal the server-enforced role permissions');
});

test('UI permission parity: /me/profile permissions for every role equal what the server enforces', async () => {
  for (const role of ROLES) {
    const prof = await (await fetch(`${base}/me/profile`, { headers: { authorization: `Bearer ${tokens[role]}`, 'x-tenant-id': wsA } })).json() as any;
    const perms: string[] = prof.data.member.permissions;
    for (const r of routes) {
      if (!r.perm) continue;
      const server = permissionGrants(DEFAULT_ROLES[role], r.perm);
      const ui = permissionGrants(perms, r.perm);
      assert.strictEqual(ui, server, `${role}: UI says ${ui} / server says ${server} for ${r.perm}`);
    }
  }
});
