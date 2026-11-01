// Analytics Builder: query semantics, joins, recursion — and, above all, that only an authorized caller reads only their own
// workspace's data: workspace isolation, per-source permissions, private APIs, extra requirements, flows, cache.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { boot } from './harness.ts';
import { Collections, type Instance, type Task } from '../src/domain.ts';
import { resolveWorkflowServiceStore } from '../src/workflow-service/store/index.ts';
import { AnalyticsService, clearAnalyticsCache } from '../src/analytics/service.ts';
import { LIMITS } from '../src/analytics/engine.ts';
import { makeContext } from '../src/context.ts';
import type { AppContext } from '../src/context.ts';

const h = await boot();
const A = await h.workspace('aaa');
const B = await h.workspace('bbb');
const wfs = resolveWorkflowServiceStore(h.store);
const T = (s: string) => `2025-03-03T${s}:00.000Z`;
const inst = (o: Partial<Instance> & { id: string }): Instance => ({ tenantId: A.id, deploymentId: 'dep1', workflowId: 'wf1', processId: 'p', status: 'completed', variables: {}, tokens: [], history: [], startedAt: T('10:00'), startedBy: 'amy', ...o } as Instance);
const task = (o: Partial<Task> & { id: string }): Task => ({ tenantId: A.id, instanceId: 'p1', tokenId: 'tk', nodeId: 'n', name: 'Review', status: 'completed', inputs: {}, createdAt: T('00:00'), ...o } as Task);
const caseRow = (o: Record<string, unknown>) => ({ tenantId: A.id, workflowDefinitionId: 'd', workflowName: 'claims', deploymentId: 'dep1', data: {}, status: 'active', piid: null, createdAt: T('09:00'), createdBy: 'amy', updatedAt: T('09:00'), updatedBy: 'amy', ...o }) as any;
const iRepo = (ctx: AppContext) => ctx.store.repo<Instance>(Collections.instances);
const tRepo = (ctx: AppContext) => ctx.store.repo<Task>(Collections.tasks);

// workspace A: case c1 → p1 → p1a → p1b (tree), case c2 → p2; tasks across the tree. workspace B: a case/process with a secret.
const recent = new Date(Date.now() - 2 * 3600_000).toISOString();
await iRepo(A.ctx).put(inst({ id: 'p1', startedAt: T('10:00'), endedAt: T('10:30'), variables: { _caseInstanceId: 'c1', tier: 'gold' } }));
await iRepo(A.ctx).put(inst({ id: 'p1a', parentInstanceId: 'p1', startedAt: T('10:05'), endedAt: T('10:15'), variables: { tier: 'gold' } }));
await iRepo(A.ctx).put(inst({ id: 'p1b', parentInstanceId: 'p1a', status: 'failed', startedAt: T('10:06'), endedAt: T('10:08'), error: { nodeId: 'x', message: 'boom', at: T('10:08') } } as any));
await iRepo(A.ctx).put(inst({ id: 'p2', startedAt: T('11:00'), endedAt: T('11:10'), variables: { _caseInstanceId: 'c2', tier: 'silver' } }));
await tRepo(A.ctx).put(task({ id: 't1', instanceId: 'p1', assignee: 'amy', createdAt: T('10:00'), claimedAt: T('10:10'), completedAt: T('10:30') }));
await tRepo(A.ctx).put(task({ id: 't2', instanceId: 'p1a', assignee: 'bob', createdAt: T('11:00'), claimedAt: T('11:05'), completedAt: T('11:20') }));
await tRepo(A.ctx).put(task({ id: 't3', instanceId: 'p2', assignee: 'amy', createdAt: T('12:00'), claimedAt: T('12:02'), completedAt: T('12:10') }));
await tRepo(A.ctx).put(task({ id: 't4', instanceId: 'p2', assignee: 'amy', status: 'created', createdAt: T('13:00'), name: 'Open one' }));
await wfs.instances().put(caseRow({ id: 'c1', piid: 'p1', data: { claimAmount: 500, region: 'EU' } }));
await wfs.instances().put(caseRow({ id: 'c2', piid: 'p2', status: 'closed', data: { claimAmount: 50, region: 'US' } }));
await wfs.instances().put(caseRow({ id: 'c3', piid: null, createdAt: recent, data: { claimAmount: 5 } }));
// B: a secret, plus a process that CLAIMS to belong to A's case and a child of A's process
await iRepo(B.ctx).put({ ...inst({ id: 'bp1', tenantId: B.id, variables: { _caseInstanceId: 'c1', secret: 'B-ONLY' } }) } as Instance);
await iRepo(B.ctx).put({ ...inst({ id: 'bp2', tenantId: B.id, parentInstanceId: 'p1' }) } as Instance);
await wfs.instances().put(caseRow({ id: 'bc1', tenantId: B.id, piid: 'bp1', data: { secret: 'B-CASE' } }));
await tRepo(B.ctx).put(task({ id: 'bt1', tenantId: B.id, instanceId: 'bp1', assignee: 'mallory' }));

