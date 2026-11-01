// Generalized onEntry/onExit — real jBPM's generic action-hook mechanism (drools:onEntry-script/
// drools:onExit-script extensionElements), previously wired ONLY for the http/REST node's special-
// cased exitScript. Proves it now works on ordinary activity nodes (manual/userTask), for both
// dialects, with the exact same kcontext/vars/instance/node/meta-locals surface a script node gets,
// and with the right TIMING: onEntry always fires when the node is triggered; onExit fires once, when
// the node instance actually completes — immediately for a node that completes synchronously, or on
// resume for a node that waits (userTask) — never on error.
import { numericIdOf } from '../src/infra/ids.ts';
import { test } from 'node:test';
import assert from 'node:assert';
import { MemoryStore } from '../src/store/memory-store.ts';
import { fakeClock } from '../src/infra/ids.ts';
import { makeContext, type AppContext } from '../src/context.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { InstanceService } from '../src/modules/instances/service.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import { stopJavaSidecar } from '../src/engine/java-sidecar.ts';
import { Collections, type Task } from '../src/domain.ts';

const newCtx = () => { let n = 0; return makeContext({ store: new MemoryStore(), tenantId: 't1', clock: fakeClock().clock, newId: () => `id${++n}` }); };

async function run(ctx: AppContext, nodes: any[], flows: any[], variables: Record<string, unknown> = {}) {
  const wf = await new WorkflowService(ctx).create({ name: 'LC ' + nodes.map((n) => n.id).join('-') }, 'a');
  const draft = await new VersionService(ctx).saveDraft(wf.defaultBranchId, { id: wf.key, name: wf.name, processes: [{ id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars: [], nodes, flows }] } as any, 'a');
  const pub = await new VersionService(ctx).publish(draft.id, 'a');
  await new DeploymentService(ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'a');
  return new InstanceService(ctx).start({ workflowId: wf.id, environment: 'prod', variables }, 'bob');
}

test.after(() => stopJavaSidecar());

test('JS onEntry/onExit on an ordinary manual task (immediate completion) — both run, with full kcontext/vars/instance/node access', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      {
        id: 't', type: 'manual', name: 'Approve',
        onEntry: 'kcontext.setVariable("entrySeen", instance.state); vars.entryNode = node.nodeId;',
        onExit: 'kcontext.setVariable("exitSeen", true);',
        onEntryLang: 'js', onExitLang: 'js',
      },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['entrySeen'], 'running', 'onEntry ran, with instance.state available');
  assert.strictEqual(inst.variables['entryNode'], 't', 'onEntry ran with vars/node access, same as a script node');
  assert.strictEqual(inst.variables['exitSeen'], true, 'onExit ran too, on the SAME immediate completion');
});

test('JS onEntry/onExit on a userTask: onEntry fires at creation, onExit fires ONLY once the task is actually completed', async () => {
  const ctx = newCtx();
  const inst = await run(ctx,
    [
      { id: 's', type: 'start' },
      {
        id: 't', type: 'userTask', name: 'Review', group: 'ops',
        onEntry: 'kcontext.setVariable("entrySeen", true);',
        onExit: 'kcontext.setVariable("exitSeen", true);',
        onEntryLang: 'js', onExitLang: 'js',
      },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(inst.status, 'waiting', JSON.stringify(inst.error || inst.history));
  assert.strictEqual(inst.variables['entrySeen'], true, 'onEntry already ran while the task waits');
  assert.strictEqual(inst.variables['exitSeen'], undefined, 'onExit has NOT run yet — the task is still waiting');

  const task = (await ctx.store.repo<Task>(Collections.tasks).query((t) => t.instanceId === inst.id))[0]!;
  await new TaskService(ctx).complete(task.id, {}, 'carol');
  const done = await new InstanceService(ctx).get(inst.id);
  assert.strictEqual(done.status, 'completed', JSON.stringify(done.error));
  assert.strictEqual(done.variables['exitSeen'], true, 'onExit ran exactly when the task was actually completed');
});

test('onExit does NOT run when the node itself errors', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      {
        id: 't', type: 'workItem', handler: 'nonexistent-handler',
        onEntry: 'kcontext.setVariable("entrySeen", true);',
        onExit: 'kcontext.setVariable("exitSeen", true);',
        onEntryLang: 'js', onExitLang: 'js',
      },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(inst.status, 'failed', JSON.stringify(inst.history));
  assert.strictEqual(inst.variables['entrySeen'], true, 'onEntry still ran before the handler failed');
  assert.strictEqual(inst.variables['exitSeen'], undefined, 'onExit must NOT run — the node never completed normally');
});

test('a failing onEntry blocks the node\'s own handler from running at all, and is catchable like any other SCRIPT_ERROR', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      { id: 't', type: 'manual', name: 'Approve', onEntry: 'throw new Error("boom");', onEntryLang: 'js' },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(inst.status, 'failed', JSON.stringify(inst.history));
  assert.strictEqual(inst.error?.nodeId, 't');
  assert.match(inst.error?.message || '', /onEntry failed/);
});

test('Java onEntry/onExit on a manual task, using the meta-locals (instanceId/currentNodeId)', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      {
        id: 't', type: 'manual', name: 'Approve',
        onEntry: 'kcontext.setVariable("entryNode", currentNodeId);',
        onExit: 'kcontext.setVariable("exitPid", instanceId);',
        onEntryLang: 'java', onExitLang: 'java',
      },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['entryNode'], 't');
  assert.strictEqual(inst.variables['exitPid'], numericIdOf(inst.id));   // jBPM numbers instances: the meta-local is that number;
});

test('Java onEntry/onExit on a userTask: onExit fires on resume, not on creation', { timeout: 30000 }, async () => {
  const ctx = newCtx();
  const inst = await run(ctx,
    [
      { id: 's', type: 'start' },
      {
        id: 't', type: 'userTask', name: 'Review', group: 'ops',
        onEntry: 'kcontext.setVariable("entrySeen", true);',
        onExit: 'kcontext.setVariable("exitSeen", true);',
        onEntryLang: 'java', onExitLang: 'java',
      },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(inst.status, 'waiting', JSON.stringify(inst.error || inst.history));
  assert.strictEqual(inst.variables['entrySeen'], true);
  assert.strictEqual(inst.variables['exitSeen'], undefined);

  const task = (await ctx.store.repo<Task>(Collections.tasks).query((t) => t.instanceId === inst.id))[0]!;
  await new TaskService(ctx).complete(task.id, {}, 'carol');
  const done = await new InstanceService(ctx).get(inst.id);
  assert.strictEqual(done.status, 'completed', JSON.stringify(done.error));
  assert.strictEqual(done.variables['exitSeen'], true);
});
