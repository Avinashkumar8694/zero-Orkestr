// Case instance / Process instance nodes: operations, parameter binding, result handling, self-target rule, workspace isolation.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { MemoryStore } from '../src/store/memory-store.ts';
import { fakeClock } from '../src/infra/ids.ts';
import { makeContext } from '../src/context.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { InstanceService } from '../src/modules/instances/service.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import { AnalyticsService } from '../src/analytics/service.ts';
import { resolveWorkflowServiceStore } from '../src/workflow-service/store/index.ts';
import { Collections, type Instance } from '../src/domain.ts';
import { NODE_DEF_BY_TYPE, NODE_HANDLERS } from '../src/engine/nodes/index.ts';
import { OPS } from '../src/engine/nodes/instance-ops/ops.ts';

const T0 = '2025-01-01T00:00:00.000Z';
const store = new MemoryStore();
let n = 0;
const mk = (tenantId: string) => makeContext({ store, tenantId, clock: fakeClock(T0).clock, newId: () => `id${++n}` });
const ctx = mk('t1'), other = mk('t2');
const wfs = resolveWorkflowServiceStore(store);

async function deploy(c = ctx, name: string, nodes: any[], flows: any[], vars: any[] = []) {
  const wf = await new WorkflowService(c).create({ name }, 'a');
  const draft = await new VersionService(c).saveDraft(wf.defaultBranchId, { id: wf.key, name: wf.name, processes: [{ id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars, nodes, flows }] } as any, 'a');
  const pub = await new VersionService(c).publish(draft.id, 'a');
  await new DeploymentService(c).deploy(pub.published.id, { environment: 'prod', activate: true }, 'a');
  return wf;
}
const line = (...mid: any[]) => ({
  nodes: [{ id: 's', type: 'start' }, ...mid, { id: 'e', type: 'end' }],
  flows: [{ id: 'f0', from: 's', to: mid[0].id }, ...mid.slice(1).map((m, i) => ({ id: `f${i + 1}`, from: mid[i].id, to: m.id })), { id: 'fe', from: mid.at(-1).id, to: 'e' }],
});
const V = [{ name: 'out', type: 'Object' }, { name: 'status', type: 'String' }, { name: 'amt', type: 'Number' }, { name: '_caseInstanceId', type: 'String' }];
const run = async (wfId: string, variables: Record<string, unknown> = {}) => new InstanceService(ctx).start({ workflowId: wfId, environment: 'prod', variables }, 'amy');
const caseRow = (id: string, tenantId = 't1', extra: any = {}) => wfs.instances().put({ id, tenantId, workflowDefinitionId: 'd', workflowName: 'claims', deploymentId: 'dep', data: { claim: { amount: 250 }, region: 'EU' }, status: 'active', piid: null, createdAt: T0, createdBy: 'amy', updatedAt: T0, updatedBy: 'amy', ...extra } as any);
await wfs.definitions().put({ id: 'd', tenantId: 't1', name: 'claims', deploymentId: 'dep', dataSchema: {}, schemaValidationEnabled: false, createdAt: T0, createdBy: 'a', updatedAt: T0, updatedBy: 'a' } as any);
await caseRow('c1'); await caseRow('cB', 't2', { data: { secret: 'B' } });

test('NI-1 registered: both nodes exist with an operation select and per-operation fields shown only for that operation', () => {
  for (const t of ['caseInstance', 'processInstance']) {
    assert.ok(NODE_HANDLERS[t], `${t} handler`);
    const d = NODE_DEF_BY_TYPE[t]!;
    const op = d.schema.flatMap((s) => s.fields).find((f) => f.key === 'operation')!;
    assert.ok(op.options!.length >= 8, `${t} lists its operations`);
    const params = d.schema.find((s) => s.title === 'Parameters')!.fields;
    assert.ok(params.every((f) => f.when?.key === 'operation' && f.when.in.length > 0), 'every parameter is tied to the operations that use it');
    assert.ok(d.palette[0]!.category === 'Instances');
  }
  assert.ok(NODE_DEF_BY_TYPE.caseInstance!.schema.flatMap((s) => s.fields).find((f) => f.key === 'operation')!.options!.includes('analytics.run'));
  assert.ok(!NODE_DEF_BY_TYPE.caseInstance!.schema.flatMap((s) => s.fields).find((f) => f.key === 'operation')!.options!.includes('process.abort'), 'a case node lists case operations only');
  assert.strictEqual(new Set(OPS.map((o) => o.key)).size, OPS.length);
});

test('NI-2 case node: read data with the flow’s case by default, a path, and a $variable id', async () => {
  const wf = await deploy(ctx, 'Case read', ...(Object.values(line(
    { id: 'a', type: 'caseInstance', operation: 'case.data.get', path: 'claim.amount', resultTo: 'amt' },
    { id: 'b', type: 'caseInstance', operation: 'case.get', caseId: '$other', resultTo: 'out', resultPath: 'workflowInstance.status' },
  )) as [any[], any[]]), V.concat([{ name: 'other', type: 'String' }]));
  const i = await run(wf.id, { _caseInstanceId: 'c1', other: 'c1' });
  assert.strictEqual(i.status, 'completed'); assert.strictEqual(i.variables.amt, 250, 'defaulted to $_caseInstanceId, then a path');
  assert.strictEqual(i.variables.out, 'active', 'an explicit $variable id and a result path');
});