const call = (method: string, path: string, token: string, body?: unknown, tenant = A.id) => h.call(method, path, { token, tenant, ...(body !== undefined ? { body } : {}) });
const preview = (token: string, query: any, params?: any, tenant = A.id) => call('POST', '/analytics-builder/preview', token, { query, params }, tenant);
const rows = (r: { body: any }) => r.body.rows as any[];
const eq = (field: string, value: unknown) => ({ field, op: 'eq', value });
const caller = (permissions: string[], actor = 'tester') => ({ actor, permissions });
const svcA = () => new AnalyticsService(A.ctx, wfs);

test('AB-1 the catalogue lists sources, relations and what THIS role may read', async () => {
  const admin = await call('GET', '/analytics-builder/catalog', A.tokens.admin!);
  assert.strictEqual(admin.status, 200);
  assert.ok(admin.body.sources.find((s: any) => s.key === 'task').fields.some((f: any) => f.key === 'totalMs' && f.computed));
  assert.ok(admin.body.relations.some((r: any) => r.key === 'process.descendants' && r.recursive));
  assert.ok(admin.body.sources.every((s: any) => s.allowed), 'an admin may read every source');
  const op = await call('GET', '/analytics-builder/catalog', A.tokens.operator!);
  assert.strictEqual(op.body.sources.find((s: any) => s.key === 'case').allowed, true);
  assert.strictEqual((await call('GET', '/analytics-builder/catalog', A.tokens.viewer!)).status, 403, 'a viewer cannot open the builder');
});

test('AB-2 filters, operators, params and relative time', async () => {
  const t = A.tokens.admin!;
  const ids = async (where: any, params?: any) => rows(await preview(t, { from: 'process', where, select: [{ field: 'process.id', as: 'id' }], sort: [{ field: 'id' }] }, params)).map((r) => r.id);
  assert.deepStrictEqual(await ids(eq('process.status', 'failed')), ['p1b']);
  assert.deepStrictEqual(await ids({ op: 'and', items: [eq('process.status', 'completed'), { field: 'process.variables.tier', op: 'eq', value: 'gold' }] }), ['p1', 'p1a']);
  assert.deepStrictEqual(await ids({ op: 'or', items: [eq('process.id', 'p2'), eq('process.status', 'failed')] }), ['p1b', 'p2']);
  assert.deepStrictEqual(await ids({ field: 'process.id', op: 'in', value: ['p1', 'p2'] }), ['p1', 'p2']);
  assert.deepStrictEqual(await ids({ field: 'process.id', op: 'startsWith', value: 'P1' }), ['p1', 'p1a', 'p1b']);
  assert.deepStrictEqual(await ids({ field: 'process.startedAt', op: 'between', value: [T('10:30'), T('12:00')] }), ['p2']);
  assert.deepStrictEqual(await ids({ field: 'process.errorMessage', op: 'notNull' }), ['p1b']);
  assert.deepStrictEqual(await ids({ field: 'process.durationMs', op: 'gt', value: 600000 }), ['p1']);
  assert.deepStrictEqual(await ids(eq('process.variables.tier', { param: 'tier' }), { tier: 'silver' }), ['p2'], 'a parameter value');
  const cases = rows(await preview(t, { from: 'case', where: { field: 'case.createdAt', op: 'gte', value: { now: '-1d' } }, select: [{ field: 'case.id', as: 'id' }] }));
  assert.deepStrictEqual(cases.map((r) => r.id), ['c3'], 'relative time');
});

