// Release 2.0.0 phase 2: timers (cron, #{var}, short delays), link events, conditional events, signal scope, suspend-until.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { kit, T0, at } from './flow-kit.ts';
import { cronNext, cronValid, computeDue, parseCron } from '../src/engine/duration.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import { InstanceService } from '../src/modules/instances/service.ts';
import { validateProcess } from '../src/modules/validation/rules.ts';
import { Collections, type TimerJob } from '../src/domain.ts';

const sc = (code: string, id = 'sc', extra: Record<string, unknown> = {}) => ({ id, type: 'script', lang: 'js', code, ...extra });
const V = [{ name: 'x', type: 'Number' }, { name: 'out', type: 'String' }, { name: 'delay', type: 'String' }, { name: 'n', type: 'Number' }];
const L = (k: ReturnType<typeof kit>, ...mid: any[]) => Object.values(k.line(...mid)) as [any[], any[]];
const iso = (s: string) => Date.parse(s);
const nextIso = (expr: string, from = '2025-01-01T00:00:00Z') => { const n = cronNext(expr, iso(from)); return n === null ? null : new Date(n).toISOString().replace('.000Z', 'Z'); };

test('G17 cron: next-fire times for POSIX (5 fields) and Quartz (6-7 fields), names, steps, L, ?, dom/dow OR, leap day, year', () => {
  const table: Array<[string, string, string | null]> = [
    ['0 9 * * *', '2025-01-01T00:00:00Z', '2025-01-01T09:00:00Z'],
    ['*/15 * * * *', '2025-01-01T00:00:00Z', '2025-01-01T00:15:00Z'],
    ['*/15 * * * *', '2025-01-01T00:15:00Z', '2025-01-01T00:30:00Z'],          // strictly after
    ['0 0 1 * *', '2025-01-01T00:00:00Z', '2025-02-01T00:00:00Z'],
    ['30 8 * * MON', '2025-01-01T00:00:00Z', '2025-01-06T08:30:00Z'],
    ['0 0 29 2 *', '2025-01-01T00:00:00Z', '2028-02-29T00:00:00Z'],              // next leap day
    ['0 12 L * *', '2025-01-01T00:00:00Z', '2025-01-31T12:00:00Z'],              // last day of the month
    ['0 12 L * *', '2025-02-01T00:00:00Z', '2025-02-28T12:00:00Z'],
    ['0 0 12 ? * MON-FRI', '2025-01-01T00:00:00Z', '2025-01-01T12:00:00Z'],       // Quartz, a Wednesday
    ['0 0 12 ? * MON-FRI', '2025-01-03T13:00:00Z', '2025-01-06T12:00:00Z'],       // after Friday noon: Monday
    ['0/30 * * * * ?', '2025-01-01T00:00:00Z', '2025-01-01T00:00:30Z'],           // seconds
    ['0 0 13 * 5', '2025-01-01T00:00:00Z', '2025-01-03T00:00:00Z'],               // POSIX: day 13 OR Friday
    ['5 4 * * SUN', '2025-01-01T00:00:00Z', '2025-01-05T04:05:00Z'],
    ['0 8 * * 7', '2025-01-01T00:00:00Z', '2025-01-05T08:00:00Z'],                // POSIX: 7 is Sunday
    ['0 0 8 ? * 1', '2025-01-01T00:00:00Z', '2025-01-05T08:00:00Z'],              // Quartz: 1 is Sunday
    ['10/20 * * * *', '2025-01-01T00:00:00Z', '2025-01-01T00:10:00Z'],
    ['10/20 * * * *', '2025-01-01T00:10:00Z', '2025-01-01T00:30:00Z'],
    ['0 0 0 1 1 ? 2030', '2025-01-01T00:00:00Z', '2030-01-01T00:00:00Z'],         // year field
    ['59 23 31 12 *', '2025-01-01T00:00:00Z', '2025-12-31T23:59:00Z'],
    ['0 0 * JAN,MAR *', '2025-01-01T00:00:00Z', '2025-01-02T00:00:00Z'],
    ['0 0 * JAN,MAR *', '2025-01-31T00:00:00Z', '2025-03-01T00:00:00Z'],
    ['0 9-17/4 * * *', '2025-01-01T10:00:00Z', '2025-01-01T13:00:00Z'],           // 9, 13, 17
    ['0 0 30 2 *', '2025-01-01T00:00:00Z', null],                                 // February 30th never happens
  ];
  for (const [expr, from, want] of table) assert.strictEqual(nextIso(expr, from), want, `${expr} after ${from}`);
  for (const bad of ['* * *', '61 * * * *', 'foo * * * *', '* 25 * * *', '*/0 * * * *', '* * 32 * *', '5-1 * * * *']) assert.ok(!cronValid(bad), `${bad} is invalid`);
  assert.ok(cronValid('0 0 12 ? * MON-FRI') && cronValid('*/5 * * * *') && cronValid('0 0 0 1 1 ? 2030'));
  assert.throws(() => parseCron('1 2'), /5 fields/);
});

