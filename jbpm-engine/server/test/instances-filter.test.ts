// What is selected on the Instances page is what the server returns: multi-state selection, type, initiator, errors-only,
// search — and the per-state / per-type counts are faceted (they ignore their own filter, so ticking a state never zeroes the others).
import { test, after } from 'node:test';
import assert from 'node:assert';
import { boot } from './harness.ts';
import { Collections } from '../src/domain.ts';

const h = await boot();
after(() => h.close());
const ws = await h.workspace('inst-filter');
const T = { token: ws.tokens.owner, tenant: ws.id };
const mk = (id: string, status: string, startedBy: string, extra: Record<string, unknown> = {}) => h.store.repo<any>(Collections.instances).put({
  id, tenantId: ws.id, workflowId: 'wf', deploymentId: 'dep', processId: 'proc.' + id, status, variables: {}, tokens: [], history: [],
  startedAt: `2026-01-0${id.length}T00:00:00.000Z`, startedBy, ...extra,
});
await mk('a', 'running', 'alice'); await mk('bb', 'waiting', 'alice'); await mk('ccc', 'suspended', 'bob');
await mk('dddd', 'failed', 'bob', { error: { nodeId: 'n', message: 'boom', at: '2026-01-04T00:00:00.000Z' } });
await mk('eeeee', 'completed', 'carol'); await mk('ffffff', 'aborted', 'carol');
const list = async (q: string) => (await h.call('GET', `/instances${q}`, T)).body as { items: any[]; total: number; counts: any };
const ids = (r: { items: any[] }) => r.items.map((i) => i.id).sort();

test('INSF-01 several states selected → exactly those states come back (comma-separated list)', async () => {
  assert.deepStrictEqual(ids(await list('?status=running,waiting,suspended')), ['a', 'bb', 'ccc']);
  assert.deepStrictEqual(ids(await list('?status=failed,completed')), ['dddd', 'eeeee']);
  assert.deepStrictEqual(ids(await list('?status=aborted')), ['ffffff']);
  assert.strictEqual((await list('')).total, 6, 'no status filter → everything');
});
test('INSF-02 initiator, errors-only and search are applied on the server', async () => {
  assert.deepStrictEqual(ids(await list('?startedBy=bob')), ['ccc', 'dddd']);
  assert.deepStrictEqual(ids(await list('?errorsOnly=true')), ['dddd']);
  assert.deepStrictEqual(ids(await list('?q=proc.ccc')), ['ccc']);
  assert.deepStrictEqual(ids(await list('?status=running,failed&startedBy=bob')), ['dddd'], 'filters combine (AND)');
});
test('INSF-03 paging counts the FILTERED set, not everything', async () => {
  const r = await list('?status=running,waiting,suspended&limit=2&offset=0');
  assert.strictEqual(r.total, 3); assert.strictEqual(r.items.length, 2);
  const r2 = await list('?status=running,waiting,suspended&limit=2&offset=2');
  assert.strictEqual(r2.items.length, 1);
});
test('INSF-04 counts are faceted: each state/type count ignores its own filter', async () => {
  const r = await list('?status=running');
  assert.deepStrictEqual(ids(r), ['a']);
  assert.deepStrictEqual(r.counts.byStatus, { running: 1, waiting: 1, suspended: 1, failed: 1, completed: 1, aborted: 1 }, 'other states keep their numbers');
  assert.strictEqual(r.counts.byType.all, 1, 'type counts follow the selected states (1 running instance)');
  assert.strictEqual((await list('')).counts.byType.all, 6);
  const bob = await list('?startedBy=bob&status=failed');
  assert.deepStrictEqual(bob.counts.byStatus, { suspended: 1, failed: 1 }, 'counts follow the OTHER filters (initiator)');
});
test('INSF-05 other workspaces never leak into results or counts', async () => {
  const other = await h.workspace('inst-filter-b');
  const r = (await h.call('GET', '/instances', { token: other.tokens.owner, tenant: other.id })).body as any;
  assert.strictEqual(r.total, 0); assert.deepStrictEqual(r.counts.byStatus, {});
});

test('INSF-06 tasks / jobs / deployments accept a comma-separated state list too', async () => {
  const { inList } = await import('../src/infra/filters.ts');
  assert.ok(inList('created,reserved', 'reserved')); assert.ok(inList(' created , reserved ', 'created'));
  assert.ok(!inList('created,reserved', 'completed')); assert.ok(inList(undefined, 'anything')); assert.ok(inList('', 'anything'));
  assert.ok(inList('active', 'active')); assert.ok(!inList('active', 'inactive'));
});
