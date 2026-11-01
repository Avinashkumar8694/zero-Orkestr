// Optional indexed lookup: one set of semantics for the in-memory filter (reference) and the SQL builder; callers get the same rows either way.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { MemoryStore } from '../src/store/memory-store.ts';
import { findRows, matchesSpec, jsonContains, buildFindSql, FIND_INDEXES } from '../src/store/find.ts';
import { kit, T0 } from './flow-kit.ts';
import { InstanceService } from '../src/modules/instances/service.ts';
import { TimerService } from '../src/modules/timers/service.ts';
import { Collections, type TimerJob } from '../src/domain.ts';

test('FIND-1 containment: objects partial, arrays "every pattern element matches some element", scalars equal', () => {
  const tokens = [{ nodeId: 'a', waitFor: { kind: 'signal', ref: 'GO' } }, { nodeId: 'b', waitFor: { kind: 'timer' } }];
  assert.ok(jsonContains(tokens, [{ waitFor: { ref: 'GO' } }]));
  assert.ok(!jsonContains(tokens, [{ waitFor: { ref: 'NO' } }]));
  assert.ok(jsonContains(tokens, [{ nodeId: 'b' }, { nodeId: 'a' }]));
  assert.ok(!jsonContains([], [{ nodeId: 'a' }]));
  assert.ok(!jsonContains(undefined, [{ nodeId: 'a' }]));
});

test('FIND-2 filters: eq / any-of / ranges / containment compose, booleans compare as text like SQL does', () => {
  const row = { id: 'x', status: 'waiting', dueAt: '2025-01-02T00:00:00Z', acknowledged: false, tokens: [{ waitFor: { ref: 'GO' } }] };
  assert.ok(matchesSpec(row, { eq: { status: ['waiting', 'running'], acknowledged: false }, lte: { dueAt: '2025-01-03' }, gte: { dueAt: '2025-01-01' }, contains: { path: 'tokens', value: [{ waitFor: { ref: 'GO' } }] } }));
  assert.ok(!matchesSpec(row, { eq: { status: 'completed' } }));
  assert.ok(!matchesSpec(row, { lte: { dueAt: '2025-01-01' } }));
  assert.ok(!matchesSpec({ id: 'y' }, { lte: { dueAt: '2030' } }), 'a missing field never matches a range');
});

test('FIND-3 the SQL is parameterised: values bound, fields validated, same clauses as the filter', () => {
  const { sql, params } = buildFindSql('instances', 't1', { eq: { status: ['waiting', 'running'] }, lte: { dueAt: 'z' }, contains: { path: 'tokens', value: [{ waitFor: { ref: "GO'; DROP TABLE x;--" } }] }, orderBy: 'dueAt', limit: 50, afterId: 'a1' });
  assert.match(sql, /collection = \$1 AND "tenantId" = \$2/);
  assert.match(sql, /\(data->>'status'\) = ANY\(\$3::text\[\]\)/);
  assert.match(sql, /\(data->'tokens'\) @> \$5::jsonb/);
  assert.match(sql, /ORDER BY \(data->>'dueAt'\) ASC, id ASC LIMIT \$7$/);
  assert.ok(!sql.includes('DROP TABLE'), 'values never reach the SQL text');
  assert.deepStrictEqual(params.slice(0, 3), ['instances', 't1', ['waiting', 'running']]);
  assert.throws(() => buildFindSql('c', 't', { eq: { 'a; DROP': 'x' } }), /bad field/);
  assert.throws(() => buildFindSql('c', 't', { contains: { path: "x'--", value: 1 } }), /bad path/);
  assert.ok(FIND_INDEXES.every((i) => /IF NOT EXISTS/.test(i) && /WHERE collection = /.test(i)));
});

