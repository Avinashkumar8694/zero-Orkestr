// Analytics must not need a whole table in memory: the store is asked only for what the query needs, in pages, and results stay identical.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { MemoryStore } from '../src/store/memory-store.ts';
import { makeContext } from '../src/context.ts';
import { Collections, type Instance } from '../src/domain.ts';
import { findRows } from '../src/store/find.ts';
import { resolveWorkflowServiceStore } from '../src/workflow-service/store/index.ts';
import { AnalyticsService } from '../src/analytics/service.ts';
import { LIMITS } from '../src/analytics/engine.ts';

const raw = new MemoryStore();
const reads: Array<{ coll: string; spec: any; rows: number }> = [];
const store = Object.assign(Object.create(raw), { findBy: async (coll: string, t: string, spec: any) => { const r = await findRows<any>(raw, coll, t, spec); reads.push({ coll, spec, rows: r.length }); return r; } });
const ctx = makeContext({ store, tenantId: 't1' });
const wf = resolveWorkflowServiceStore(store);
const svc = new AnalyticsService(ctx, wf);
const ALL = { actor: 'root', permissions: ['*'] };
const N = 6000;
const repo = raw.repo<Instance>(Collections.instances);
for (let n = 0; n < N; n++) await repo.put({ id: `p${String(n).padStart(5, '0')}`, tenantId: 't1', deploymentId: 'd', workflowId: 'w', processId: 'proc', status: n % 100 === 0 ? 'failed' : 'completed', variables: {}, tokens: [], history: [], startedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, n % 3600)).toISOString(), startedBy: `u${n % 7}`, ...(n >= 100 && n < 500 ? { parentInstanceId: `p${String(n - 100).padStart(5, '0')}` } : {}) } as Instance);
await raw.repo<Instance>(Collections.instances).put({ id: 'other', tenantId: 't2', status: 'failed' } as any);
const preview = (q: any, params?: any) => svc.preview(q, params, ALL);
const reset = () => { reads.length = 0; };
const maxRead = () => Math.max(0, ...reads.map((r) => r.rows));

test('SCALE-1 an equality on a stored field is handed to the store: only matching rows are read', async () => {
  reset();
  const r = await preview({ from: 'process', where: { op: 'and', items: [{ field: 'process.status', op: 'eq', value: 'failed' }] }, metrics: [{ fn: 'count', as: 'n' }] });
  assert.deepStrictEqual(r.rows, [{ n: 60 }]);
  assert.strictEqual(reads.reduce((a, x) => a + x.rows, 0), 60, 'the store returned 60 rows, not 6000');
  assert.deepStrictEqual(reads[0]!.spec.eq, { status: 'failed' });
  const viaParam = await svc.preview({ from: 'process', where: { op: 'and', items: [{ field: 'process.startedBy', op: 'in', value: { param: 'who' } }] }, metrics: [{ fn: 'count', as: 'n' }] }, { who: ['u1', 'u2'] }, ALL);
  assert.ok((viaParam.rows[0]!.n as number) > 1500 && (viaParam.rows[0]!.n as number) < 1800);
});

test('SCALE-2 a computed or dynamic condition is NOT pushed (it is evaluated here) — and the answer is the same as without pushdown', async () => {
  reset();
  const r = await preview({ from: 'process', where: { op: 'and', items: [{ field: 'process.durationMs', op: 'gt', value: 0 }] }, metrics: [{ fn: 'count', as: 'n' }] });
  assert.strictEqual(r.rows[0]!.n, 0);
  assert.ok(reads.every((x) => !x.spec.eq), 'nothing pushed for a computed field');
});

test('SCALE-3 rows arrive in pages (never one giant read) and a full page of an unsorted list stops the scan early', async () => {
  reset();
  const r = await preview({ from: 'process', select: [{ field: 'process.id', as: 'id' }], limit: 10 });
  assert.strictEqual(r.rows.length, 10); assert.strictEqual(r.meta.total, null, 'stopped early, total unknown');
  assert.ok(r.meta.scanned <= 2000, `scanned ${r.meta.scanned}`);
  reset();
  await preview({ from: 'process', metrics: [{ fn: 'count', as: 'n' }] });
  assert.ok(maxRead() <= 2000, `largest single read: ${maxRead()}`);
  assert.strictEqual(reads.reduce((a, x) => a + x.rows, 0), N, 'all rows were read, in pages');
});