test('G17/G18/G19 computeDue: cron, #{variable}, short delays, dates; a missing variable is an error, not an instant fire', () => {
  const now = '2025-01-01T00:00:00.000Z';
  assert.strictEqual(computeDue({ cron: '0 9 * * *' }, now), '2025-01-01T09:00:00.000Z');
  assert.strictEqual(computeDue('cron:0 9 * * *', now), '2025-01-01T09:00:00.000Z');
  assert.strictEqual(computeDue({ cycle: '0 9 * * *', language: 'cron' }, now), '2025-01-01T09:00:00.000Z');
  assert.strictEqual(computeDue({ cycle: 'cron:*/10 * * * *' }, now), '2025-01-01T00:10:00.000Z');
  assert.strictEqual(computeDue({ duration: '#{wait}' }, now, { wait: 'PT10M' }), '2025-01-01T00:10:00.000Z');
  assert.strictEqual(computeDue('#{cfg.delay}', now, { cfg: { delay: '2h' } }), '2025-01-01T02:00:00.000Z');
  assert.strictEqual(computeDue({ duration: '1h 30m' }, now), '2025-01-01T01:30:00.000Z');
  assert.strictEqual(computeDue({ duration: '90m' }, now), '2025-01-01T01:30:00.000Z');
  assert.strictEqual(computeDue({ date: '#{d}' }, now, { d: '2025-06-01T12:00:00Z' }), '2025-06-01T12:00:00.000Z');
  assert.strictEqual(computeDue({ cycle: 'R/PT1H' }, now), '2025-01-01T01:00:00.000Z', 'existing forms unchanged');
  assert.strictEqual(computeDue('PT5M', now), '2025-01-01T00:05:00.000Z');
  assert.throws(() => computeDue({ duration: '#{wait}' }, now, {}), /variable has no value/);
  assert.throws(() => computeDue({ cron: '0 0 30 2 *' }, now), /never fires/);
});

test('G17-G19 timers in flows: cron catch, #{var} delay, short delay, failing cleanly on a missing variable', async () => {
  const k = kit();
  const cronCatch = await k.deploy('croncatch', ...L(k, { id: 'c', type: 'catch', event: { timer: { cron: '0 9 * * *' } } }, sc('vars.out="woke"')), V);
  const i = await k.start(cronCatch.wf.id);
  const job = (await k.store.repo<TimerJob>(Collections.timers).query((t) => t.instanceId === i.id))[0]!;
  assert.strictEqual(job.dueAt, '2025-01-01T09:00:00.000Z');
  await k.tick(8 * 3600); assert.strictEqual((await k.get(i.id)).status, 'waiting');
  await k.tick(10 * 3600); assert.strictEqual((await k.get(i.id)).variables.out, 'woke');
  const dv = await k.deploy('varDelay', ...L(k, { id: 'c', type: 'catch', event: { timer: { duration: '#{delay}' } } }, sc('vars.out="late"')), V);
  const j = await k.start(dv.wf.id, { delay: 'PT10M' });
  await k.tick(5 * 60); assert.strictEqual((await k.get(j.id)).status, 'waiting'); await k.tick(11 * 60); assert.strictEqual((await k.get(j.id)).status, 'completed');
  const miss = await k.start(dv.wf.id);
  assert.strictEqual(miss.status, 'failed'); assert.match(miss.error!.message, /variable has no value/);
  const short = await k.deploy('shortDelay', ...L(k, { id: 'c', type: 'catch', event: { timer: { duration: '90m' } } }), V);
  const s = await k.start(short.wf.id);
  await k.tick(80 * 60); assert.strictEqual((await k.get(s.id)).status, 'waiting'); await k.tick(100 * 60); assert.strictEqual((await k.get(s.id)).status, 'completed');
});