test('NI-3 case node: update data (merge), status, comment, milestone', async () => {
  const wf = await deploy(ctx, 'Case write', ...(Object.values(line(
    { id: 'a', type: 'caseInstance', operation: 'case.data.update', data: { reviewed: true, amountSeen: '$amt' } },
    { id: 'b', type: 'caseInstance', operation: 'case.status.set', status: 'Pending Review' },
    { id: 'c', type: 'caseInstance', operation: 'case.comment.add', body: 'checked by flow' },
    { id: 'd', type: 'caseInstance', operation: 'case.milestone.achieve', name: 'Reviewed' },
  )) as [any[], any[]]), V);
  const i = await run(wf.id, { _caseInstanceId: 'c1', amt: 99 });
  assert.strictEqual(i.status, 'completed', JSON.stringify(i.error));
  const c = (await wfs.instances().get('c1'))!;
  assert.deepStrictEqual(c.data, { claim: { amount: 250 }, region: 'EU', reviewed: true, amountSeen: 99 }, 'merged, other fields kept, $amt bound');
  assert.strictEqual(c.status, 'Pending Review');
  assert.strictEqual((await wfs.comments().query((x) => x.workflowInstanceId === 'c1')).length, 1);
  assert.ok((c.milestones ?? (await wfs.instances().get('c1'))!.milestones)?.some((m) => m.name === 'Reviewed'));
});

test('NI-4 process node: reads its own live state; another instance’s variables and tasks', async () => {
  const waiter = await deploy(ctx, 'Waiter', ...(Object.values(line({ id: 'u', type: 'userTask', name: 'Wait', group: 'g' })) as [any[], any[]]));
  const w = await new InstanceService(ctx).start({ workflowId: waiter.id, environment: 'prod', variables: { tag: 'blue' } }, 'amy');
  const reader = await deploy(ctx, 'Reader', ...(Object.values(line(
    { id: 'a', type: 'processInstance', operation: 'process.get', resultTo: 'out', resultPath: 'status' },
    { id: 'b', type: 'processInstance', operation: 'process.variables.get', instanceId: '$target', name: 'tag', resultTo: 'status' },
    { id: 'c', type: 'processInstance', operation: 'process.tasks', instanceId: '$target', resultTo: 'tasks' },
  )) as [any[], any[]]), V.concat([{ name: 'target', type: 'String' }, { name: 'tasks', type: 'Object' }]));
  const i = await run(reader.id, { target: w.id });
  assert.strictEqual(i.status, 'completed', JSON.stringify(i.error));
  assert.strictEqual(i.variables.out, 'running', 'its own state is read live, while it is still running this very node');
  assert.strictEqual(i.variables.status, 'blue');
  assert.strictEqual((i.variables.tasks as any[]).length, 1);
});

test('NI-5 self-target: writes to the running instance are refused; reads are fine; "store" lets the flow carry on', async () => {
  const bad = await deploy(ctx, 'Self signal', ...(Object.values(line({ id: 'a', type: 'processInstance', operation: 'process.signal', name: 'x' })) as [any[], any[]]));
  const failed = await run(bad.id);
  assert.strictEqual(failed.status, 'failed'); assert.match(failed.error!.message, /SELF_TARGET/);
  const soft = await deploy(ctx, 'Self signal soft', ...(Object.values(line(
    { id: 'a', type: 'processInstance', operation: 'process.abort', resultTo: 'out', onError: 'store' },
    { id: 'b', type: 'processInstance', operation: 'process.variables.set', variables: { x: 1 }, resultTo: 'status', onError: 'store' },
  )) as [any[], any[]]), V);
  const ok = await run(soft.id);
  assert.strictEqual(ok.status, 'completed', 'the flow carried on');
  assert.strictEqual((ok.variables.out as any).code, 'SELF_TARGET'); assert.strictEqual((ok.variables.status as any).code, 'SELF_TARGET');
});

