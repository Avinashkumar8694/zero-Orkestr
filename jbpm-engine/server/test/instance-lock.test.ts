// Two "replicas" (separate service objects over one copying store, like a real database) hitting the SAME instance at once.
// Without a per-instance lease the second writer overwrites the first (lost update) or both resume the same token.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { kit } from './flow-kit.ts';
import { InstanceService } from '../src/modules/instances/service.ts';
import { WORKITEM_HANDLERS } from '../src/engine/workitems/registry.ts';

// a real side effect (an e-mail, an HTTP call) that must happen once, however many replicas race
let effects = 0;
(WORKITEM_HANDLERS as Record<string, unknown>).countme = async () => { effects++; return {}; };
const effect = (id = 'inc') => ({ id, type: 'workItem', handler: 'countme', params: {}, resultTo: {} });

const replicaA = (k: ReturnType<typeof kit>) => new InstanceService(k.ctx);
const replicaB = (k: ReturnType<typeof kit>) => new InstanceService(k.ctx);

test('LOCK-1 20 concurrent variable edits from two replicas: none is lost', async () => {
  const k = kit('t1', { copies: true });
  const w = await k.deploy('lock1', ...(Object.values(k.line({ id: 'u', type: 'userTask', name: 'Wait', group: 'g' })) as [any[], any[]]));
  const i = await k.start(w.wf.id);
  const [a, b] = [replicaA(k), replicaB(k)];
  await Promise.all(Array.from({ length: 20 }, (_, n) => (n % 2 ? a : b).updateVariables(i.id, { [`k${n}`]: n }, 'amy').catch((e) => e)));
  const vars = (await k.get(i.id)).variables;
  assert.deepStrictEqual(Object.keys(vars).filter((x) => x.startsWith('k')).length, 20, JSON.stringify(vars));
});

test('LOCK-2 five replicas signal the same waiting instance at once: it resumes exactly once', async () => {
  const k = kit('t1', { copies: true });
  const w = await k.deploy('lock2', ...(Object.values(k.line({ id: 'c', type: 'catch', event: { signal: 'GO' } }, effect())) as [any[], any[]]), [{ name: 'x', type: 'Number' }]);
  effects = 0;
  const i = await k.start(w.wf.id);
  await Promise.all(Array.from({ length: 5 }, () => new InstanceService(k.ctx).signal(i.id, 'GO', undefined, 'amy').catch((e) => e)));
  const done = await k.get(i.id);
  assert.strictEqual(done.status, 'completed');
  assert.strictEqual(effects, 1, 'the side effect happened once');
  assert.strictEqual(done.history.filter((h) => h.nodeId === 'inc').length, 1);
});

test('LOCK-3 a timer fire and a task completion racing on one instance: one consistent outcome, no double run', async () => {
  const k = kit('t1', { copies: true });
  const w = await k.deploy('lock3', [{ id: 's', type: 'start' }, { id: 'u', type: 'userTask', name: 'Slow', group: 'g' }, { id: 'bt', type: 'boundary', on: 'u', event: { timer: { duration: 'PT1H' } }, interrupting: true },
    effect('esc'), { id: 'e', type: 'end' }, { id: 'e2', type: 'end' }],
    [{ id: 'f0', from: 's', to: 'u' }, { id: 'f1', from: 'u', to: 'e' }, { id: 'f2', from: 'bt', to: 'esc' }, { id: 'f3', from: 'esc', to: 'e2' }], [{ name: 'x', type: 'Number' }]);
  effects = 0;
  const i = await k.start(w.wf.id);
  const t = (await k.tasks(i.id))[0]!;
  await Promise.all([k.tick(2 * 3600).catch((e) => e), k.completeTask(t.id).catch((e) => e), k.tick(2 * 3600).catch((e) => e)]);
  const done = await k.get(i.id);
  assert.strictEqual(done.status, 'completed');
  assert.ok(effects <= 1, 'the escalation path ran at most once');
  assert.ok(done.history.filter((h) => h.nodeId === 'e' || h.nodeId === 'e2').length === 1, 'exactly one end was reached');
});
after(() => setTimeout(() => process.exit(0), 50).unref());