test('AB-3 joins: case → process → tasks, left vs inner, row multiplication, workspace row', async () => {
  const t = A.tokens.admin!;
  const lr = (await preview(t, { from: 'case', joins: [{ rel: 'case.process' }, { rel: 'process.tasks' }], select: [{ field: 'case.id', as: 'c' }, { field: 'task.id', as: 't' }], sort: [{ field: 'c' }, { field: 't' }] })).body.rows;
  assert.deepStrictEqual(lr.map((r: any) => `${r.c}:${r.t}`), ['c1:t1', 'c2:t3', 'c2:t4', 'c3:null'], 'left keeps the case with no process; a many join multiplies rows');
  const ir = (await preview(t, { from: 'case', joins: [{ rel: 'case.process', type: 'inner' }], select: [{ field: 'case.id', as: 'c' }], sort: [{ field: 'c' }] })).body.rows;
  assert.deepStrictEqual(ir.map((r: any) => r.c), ['c1', 'c2'], 'inner drops c3 (no process)');
  const ws = (await preview(t, { from: 'process', joins: [{ rel: 'process.workspace' }], where: eq('process.id', 'p1'), select: [{ field: 'workspace.slug', as: 'ws' }] })).body.rows;
  assert.deepStrictEqual(ws, [{ ws: 'aaa' }]);
  const back = (await preview(t, { from: 'process', joins: [{ rel: 'process.case' }], where: eq('process.id', 'p2'), select: [{ field: 'case.data.region', as: 'region' }] })).body.rows;
  assert.deepStrictEqual(back, [{ region: 'US' }], 'process → case, and a case.data path');
  const bad = await preview(t, { from: 'case', joins: [{ rel: 'process.tasks' }], select: [{ field: 'case.id' }] });
  assert.strictEqual(bad.status, 422); assert.match(bad.body.error.message, /not in this query yet/);
});

test('AB-4 recursion: descendants (with depth), ancestors, root, and the case-wide task set', async () => {
  const t = A.tokens.admin!;
  const d = (await preview(t, { from: 'process', joins: [{ rel: 'process.descendants', as: 'sub' }], where: eq('process.id', 'p1'), select: [{ field: 'sub.id', as: 'id' }, { field: 'sub.depth', as: 'depth' }], sort: [{ field: 'depth' }] })).body.rows;
  assert.deepStrictEqual(d, [{ id: 'p1a', depth: 1 }, { id: 'p1b', depth: 2 }], 'the whole call tree, with depth');
  const anc = (await preview(t, { from: 'process', joins: [{ rel: 'process.ancestors', as: 'up' }], where: eq('process.id', 'p1b'), select: [{ field: 'up.id', as: 'id' }, { field: 'up.depth', as: 'depth' }], sort: [{ field: 'depth' }] })).body.rows;
  assert.deepStrictEqual(anc, [{ id: 'p1a', depth: 1 }, { id: 'p1', depth: 2 }]);
  const root = (await preview(t, { from: 'process', joins: [{ rel: 'process.root', as: 'top' }], where: eq('process.id', 'p1b'), select: [{ field: 'top.id', as: 'id' }] })).body.rows;
  assert.deepStrictEqual(root, [{ id: 'p1' }]);
  const tasks = (await preview(t, { from: 'case', joins: [{ rel: 'case.tasks' }], where: eq('case.id', 'c1'), select: [{ field: 'task.id', as: 't' }], sort: [{ field: 't' }] })).body.rows;
  assert.deepStrictEqual(tasks.map((r: any) => r.t), ['t1', 't2'], 'a case’s tasks include those of its sub-processes');
  const perRoot = (await preview(t, { from: 'process', joins: [{ rel: 'process.descendants', as: 'sub', type: 'inner' }], groupBy: [{ field: 'process.id', as: 'root' }], metrics: [{ fn: 'count', as: 'n' }], sort: [{ field: 'root' }] })).body.rows;
  assert.deepStrictEqual(perRoot, [{ root: 'p1', n: 2 }, { root: 'p1a', n: 1 }], 'descendants counted per parent');
});