test('G17 cron start timer and non-interrupting cron boundary: recurring, fires once after downtime (no catch-up storm)', async () => {
  const k = kit();
  const st = await k.deploy('cronstart', [{ id: 's', type: 'start', on: { timer: { cron: '*/10 * * * *' } } }, sc('vars.n = 1;', 'sc'), { id: 'e', type: 'end' }], [{ id: 'f0', from: 's', to: 'sc' }, { id: 'f1', from: 'sc', to: 'e' }], V);
  const jobs = () => k.store.repo<TimerJob>(Collections.timers).query((t) => t.kind === 'start' && t.status === 'scheduled');
  assert.strictEqual((await jobs())[0]!.dueAt, '2025-01-01T00:10:00.000Z'); assert.strictEqual((await jobs())[0]!.cycle, 'cron:*/10 * * * *');
  await k.tick(11 * 60); assert.strictEqual((await k.instances()).length, 1);
  assert.strictEqual((await jobs())[0]!.dueAt, '2025-01-01T00:20:00.000Z', 'the next occurrence is scheduled');
  await k.tick(3 * 3600);                                              // the system was "down" for ~3 hours: 18 occurrences were missed
  assert.strictEqual((await k.instances()).length, 2, 'it fires ONCE, not 18 times');
  assert.ok(Date.parse((await jobs())[0]!.dueAt) > Date.parse(at(3 * 3600)), 'and the next one is in the future');
  void st;
  const bd = await k.deploy('cronboundary', [{ id: 's', type: 'start' }, { id: 'u', type: 'userTask', name: 'Wait', group: 'g' }, { id: 'bt', type: 'boundary', on: 'u', event: { timer: { cron: '*/5 * * * *' } }, interrupting: false }, sc('vars.n = (vars.n || 0) + 1;', 'h'), { id: 'e', type: 'end' }, { id: 'e2', type: 'end' }],
    [{ id: 'f0', from: 's', to: 'u' }, { id: 'f1', from: 'u', to: 'e' }, { id: 'f2', from: 'bt', to: 'h' }, { id: 'f3', from: 'h', to: 'e2' }], V);
  const i = await k.start(bd.wf.id);
  await k.tick(6 * 60); await k.tick(12 * 60);
  const done = await k.get(i.id);
  assert.strictEqual(done.history.filter((h) => h.nodeId === 'h').length, 2, 'the boundary fired at each occurrence');
  assert.strictEqual(done.status, 'waiting', 'a non-interrupting boundary leaves the task running');
});

test('G20 link events: a throw jumps to the catch of the same name; the validator pairs them and sees through the jump', async () => {
  const k = kit();
  const flow = (throwLink: string, catchLinks: string[]) => ({
    nodes: [{ id: 's', type: 'start' }, { id: 't', type: 'throw', name: 'Go to B', event: { link: throwLink } }, ...catchLinks.map((l, n) => ({ id: `c${n}`, type: 'catch', name: `B${n}`, event: { link: l } })),
      sc('vars.out = "landed";', 'landed', { name: 'Landed' }), { id: 'e', type: 'end' }],
    flows: [{ id: 'f0', from: 's', to: 't' }, { id: 'f1', from: 'c0', to: 'landed' }, { id: 'f2', from: 'landed', to: 'e' }],
  });
  const ok = flow('B', ['B']);
  assert.deepStrictEqual((await validateProcess({ id: 'p', name: 'p', package: 'x', vars: [], ...ok } as any)).problems.filter((p) => p.severity === 'error'), [], 'valid, and nothing downstream of the catch is "unreachable"');
  const w = await k.deploy('linkok', ok.nodes, ok.flows, V);
  const i = await k.start(w.wf.id); assert.strictEqual(i.status, 'completed'); assert.strictEqual(i.variables.out, 'landed');
  assert.ok(i.history.some((h) => h.nodeId === 't' && h.outcome === 'link:B'));
  const msgs = async (f: any) => (await validateProcess({ id: 'p', name: 'p', package: 'x', vars: [], ...f } as any)).problems.filter((p) => p.rule === 'link-events').map((p) => `${p.severity}:${p.message}`);
  assert.match((await msgs(flow('MISSING', ['B'])))[0]!, /error:Link throw "Go to B" has no catch named "MISSING"/);
  assert.match((await msgs(flow('B', ['B', 'B'])))[0]!, /error:Link "B" has 2 catch events/);
  assert.match((await msgs(flow('B', ['B', 'ORPHAN']))).join('|'), /warning:Link catch "B1" is never thrown to/);
});

