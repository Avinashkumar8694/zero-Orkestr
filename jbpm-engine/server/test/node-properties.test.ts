// jBPM node properties: SLA due date, user-task deadlines, call-activity waitForCompletion, delay/deadline parsing, validation.
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
import { TaskService } from '../src/modules/tasks/service.ts';
import { NotificationService } from '../src/modules/notifications/service.ts';
import { Collections, type AuditEvent, type Task } from '../src/domain.ts';
import { parseDelay, dueFrom } from '../src/engine/duration.ts';
import { parseDeadlines } from '../src/engine/deadlines.ts';
import { validateProcess } from '../src/modules/validation/rules.ts';

const T0 = '2025-01-01T00:00:00.000Z';
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();
const store = new MemoryStore();
let n = 0;
const ctx = makeContext({ store, tenantId: 't1', clock: fakeClock(T0).clock, newId: () => `id${++n}` });

async function deploy(name: string, nodes: any[], flows: any[]) {
  const wf = await new WorkflowService(ctx).create({ name }, 'a');
  const draft = await new VersionService(ctx).saveDraft(wf.defaultBranchId, { id: wf.key, name: wf.name, processes: [{ id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars: [], nodes, flows }] } as any, 'a');
  const pub = await new VersionService(ctx).publish(draft.id, 'a');
  await new DeploymentService(ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'a');
  return { wf, processId: `${wf.key}.process` };
}
const oneTask = (task: Record<string, unknown>) => ({
  nodes: [{ id: 's', type: 'start' }, { id: 'u', type: 'userTask', name: 'Review', group: 'reviewers', ...task }, { id: 'e', type: 'end' }],
  flows: [{ id: 'f1', from: 's', to: 'u' }, { id: 'f2', from: 'u', to: 'e' }],
});
const taskOf = async (instanceId: string) => (await store.repo<Task>(Collections.tasks).query((t) => t.instanceId === instanceId))[0]!;
const audits = (kind: string) => store.repo<AuditEvent>(Collections.audit).query((a) => a.kind === kind);

test('NP-1 parseDelay / dueFrom read the designer short forms, ISO, repeating and #{var}', () => {
  assert.strictEqual(parseDelay('4h'), 4 * 3_600_000);
  assert.strictEqual(parseDelay('1h 30m'), 90 * 60_000);
  assert.strictEqual(parseDelay('2d'), 2 * 86_400_000);
  assert.strictEqual(parseDelay('PT30M'), 30 * 60_000);
  assert.strictEqual(parseDelay('R3/PT1H'), 3_600_000);
  assert.strictEqual(parseDelay('soon'), 0);
  assert.strictEqual(dueFrom('2h', T0), at(7200));
  assert.strictEqual(dueFrom('#{sla}', T0, { sla: 'PT1H' }), at(3600));
  assert.strictEqual(dueFrom('2030-01-01T00:00:00Z', T0), '2030-01-01T00:00:00.000Z');
  assert.strictEqual(dueFrom('nonsense', T0), null);
});

test('NP-2 deadline syntax: jBPM reassign / notify strings, several components, bad input explained', () => {
  const r = parseDeadlines('[users:john,mary|groups:Managers]@[4h,1d]^[users:bob]@[2h]', 'notStartedReassign');
  assert.strictEqual(r.deadlines.length, 2); assert.deepStrictEqual(r.deadlines[0]!.expiries, ['4h', '1d']); assert.strictEqual(r.deadlines[0]!.action.users, 'john,mary');
  const nn = parseDeadlines('[tousers:a|toemails:a@b.c|subject:Late|body:Act]@[2d]', 'notCompletedNotify');
  assert.strictEqual(nn.deadlines[0]!.action.subject, 'Late');
  assert.match(parseDeadlines('[tousers:a]@[1h]', 'notStartedReassign').error!, /not valid for notStartedReassign/);
  assert.match(parseDeadlines('users:a@1h', 'notStartedReassign').error!, /\[action\]@\[expiry\]/);
  assert.match(parseDeadlines('[users:a]@[whenever]', 'notStartedReassign').error!, /not a duration/);
  assert.deepStrictEqual(parseDeadlines('', 'notStartedNotify'), { deadlines: [] });
});

