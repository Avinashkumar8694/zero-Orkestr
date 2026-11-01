// A long loop must not make the instance row grow without bound — and capping must not change what the process does.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { kit } from './flow-kit.ts';
import { historyCap, compactHistory, visitCount } from '../src/engine/history-cap.ts';

const loopFlow = (k: ReturnType<typeof kit>, laps: number) => k.deploy(`loop${laps}`,
  [{ id: 's', type: 'start' }, { id: 'init', type: 'script', lang: 'js', code: 'vars.n = 0;' }, { id: 'merge', type: 'gateway', mode: 'exclusive' }, { id: 'fork', type: 'gateway', mode: 'parallel' },
    { id: 'a', type: 'script', lang: 'js', code: 'vars.a = (vars.a || 0) + 1;' }, { id: 'b', type: 'script', lang: 'js', code: 'vars.b = (vars.b || 0) + 1;' },
    { id: 'join', type: 'gateway', mode: 'parallel' }, { id: 'inc', type: 'script', lang: 'js', code: 'vars.n = vars.n + 1;' },
    { id: 'again', type: 'gateway', mode: 'exclusive', default: 'fend' }, { id: 'e', type: 'end' }],
  [{ id: 'f0', from: 's', to: 'init' }, { id: 'f1', from: 'init', to: 'merge' }, { id: 'fm', from: 'merge', to: 'fork' }, { id: 'f2', from: 'fork', to: 'a' }, { id: 'f3', from: 'fork', to: 'b' }, { id: 'f4', from: 'a', to: 'join' }, { id: 'f5', from: 'b', to: 'join' },
    { id: 'f6', from: 'join', to: 'inc' }, { id: 'f7', from: 'inc', to: 'again' }, { id: 'floop', from: 'again', to: 'merge', when: `n < ${laps}`, lang: 'js' }, { id: 'fend', from: 'again', to: 'e' }],
  [{ name: 'n', type: 'Number' }, { name: 'a', type: 'Number' }, { name: 'b', type: 'Number' }]);

test('HIST-1 a loop past the cap keeps the row small; the process behaves exactly as without the cap (parallel joins inside the loop)', async () => {
  const k = kit();
  const w = await loopFlow(k, 25);
  const keep = { ...historyCap };
  try {
    historyCap.max = 0;                                         // reference run: no cap
    const full = await k.start(w.wf.id);
    historyCap.max = 60;
    const capped = await k.start(w.wf.id);
    assert.strictEqual(capped.status, 'completed'); assert.strictEqual(full.status, 'completed');
    assert.deepStrictEqual(capped.variables, full.variables, 'same result');
    assert.ok(full.history.length > 150, `the loop makes a long history (${full.history.length})`);
    assert.ok(capped.history.length <= 60, `capped to ${capped.history.length}`);
    assert.strictEqual(visitCount(capped, 'join'), visitCount(full, 'join'), 'visit counts survive compaction');
    assert.strictEqual(visitCount(capped, 'a'), 25);
  } finally { Object.assign(historyCap, keep); }
});

test('HIST-2 compaction keeps the start and the latest visits, counts what it dropped, and is a no-op below the cap or when switched off', () => {
  const mk = (n: number): any => ({ history: Array.from({ length: n }, (_, i) => ({ tokenId: 't', nodeId: i % 2 ? 'x' : 'y', type: 'script', enteredAt: String(i) })) });
  const keep = { ...historyCap };
  try {
    historyCap.max = 10; historyCap.keepFirst = 3;
    const small = mk(8); compactHistory(small); assert.strictEqual(small.history.length, 8); assert.strictEqual(small.historyCompacted, undefined);
    const big = mk(40); compactHistory(big);
    assert.strictEqual(big.history.length, 10);
    assert.deepStrictEqual(big.history.slice(0, 3).map((h: any) => h.enteredAt), ['0', '1', '2'], 'the start is kept');
    assert.strictEqual(big.history.at(-1).enteredAt, '39', 'the latest is kept');
    assert.strictEqual(Object.values(big.historyCompacted as Record<string, number>).reduce((a, b) => a + b, 0), 30, 'every dropped visit is counted');
    historyCap.max = 0; const off = mk(100); compactHistory(off); assert.strictEqual(off.history.length, 100);
  } finally { Object.assign(historyCap, keep); }
});
after(() => setTimeout(() => process.exit(0), 50).unref());
