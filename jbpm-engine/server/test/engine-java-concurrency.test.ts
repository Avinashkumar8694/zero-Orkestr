// The JVM sidecar used to serialize every Java script/condition call onto HttpServer's single default
// dispatch thread (a per-call System.out.setOut/restore swap made that the only safe option). Fixed
// this session: Server.java runs a real thread-pool Executor, and ScriptRunner.java's log capture is
// thread-local (a single dispatching PrintStream installed once, routing writes via a ThreadLocal
// buffer) instead of a shared-mutable global swap — so concurrent calls now genuinely run in
// parallel. These tests prove three things a timing number alone doesn't: (1) concurrent DIFFERENT
// scripts don't cross-contaminate each other's variables/results, (2) concurrent scripts don't
// cross-contaminate each other's captured log output specifically (the exact thing the thread-local
// fix targets), (3) publish-time validation actually pre-warms the SAME compiled-class cache real
// execution looks up (the classNameFor cache key depends on varTypes shape — passing a different
// shape at validate-time than execution-time, as an earlier version of rules.ts did for scripts,
// computes a different key and silently defeats "compile once at publish"). Plus one real timing
// test proving actual parallelism, with a loose enough bound to not be flaky across machines/CI.
import { test } from 'node:test';
import assert from 'node:assert';
import { runScript, evalCondition } from '../src/engine/sandbox.ts';
import { validateJava, stopJavaSidecar } from '../src/engine/java-sidecar.ts';

test.after(() => stopJavaSidecar());

test('concurrent DIFFERENT Java scripts produce correct, isolated results — no cross-contamination under the thread pool', { timeout: 30000 }, async () => {
  const N = 25;
  const results = await Promise.all(Array.from({ length: N }, async (_, i) => {
    const vars: Record<string, unknown> = { n: i };
    await runScript(
      `kcontext.setVariable("computed", ((Number) kcontext.getVariable("n")).intValue() * 1000);`,
      vars, 5000, { lang: 'java' },
    );
    return { i, computed: vars.computed };
  }));
  for (const r of results) assert.strictEqual(r.computed, r.i * 1000, `instance ${r.i} got another call's result`);
});

test('concurrent Java scripts each get EXACTLY their own captured log output — no cross-thread leakage from the thread-local capture', { timeout: 30000 }, async () => {
  const N = 20;
  const results = await Promise.all(Array.from({ length: N }, (_, i) => {
    const logs: string[] = [];
    return runScript(`System.out.println("UNIQUE_MARKER_${i}");`, {}, 5000, { lang: 'java', log: (line) => logs.push(line) })
      .then(() => ({ i, logs }));
  }));
  for (const r of results) {
    assert.strictEqual(r.logs.length, 1, `instance ${r.i} captured ${r.logs.length} log lines, expected exactly 1`);
    assert.strictEqual(r.logs[0], `UNIQUE_MARKER_${r.i}`, `instance ${r.i} got a different thread's log line`);
  }
});

test('concurrent Java CONDITIONS also stay isolated under the thread pool (not just scripts)', { timeout: 30000 }, async () => {
  const N = 20;
  const results = await Promise.all(Array.from({ length: N }, (_, i) =>
    evalCondition('((Number) kcontext.getVariable("n")).intValue() % 2 == 0', 'java', { n: i }, 5000, { n: 'Integer' }, {}),
  ));
  for (let i = 0; i < N; i++) assert.strictEqual(results[i], i % 2 === 0, `condition for n=${i} got another call's result`);
});

test('publish-time validate() pre-warms the SAME compiled-class cache real execution looks up (matching varTypes shape)', { timeout: 30000 }, async () => {
  const varTypes = { amount: 'double' };
  const code = 'kcontext.setVariable("x", ((Number) kcontext.getVariable("amount")).doubleValue() + 1);';

  await validateJava(code, false, varTypes); // simulates rules.ts's publish-time dry-compile

  const vars: Record<string, unknown> = { amount: 5 };
  const t0 = Date.now();
  await runScript(code, vars, 5000, { lang: 'java', varTypes });
  const afterValidateMs = Date.now() - t0;

  // A genuinely never-validated, distinct script — real cold-compile timing baseline.
  const coldCode = 'kcontext.setVariable("y", ((Number) kcontext.getVariable("amount")).doubleValue() + 2);';
  const t1 = Date.now();
  await runScript(coldCode, { amount: 5 }, 5000, { lang: 'java', varTypes });
  const coldMs = Date.now() - t1;

  assert.strictEqual(vars.x, 6);
  assert.ok(afterValidateMs <= coldMs, `execution after validate() (${afterValidateMs}ms) should be faster than or equal to a genuine cold compile (${coldMs}ms) — cache was not pre-warmed`);
});

test('N concurrent CPU-bound Java scripts run measurably faster than N x (single-call time) — real parallelism, not a serialized queue', { timeout: 30000 }, async () => {
  const N = 8;
  const BUSY_MS = 80;
  const code = `long start = System.nanoTime(); while ((System.nanoTime() - start) < ${BUSY_MS}_000_000L) {} kcontext.setVariable("done", true);`;
  await runScript(code, {}, 5000, { lang: 'java' }); // warm up — exclude one-time compile from the timing
  const t0 = Date.now();
  await Promise.all(Array.from({ length: N }, () => runScript(code, {}, 5000, { lang: 'java' })));
  const elapsed = Date.now() - t0;
  // Loose bound (not tied to a specific core count): a fully-serialized queue would take ~N*BUSY_MS;
  // real parallelism should land well under that even on a constrained CI runner with only 2 cores.
  assert.ok(elapsed < N * BUSY_MS * 0.75, `${N} concurrent ${BUSY_MS}ms scripts took ${elapsed}ms — expected well under ${N * BUSY_MS}ms (serialized), got no meaningful parallelism`);
});