test('G21 conditional catch: passes at once when true; otherwise waits and is released by a variable edit or by work in another branch', async () => {
  const k = kit();
  const cond = (name: string) => k.deploy(name, ...L(k, { id: 'c', type: 'catch', event: { condition: 'x > 5', lang: 'js' } }, sc('vars.out="through"')), V);
  const w = await cond('condcatch');
  assert.strictEqual((await k.start(w.wf.id, { x: 9 })).variables.out, 'through', 'already true: no waiting');
  const i = await k.start(w.wf.id, { x: 1 });
  assert.strictEqual(i.status, 'waiting'); assert.deepStrictEqual(k.trace(i).waiting, ['c:condition']);
  await new InstanceService(k.ctx).updateVariables(i.id, { x: 3 }, 'amy');
  assert.strictEqual((await k.get(i.id)).status, 'waiting', 'still false');
  await new InstanceService(k.ctx).updateVariables(i.id, { x: 8 }, 'amy');
  const done = await k.get(i.id); assert.strictEqual(done.status, 'completed'); assert.strictEqual(done.variables.out, 'through');
  // released by the outcome of a task in a parallel branch
  const par = await k.deploy('condpar', [{ id: 's', type: 'start' }, { id: 'fork', type: 'gateway', mode: 'parallel' }, { id: 'u', type: 'userTask', name: 'Decide', group: 'g', outputs: { x: 'x' } }, { id: 'e1', type: 'end' },
      { id: 'c', type: 'catch', event: { condition: 'x > 5', lang: 'js' } }, sc('vars.out="branch B"', 'b'), { id: 'e2', type: 'end' }],
    [{ id: 'f0', from: 's', to: 'fork' }, { id: 'f1', from: 'fork', to: 'u' }, { id: 'f2', from: 'fork', to: 'c' }, { id: 'f3', from: 'u', to: 'e1' }, { id: 'f4', from: 'c', to: 'b' }, { id: 'f5', from: 'b', to: 'e2' }], V);
  const p = await k.start(par.wf.id, { x: 0 });
  await k.completeTask((await k.tasks(p.id))[0]!.id, { x: 10 });
  const pd = await k.get(p.id); assert.strictEqual(pd.status, 'completed'); assert.strictEqual(pd.variables.out, 'branch B');
});

test('G22 conditional boundary: interrupts its host when the condition becomes true', async () => {
  const k = kit();
  const w = await k.deploy('condbound', [{ id: 's', type: 'start' }, { id: 'u', type: 'userTask', name: 'Slow', group: 'g' }, { id: 'bc', type: 'boundary', on: 'u', event: { condition: 'x > 5', lang: 'js' }, interrupting: true },
    sc('vars.out="cut short"', 'h'), { id: 'e', type: 'end' }, { id: 'e2', type: 'end' }],
    [{ id: 'f0', from: 's', to: 'u' }, { id: 'f1', from: 'u', to: 'e' }, { id: 'f2', from: 'bc', to: 'h' }, { id: 'f3', from: 'h', to: 'e2' }], V);
  const i = await k.start(w.wf.id, { x: 1 });
  assert.strictEqual(i.status, 'waiting');
  await new InstanceService(k.ctx).updateVariables(i.id, { x: 7 }, 'amy');
  const d = await k.get(i.id);
  assert.strictEqual(d.status, 'completed'); assert.strictEqual(d.variables.out, 'cut short');
  assert.deepStrictEqual((await k.tasks(i.id)).map((t) => t.status), ['exited'], 'the interrupted task was closed');
});

