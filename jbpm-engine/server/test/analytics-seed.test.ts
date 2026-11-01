// Built-in analytics APIs ship as versioned seed migrations: applied once per workspace, not on every restart.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { boot } from './harness.ts';
import { Collections, type AuditEvent, type Instance } from '../src/domain.ts';
import { resolveWorkflowServiceStore } from '../src/workflow-service/store/index.ts';
import { AnalyticsService, runAnalyticsSeedMigrations, clearAnalyticsCache } from '../src/analytics/service.ts';
import { SEED_MIGRATIONS, LATEST_SEED_VERSION } from '../src/analytics/seed.ts';
import { migrateAnalyticsFor, migrateAnalyticsAll } from '../src/analytics/migrate.ts';

const h = await boot();
const wfs = resolveWorkflowServiceStore(h.store);
const ALL = { actor: 'root', permissions: ['*'] };
const slugs = async (ctx = h.ctx) => (await new AnalyticsService(ctx, wfs).list(ALL)).map((a) => a.slug).sort();
const V1 = SEED_MIGRATIONS[0]!.apis.map((a) => a.slug).sort();

test('SD-1 the default workspace was seeded at boot; a new workspace is seeded at signup', async () => {
  assert.deepStrictEqual(await slugs(), V1, 'default workspace');
  const ws = await h.workspace('seedws');
  assert.deepStrictEqual(await slugs(ws.ctx), V1, 'a fresh workspace gets the same set');
  const list = await h.call('GET', '/analytics-builder/apis', { token: ws.tokens.admin!, tenant: ws.id });
  const one = list.body.items.find((a: any) => a.slug === 'instances-by-status');
  assert.strictEqual(one.builtIn, true); assert.strictEqual(one.status, 'published'); assert.strictEqual(one.ownerId, 'system');
});

test('SD-2 every built-in is valid and runs (with its parameters) on an empty workspace', async () => {
  const ws = await h.workspace('emptyws');
  const svc = new AnalyticsService(ws.ctx, wfs);
  for (const api of SEED_MIGRATIONS.flatMap((m) => m.apis)) {
    const params = Object.fromEntries((api.params ?? []).map((p) => [p.name, 'none']));
    const r = await svc.run(api.slug, params, 'http', ALL);
    assert.ok(Array.isArray(r.rows), api.slug); assert.ok(r.columns.length > 0, api.slug);
  }
});

test('SD-3 a restart does nothing: same set, no new audit entry, marker at the latest version', async () => {
  const ws = await h.workspace('restartws');
  const before = await slugs(ws.ctx);
  const audits = async () => (await h.store.repo<AuditEvent>(Collections.audit).query((a) => a.tenantId === ws.id && a.kind === 'analytics.seeded')).length;
  const a0 = await audits();
  const again = await runAnalyticsSeedMigrations(ws.ctx, wfs);
  assert.deepStrictEqual(again, { applied: [], created: [] });
  await migrateAnalyticsAll(h.store);                                   // what the server does on every start
  assert.deepStrictEqual(await slugs(ws.ctx), before);
  assert.strictEqual(await audits(), a0, 'nothing new was recorded');
  const marker = await h.store.repo<any>('analytics_seed').get(`${ws.id}:analytics`);
  assert.strictEqual(marker.version, LATEST_SEED_VERSION);
});

test('SD-4 a built-in an administrator deleted stays deleted after a restart', async () => {
  const ws = await h.workspace('deletews');
  const svc = new AnalyticsService(ws.ctx, wfs);
  const gone = (await svc.list(ALL)).find((a) => a.slug === 'overdue-tasks')!;
  await svc.remove(gone.id, ALL);
  await migrateAnalyticsFor(h.store, ws.id); await migrateAnalyticsAll(h.store);
  assert.ok(!(await slugs(ws.ctx)).includes('overdue-tasks'));
  assert.strictEqual((await slugs(ws.ctx)).length, V1.length - 1);
});

test('SD-5 a slug the workspace already uses is left alone (and the rest still seeds)', async () => {
  // simulate a workspace that existed before the seed: create it without running the migration, with its own "failed-instances"
  const ctx = (await h.workspace('legacyws', [], null)).ctx;
  await h.store.repo<any>('analytics_seed').delete(`${ctx.tenantId}:analytics`);
  for (const a of await new AnalyticsService(ctx, wfs).list(ALL)) await new AnalyticsService(ctx, wfs).remove(a.id, ALL);
  const mine = await new AnalyticsService(ctx, wfs).create({ slug: 'failed-instances', name: 'My own failures', status: 'published', query: { from: 'process', metrics: [{ fn: 'count', as: 'n' }] } }, ALL);
  const r = await runAnalyticsSeedMigrations(ctx, wfs);
  assert.ok(!r.created.includes('failed-instances'));
  assert.strictEqual(r.created.length, V1.length - 1);
  const kept = await new AnalyticsService(ctx, wfs).get(mine.id, ALL);
  assert.strictEqual(kept.name, 'My own failures'); assert.ok(!kept.builtIn, 'the user’s own API was not replaced');
});