test('SCALE-4 sorting keeps only the top rows: same page as a full sort, over 6000 rows', async () => {
  const q = { from: 'process', select: [{ field: 'process.id', as: 'id' }, { field: 'process.startedAt', as: 't' }], sort: [{ field: 't', dir: 'desc' as const }, { field: 'id' }], limit: 5, offset: 3 };
  const r = await preview(q);
  const all = (await repo.query((x) => x.tenantId === 't1')).map((x) => ({ id: x.id, t: x.startedAt })).sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : a.id.localeCompare(b.id)));
  assert.deepStrictEqual(r.rows, all.slice(3, 8)); assert.strictEqual(r.meta.total, N);
});

test('SCALE-5 recursion reads one level at a time (not the whole process table), and finds the same tree', async () => {
  reset();
  const roots = Array.from({ length: 50 }, (_, n) => `p${String(n).padStart(5, '0')}`);
  const r = await preview({ from: 'process', joins: [{ rel: 'process.descendants', as: 'sub', type: 'inner' }], where: { op: 'and', items: [{ field: 'process.id', op: 'in', value: roots }] }, groupBy: [{ field: 'process.id', as: 'root' }], metrics: [{ fn: 'count', as: 'subs' }, { fn: 'max', field: 'sub.depth', as: 'deepest' }], sort: [{ field: 'root' }] });
  assert.strictEqual(r.rows.length, 50); assert.deepStrictEqual(r.rows[0], { root: 'p00000', subs: 4, deepest: 4 });   // p00000 → p00100 → p00200 → p00300 → p00400
  const levelReads = reads.filter((x) => x.spec.eq?.parentInstanceId);
  assert.ok(levelReads.length <= 5, `${levelReads.length} level lookups for 50 roots (not 50 x depth)`);
  assert.ok(maxRead() <= 2000);
});

test('SCALE-6 groups and scan are capped while reading and reported as truncated', async () => {
  const keep = { ...LIMITS };
  try {
    LIMITS.maxGroups = 3;
    const g = await preview({ from: 'process', groupBy: [{ field: 'process.id', as: 'id' }], metrics: [{ fn: 'count', as: 'n' }] });
    assert.strictEqual(g.meta.truncated, true); assert.match(g.meta.truncatedReason!, /group limit/); assert.ok(g.rows.length <= 3);
    Object.assign(LIMITS, keep); LIMITS.maxScan = 2500; reset();
    const s = await preview({ from: 'process', metrics: [{ fn: 'count', as: 'n' }] });
    assert.strictEqual(s.rows[0]!.n, 2500); assert.match(s.meta.truncatedReason!, /scan limit/);
  } finally { Object.assign(LIMITS, keep); }
});

test('SCALE-7 another workspace is never read, even by a lookup', async () => {
  reset();
  const r = await preview({ from: 'process', where: { op: 'and', items: [{ field: 'process.id', op: 'eq', value: 'other' }] }, metrics: [{ fn: 'count', as: 'n' }] });
  assert.strictEqual(r.rows[0]!.n, 0);
});
after(() => setTimeout(() => process.exit(0), 50).unref());

test('SCALE-8 the result cache is bounded by bytes: it evicts oldest first, refuses one oversized result, never exceeds its budget', async () => {
  const { analyticsCacheStats, clearAnalyticsCache, cacheLimits } = await import('../src/analytics/service.ts');
  const keep = cacheLimits.bytes;
  try {
    clearAnalyticsCache(); cacheLimits.bytes = 30_000;
    const made = await svc.create({ slug: 'cached-rows', name: 'Cached rows', status: 'published', cacheSeconds: 300, params: [{ name: 'n', type: 'number', required: true }],
      query: { from: 'process', where: { op: 'and', items: [{ field: 'process.startedBy', op: 'eq', value: 'u1' }] }, select: [{ field: 'process.id', as: 'id' }, { field: 'process.startedAt', as: 't' }], limit: 60 } }, ALL);
    assert.ok(made.id);
    for (let n = 0; n < 40; n++) await svc.run('cached-rows', { n }, 'http', ALL);          // 40 distinct parameter sets, each a ~3 KB result
    const st = analyticsCacheStats();
    assert.ok(st.bytes <= 30_000, `cache holds ${st.bytes} bytes (limit 30000)`); assert.ok(st.entries > 0 && st.entries < 40, `${st.entries} entries kept of 40`);
    clearAnalyticsCache(); cacheLimits.bytes = 1000;                                          // smaller than one result x 4: not cacheable at all
    await svc.run('cached-rows', { n: 1 }, 'http', ALL);
    assert.strictEqual(analyticsCacheStats().entries, 0, 'an oversized result is simply not cached');
  } finally { cacheLimits.bytes = keep; clearAnalyticsCache(); }
});
