// REAL multi-replica proof: separate OS processes (replicas), one real Postgres, one real Redis. No simulation.
// Run with `npm run test:live` (starts throw-away Docker containers when PG_URL / REDIS_URL are not set).
import 'reflect-metadata';
import { test, after } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { PgStore } from '../../src/store/pg-store.ts';
import { makeContext } from '../../src/context.ts';
import { config } from '../../src/infra/config.ts';
import { WorkflowService } from '../../src/modules/workflows/service.ts';
import { VersionService } from '../../src/modules/versions/service.ts';
import { DeploymentService } from '../../src/modules/deployments/service.ts';
import { InstanceService } from '../../src/modules/instances/service.ts';
import { TimerService } from '../../src/modules/timers/service.ts';

const TENANT = `live_${Date.now()}`;
const PREFIX = `live-${Date.now()}:`;
const store = new PgStore(config.pgUrl!);
const ctx = makeContext({ store, tenantId: TENANT });
after(async () => { await store.close(); setTimeout(() => process.exit(0), 50).unref(); });

type Out = { replica: string; coordinator: string; ok?: boolean; fired?: number; error?: string };
const worker = (id: string, cmd: object, wait = true) => new Promise<Out>((resolve, reject) => {
  const p = spawn(process.execPath, ['--import', 'tsx', 'test/live/worker.ts'], { env: { ...process.env, REPLICA_ID: id, REDIS_KEY_PREFIX: PREFIX, CLUSTER_HEARTBEAT_MS: '500', LIVE_CMD: JSON.stringify({ tenant: TENANT, ...cmd }) } });
  let buf = ''; p.stdout.on('data', (d) => { buf += d; const m = !wait && buf.split('\n').find((x) => x.startsWith('{"replica"') && x.includes('"ok"')); if (m) resolve(JSON.parse(m)); });
  p.stderr.on('data', (d) => process.env.LIVE_DEBUG && process.stderr.write(d));
  p.on('exit', () => { if (wait) { try { resolve(JSON.parse(buf.split('\n').filter((x) => x.startsWith('{"replica"')).pop()!)); } catch { reject(new Error(`no output from ${id}: ${buf}`)); } } });
  (worker as any).last = p;
});

const deploy = async (name: string, nodes: any[], flows: any[]) => {
  const wf = await new WorkflowService(ctx).create({ name }, 'a');
  const d = await new VersionService(ctx).saveDraft(wf.defaultBranchId, { id: wf.key, name: wf.name, processes: [{ id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars: [], nodes, flows }] } as any, 'a');
  const pub = await new VersionService(ctx).publish(d.id, 'a');
  await new DeploymentService(ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'a');
  return wf;
};
const count = { id: 'cnt', type: 'script', name: 'count', code: "setVariable('n', (getVariable('n') || 0) + 1)" };
const line = (...mid: any[]) => ({ nodes: [{ id: 's', type: 'start' }, ...mid, { id: 'e', type: 'end' }], flows: [{ id: 'f0', from: 's', to: mid[0].id }, ...mid.slice(1).map((m, i) => ({ id: `f${i + 1}`, from: mid[i].id, to: m.id })), { id: 'fe', from: mid.at(-1).id, to: 'e' }] });

test('LIVE-1 workers really use Redis (not the in-process fallback)', async () => {
  const r = await worker('r1', { op: 'claim', key: 'probe', ttlMs: 2000 });
  assert.strictEqual(r.coordinator, 'redis'); assert.strictEqual(r.ok, true);
});

test('LIVE-2 five replicas signal one waiting instance at once: it resumes exactly once', async () => {
  const l = line({ id: 'c', type: 'catch', event: { signal: 'GO' } }, count);
  const wf = await deploy('live2', l.nodes, l.flows);
  const inst = await new InstanceService(ctx).start({ workflowId: wf.id, environment: 'prod' }, 'a');
  const res = await Promise.all(Array.from({ length: 5 }, (_, i) => worker(`rep${i}`, { op: 'signal', id: inst.id, name: 'GO' })));
  assert.ok(res.every((r) => r.coordinator === 'redis'));
  const done = await new InstanceService(ctx).get(inst.id);
  assert.strictEqual(done.status, 'completed');
  assert.strictEqual(done.variables.n, 1, `script ran ${done.variables.n} times`);
  assert.strictEqual(done.history.filter((h: any) => h.nodeId === 'cnt').length, 1);
});

