// Safety net for release 2.0.0: recorded behaviour of TODAY's engine. A change here is a regression unless it was approved on purpose.
// Re-record only deliberately:  UPDATE_GOLDEN=1 node --import tsx --test test/golden.test.ts
import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { kit } from './flow-kit.ts';
import { validateProcess } from '../src/modules/validation/rules.ts';

const DIR = path.resolve(import.meta.dirname, 'fixtures/golden');
function golden(name: string, actual: unknown) {
  const file = path.join(DIR, `${name}.json`);
  const text = JSON.stringify(actual, null, 1) + '\n';
  if (process.env.UPDATE_GOLDEN === '1' || !fs.existsSync(file)) { fs.writeFileSync(file, text); return; }
  assert.deepStrictEqual(JSON.parse(text), JSON.parse(fs.readFileSync(file, 'utf8')), `${name}: behaviour changed (re-record with UPDATE_GOLDEN=1 only if intended)`);
}

test('GOLD-1 the real project (23 processes) validates exactly as before', async () => {
  const project = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../../../policy_system_node_project.json'), 'utf8'));
  const out: Record<string, unknown> = {};
  for (const p of project.processes) {
    const r = await validateProcess(p);
    // the Java-compile rule depends on a JVM being installed, so it is not part of the stable record
    out[p.id] = r.problems.filter((x) => x.rule !== 'java-support').map((x) => `${x.severity}:${x.rule}:${x.nodeId ?? x.flowId ?? ''}:${x.message}`).sort();
  }
  golden('validation-policy-project', out);
});