test('NI-6 process node controls ANOTHER instance (suspend, resume, abort, signal) and starts a new one', async () => {
  const waiter = await deploy(ctx, 'Waiter 2', ...(Object.values(line({ id: 'u', type: 'userTask', name: 'Wait', group: 'g' })) as [any[], any[]]));
  const w = await new InstanceService(ctx).start({ workflowId: waiter.id, environment: 'prod' }, 'amy');
  const ctl = await deploy(ctx, 'Controller', ...(Object.values(line(
    { id: 'a', type: 'processInstance', operation: 'process.suspend', instanceId: '$target' },
    { id: 'b', type: 'processInstance', operation: 'process.resume', instanceId: '$target' },
    { id: 'c', type: 'processInstance', operation: 'process.abort', instanceId: '$target', resultTo: 'out', resultPath: 'status' },
    { id: 'd', type: 'processInstance', operation: 'process.start', workflowId: waiter.id, variables: { from: 'flow' }, resultTo: 'tasks', resultPath: 'id' },
  )) as [any[], any[]]), V.concat([{ name: 'target', type: 'String' }, { name: 'tasks', type: 'String' }]));
  const i = await run(ctl.id, { target: w.id });
  assert.strictEqual(i.status, 'completed', JSON.stringify(i.error));
  assert.strictEqual(i.variables.out, 'aborted');
  assert.strictEqual((await new InstanceService(ctx).get(w.id)).status, 'aborted');
  const started = await new InstanceService(ctx).get(String(i.variables.tasks));
  assert.strictEqual(started.status, 'waiting'); assert.strictEqual(started.variables.from, 'flow');
});

test('NI-7 workspace isolation: another workspace’s case or instance is "not found" to the node', async () => {
  const wf = await deploy(ctx, 'Peek', ...(Object.values(line(
    { id: 'a', type: 'caseInstance', operation: 'case.get', caseId: 'cB', resultTo: 'out', onError: 'store' },
  )) as [any[], any[]]), V);
  const i = await run(wf.id);
  assert.match(JSON.stringify((i.variables.out as any).error), /not found/i);
  assert.ok(!JSON.stringify(i.variables).includes('"secret"'));
  const foreign = await deploy(other, 'Foreign', ...(Object.values(line({ id: 'u', type: 'userTask', name: 'W', group: 'g' })) as [any[], any[]]));
  const fi = await new InstanceService(other).start({ workflowId: foreign.id, environment: 'prod' }, 'zed');
  const peek = await deploy(ctx, 'Peek 2', ...(Object.values(line(
    { id: 'a', type: 'processInstance', operation: 'process.get', instanceId: '$target', resultTo: 'out', onError: 'store' },
    { id: 'b', type: 'processInstance', operation: 'process.abort', instanceId: '$target', resultTo: 'status', onError: 'store' },
  )) as [any[], any[]]), V.concat([{ name: 'target', type: 'String' }]));
  const p = await run(peek.id, { target: fi.id });
  assert.match(JSON.stringify(p.variables.out), /not found/i);
  assert.strictEqual((await new InstanceService(other).get(fi.id)).status, 'waiting', 'and it was not aborted');
});

test('NI-8 analytics.run from a flow: only an API its owner allowed for flows, with the engine’s authority', async () => {
  const svc = new AnalyticsService(ctx, wfs);
  const owner = { actor: 'boss', permissions: ['*'] };
  await svc.create({ slug: 'open-cases', name: 'Open cases', status: 'published', allowFlows: true, params: [{ name: 'region', type: 'string', required: true }],
    query: { from: 'case', where: { field: 'case.data.region', op: 'eq', value: { param: 'region' } }, metrics: [{ fn: 'count', as: 'n' }] } }, owner);
  await svc.create({ slug: 'closed-door', name: 'Not for flows', status: 'published', query: { from: 'case', metrics: [{ fn: 'count', as: 'n' }] } }, owner);
  const wf = await deploy(ctx, 'Uses analytics', ...(Object.values(line(
    { id: 'a', type: 'caseInstance', operation: 'analytics.run', slug: 'open-cases', params: { region: '$status' }, resultTo: 'out', resultPath: 'rows.0.n' },
    { id: 'b', type: 'processInstance', operation: 'analytics.run', slug: 'closed-door', resultTo: 'tasks', onError: 'store' },
  )) as [any[], any[]]), V.concat([{ name: 'tasks', type: 'Object' }]));
  const i = await run(wf.id, { status: 'EU' });
  assert.strictEqual(i.status, 'completed', JSON.stringify(i.error));
  assert.strictEqual(i.variables.out, 1, 'the API ran with the flow’s parameter');
  assert.match(String((i.variables.tasks as any).error), /not available to flows/);
});

test('NI-9 unknown operation / wrong node kind fails clearly; oversize results are refused', async () => {
  const wf = await deploy(ctx, 'Bad op', ...(Object.values(line({ id: 'a', type: 'caseInstance', operation: 'process.abort', resultTo: 'out', onError: 'store' })) as [any[], any[]]), V);
  const i = await run(wf.id);
  assert.strictEqual(i.status, 'failed', 'a misconfigured node fails the node (a typo must not be silently stored)');
  assert.match(i.error!.message, /unknown case operation/);
  const big = 'x'.repeat(1_100_000);
  await caseRow('cBig', 't1', { data: { blob: big } });
  const wf2 = await deploy(ctx, 'Big', ...(Object.values(line({ id: 'a', type: 'caseInstance', operation: 'case.data.get', caseId: 'cBig', resultTo: 'out', onError: 'store' })) as [any[], any[]]), V);
  const j = await run(wf2.id);
  assert.match(String((j.variables.out as any).error), /over the 1000 KB/);
});
after(() => setTimeout(() => process.exit(0), 50).unref());