test('AB-5 aggregation: metrics, buckets, having, sort, paging, percentiles', async () => {
  const t = A.tokens.admin!;
  const byUser = (await preview(t, { from: 'task', where: { field: 'task.completedAt', op: 'notNull' }, groupBy: [{ field: 'task.assignee', as: 'who' }], metrics: [{ fn: 'count', as: 'n' }, { fn: 'avg', field: 'task.totalMs', as: 'avgMs' }, { fn: 'max', field: 'task.workMs', as: 'maxWork' }], sort: [{ field: 'who' }] })).body;
  assert.strictEqual(byUser.mode, 'aggregate');
  assert.deepStrictEqual(byUser.rows, [{ who: 'amy', n: 2, avgMs: 1_200_000, maxWork: 1_200_000 }, { who: 'bob', n: 1, avgMs: 1_200_000, maxWork: 900_000 }]);
  const day = (await preview(t, { from: 'process', groupBy: [{ field: 'process.startedAt', bucket: 'day', as: 'day' }], metrics: [{ fn: 'count', as: 'n' }, { fn: 'countDistinct', field: 'process.startedBy', as: 'who' }] })).body.rows;
  assert.deepStrictEqual(day, [{ day: '2025-03-03', n: 4, who: 1 }]);
  const having = (await preview(t, { from: 'task', groupBy: [{ field: 'task.assignee', as: 'who' }], metrics: [{ fn: 'count', as: 'n' }], having: { field: 'n', op: 'gt', value: 1 } })).body.rows;
  assert.deepStrictEqual(having, [{ who: 'amy', n: 3 }]);
  const p = (await preview(t, { from: 'task', where: { field: 'task.totalMs', op: 'notNull' }, metrics: [{ fn: 'p50', field: 'task.totalMs', as: 'median' }, { fn: 'sum', field: 'task.totalMs', as: 'sum' }] })).body.rows;
  assert.deepStrictEqual(p, [{ median: 1_200_000, sum: 3_600_000 }]);
  const page = (await preview(t, { from: 'task', select: [{ field: 'task.id', as: 'id' }], sort: [{ field: 'id', dir: 'desc' }], limit: 2, offset: 1 })).body;
  assert.deepStrictEqual(page.rows.map((r: any) => r.id), ['t3', 't2']); assert.strictEqual(page.meta.total, 4);
  const overdue = (await preview(t, { from: 'task', where: eq('task.overdue', true), select: [{ field: 'task.id', as: 'id' }] })).body.rows;
  assert.deepStrictEqual(overdue, [], 'no due dates set → nothing overdue');
});

