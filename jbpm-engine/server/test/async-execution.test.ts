// "Is Async" nodes and background starts: the caller is released at once, the worker runs the node, retries infrastructure failures.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { MemoryStore } from '../src/store/memory-store.ts';
import { fakeClock } from '../src/infra/ids.ts';
import { makeContext } from '../src/context.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { InstanceService } from '../src/modules/instances/service.ts';
import { TimerService } from '../src/modules/timers/service.ts';
import { Collections, type TimerJob } from '../src/domain.ts';
import { boot } from './harness.ts';

const T0 = '2025-01-01T00:00:00.000Z';
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

async function deployed(nodes: any[], flows: any[], vars: any[] = []) {
  let n = 0;
  const store = new MemoryStore();
  const ctx = makeContext({ store, tenantId: 't1', clock: fakeClock(T0).clock, newId: () => `id${++n}` });
  const wf = await new WorkflowService(ctx).create({ name: 'Async WF' }, 'a');
  const draft = await new VersionService(ctx).saveDraft(wf.defaultBranchId, { id: wf.key, name: wf.name, processes: [{ id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars, nodes, flows }] } as any, 'a');
  const pub = await new VersionService(ctx).publish(draft.id, 'a');
  await new DeploymentService(ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'a');
  return { store, ctx, wf, jobs: () => store.repo<TimerJob>(Collections.timers).query(() => true) };
}
const line = (asyncNode: Record<string, unknown> = {}) => ({
  nodes: [{ id: 's', type: 'start' }, { id: 'sc', type: 'script', lang: 'js', code: 'vars.done = true;', ...asyncNode }, { id: 'e', type: 'end' }],
  flows: [{ id: 'f1', from: 's', to: 'sc' }, { id: 'f2', from: 'sc', to: 'e' }],
});

test('ASYNC-1 an async node parks the token, returns to the caller, and the worker runs it', async () => {
  const w = await deployed(...(Object.values(line({ async: true })) as [any[], any[]]), [{ name: 'done', type: 'boolean' }]);
  const inst = await new InstanceService(w.ctx).start({ workflowId: w.wf.id, environment: 'prod' }, 'bob');
  assert.strictEqual(inst.status, 'waiting', 'the caller gets the instance parked at the async node');
  assert.notStrictEqual(inst.variables.done, true, 'the script has not run yet');
  assert.strictEqual(inst.tokens[0]!.waitFor?.kind, 'async');
  const [job] = await w.jobs();
  assert.strictEqual(job!.kind, 'async'); assert.strictEqual(job!.status, 'scheduled');
  assert.strictEqual(await new TimerService(w.ctx).tick(at(1)), 1);
  const done = await new InstanceService(w.ctx).get(inst.id);
  assert.strictEqual(done.status, 'completed'); assert.strictEqual(done.variables.done, true);
  assert.strictEqual(done.history.filter((h) => h.nodeId === 'sc').length, 1, 'one visit — the queued marker is replaced by the real run');
});

test('ASYNC-2 a node without async still runs inline (default unchanged)', async () => {
  const w = await deployed(...(Object.values(line()) as [any[], any[]]), [{ name: 'done', type: 'boolean' }]);
  const inst = await new InstanceService(w.ctx).start({ workflowId: w.wf.id, environment: 'prod' }, 'bob');
  assert.strictEqual(inst.status, 'completed'); assert.strictEqual((await w.jobs()).length, 0);
});

test('ASYNC-3 a background start returns before the first node runs', async () => {
  const w = await deployed(...(Object.values(line()) as [any[], any[]]), [{ name: 'done', type: 'boolean' }]);
  const inst = await new InstanceService(w.ctx).start({ workflowId: w.wf.id, environment: 'prod', async: true }, 'bob');
  assert.strictEqual(inst.status, 'running'); assert.strictEqual(inst.history.length, 0);
  assert.strictEqual(inst.tokens[0]!.waitFor?.kind, 'async');
  const stored = await new InstanceService(w.ctx).get(inst.id);
  assert.strictEqual(stored.status, 'running', 'it exists and can be followed');
  await new TimerService(w.ctx).tick(at(1));
  const done = await new InstanceService(w.ctx).get(inst.id);
  assert.strictEqual(done.status, 'completed'); assert.strictEqual(done.variables.done, true);
});

test('ASYNC-4 a business error inside an async node follows the normal error model', async () => {
  const w = await deployed(...(Object.values(line({ async: true, code: 'throw new Error("boom")' })) as [any[], any[]]));
  const inst = await new InstanceService(w.ctx).start({ workflowId: w.wf.id, environment: 'prod' }, 'bob');
  await new TimerService(w.ctx).tick(at(1));
  const done = await new InstanceService(w.ctx).get(inst.id);
  assert.strictEqual(done.status, 'failed'); assert.match(done.error!.message, /boom/);
});