test('LIVE-3 three replicas edit variables of one instance concurrently: no lost update', async () => {
  const l = line({ id: 'u', type: 'userTask', name: 'Wait', group: 'g' });
  const wf = await deploy('live3', l.nodes, l.flows);
  const inst = await new InstanceService(ctx).start({ workflowId: wf.id, environment: 'prod' }, 'a');
  const mk = (p: string) => Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`${p}${i}`, i]));
  await Promise.all(['a', 'b', 'c'].map((p) => worker(`rep-${p}`, { op: 'vars', id: inst.id, vars: mk(p) })));
  const v = (await new InstanceService(ctx).get(inst.id)).variables;
  assert.strictEqual(Object.keys(v).length, 24, JSON.stringify(Object.keys(v)));
});

test('LIVE-4 a due timer is fired by exactly one of four replicas ticking together', async () => {
  const l = line({ id: 'c', type: 'catch', event: { timer: { duration: 'PT1H' } } }, count);
  const wf = await deploy('live4', l.nodes, l.flows);
  const inst = await new InstanceService(ctx).start({ workflowId: wf.id, environment: 'prod' }, 'a');
  const now = new Date(Date.now() + 2 * 3600_000).toISOString();
  const res = await Promise.all(Array.from({ length: 4 }, (_, i) => worker(`tk${i}`, { op: 'tick', now })));
  assert.strictEqual(res.reduce((s, r) => s + (r.fired ?? 0), 0) >= 1, true);
  const done = await new InstanceService(ctx).get(inst.id);
  assert.strictEqual(done.status, 'completed'); assert.strictEqual(done.variables.n, 1, `fired ${done.variables.n} times`);
});

test('LIVE-5 a replica killed while holding a lease: others are refused, then take over after the lease expires', async () => {
  const h = await worker('dead', { op: 'hold', key: 'crash-key', ttlMs: 3000 }, false);
  assert.strictEqual(h.ok, true);
  (worker as any).last.kill('SIGKILL');                                    // crash: no release, no goodbye
  const early = await worker('live-1', { op: 'claim', key: 'crash-key', ttlMs: 3000 });
  assert.strictEqual(early.ok, false, 'lease still held by the dead replica');
  await new Promise((r) => setTimeout(r, 3500));
  const late = await worker('live-2', { op: 'claim', key: 'crash-key', ttlMs: 3000 });
  assert.strictEqual(late.ok, true, 'lease expired, another replica takes over');
});

test('LIVE-6 four replicas each create tasks at the same moment under leastLoaded: they spread evenly, nobody is picked twice by mistake', async () => {
  const l = line({ id: 'u', type: 'userTask', name: 'Review', actors: ['ann', 'bob', 'cy'], assignmentStrategy: 'leastLoaded' });
  const wf = await deploy('live6', l.nodes, l.flows);
  const res = await Promise.all(Array.from({ length: 4 }, (_, i) => worker(`as${i}`, { op: 'start', workflowId: wf.id, count: 3 })));
  assert.ok(res.every((r) => r.ok && r.coordinator === 'redis'), JSON.stringify(res));
  const tasks = await store.repo<any>('tasks').query((t: any) => t.tenantId === TENANT && t.name === 'Review');
  const per = new Map<string, number>(); for (const t of tasks) per.set(String(t.assignee), (per.get(String(t.assignee)) || 0) + 1);
  assert.strictEqual(tasks.length, 12);
  assert.deepStrictEqual([...per.values()].sort(), [4, 4, 4], `spread was ${JSON.stringify([...per])}`);
});