test('AB-6 bad queries are refused with a readable reason (unknown fields, operators, mixes)', async () => {
  const t = A.tokens.admin!;
  const msg = async (q: any) => { const r = await preview(t, q); assert.strictEqual(r.status, 422, JSON.stringify(q)); return r.body.error.message as string; };
  assert.match(await msg({ from: 'process', select: [{ field: 'process.password' }] }), /unknown field/);
  assert.match(await msg({ from: 'nope' }), /unknown source/);
  assert.match(await msg({ from: 'process', where: { field: 'process.id', op: 'regex', value: 'x' } }), /unknown operator/);
  assert.match(await msg({ from: 'process', select: [{ field: 'process.id' }], metrics: [{ fn: 'count' }] }), /either "select"/);
  assert.match(await msg({ from: 'process', groupBy: [{ field: 'process.status', bucket: 'day' }], metrics: [{ fn: 'count' }] }), /not a date/);
  assert.match(await msg({ from: 'process', joins: [{ rel: 'process.tasks', as: 'process' }], select: [{ field: 'process.id' }] }), /already used/);
  assert.match(await msg({ from: 'process', where: { field: 'process.id', op: 'eq', value: { now: 'yesterday' } }, select: [{ field: 'process.id' }] }), /relative time/);
  assert.match(await msg({ from: 'process', where: { field: 'process.id', op: 'eq', value: { param: 'x' } }, select: [{ field: 'process.id' }] }), /preview needs a value/);
});

// ---------------------------------------------------------------------------------------------------- SECURITY
test('SEC-1 workspace isolation: another workspace’s rows are never visible, however the query is built', async () => {
  const t = A.tokens.admin!;
  const all = async (from: string, field = 'id') => rows(await preview(t, { from, select: [{ field: `${from}.${field}`, as: 'v' }] })).map((r) => r.v);
  assert.ok(!(await all('process')).includes('bp1') && !(await all('process')).includes('bp2'));
  assert.ok(!(await all('task')).includes('bt1'));
  assert.ok(!(await all('case')).includes('bc1'));
  // B's process claims A's case, B's child claims A's parent: no join may follow either link across workspaces
  const viaCase = (await preview(t, { from: 'case', joins: [{ rel: 'case.process' }], where: eq('case.id', 'c1'), select: [{ field: 'process.id', as: 'p' }] })).body.rows;
  assert.deepStrictEqual(viaCase, [{ p: 'p1' }]);
  const kids = (await preview(t, { from: 'process', joins: [{ rel: 'process.descendants', as: 'sub' }], where: eq('process.id', 'p1'), select: [{ field: 'sub.id', as: 'id' }] })).body.rows.map((r: any) => r.id);
  assert.ok(!kids.includes('bp2'), 'the recursive walk stays inside the workspace');
  const secret = JSON.stringify((await preview(t, { from: 'process', select: [{ field: 'process.variables.secret', as: 's' }] })).body);
  assert.ok(!secret.includes('B-ONLY'));
  const sum = (await preview(t, { from: 'task', metrics: [{ fn: 'count', as: 'n' }] })).body.rows[0].n;
  assert.strictEqual(sum, 4, 'aggregates count only this workspace');
  // and B sees only B
  const b = rows(await preview(B.tokens.admin!, { from: 'process', select: [{ field: 'process.id', as: 'id' }], sort: [{ field: 'id' }] }, undefined, B.id)).map((r) => r.id);
  assert.deepStrictEqual(b, ['bp1', 'bp2']);
});

test('SEC-2 a member of workspace A cannot use workspace B (header swap), and the platform-wide scope is refused', async () => {
  const swapped = await preview(A.tokens.admin!, { from: 'process', select: [{ field: 'process.id' }] }, undefined, B.id);
  assert.strictEqual(swapped.status, 403, 'not a member of B');
  assert.throws(() => new AnalyticsService(makeContext({ store: h.store, tenantId: 'all' }), wfs), /needs a workspace/);
});

