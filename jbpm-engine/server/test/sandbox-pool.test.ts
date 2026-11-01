// Bounded per-workspace isolate pool: state isolation, bounded creation, queueing, recycling, eviction, fairness.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { runScript, evalCondition, sandboxStats, configureSandbox, sandboxConfig } from '../src/engine/sandbox.ts';

const saved = { ...sandboxConfig() };
beforeEach(() => configureSandbox({ ...saved }));
afterEach(() => configureSandbox({ ...saved }));
const run = (code: string, tenantId: string, vars: Record<string, unknown> = {}, quota?: number, timeout = 2000) =>
  runScript(code, vars, timeout, { tenantId, maxConcurrentScripts: quota }).then(() => vars);
const burn = (ms: number) => `var t = Date.now(); while (Date.now() - t < ${ms}) {}`;
const code = (e: unknown) => (e as { code?: string })?.code;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('POOL-1 state set by one script (globalThis, Object/Array/String prototypes) is invisible to the next, same isolate and across workspaces', async () => {
  const poison = 'globalThis.leak = 42; Object.prototype.p = "pwn"; Array.prototype.q = 1; String.prototype.zz = function(){return 1}; Math.max = function(){return -1}; JSON.stringify = function(){return "x"}; leak2 = 7;';
  await run(poison, 'pool-a', {}, 1);
  const probe = 'vars.out = [typeof globalThis.leak, typeof ({}).p, typeof [].q, typeof "s".zz, Math.max(1,2), typeof leak2].join(",")';
  const same = await run(probe, 'pool-a', {}, 1);
  assert.strictEqual(same.out, 'undefined,undefined,undefined,undefined,2,undefined', 'same pooled isolate, fresh context');
  assert.strictEqual(sandboxStats().isolatesAlive['pool-a'], 1, 'it really was the same (single) isolate');
  const other = await run(probe, 'pool-b');
  assert.strictEqual(other.out, 'undefined,undefined,undefined,undefined,2,undefined', 'other workspace');
  const v = await run('', 'pool-a', { n: 1 }); // and the engine's own variables are untouched by the poison
  assert.deepStrictEqual(v, { n: 1 });
});

test('POOL-2 2000 parallel executions in one workspace: all correct, isolates ≤ pool size, ≤ global ceiling, RSS bounded', async () => {
  configureSandbox({ queueMax: 5000, queueTimeoutMs: 60_000 }); // the default queue (1000) would, by design, reject part of a 2000-burst
  const before = sandboxStats();
  const rss0 = process.memoryUsage().rss;
  let peakRss = rss0, peakIsolates = 0;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); peakIsolates = Math.max(peakIsolates, sandboxStats().totalIsolates); }, 5);
  const N = 2000;
  const results = await Promise.all(Array.from({ length: N }, (_, i) => run('vars.out = vars.n * 2 + 1', 'pool-load', { n: i })));
  clearInterval(sampler);
  results.forEach((r, i) => assert.strictEqual(r.out, i * 2 + 1));
  const after = sandboxStats();
  assert.ok(after.created - before.created <= sandboxConfig().poolDefaultSize + Math.ceil(N / sandboxConfig().maxRuns), `created ${after.created - before.created}`);   // pool size + isolates replaced after max runs
  assert.ok(peakIsolates <= sandboxConfig().maxIsolates, `peak isolates ${peakIsolates}`);
  assert.ok((after.isolatesAlive['pool-load'] ?? 0) <= sandboxConfig().poolDefaultSize);
  assert.ok((peakRss - rss0) / 1048576 < 500, `RSS growth ${(peakRss - rss0) / 1048576}MB`);
});

test('POOL-3 queue overflow and queue timeout surface as QUOTA_EXCEEDED; queued work still completes in order', async () => {
  configureSandbox({ queueMax: 3, queueTimeoutMs: 5000 });
  const running = run(burn(150), 'pool-q', {}, 1);                       // occupies the only isolate
  await sleep(20);
  const queued = Array.from({ length: 3 }, (_, i) => run('vars.i = ' + i, 'pool-q', {}, 1));
  await assert.rejects(run('1', 'pool-q', {}, 1), (e) => code(e) === 'QUOTA_EXCEEDED' && /queue full/.test((e as Error).message));
  await running;
  assert.deepStrictEqual((await Promise.all(queued)).map((v) => v.i), [0, 1, 2]);
  assert.strictEqual(sandboxStats().queued['pool-q'], undefined);

  configureSandbox({ queueMax: 1000, queueTimeoutMs: 60 });
  const hog = run(burn(400), 'pool-qt', {}, 1);
  await sleep(20);
  await assert.rejects(run('1', 'pool-qt', {}, 1), (e) => code(e) === 'QUOTA_EXCEEDED' && /waiting for a script slot/.test((e as Error).message));
  await hog;
  assert.ok(sandboxStats().queueTimeouts >= 1);
  // a condition hitting a full queue throws (never silently "false")
  configureSandbox({ queueMax: 0 });
  const hog2 = run(burn(150), 'pool-qc', {}, 1);
  await sleep(20);
  await assert.rejects(evalCondition('true', 'js', {}, 500, undefined, { tenantId: 'pool-qc', maxConcurrentScripts: 1 }), (e) => code(e) === 'QUOTA_EXCEEDED');
  await hog2;
});