test('GOLD-2 representative flows run exactly as before (traces)', async () => {
  const out: Record<string, unknown> = {};
  const k = kit();
  const V = [{ name: 'x', type: 'Number' }, { name: 'out', type: 'String' }, { name: 'items', type: 'Object' }];
  const sc = (code: string, id = 'sc') => ({ id, type: 'script', lang: 'js', code });

  { const w = await k.deploy('linear', ...(Object.values(k.line(sc('vars.out = "a"; vars.x = 1;'))) as [any[], any[]]), V); out.linear = k.trace(await k.start(w.wf.id)); }
  for (const x of [1, 9]) {
    const w = await k.deploy(`xor${x}`, [{ id: 's', type: 'start' }, { id: 'g', type: 'gateway', mode: 'exclusive', default: 'fd' }, sc('vars.out="big"', 'big'), sc('vars.out="small"', 'small'), { id: 'e', type: 'end' }],
      [{ id: 'f0', from: 's', to: 'g' }, { id: 'fb', from: 'g', to: 'big', when: 'x > 5', lang: 'js' }, { id: 'fd', from: 'g', to: 'small' }, { id: 'f1', from: 'big', to: 'e' }, { id: 'f2', from: 'small', to: 'e' }], V);
    out[`exclusive-x${x}`] = k.trace(await k.start(w.wf.id, { x }));
  }
  { const w = await k.deploy('par', [{ id: 's', type: 'start' }, { id: 'fork', type: 'gateway', mode: 'parallel' }, sc('vars.x=(vars.x||0)+1', 'a'), sc('vars.x=(vars.x||0)+10', 'b'), { id: 'join', type: 'gateway', mode: 'parallel' }, { id: 'e', type: 'end' }],
      [{ id: 'f0', from: 's', to: 'fork' }, { id: 'f1', from: 'fork', to: 'a' }, { id: 'f2', from: 'fork', to: 'b' }, { id: 'f3', from: 'a', to: 'join' }, { id: 'f4', from: 'b', to: 'join' }, { id: 'f5', from: 'join', to: 'e' }], V);
    out.parallel = k.trace(await k.start(w.wf.id)); }
  { const w = await k.deploy('task', ...(Object.values(k.line({ id: 'u', type: 'userTask', name: 'Review', group: 'g' }, sc('vars.out="after"'))) as [any[], any[]]), V);
    const i = await k.start(w.wf.id); const before = k.trace(i); await k.completeTask((await k.tasks(i.id))[0]!.id, { x: 5 }); out.userTask = { before, after: k.trace(await k.get(i.id)) }; }
  { const w = await k.deploy('timer', ...(Object.values(k.line({ id: 'c', type: 'catch', event: { timer: { duration: 'PT5M' } } }, sc('vars.out="woke"'))) as [any[], any[]]), V);
    const i = await k.start(w.wf.id); const before = k.trace(i); await k.tick(10 * 60); out.catchTimer = { before, after: k.trace(await k.get(i.id)) }; }
  { const w = await k.deploy('boundary', [{ id: 's', type: 'start' }, { id: 'u', type: 'userTask', name: 'Slow', group: 'g' }, { id: 'bt', type: 'boundary', on: 'u', event: { timer: { duration: 'PT1H' } }, interrupting: true }, sc('vars.out="escalated"', 'esc'), { id: 'e', type: 'end' }, { id: 'e2', type: 'end' }],
      [{ id: 'f0', from: 's', to: 'u' }, { id: 'f1', from: 'u', to: 'e' }, { id: 'f2', from: 'bt', to: 'esc' }, { id: 'f3', from: 'esc', to: 'e2' }], V);
    const i = await k.start(w.wf.id); await k.tick(2 * 3600); out.boundaryTimer = { instance: k.trace(await k.get(i.id)), tasks: (await k.tasks(i.id)).map((t) => t.status) }; }
  { const w = await k.deploy('sigcatch', ...(Object.values(k.line({ id: 'c', type: 'catch', event: { signal: 'GO' } }, sc('vars.out="went"'))) as [any[], any[]]), V);
    const i = await k.start(w.wf.id); const before = k.trace(i); const { InstanceService } = await import('../src/modules/instances/service.ts');
    const r = await new InstanceService(k.ctx).broadcast('GO', undefined, 'amy'); out.signalCatch = { before, signaled: r.signaled, after: k.trace(await k.get(i.id)) }; }
  { const w = await k.deploy('errb', [{ id: 's', type: 'start' }, sc('throw new Error("boom")', 'bad'), { id: 'be', type: 'boundary', on: 'bad', event: { error: '' } }, sc('vars.out="handled"', 'h'), { id: 'e', type: 'end' }, { id: 'e2', type: 'end' }],
      [{ id: 'f0', from: 's', to: 'bad' }, { id: 'f1', from: 'bad', to: 'e' }, { id: 'f2', from: 'be', to: 'h' }, { id: 'f3', from: 'h', to: 'e2' }], V);
    out.errorBoundary = k.trace(await k.start(w.wf.id)); }
  { const w = await k.deploy('unhandled', ...(Object.values(k.line(sc('throw new Error("nope")'))) as [any[], any[]]), V); out.unhandledError = k.trace(await k.start(w.wf.id)); }
  { const child = await k.deploy('child', ...(Object.values(k.line(sc('vars.out = "from child"'))) as [any[], any[]]), V);
    const w = await k.deploy('caller', ...(Object.values(k.line({ id: 'c', type: 'call', process: child.processId, outputs: { out: 'out' } })) as [any[], any[]]), V);
    out.callSync = k.trace(await k.start(w.wf.id)); }
  { const child = await k.deploy('childwait', ...(Object.values(k.line({ id: 'u', type: 'userTask', name: 'Child task', group: 'g' })) as [any[], any[]]), V);
    const w = await k.deploy('callerwait', ...(Object.values(k.line({ id: 'c', type: 'call', process: child.processId }, sc('vars.out="parent done"'))) as [any[], any[]]), V);
    const i = await k.start(w.wf.id); const before = k.trace(i); const t = (await k.tasks()).find((x) => x.name === 'Child task')!; await k.completeTask(t.id); out.callWaiting = { before, after: k.trace(await k.get(i.id)) }; }
  { const w = await k.deploy('sub', ...(Object.values(k.line({ id: 'sp', type: 'subprocess', nodes: [{ id: 'ss', type: 'start' }, sc('vars.out="inner"', 'in'), { id: 'se', type: 'end' }], flows: [{ id: 'sf0', from: 'ss', to: 'in' }, { id: 'sf1', from: 'in', to: 'se' }] })) as [any[], any[]]), V);
    out.subprocess = k.trace(await k.start(w.wf.id)); }
  { const w = await k.deploy('term', [{ id: 's', type: 'start' }, { id: 'fork', type: 'gateway', mode: 'parallel' }, { id: 'u', type: 'userTask', name: 'Never', group: 'g' }, { id: 'et', type: 'end', result: 'terminate' }, { id: 'e', type: 'end' }],
      [{ id: 'f0', from: 's', to: 'fork' }, { id: 'f1', from: 'fork', to: 'u' }, { id: 'f2', from: 'fork', to: 'et' }, { id: 'f3', from: 'u', to: 'e' }], V);
    const i = await k.start(w.wf.id); out.terminate = { instance: k.trace(i), tasks: (await k.tasks(i.id)).map((t) => t.status) }; }
  { const w = await k.deploy('async', ...(Object.values(k.line({ ...sc('vars.out="bg"'), async: true })) as [any[], any[]]), V);
    const i = await k.start(w.wf.id); const before = k.trace(i); await k.tick(5); out.asyncNode = { before, after: k.trace(await k.get(i.id)) }; }
  golden('traces', out);
});
after(() => setTimeout(() => process.exit(0), 50).unref());