test('SEC-3 roles: building needs analytics:query; every source needs its own permission', async () => {
  const q = { from: 'process', select: [{ field: 'process.id', as: 'id' }] };
  assert.strictEqual((await preview(A.tokens.viewer!, q)).status, 403, 'viewer: query:read but no analytics:query');
  assert.strictEqual((await preview(A.tokens.developer!, q)).status, 403, 'developer: same');
  assert.strictEqual((await preview(A.tokens.worker!, q)).status, 403);
  assert.strictEqual((await preview(A.tokens.operator!, q)).status, 200, 'operator may build');
  // an operator holds workflowInstance:manage + query:read + workflow:view + team:read, so every source is open to them; narrow the permission set to prove each one bites
  const only = (...p: string[]) => ['analytics:query', ...p];
  const run = (perms: string[], from: string) => svcA().preview({ from, select: [{ field: `${from}.id`, as: 'id' }] } as any, undefined, caller(perms));
  await assert.rejects(run(only('query:read'), 'case'), /workflowInstance:manage/);
  await assert.rejects(run(only('workflowInstance:manage'), 'process'), /query:read/);
  await assert.rejects(run(only('query:read'), 'project'), /workflow:view/);
  await assert.rejects(run(only('query:read'), 'workspace'), /team:read/);
  await assert.doesNotReject(run(only('query:read'), 'task'));
  // a JOIN is a read of the joined source too: process ⨝ project needs workflow:view as well
  await assert.rejects(svcA().preview({ from: 'process', joins: [{ rel: 'process.project' }], select: [{ field: 'project.name' }] } as any, undefined, caller(only('query:read'))), /workflow:view/);
  // and a relation can’t be used to smuggle a source: case ⨝ audits needs the case permission even if the SELECT only names audit fields
  await assert.rejects(svcA().preview({ from: 'process', joins: [{ rel: 'process.case' }, { rel: 'case.audits' }], select: [{ field: 'audit.kind' }] } as any, undefined, caller(only('query:read'))), /workflowInstance:manage/);
});

test('SEC-4 you cannot publish an API over data you may not read yourself, nor require a permission you lack', async () => {
  const def = (extra: any = {}) => ({ slug: 'cases-open', name: 'Open cases', status: 'published', query: { from: 'case', metrics: [{ fn: 'count', as: 'n' }] }, ...extra });
  await assert.rejects(svcA().create(def(), caller(['analytics:query', 'query:read'])), /workflowInstance:manage/);
  await assert.rejects(svcA().create(def({ slug: 'p-only', query: { from: 'process', metrics: [{ fn: 'count' }] }, requires: 'admin:iam' }), caller(['analytics:query', 'query:read'])), /do not hold yourself/);
});

test('SEC-5 calling a published API: query:read + the source permissions + the API’s own requirement', async () => {
  clearAnalyticsCache();
  const mk = async (slug: string, query: any, extra: any = {}) => (await call('POST', '/analytics-builder/apis', A.tokens.admin!, { slug, name: slug, status: 'published', query, ...extra })).body;
  const proc = await mk('proc-count', { from: 'process', metrics: [{ fn: 'count', as: 'n' }] });
  const cs = await mk('case-count', { from: 'case', metrics: [{ fn: 'count', as: 'n' }] });
  const adminOnly = await mk('admin-only', { from: 'process', metrics: [{ fn: 'count', as: 'n' }] }, { requires: 'admin:iam' });
  assert.ok(proc.id && cs.id && adminOnly.id);
  const run = (slug: string, token: string, method = 'GET') => call(method, `/analytics/run/${slug}`, token, method === 'POST' ? {} : undefined);
  assert.strictEqual((await run('proc-count', A.tokens.viewer!)).status, 200, 'viewer: query:read + process source');
  assert.strictEqual((await run('proc-count', A.tokens.viewer!)).body.rows[0].n, 4);
  assert.strictEqual((await run('case-count', A.tokens.viewer!)).status, 403, 'viewer has no workflowInstance:manage → no case data');
  assert.strictEqual((await run('case-count', A.tokens.worker!)).status, 403, 'worker has the case permission but no query:read');
  assert.strictEqual((await run('case-count', A.tokens.operator!)).status, 200);
  assert.strictEqual((await run('admin-only', A.tokens.operator!)).status, 403, 'the API’s own requires');
  assert.strictEqual((await run('admin-only', A.tokens.admin!, 'POST')).status, 200);
  assert.strictEqual((await call('GET', '/analytics/run/proc-count', '', undefined)).status, 401);
  // B cannot see A's API by slug, and A's data is not in B
  assert.strictEqual((await call('GET', '/analytics/run/proc-count', B.tokens.admin!, undefined, B.id)).status, 404);
});