test('SD-6 a later migration applies ONLY its own APIs, once', async () => {
  const ws = await h.workspace('upgradews');
  const next = { version: LATEST_SEED_VERSION + 1, description: 'test', apis: [{ slug: 'extra-count', name: 'Extra count', description: 'x', query: { from: 'task' as const, metrics: [{ fn: 'count' as const, as: 'n' }] } }] };
  SEED_MIGRATIONS.push(next);
  try {
    const r = await runAnalyticsSeedMigrations(ws.ctx, wfs);
    assert.deepStrictEqual(r.applied, [next.version]); assert.deepStrictEqual(r.created, ['extra-count']);
    assert.deepStrictEqual(await runAnalyticsSeedMigrations(ws.ctx, wfs), { applied: [], created: [] });
    assert.strictEqual((await slugs(ws.ctx)).length, V1.length + 1);
  } finally { SEED_MIGRATIONS.pop(); }
});

test('SD-7 access: built-ins follow the normal rules (viewer reads process data, not cases; only an admin edits a built-in)', async () => {
  clearAnalyticsCache();
  const ws = await h.workspace('accessws');
  const run = (slug: string, token: string) => h.call('GET', `/analytics/run/${slug}`, { token, tenant: ws.id });
  assert.strictEqual((await run('instances-by-status', ws.tokens.viewer!)).status, 200);
  assert.strictEqual((await run('cases-by-status', ws.tokens.viewer!)).status, 403, 'cases need workflowInstance:manage');
  assert.strictEqual((await run('cases-by-status', ws.tokens.operator!)).status, 200);
  const list = (await h.call('GET', '/analytics-builder/apis', { token: ws.tokens.operator!, tenant: ws.id })).body.items;
  const id = list.find((a: any) => a.slug === 'instances-by-status').id;
  assert.strictEqual((await h.call('PUT', `/analytics-builder/apis/${id}`, { token: ws.tokens.operator!, tenant: ws.id, body: { name: 'Hacked name' } })).status, 403, 'an operator cannot change a built-in');
  assert.strictEqual((await h.call('PUT', `/analytics-builder/apis/${id}`, { token: ws.tokens.admin!, tenant: ws.id, body: { name: 'Renamed by admin' } })).status, 200);
});

test('SD-8 the built-ins return real answers on real data', async () => {
  const ws = await h.workspace('dataws');
  const put = (o: any) => ws.ctx.store.repo<Instance>(Collections.instances).put({ tenantId: ws.id, deploymentId: 'd', workflowId: 'w', processId: 'p', variables: {}, tokens: [], history: [], startedBy: 'amy', startedAt: new Date().toISOString(), ...o });
  await put({ id: 'i1', status: 'completed', endedAt: new Date().toISOString() }); await put({ id: 'i2', status: 'failed', error: { nodeId: 'n1', message: 'boom', at: 'x' } }); await put({ id: 'i3', status: 'failed', parentInstanceId: 'i1' });
  const svc = new AnalyticsService(ws.ctx, wfs);
  const by = (await svc.run('instances-by-status', {}, 'http', ALL)).rows;
  assert.deepStrictEqual(by, [{ status: 'failed', instances: 2 }, { status: 'completed', instances: 1 }]);
  const failed = (await svc.run('failed-instances', {}, 'http', ALL)).rows;
  assert.strictEqual(failed.length, 2); assert.ok(failed.some((r) => r.error === 'boom' && r.node === 'n1'));
  const tree = (await svc.run('process-call-tree', { instanceId: 'i1' }, 'http', ALL)).rows;
  assert.deepStrictEqual(tree.map((r) => [r.depth, r.instanceId]), [[1, 'i3']]);
  const perDay = (await svc.run('instances-started-per-day', {}, 'http', ALL)).rows;
  assert.strictEqual(perDay[0]!.started, 3);
});
test('SD-9 concurrent seeding (two start-up paths, or two replicas) never produces duplicates', async () => {
  const ws = await h.workspace('raceonews', [], null);
  const ctx = ws.ctx;
  await h.store.repo<any>('analytics_seed').delete(`${ctx.tenantId}:analytics`);
  const svc = new AnalyticsService(ctx, wfs);
  for (const a of await svc.list(ALL)) await svc.remove(a.id, ALL);
  await Promise.all([runAnalyticsSeedMigrations(ctx, wfs), runAnalyticsSeedMigrations(ctx, wfs), migrateAnalyticsFor(h.store, ctx.tenantId), migrateAnalyticsFor(h.store, ctx.tenantId)]);
  const got = await slugs(ctx);
  assert.deepStrictEqual(got, V1, 'exactly one of each');
  // two REPLICAS don't share this process's lock: simulate by calling the unlocked creator directly, twice, at once
  await h.store.repo<any>('analytics_seed').delete(`${ctx.tenantId}:analytics`);
  for (const a of await svc.list(ALL)) await svc.remove(a.id, ALL);
  const api = SEED_MIGRATIONS[0]!.apis[0]!;
  await Promise.all([svc.createBuiltIn(api), svc.createBuiltIn(api), svc.createBuiltIn(api)]);
  assert.strictEqual((await svc.list(ALL)).filter((a) => a.slug === api.slug).length, 1, 'a deterministic id collapses concurrent creators into one row');
});
after(async () => { await h.close(); setTimeout(() => process.exit(0), 50).unref(); });