test('POOL-4 a timeout or an OOM recycles only that isolate; concurrent and following runs are unaffected', async () => {
  const r0 = sandboxStats().recycled;
  const good = run(burn(120) + ' vars.ok = 1', 'pool-r', {}, 2);       // other isolate of the same workspace
  await assert.rejects(run('while(true){}', 'pool-r', {}, 2, 80), /timed out/i);
  assert.strictEqual((await good).ok, 1, 'neighbour run survived the other isolate\'s timeout');
  assert.strictEqual(sandboxStats().recycled - r0, 1);
  await assert.rejects(run('var a=[]; while(true) a.push(new Array(1e6).fill(1));', 'pool-r', {}, 2, 5000));
  assert.ok(sandboxStats().recycled - r0 >= 2);
  for (let i = 0; i < 5; i++) assert.strictEqual((await run('vars.v = 5', 'pool-r', {}, 2)).v, 5);
  configureSandbox({ maxRuns: 3 });
  const c0 = sandboxStats().created;
  for (let i = 0; i < 7; i++) await run('1', 'pool-mr', {}, 1);
  assert.ok(sandboxStats().created - c0 >= 2, 'recycled after maxRuns and replaced transparently');
});

test('POOL-5 idle isolates are evicted (stats return to zero)', async () => {
  configureSandbox({ idleMs: 40 });
  await Promise.all(Array.from({ length: 6 }, () => run(burn(10), 'pool-idle', {}, 3)));
  assert.ok(sandboxStats().isolatesAlive['pool-idle'] >= 1);
  await sleep(150);
  assert.strictEqual(sandboxStats().isolatesAlive['pool-idle'], undefined);
});

test('POOL-6 two workspaces under load are served fairly under a tiny global ceiling and never share an isolate', async () => {
  configureSandbox({ maxIsolates: 2, idleMs: 60_000 });
  let peak = 0, done = 0, doneAtB = -1;
  const sampler = setInterval(() => { peak = Math.max(peak, sandboxStats().totalIsolates); }, 2);
  const a = Array.from({ length: 60 }, (_, i) => run(burn(8) + ' vars.t = "A"', 'fair-a', { i }, 4).then((v) => { done++; assert.strictEqual(v.t, 'A'); }));
  await sleep(10);
  const b = Array.from({ length: 6 }, () => run(burn(8) + ' vars.t = "B"', 'fair-b', {}, 4).then((v) => { done++; assert.strictEqual(v.t, 'B'); }));
  await Promise.all(b); doneAtB = done;
  await Promise.all(a);
  clearInterval(sampler);
  assert.ok(peak <= 2, `peak ${peak}`);
  assert.ok(doneAtB < 66 - 25, `B was served while A still had a backlog (done at B finish: ${doneAtB})`);
  const alive = sandboxStats().isolatesAlive;
  assert.ok(!('fair-a' in alive && 'fair-b' in alive && alive['fair-a'] + alive['fair-b'] > 2));
});

// ------------------------------------------------ overflow mode: queue vs reject, effective concurrency
import { resetSandboxPeaks, effectiveScriptConcurrency, effectiveOverflowMode } from '../src/engine/sandbox.ts';
import { MemoryStore } from '../src/store/memory-store.ts';
import { fakeClock } from '../src/infra/ids.ts';
import { makeContext } from '../src/context.ts';
import { SettingsService } from '../src/modules/settings/service.ts';

const runM = (c: string, tenantId: string, quota: number | undefined, mode: string | undefined, vars: Record<string, unknown> = {}) =>
  runScript(c, vars, 2000, { tenantId, maxConcurrentScripts: quota, scriptOverflowMode: mode }).then(() => vars);
const settle = (ps: Promise<unknown>[]) => Promise.allSettled(ps);

test('POOL-7 reject mode: 2000 simultaneous with limit 50 → exactly 50 run, 1950 refused immediately with QUOTA_EXCEEDED', async () => {
  configureSandbox({ poolMaxSize: 64, maxIsolates: 64, overflowMode: 'queue' });
  await Promise.all(Array.from({ length: 50 }, () => runM(burn(30), 'rej-a', 50, 'reject'))); // warm the pool: rejection speed, not isolate boot
  resetSandboxPeaks();
  const t0 = performance.now();
  let rejectedAt = 0;
  const ps = Array.from({ length: 2000 }, (_, i) => runM(burn(60) + ' vars.out = vars.n', 'rej-a', 50, 'reject', { n: i })
    .catch((e) => { rejectedAt = Math.max(rejectedAt, performance.now() - t0); throw e; }));
  const rs = await settle(ps);
  const ok = rs.filter((r) => r.status === 'fulfilled').length;
  const rejected = rs.filter((r) => r.status === 'rejected' && code((r as PromiseRejectedResult).reason) === 'QUOTA_EXCEEDED').length;
  assert.strictEqual(ok, 50);
  assert.strictEqual(rejected, 1950);
  assert.ok(rejectedAt < 100, `all rejections returned within ${rejectedAt.toFixed(1)}ms (not after waiting)`);
  assert.strictEqual(sandboxStats().peakRunning['rej-a'], 50);
  assert.strictEqual(sandboxStats().queued['rej-a'], undefined, 'reject mode never queues');
  // POOL-12 (f): the pool is healthy afterwards
  for (let i = 0; i < 5; i++) assert.strictEqual((await runM('vars.v = 1', 'rej-a', 50, 'reject')).v, 1);
  assert.ok(sandboxStats().totalIsolates >= 1);
});