test('NP-3 SLA: a user task past its SLA is flagged violated (process unaffected); one finished in time is met', async () => {
  const d = await deploy('Sla WF', ...(Object.values(oneTask({ slaDueDate: 'PT1H' })) as [any[], any[]]));
  const late = await new InstanceService(ctx).start({ workflowId: d.wf.id, environment: 'prod' }, 'bob');
  const onTime = await new InstanceService(ctx).start({ workflowId: d.wf.id, environment: 'prod' }, 'bob');
  assert.strictEqual(late.history.find((h) => h.nodeId === 'u')!.sla?.status, 'pending');
  await new TaskService(ctx).claim((await taskOf(onTime.id)).id, 'amy'); await new TaskService(ctx).complete((await taskOf(onTime.id)).id, {}, 'amy');
  assert.strictEqual((await new InstanceService(ctx).get(onTime.id)).history.find((h) => h.nodeId === 'u')!.sla?.status, 'met');
  await new TimerService(ctx).tick(at(2 * 3600));
  const flagged = await new InstanceService(ctx).get(late.id);
  assert.strictEqual(flagged.status, 'waiting', 'the process keeps running');
  assert.strictEqual(flagged.history.find((h) => h.nodeId === 'u')!.sla?.status, 'violated');
  assert.ok((await audits('node.sla.violated')).some((a) => a.instanceId === late.id));
  assert.ok((await new NotificationService(ctx).listFor('bob')).items.some((x) => x.kind === 'sla-breached'));
  await new TaskService(ctx).claim((await taskOf(late.id)).id, 'amy'); await new TaskService(ctx).complete((await taskOf(late.id)).id, {}, 'amy');
  assert.strictEqual((await new InstanceService(ctx).get(late.id)).history.find((h) => h.nodeId === 'u')!.sla?.status, 'violated', 'finishing late does not undo it');
});

test('NP-4 SLA clock survives an async hop (queued node, then it runs)', async () => {
  const d = await deploy('Sla Async', [{ id: 's', type: 'start' }, { id: 'sc', type: 'script', lang: 'js', code: 'vars.x = 1;', async: true, slaDueDate: 'PT1H' }, { id: 'e', type: 'end' }], [{ id: 'f1', from: 's', to: 'sc' }, { id: 'f2', from: 'sc', to: 'e' }]);
  const inst = await new InstanceService(ctx).start({ workflowId: d.wf.id, environment: 'prod' }, 'bob');
  assert.strictEqual(inst.history.find((h) => h.nodeId === 'sc')!.sla?.status, 'pending');
  await new TimerService(ctx).tick(at(10));
  const done = await new InstanceService(ctx).get(inst.id);
  assert.strictEqual(done.status, 'completed');
  assert.strictEqual(done.history.filter((h) => h.nodeId === 'sc').length, 1);
  assert.strictEqual(done.history.find((h) => h.nodeId === 'sc')!.sla?.status, 'met');
});