test('SEC-6 the cache never serves a result to someone who is not allowed it', async () => {
  clearAnalyticsCache();
  const made = await call('POST', '/analytics-builder/apis', A.tokens.admin!, { slug: 'cached-cases', name: 'Cached cases', status: 'published', cacheSeconds: 300, query: { from: 'case', metrics: [{ fn: 'count', as: 'n' }] } });
  assert.strictEqual(made.status, 201);
  const first = await call('GET', '/analytics/run/cached-cases', A.tokens.operator!);
  assert.strictEqual(first.body.meta.cached, false);
  const second = await call('GET', '/analytics/run/cached-cases', A.tokens.operator!);
  assert.strictEqual(second.body.meta.cached, true, 'a second allowed call is served from the cache');
  assert.strictEqual((await call('GET', '/analytics/run/cached-cases', A.tokens.viewer!)).status, 403, 'a cached entry is not a way around the permission check');
  const up = await call('PUT', `/analytics-builder/apis/${made.body.id}`, A.tokens.admin!, { query: { from: 'case', metrics: [{ fn: 'count', as: 'n' }, { fn: 'count', field: 'case.piid', as: 'withProcess' }] } });
  assert.strictEqual(up.body.version, 2);
  assert.strictEqual((await call('GET', '/analytics/run/cached-cases', A.tokens.operator!)).body.meta.cached, false, 'editing bumps the version: nothing stale is served');
});

test('SEC-7 private APIs belong to their owner; only the owner or an admin can change one', async () => {
  const priv = await call('POST', '/analytics-builder/apis', A.tokens.operator!, { slug: 'my-private', name: 'Mine', status: 'published', visibility: 'private', query: { from: 'process', metrics: [{ fn: 'count' }] } });
  assert.strictEqual(priv.status, 201);
  const shared = await call('POST', '/analytics-builder/apis', A.tokens.operator!, { slug: 'my-shared', name: 'Shared', status: 'published', query: { from: 'process', metrics: [{ fn: 'count' }] } });
  // another member (admin seat here is a different principal) cannot see the private one in the list or call it
  const otherList = (await call('GET', '/analytics-builder/apis', A.tokens.owner!)).body.items.map((a: any) => a.slug);
  assert.ok(!otherList.includes('my-private') && otherList.includes('my-shared'));
  assert.strictEqual((await call('GET', '/analytics/run/my-private', A.tokens.viewer!)).status, 404);
  assert.strictEqual((await call('GET', `/analytics-builder/apis/${priv.body.id}`, A.tokens.owner!)).status, 404);
  assert.strictEqual((await call('GET', '/analytics/run/my-private', A.tokens.operator!)).status, 200, 'the owner can');
  // a non-owner without admin:iam cannot edit a shared one
  assert.strictEqual((await svcA().update(shared.body.id, { name: 'Renamed' }, caller(['*'], 'someone-admin'))).name, 'Renamed', 'a workspace admin can');
  await assert.rejects(svcA().update(shared.body.id, { name: 'Hijack' }, caller(['analytics:query', 'query:read', 'workflow:view', 'team:read'], 'intruder')), /owner or a workspace administrator/);
  await assert.rejects(svcA().remove(shared.body.id, caller(['analytics:query'], 'intruder')), /owner or a workspace administrator/);
});

