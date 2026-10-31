import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { createApp } from '../src/app.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { makeContext } from '../src/context.ts';
import { config } from '../src/infra/config.ts';
import { IamService } from '../src/modules/iam/service.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { AssetsService } from '../src/modules/assets/service.ts';

let server: http.Server;
let base: string;
let store: MemoryStore;
let adminToken: string;
let authorToken: string;
let workerToken: string;
let wf1Id: string;
let wf2Id: string;
let wf2EventId: string;

test.before(async () => {
  store = new MemoryStore();
  const ctx = makeContext({ store, tenantId: config.defaultTenant });
  const iam = new IamService(ctx);
  await iam.ensureSeeded('admin-password');

  // Create users: author (workflow:view, workflow:edit) and worker (task:manage)
  await iam.createUser({ username: 'author1', password: 'password123', roles: ['author'] }, 'admin');
  await iam.createUser({ username: 'worker1', password: 'password123', roles: ['worker'] }, 'admin');

  // Create two projects and add assets to generate audit events
  const wf1 = await new WorkflowService(ctx).create({ name: 'ClaimsProject' }, 'author1');
  const wf2 = await new WorkflowService(ctx).create({ name: 'PolicyProject' }, 'admin');
  wf1Id = wf1.id;
  wf2Id = wf2.id;

  const assets = new AssetsService(ctx);
  await assets.add(wf1.id, 'forms', 'ClaimForm', 'author1');
  await assets.add(wf2.id, 'forms', 'PolicyForm', 'admin');

  const { app } = createApp(store);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/api`;

  adminToken = (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin-password' }) })).json() as any).token;
  authorToken = (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'author1', password: 'password123' }) })).json() as any).token;
  workerToken = (await (await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'worker1', password: 'password123' }) })).json() as any).token;
});

test.after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('Audit log permissions & workspace scoping', async () => {
  // 1. Admin can access global audit and sees events across all workspaces
  const adminRes = await fetch(`${base}/audit`, { headers: { Authorization: `Bearer ${adminToken}` } });
  assert.strictEqual(adminRes.status, 200);
  const adminBody = await adminRes.json() as any;
  assert(adminBody.items.length >= 2);

  // 2. Author (non-admin) calling global /api/audit without workflowId is blocked (403)
  const authorGlobalRes = await fetch(`${base}/audit`, { headers: { Authorization: `Bearer ${authorToken}` } });
  assert.strictEqual(authorGlobalRes.status, 403);
  const authorGlobalBody = await authorGlobalRes.json() as any;
  assert(authorGlobalBody.error.message.includes('non-admin users must specify a workflowId'));

  // 3. Author calling global /api/audit?workflowId=wf1.id succeeds and only sees wf1 events
  const authorScopedGlobalRes = await fetch(`${base}/audit?workflowId=${wf1Id}`, { headers: { Authorization: `Bearer ${authorToken}` } });
  assert.strictEqual(authorScopedGlobalRes.status, 200);
  const authorScopedGlobalBody = await authorScopedGlobalRes.json() as any;
  assert(authorScopedGlobalBody.items.every((e: any) => e.workflowId === wf1Id));
  assert(authorScopedGlobalBody.items.some((e: any) => e.data?.name === 'ClaimForm'));
  assert(!authorScopedGlobalBody.items.some((e: any) => e.data?.name === 'PolicyForm'));

  // 4. Author calling dedicated /api/workflows/:id/audit succeeds (scoped to project)
  const authorWfAuditRes = await fetch(`${base}/workflows/${wf1Id}/audit`, { headers: { Authorization: `Bearer ${authorToken}` } });
  assert.strictEqual(authorWfAuditRes.status, 200);
  const authorWfAuditBody = await authorWfAuditRes.json() as any;
  assert(authorWfAuditBody.items.length >= 1);
  assert(authorWfAuditBody.items.every((e: any) => e.workflowId === wf1Id));

  // 5. Author calling /api/workflows/:id/audit/facets gets facets for wf1 only
  const authorFacetsRes = await fetch(`${base}/workflows/${wf1Id}/audit/facets`, { headers: { Authorization: `Bearer ${authorToken}` } });
  assert.strictEqual(authorFacetsRes.status, 200);
  const authorFacetsBody = await authorFacetsRes.json() as any;
  assert(authorFacetsBody.actors.includes('author1'));

  // 6. Worker (no workflow:view permission) is rejected with 403
  const workerRes = await fetch(`${base}/workflows/${wf1Id}/audit`, { headers: { Authorization: `Bearer ${workerToken}` } });
  assert.strictEqual(workerRes.status, 403);

  // 7. Author calling /api/workflows/:id/audit/:eventId for wf2 event returns 404 (isolation)
  const wf2Events = (await (await fetch(`${base}/workflows/${wf2Id}/audit`, { headers: { Authorization: `Bearer ${adminToken}` } })).json() as any).items;
  wf2EventId = wf2Events[0].id;

  const crossWfRes = await fetch(`${base}/workflows/${wf1Id}/audit/${wf2EventId}`, { headers: { Authorization: `Bearer ${authorToken}` } });
  assert.strictEqual(crossWfRes.status, 404);
});
