// Cross-tenant ID guessing: a stub entity owned by workspace A exists in EVERY collection under a known id;
// the owner of workspace B (full permissions in B) then hits every id-addressed route with that id. No route
// may reveal, change or delete A's data: the answer must be a 4xx, never 2xx, never 5xx.
// Also: B's collections/analytics never include A's rows.
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
import { IamService } from '../src/modules/iam/service.ts';
import { TenantService } from '../src/modules/tenants/service.ts';
import { signToken } from '../src/infra/auth.ts';
import { PlanService } from '../src/modules/plans/plans.ts';
import { Collections } from '../src/domain.ts';

let server: http.Server, base: string, store: MemoryStore, wsA = '', wsB = '';
const tok = (sub: string) => signToken({ sub, username: sub, roles: [], groups: [], email: sub, emailVerified: true });
const tokA = tok('owner-a@example.com'), tokB = tok('owner-b@example.com');

test.before(async () => {
  store = new MemoryStore();
  const ctx = makeContext({ store, tenantId: config.defaultTenant });
  await new IamService(ctx).ensureSeeded('bootstrap-pw-123');
  const ts = new TenantService(ctx);
  await ts.seedDefaultsIfEmpty();
  wsA = (await ts.signup({ name: 'Iso A', slug: 'iso-a', ownerEmail: 'owner-a@example.com' })).id;
  wsB = (await ts.signup({ name: 'Iso B', slug: 'iso-b', ownerEmail: 'owner-b@example.com' })).id;
  for (const id of [wsA, wsB]) await new PlanService(store).assign(id, 'enterprise', { planExpiresAt: null });
  const { app } = createApp(store);
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}/api`;
});
test.after(() => new Promise<void>((r) => server.close(() => r())));

function idRoutes() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const out: Array<{ method: string; path: string }> = [];
  for (const f of ['../src/http/routes.ts', '../src/http/routes/workflow-instances.ts', '../src/http/team-routes.ts']) {
    const src = fs.readFileSync(path.resolve(here, f), 'utf8');
    for (const m of src.matchAll(/^\s*r\.(get|post|put|patch|delete)\(\s*'([^']*:[^']+)'/gm)) {
      // broadcast signals take a signal NAME, not an entity id, and only ever reach instances of the CALLER's workspace
      // (execution-engine.broadcastSignal filters by tenantId) — asserted separately below
      if (/\/signals?\/:signalName$/.test(m[2])) continue;
      out.push({ method: m[1].toUpperCase(), path: m[2] });
    }
  }
  return out;
}

test('B (full rights in B) cannot read, change or delete A\'s entities by id on any route', async () => {
  for (const c of Object.values(Collections)) {
    if (['tenants', 'tenantMembers', 'plans', 'users', 'roles'].includes(c)) continue;
    await store.repo<any>(c).put({ id: 'victim', tenantId: wsA, name: 'SECRET-A', message: 'SECRET-A', workflowId: 'victim', deploymentId: 'victim', instanceId: 'victim', versionId: 'victim', processId: 'victim', status: 'active' });
  }
  const routes = idRoutes();
  assert.ok(routes.length > 60, `parsed ${routes.length} id routes`);
  const bad: string[] = [];
  for (const r of routes) {
    const p = r.path.replace(/:[A-Za-z]+/g, 'victim');
    const res = await fetch(`${base}${p}`, {
      method: r.method,
      headers: { authorization: `Bearer ${tokB}`, 'x-tenant-id': wsB, 'content-type': 'application/json' },
      ...(r.method === 'GET' || r.method === 'DELETE' ? {} : { body: '{}' }),
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.text();
    // a GET may answer 200 with an EMPTY filtered list (e.g. /workflows/:id/branches), but never with A's row;
    // anything that writes must be refused outright; nothing may 5xx
    const ok = res.status >= 500 ? false : res.status >= 400 ? true : r.method === 'GET' && !body.includes('SECRET-A');
    if (!ok) bad.push(`${r.method} ${r.path} → ${res.status}`);
  }
  assert.deepStrictEqual(bad, [], 'routes that answered B about A\'s entity');
  // A's stubs are untouched
  for (const c of Object.values(Collections)) {
    if (['tenants', 'tenantMembers', 'plans', 'users', 'roles'].includes(c)) continue;
    assert.ok(await store.repo<any>(c).get('victim'), `${c}/victim still exists`);
  }
});

test('B\'s list and analytics endpoints never include A\'s rows', async () => {
  const get = async (p: string, t = tokB, ws = wsB) => { const r = await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${t}`, 'x-tenant-id': ws } }); return { status: r.status, text: await r.text() }; };
  const lists = ['/workflows', '/folders', '/deployments', '/instances', '/tasks', '/errors', '/timers', '/audit', '/notifications', '/users', '/groups', '/roles',
    '/query/analytics/summary', '/query/process-instances', '/query/tasks', '/workflow-instances', '/workflow-analytics/summary', '/catalog/processes'];
  for (const p of lists) {
    const r = await get(p);
    if (r.status === 404) continue;                      // path not part of this build's surface
    assert.ok(r.status < 500, `${p} → ${r.status}`);
    assert.ok(!r.text.includes('SECRET-A') && !r.text.includes('victim'), `${p} leaked A's data`);
  }
  // analytics scoped: A's summary sees the stub rows, B's does not
  const sumA = await get('/query/analytics/summary', tokA, wsA);
  const sumB = await get('/query/analytics/summary', tokB, wsB);
  if (sumA.status === 200 && sumB.status === 200) {
    const a = JSON.parse(sumA.text), b = JSON.parse(sumB.text);
    assert.ok((a.instances?.total ?? 0) >= (b.instances?.total ?? 0));
    assert.strictEqual(b.instances?.total ?? 0, 0, 'B has no instances of its own');
  }
});

test('broadcast signals only reach the caller\'s own workspace', async () => {
  for (const p of ['/signals/victim', '/workflow-instances/signal/victim']) {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: { authorization: `Bearer ${tokB}`, 'x-tenant-id': wsB, 'content-type': 'application/json' }, body: '{}' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(((await res.json()) as any).signaled, 0, 'B signalled nothing of A\'s');
  }
});