test('SEC-8 flows: only an API whose owner enabled "allow flows" runs with engine authority', async () => {
  await call('POST', '/analytics-builder/apis', A.tokens.admin!, { slug: 'flow-ok', name: 'Flow api', status: 'published', allowFlows: true, query: { from: 'case', metrics: [{ fn: 'count', as: 'n' }] } });
  await call('POST', '/analytics-builder/apis', A.tokens.admin!, { slug: 'flow-no', name: 'Flow api', status: 'published', query: { from: 'case', metrics: [{ fn: 'count', as: 'n' }] } });
  const flow = caller([]);                                     // a flow carries no user permissions at all
  assert.strictEqual((await svcA().run('flow-ok', {}, 'flow', flow)).rows[0]!.n, 3);
  await assert.rejects(svcA().run('flow-no', {}, 'flow', flow), /not available to flows/);
  await assert.rejects(svcA().run('flow-ok', {}, 'http', flow), /workflowInstance:manage/, 'the same API over HTTP still checks the caller');
  const ofB = new AnalyticsService(B.ctx, wfs);
  await assert.rejects(ofB.run('flow-ok', {}, 'flow', flow), /not found|Not found/i, 'and a flow in workspace B cannot reach A’s API');
});

test('SEC-9 drafts are not callable; slugs and parameters are validated', async () => {
  const t = A.tokens.admin!;
  const draft = await call('POST', '/analytics-builder/apis', t, { slug: 'a-draft', name: 'Draft one', query: { from: 'process', metrics: [{ fn: 'count' }] } });
  assert.strictEqual(draft.body.status, 'draft');
  assert.strictEqual((await call('GET', '/analytics/run/a-draft', t)).status, 404);
  for (const slug of ['ab', 'Has Caps', '9lives', 'run', 'catalog']) assert.strictEqual((await call('POST', '/analytics-builder/apis', t, { slug, name: 'Some name', query: { from: 'process', metrics: [{ fn: 'count' }] } })).status, 422, slug);
  assert.strictEqual((await call('POST', '/analytics-builder/apis', t, { slug: 'a-draft', name: 'Duplicate', query: { from: 'process', metrics: [{ fn: 'count' }] } })).status, 409);
  assert.strictEqual((await call('POST', '/analytics-builder/apis', t, { slug: 'undeclared', name: 'Undeclared', query: { from: 'process', where: eq('process.status', { param: 'st' }), metrics: [{ fn: 'count' }] } })).status, 422, 'a parameter the query uses must be declared');
  await call('POST', '/analytics-builder/apis', t, { slug: 'by-status', name: 'By status', status: 'published', params: [{ name: 'st', type: 'string', required: true }, { name: 'min', type: 'number', default: 0 }],
    query: { from: 'process', where: eq('process.status', { param: 'st' }), metrics: [{ fn: 'count', as: 'n' }] } });
  assert.strictEqual((await call('GET', '/analytics/run/by-status', t)).status, 422, 'a required parameter');
  assert.strictEqual((await call('GET', '/analytics/run/by-status?st=failed&bogus=1', t)).status, 422, 'an unknown parameter');
  assert.strictEqual((await call('GET', '/analytics/run/by-status?st=failed', t)).body.rows[0].n, 1);
  assert.strictEqual((await call('POST', '/analytics/run/by-status', t, { params: { st: 'completed' } })).body.rows[0].n, 3);
});

test('SEC-10 guards: a huge scan is cut off and says so; results are capped', async () => {
  const keep = { ...LIMITS };
  try {
    LIMITS.maxScan = 2;
    const r = (await preview(A.tokens.admin!, { from: 'process', select: [{ field: 'process.id' }] })).body;
    assert.strictEqual(r.meta.truncated, true); assert.match(r.meta.truncatedReason, /scan limit/); assert.ok(r.rows.length <= 2);
  } finally { Object.assign(LIMITS, keep); }
  const capped = (await preview(A.tokens.admin!, { from: 'process', select: [{ field: 'process.id' }], limit: 999999 })).body;
  assert.ok(capped.rows.length <= LIMITS.maxRows);
});

after(async () => { await h.close(); setTimeout(() => process.exit(0), 50).unref(); });