test('G24 signal scope: scope "instance" never leaves the instance; the default still reaches other instances', async () => {
  const k = kit();
  const outsider = await k.deploy('outsider', ...L(k, { id: 'c', type: 'catch', event: { signal: 'GO' } }), V);
  const out = await k.start(outsider.wf.id);
  const mk = (name: string, scope?: string) => k.deploy(name, [{ id: 's', type: 'start' }, { id: 'fork', type: 'gateway', mode: 'parallel' }, { id: 'c', type: 'catch', event: { signal: 'GO' } }, sc('vars.out="got"', 'g'), { id: 'e1', type: 'end' },
    { id: 't', type: 'throw', event: { signal: 'GO', ...(scope ? { scope } : {}) } }, { id: 'e2', type: 'end' }],
    [{ id: 'f0', from: 's', to: 'fork' }, { id: 'f1', from: 'fork', to: 'c' }, { id: 'f2', from: 'fork', to: 't' }, { id: 'f3', from: 'c', to: 'g' }, { id: 'f4', from: 'g', to: 'e1' }, { id: 'f5', from: 't', to: 'e2' }], V);
  const local = await k.start((await mk('scoped', 'instance')).wf.id);
  assert.strictEqual(local.variables.out, 'got', 'its own branch received it');
  assert.strictEqual((await k.get(out.id)).status, 'waiting', 'the other instance did not');
  await k.start((await mk('wide')).wf.id);          // (a workspace-wide signal never reached the sender's OWN running branches: that is what scope "instance" is for)
  assert.strictEqual((await k.get(out.id)).status, 'completed', 'the default scope reaches the whole workspace (unchanged)');
});

test('G25 suspend until: the task exists but cannot be claimed until its time, then appears', async () => {
  const k = kit();
  const w = await k.deploy('susp', ...L(k, { id: 'u', type: 'userTask', name: 'Later', group: 'g', suspendUntil: 'PT1H' }), V);
  const i = await k.start(w.wf.id);
  const t = (await k.tasks(i.id))[0]!;
  assert.strictEqual(t.status, 'suspended');
  await assert.rejects(new TaskService(k.ctx).claim(t.id, 'amy'), /not claimable/);
  await k.tick(30 * 60); assert.strictEqual((await k.tasks(i.id))[0]!.status, 'suspended');
  await k.tick(2 * 3600); assert.strictEqual((await k.tasks(i.id))[0]!.status, 'created');
  assert.strictEqual((await new TaskService(k.ctx).claim(t.id, 'amy')).assignee, 'amy');
  const plain = await k.deploy('nosusp', ...L(k, { id: 'u', type: 'userTask', name: 'Now', group: 'g' }), V);
  assert.strictEqual((await k.tasks((await k.start(plain.wf.id)).id))[0]!.status, 'created', 'unset: unchanged');
});

test('timer-spec validation: bad cron / date / duration are reported with a clear message; good and #{var} forms pass', async () => {
  const mk = (timer: unknown) => ({ id: 'p', name: 'p', package: 'x', vars: [], nodes: [{ id: 's', type: 'start' }, { id: 'c', type: 'catch', name: 'Wait', event: { timer } }, { id: 'e', type: 'end' }], flows: [{ id: 'f0', from: 's', to: 'c' }, { id: 'f1', from: 'c', to: 'e' }] } as any);
  const errs = async (t: unknown) => (await validateProcess(mk(t))).problems.filter((p) => p.rule === 'timer-spec').map((p) => p.message);
  for (const good of ['PT5M', '1h 30m', 'cron:0 9 * * *', { cron: '0 9 * * MON-FRI' }, { duration: '#{d}' }, { date: '2030-01-01T00:00:00Z' }, { cycle: 'R/PT1H' }, { cycle: '*/5 * * * *', language: 'cron' }]) assert.deepStrictEqual(await errs(good), [], JSON.stringify(good));
  assert.match((await errs({ cron: '61 * * * *' }))[0]!, /cron expression "61 \* \* \* \*" is not valid/);
  assert.match((await errs('whenever'))[0]!, /is not a duration/);
  assert.match((await errs({ date: 'someday' }))[0]!, /is not a date/);
  assert.match((await errs({ cycle: 'soon' }))[0]!, /not readable/);
});
after(() => setTimeout(() => process.exit(0), 50).unref());