test('ASYNC-5 an infrastructure failure retries with backoff, then fails the instance when attempts run out', async () => {
  const w = await deployed(...(Object.values(line({ async: true, asyncRetries: 1, asyncRetryDelay: 'PT5S' })) as [any[], any[]]));
  const inst = await new InstanceService(w.ctx).start({ workflowId: w.wf.id, environment: 'prod' }, 'bob');
  const [job] = await w.jobs();
  assert.strictEqual(job!.maxAttempts, 2); assert.strictEqual(job!.retryDelayMs, 5000);
  const real = InstanceService.prototype.fireAsync;
  InstanceService.prototype.fireAsync = async () => { throw new Error('store unavailable'); };
  try {
    await new TimerService(w.ctx).tick(at(1));
    let j = (await w.jobs())[0]!;
    assert.strictEqual(j.status, 'scheduled'); assert.strictEqual(j.attempts, 1); assert.match(j.lastError!, /store unavailable/);
    assert.strictEqual((await new InstanceService(w.ctx).get(inst.id)).status, 'waiting', 'still waiting between attempts');
    await new TimerService(w.ctx).tick(at(60));
    j = (await w.jobs())[0]!;
    assert.strictEqual(j.attempts, 2); assert.notStrictEqual(j.status, 'scheduled', 'attempts used up');
    const failed = await new InstanceService(w.ctx).get(inst.id);
    assert.strictEqual(failed.status, 'failed'); assert.match(failed.error!.message, /after 2 attempt/);
  } finally { InstanceService.prototype.fireAsync = real; }
});

test('ASYNC-6 aborting an instance cancels its queued async job', async () => {
  const w = await deployed(...(Object.values(line({ async: true })) as [any[], any[]]));
  const inst = await new InstanceService(w.ctx).start({ workflowId: w.wf.id, environment: 'prod' }, 'bob');
  await new InstanceService(w.ctx).abort(inst.id, 'bob');
  assert.strictEqual(await new TimerService(w.ctx).tick(at(1)), 0);
  assert.strictEqual((await w.jobs())[0]!.status, 'cancelled');
});

test('ASYNC-7 HTTP: async:true or Prefer: respond-async answers 202 with a Location; plain start stays 201', async () => {
  const h = await boot();
  try {
    const ws = await h.workspace('asyncws');
    const wf = await new WorkflowService(ws.ctx).create({ name: 'Http Async' }, 'a');
    const draft = await new VersionService(ws.ctx).saveDraft(wf.defaultBranchId, { id: wf.key, name: wf.name, processes: [{ id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars: [], ...line() }] } as any, 'a');
    const pub = await new VersionService(ws.ctx).publish(draft.id, 'a');
    await new DeploymentService(ws.ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'a');
    const start = (extra: Record<string, unknown>, headers: Record<string, string> = {}) =>
      h.call('POST', '/instances', { token: ws.tokens.owner, tenant: ws.id, body: { workflowId: wf.id, environment: 'prod', ...extra }, headers });
    const sync = await start({});
    assert.strictEqual(sync.status, 201); assert.strictEqual(sync.body.status, 'completed');
    const a = await start({ async: true });
    assert.strictEqual(a.status, 202); assert.match(a.headers.get('location')!, /\/api\/instances\/.+/); assert.strictEqual(a.body.status, 'running');
    const b = await start({}, { prefer: 'respond-async' });
    assert.strictEqual(b.status, 202); assert.strictEqual(b.headers.get('preference-applied'), 'respond-async');
  } finally { await h.close(); }
});
after(() => setTimeout(() => process.exit(0), 50).unref());

test('ASYNC-8 validation: async on a node that cannot run in the background warns; bad retries / delay are errors', async () => {
  const { validateProcess } = await import('../src/modules/validation/rules.ts');
  const mk = (extra: Record<string, unknown>, type = 'script') => ({
    id: 'p', name: 'p', package: 'x', vars: [],
    nodes: [{ id: 's', type: 'start' }, { id: 'n', type: type as any, name: 'N', lang: 'js', code: 'x=1', ...extra }, { id: 'e', type: 'end' }],
    flows: [{ id: 'f1', from: 's', to: 'n' }, { id: 'f2', from: 'n', to: 'e' }],
  } as any);
  const rule = (r: Awaited<ReturnType<typeof validateProcess>>) => r.problems.filter((p) => p.rule === 'async-config');
  assert.deepStrictEqual(rule(await validateProcess(mk({ async: true, asyncRetries: 2, asyncRetryDelay: 'PT30S' }))), []);
  assert.strictEqual(rule(await validateProcess(mk({ async: true }, 'manual')))[0]?.severity, 'warning');
  assert.strictEqual(rule(await validateProcess(mk({ async: true, asyncRetries: 99 })))[0]?.severity, 'error');
  assert.strictEqual(rule(await validateProcess(mk({ async: true, asyncRetryDelay: 'soon' })))[0]?.severity, 'error');
});