test('POOL-8 queue mode: same burst with a big enough queue → all 2000 succeed and never more than 50 run at once', async () => {
  configureSandbox({ poolMaxSize: 64, maxIsolates: 64, queueMax: 5000, queueTimeoutMs: 60_000 });
  resetSandboxPeaks();
  const rs = await Promise.all(Array.from({ length: 2000 }, (_, i) => runM('vars.out = vars.n * 2', 'que-a', 50, 'queue', { n: i })));
  rs.forEach((r, i) => assert.strictEqual(r.out, i * 2));
  assert.ok(sandboxStats().peakRunning['que-a'] <= 50, `peak ${sandboxStats().peakRunning['que-a']}`);
  assert.strictEqual(sandboxStats().effectiveConcurrency['que-a'], 50);
});

test('POOL-9 queue mode with a small queue / short wait → the documented overflow and timeout errors', async () => {
  configureSandbox({ queueMax: 2, queueTimeoutMs: 60 });
  const hog = runM(burn(300), 'que-b', 1, 'queue');
  await sleep(20);
  const waiters = [runM('1', 'que-b', 1, 'queue'), runM('1', 'que-b', 1, 'queue')];
  await assert.rejects(runM('1', 'que-b', 1, 'queue'), (e) => code(e) === 'QUOTA_EXCEEDED' && /queue full/.test((e as Error).message));
  const w = await settle(waiters);
  assert.ok(w.every((r) => r.status === 'rejected' && /waiting for a script slot/.test(String((r as PromiseRejectedResult).reason?.message))), 'waiters time out');
  await hog;
});

test('POOL-10 effective concurrency = min(quota || default, SCRIPT_POOL_MAX_SIZE); per-workspace mode beats env; invalid mode is rejected', async () => {
  configureSandbox({ poolDefaultSize: 4, poolMaxSize: 16, overflowMode: 'queue' });
  assert.strictEqual(effectiveScriptConcurrency(0), 4);
  assert.strictEqual(effectiveScriptConcurrency(undefined), 4);
  assert.strictEqual(effectiveScriptConcurrency(50), 16, 'a quota above the pool max is capped by SCRIPT_POOL_MAX_SIZE');
  configureSandbox({ poolMaxSize: 100 });
  assert.strictEqual(effectiveScriptConcurrency(50), 50);
  assert.strictEqual(effectiveOverflowMode(undefined), 'queue');
  assert.strictEqual(effectiveOverflowMode('reject'), 'reject', 'workspace beats env');
  configureSandbox({ overflowMode: 'reject' });
  assert.strictEqual(effectiveOverflowMode(undefined), 'reject', 'unset = env');
  assert.strictEqual(effectiveOverflowMode('queue'), 'queue', 'workspace beats env (other direction)');

  const ctx = makeContext({ store: new MemoryStore(), tenantId: 'ws-set', clock: fakeClock().clock, newId: (() => { let n = 0; return () => `s${++n}`; })() });
  const svc = new SettingsService(ctx);
  assert.strictEqual((await svc.update({ scriptOverflowMode: 'reject' }, 'a')).scriptOverflowMode, 'reject');
  await assert.rejects(svc.update({ scriptOverflowMode: 'drop' as never }, 'a'), (e) => (e as { code?: string }).code === 'VALIDATION' || /scriptOverflowMode/.test((e as Error).message));
  assert.strictEqual((await svc.get()).scriptOverflowMode, 'reject', 'invalid update left the setting untouched');
  assert.strictEqual((await svc.update({ scriptOverflowMode: null as never }, 'a')).scriptOverflowMode, undefined, 'null = back to the env default');
});

test('POOL-11 one workspace in reject mode and another in queue mode behave independently at the same time', async () => {
  configureSandbox({ poolMaxSize: 16, queueMax: 100, queueTimeoutMs: 5000 });
  const rej = Array.from({ length: 6 }, () => runM(burn(80), 'mix-r', 2, 'reject'));
  const que = Array.from({ length: 6 }, (_, i) => runM(burn(20) + ' vars.i = ' + i, 'mix-q', 2, 'queue'));
  const [r, q] = await Promise.all([settle(rej), Promise.all(que)]);
  assert.strictEqual(r.filter((x) => x.status === 'fulfilled').length, 2);
  assert.strictEqual(r.filter((x) => x.status === 'rejected' && code((x as PromiseRejectedResult).reason) === 'QUOTA_EXCEEDED').length, 4);
  assert.deepStrictEqual(q.map((v) => v.i), [0, 1, 2, 3, 4, 5], 'queue-mode workspace waited and all succeeded');
});