test('NP-5 user-task deadlines: not-started reassigns, started task ignores it, not-completed notifies', async () => {
  const d = await deploy('Deadline WF', ...(Object.values(oneTask({
    notStartedReassign: '[users:alice]@[1h]', notCompletedNotify: '[tousers:carol|subject:Overdue|body:Finish it]@[3h]',
  })) as [any[], any[]]));
  const idle = await new InstanceService(ctx).start({ workflowId: d.wf.id, environment: 'prod' }, 'bob');
  const busy = await new InstanceService(ctx).start({ workflowId: d.wf.id, environment: 'prod' }, 'bob');
  await new TaskService(ctx).start((await taskOf(busy.id)).id, 'dave');               // work begins on this one
  await new TimerService(ctx).tick(at(2 * 3600));
  const t1 = await taskOf(idle.id), t2 = await taskOf(busy.id);
  assert.strictEqual(t1.assignee, 'alice'); assert.strictEqual(t1.status, 'reserved');
  assert.strictEqual(t2.assignee, 'dave'); assert.strictEqual(t2.status, 'inprogress', 'a started task ignores the not-started deadline');
  await new TimerService(ctx).tick(at(4 * 3600));
  const carol = (await new NotificationService(ctx).listFor('carol')).items;
  assert.strictEqual(carol.length, 2, 'both tasks are still open → both notified');
  assert.strictEqual(carol[0]!.title, 'Overdue');
  assert.ok((await audits('task.reassigned.deadline')).length >= 1);
});

test('NP-6 a completed task is never touched by its pending deadlines', async () => {
  const d = await deploy('Deadline Done', ...(Object.values(oneTask({ notCompletedNotify: '[tousers:erin]@[1h]' })) as [any[], any[]]));
  const inst = await new InstanceService(ctx).start({ workflowId: d.wf.id, environment: 'prod' }, 'bob');
  const t = await taskOf(inst.id);
  await new TaskService(ctx).claim(t.id, 'amy'); await new TaskService(ctx).complete(t.id, {}, 'amy');
  await new TimerService(ctx).tick(at(2 * 3600));
  assert.strictEqual((await new NotificationService(ctx).listFor('erin')).items.length, 0);
});

test('NP-7 call activity: waitForCompletion=false continues at once; default waits; legacy independent=true stays fire-and-forget', async () => {
  const child = await deploy('Child WF', ...(Object.values(oneTask({})) as [any[], any[]]));
  const parent = (callProps: Record<string, unknown>) => ({
    nodes: [{ id: 's', type: 'start' }, { id: 'c', type: 'call', process: child.processId, ...callProps }, { id: 'e', type: 'end' }],
    flows: [{ id: 'f1', from: 's', to: 'c' }, { id: 'f2', from: 'c', to: 'e' }],
  });
  const run = async (name: string, props: Record<string, unknown>) => {
    const p = await deploy(name, ...(Object.values(parent(props)) as [any[], any[]]));
    return new InstanceService(ctx).start({ workflowId: p.wf.id, environment: 'prod' }, 'bob');
  };
  assert.strictEqual((await run('P wait default', {})).status, 'waiting');
  assert.strictEqual((await run('P no wait', { waitForCompletion: false })).status, 'completed');
  assert.strictEqual((await run('P legacy', { independent: true })).status, 'completed');
  assert.strictEqual((await run('P indep + wait', { independent: true, waitForCompletion: true })).status, 'waiting');
});

test('NP-8 validation flags unreadable SLA and deadline text', async () => {
  const proc = (extra: Record<string, unknown>) => ({ id: 'p', name: 'p', package: 'x', vars: [], nodes: [{ id: 's', type: 'start' }, { id: 'u', type: 'userTask', name: 'U', group: 'g', ...extra }, { id: 'e', type: 'end' }], flows: [{ id: 'f1', from: 's', to: 'u' }, { id: 'f2', from: 'u', to: 'e' }] } as any);
  const timing = async (extra: Record<string, unknown>) => (await validateProcess(proc(extra))).problems.filter((p) => p.rule === 'node-timing');
  assert.deepStrictEqual(await timing({ slaDueDate: '2h', notStartedReassign: '[users:a]@[4h]' }), []);
  assert.match((await timing({ slaDueDate: 'someday' }))[0]!.message, /SLA due date/);
  assert.match((await timing({ notCompletedNotify: '[users:a]@[1h]' }))[0]!.message, /notCompletedNotify/);
});
after(() => setTimeout(() => process.exit(0), 50).unref());