test('FIND-4 findRows: same answer from the fallback and from a store with its own findBy (which is preferred)', async () => {
  const store = new MemoryStore();
  for (let n = 0; n < 30; n++) await store.repo<any>('things').put({ id: `i${String(n).padStart(2, '0')}`, tenantId: n % 5 === 0 ? 'other' : 't1', status: n % 2 ? 'waiting' : 'done', dueAt: `2025-01-${String(n + 1).padStart(2, '0')}` });
  const spec = { eq: { status: 'waiting' }, lte: { dueAt: '2025-01-20' }, orderBy: 'dueAt', limit: 4 };
  const viaFallback = await findRows<any>(store, 'things', 't1', spec);
  assert.deepStrictEqual(viaFallback.map((r) => r.id), ['i01', 'i03', 'i07', 'i09']);
  let called = 0;
  const withSql = Object.assign(Object.create(store), { findBy: async (...a: any[]) => { called++; return viaFallback; } });
  assert.strictEqual((await findRows<any>(withSql, 'things', 't1', spec)).length, 4); assert.strictEqual(called, 1);
  const page2 = await findRows<any>(store, 'things', 't1', { eq: { status: 'waiting' }, afterId: 'i09', limit: 2 });
  assert.deepStrictEqual(page2.map((r) => r.id), ['i11', 'i13']);
});

test('FIND-5 signal delivery asks the store for only the waiting instances (not all of them) and still reaches exactly those', async () => {
  const k = kit();
  const waiter = await k.deploy('sigwait', ...(Object.values(k.line({ id: 'c', type: 'catch', event: { signal: 'GO' } })) as [any[], any[]]));
  const other = await k.deploy('othersig', ...(Object.values(k.line({ id: 'c', type: 'catch', event: { signal: 'NOPE' } })) as [any[], any[]]));
  const targets = await Promise.all([k.start(waiter.wf.id), k.start(waiter.wf.id)]);
  for (let n = 0; n < 15; n++) await k.start(other.wf.id);
  const calls: any[] = [];
  const spied = Object.assign(Object.create(k.store), { findBy: async (c: string, t: string, spec: any) => { calls.push({ c, spec }); const { findRows: fr } = await import('../src/store/find.ts'); return fr(k.store, c, t, spec); } });
  // run the broadcast through a context whose store advertises findBy
  const { makeContext } = await import('../src/context.ts');
  const ctx = makeContext({ store: spied, tenantId: 't1', clock: k.ctx.clock, newId: k.ctx.newId });
  const r = await new InstanceService(ctx).broadcast('GO', undefined, 'amy');
  assert.strictEqual(r.signaled, 2);
  assert.ok(calls.some((x) => x.c === 'instances' && x.spec.contains?.value?.[0]?.waitFor?.ref === 'GO'), 'it used the indexed lookup');
  for (const t of targets) assert.strictEqual((await k.get(t.id)).status, 'completed');
});

test('FIND-6 the timer tick (replica-gated path) loads only one batch of due jobs, oldest first', async () => {
  const k = kit();
  const jobs = k.store.repo<TimerJob>(Collections.timers);
  for (let n = 0; n < 300; n++) await jobs.put({ id: `j${String(n).padStart(3, '0')}`, tenantId: 't1', instanceId: `gone${n}`, tokenId: 't', nodeId: 'n', kind: 'duration', dueAt: new Date(Date.parse(T0) + n * 1000).toISOString(), fired: 0, status: 'scheduled' });
  let loaded = 0;
  const spied = Object.assign(Object.create(k.store), { findBy: async (c: string, t: string, spec: any) => { const rows = await findRows<any>(k.store, c, t, spec); loaded += rows.length; return rows; } });
  const { makeContext } = await import('../src/context.ts');
  const ctx = makeContext({ store: spied, tenantId: 't1', clock: k.ctx.clock, newId: k.ctx.newId });
  const claimed: string[] = [];
  await new TimerService(ctx).tick(new Date(Date.parse(T0) + 1_000_000).toISOString(), { batchSize: 25, claim: async (j) => { claimed.push(j.id); return async () => undefined; } });
  assert.strictEqual(loaded, 25, 'one batch, not all 300');
  assert.deepStrictEqual(claimed.slice(0, 3), ['j000', 'j001', 'j002'], 'oldest first');
});
after(() => setTimeout(() => process.exit(0), 50).unref());
