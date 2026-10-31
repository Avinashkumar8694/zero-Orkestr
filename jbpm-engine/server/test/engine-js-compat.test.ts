// Proves the three JS access styles (kcontext / bare-name / vars object) and the java.util.*
// compatibility shim actually work end to end through the full engine (workflow -> publish ->
// deploy -> start -> step) — not just that sandbox.ts's functions look right in isolation.
import { test } from 'node:test';
import assert from 'node:assert';
import { MemoryStore } from '../src/store/memory-store.ts';
import { fakeClock } from '../src/infra/ids.ts';
import { makeContext, type AppContext } from '../src/context.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';
import { InstanceService } from '../src/modules/instances/service.ts';

const newCtx = () => { let n = 0; return makeContext({ store: new MemoryStore(), tenantId: 't1', clock: fakeClock().clock, newId: () => `id${++n}` }); };

async function run(ctx: AppContext, nodes: any[], flows: any[], variables: Record<string, unknown> = {}, correlationKey?: string) {
  const wf = await new WorkflowService(ctx).create({ name: 'JS ' + nodes.map((n) => n.id).join('') }, 'a');
  const draft = await new VersionService(ctx).saveDraft(wf.defaultBranchId, { id: wf.key, name: wf.name, processes: [{ id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars: [], nodes, flows }] } as any, 'a');
  const pub = await new VersionService(ctx).publish(draft.id, 'a');
  await new DeploymentService(ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'a');
  return new InstanceService(ctx).start({ workflowId: wf.id, environment: 'prod', variables, correlationKey }, 'bob');
}

test('a JS script can read/write process variables via the vars object', async () => {
  const inst = await run(newCtx(),
    [{ id: 's', type: 'start' }, { id: 't', type: 'script', lang: 'js', code: 'vars.status = "DONE:" + vars.caseId;' }, { id: 'e', type: 'end' }],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
    { caseId: 'CASE-1' },
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['status'], 'DONE:CASE-1');
});

test('a JS script can read/write process variables by bare name (matches real jBPM\'s own JavaScriptAction convention)', async () => {
  const inst = await run(newCtx(),
    [{ id: 's', type: 'start' }, { id: 't', type: 'script', lang: 'js', code: 'status = "DONE:" + caseId;' }, { id: 'e', type: 'end' }],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
    { caseId: 'CASE-2' },
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['status'], 'DONE:CASE-2');
});

test('kcontext is available in a JS gateway condition (previously missing entirely)', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' }, { id: 'g', type: 'gateway', mode: 'exclusive' },
      { id: 'a', type: 'manual', name: 'A' }, { id: 'b', type: 'manual', name: 'B' }, { id: 'e', type: 'end' },
    ],
    [
      { id: 'f1', from: 's', to: 'g' },
      { id: 'f2', from: 'g', to: 'a', lang: 'js', when: 'kcontext.getVariable("amount") > 1000' },
      { id: 'f3', from: 'g', to: 'b', lang: 'js', when: 'kcontext.getVariable("amount") <= 1000' },
      { id: 'f4', from: 'a', to: 'e' }, { id: 'f5', from: 'b', to: 'e' },
    ],
    { amount: 1500 },
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.ok(inst.history.some((h) => h.nodeId === 'a'));
  assert.ok(!inst.history.some((h) => h.nodeId === 'b'));
});

test('vars object also works in a JS gateway condition', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' }, { id: 'g', type: 'gateway', mode: 'exclusive' },
      { id: 'a', type: 'manual', name: 'A' }, { id: 'b', type: 'manual', name: 'B' }, { id: 'e', type: 'end' },
    ],
    [
      { id: 'f1', from: 's', to: 'g' },
      { id: 'f2', from: 'g', to: 'a', lang: 'js', when: 'vars.claimType === "DEATH"' },
      { id: 'f3', from: 'g', to: 'b', lang: 'js', when: 'vars.claimType !== "DEATH"' },
      { id: 'f4', from: 'a', to: 'e' }, { id: 'f5', from: 'b', to: 'e' },
    ],
    { claimType: 'DEATH' },
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.ok(inst.history.some((h) => h.nodeId === 'a'));
});

test('a real jBPM JS script using Nashorn-style java.util.* / Java.type() interop runs via the js-compat shim', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      {
        id: 't', type: 'script', lang: 'js', code:
          'var list = new java.util.ArrayList();\n' +
          'list.add("a"); list.add("b");\n' +
          'var MapType = Java.type("java.util.HashMap");\n' +
          'var map = new MapType();\n' +
          'map.put("count", list.size());\n' +
          'kcontext.setVariable("count", map.get("count"));\n' +
          'kcontext.setVariable("joined", list.get(0) + "," + list.get(1));',
      },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['count'], 2);
  assert.strictEqual(inst.variables['joined'], 'a,b');
});

test('JS kcontext.getProcessInstance() exposes processId/parentProcessInstanceId/state/correlationKey (same shape as the Java dialect)', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      {
        id: 't', type: 'script', lang: 'js', code:
          'kcontext.setVariable("pid", kcontext.getProcessInstance().getProcessId());\n' +
          'kcontext.setVariable("parent", kcontext.getProcessInstance().getParentProcessInstanceId());\n' +
          'kcontext.setVariable("state", kcontext.getProcessInstance().getState());\n' +
          'kcontext.setVariable("corr", kcontext.getProcessInstance().getCorrelationKey());\n' +
          'kcontext.setVariable("myNodeId", kcontext.getNodeInstance().getNodeId());',
      },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
    {},
    'CORR-JS-1',
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['pid'], inst.processId);
  assert.strictEqual(inst.variables['parent'], undefined, 'a root instance has no parent (JS: unset, not null — same "no parent" meaning as Java\'s null)');
  assert.strictEqual(inst.variables['state'], 1);
  assert.strictEqual(inst.variables['corr'], 'CORR-JS-1');
  assert.strictEqual(inst.variables['myNodeId'], 't');
});

test('JS kcontext.getKieRuntime().signalEvent(type,event,processInstanceId) delivers to a SPECIFIC other instance', async () => {
  const ctx = newCtx();
  const catcher = await run(ctx,
    [{ id: 's', type: 'start' }, { id: 'c', type: 'catch', event: { signal: 'Ping' } }, { id: 'e', type: 'end' }],
    [{ id: 'f1', from: 's', to: 'c' }, { id: 'f2', from: 'c', to: 'e' }],
  );
  assert.strictEqual(catcher.status, 'waiting', JSON.stringify(catcher.error || catcher.history));
  const sender = await run(ctx,
    [
      { id: 's', type: 'start' },
      { id: 't', type: 'script', lang: 'js', code: `kcontext.getKieRuntime().signalEvent("Ping", "hello", "${catcher.id}");` },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(sender.status, 'completed', JSON.stringify(sender.error));
  const resumedCatcher = await new InstanceService(ctx).get(catcher.id);
  assert.strictEqual(resumedCatcher.status, 'completed', 'the targeted signal actually resumed the OTHER instance');
});

test('JS kcontext.getKieRuntime().abortProcessInstance(selfId) aborts the current instance from within its own script', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      { id: 't', type: 'script', lang: 'js', code: 'kcontext.getKieRuntime().abortProcessInstance(kcontext.getProcessInstance().getId());' },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(inst.status, 'aborted', JSON.stringify(inst.error || inst.history));
});

test('the `instance`/`node` globals are this engine\'s simpler, Node-idiomatic alternative to kcontext.getProcessInstance()/.getNodeInstance() chains', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      {
        id: 't', type: 'script', lang: 'js', code:
          'kcontext.setVariable("pid", instance.processId);\n' +
          'kcontext.setVariable("parent", instance.parentId);\n' +
          'kcontext.setVariable("state", instance.state);\n' +
          'kcontext.setVariable("corr", instance.correlationKey);\n' +
          'kcontext.setVariable("myNodeId", node.nodeId);\n' +
          'kcontext.setVariable("myNodeInstId", node.id);\n' +
          'kcontext.setVariable("instAndKcontextIdMatch", instance.id === kcontext.getProcessInstance().getId());',
      },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
    {},
    'CORR-INST-1',
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['pid'], inst.processId);
  assert.strictEqual(inst.variables['parent'], undefined, 'a root instance has no parent');
  assert.strictEqual(inst.variables['state'], 'running', 'this engine\'s OWN status vocabulary, not jBPM\'s STATE_* int');
  assert.strictEqual(inst.variables['corr'], 'CORR-INST-1');
  assert.strictEqual(inst.variables['myNodeId'], 't');
  assert.ok(typeof inst.variables['myNodeInstId'] === 'string' && (inst.variables['myNodeInstId'] as string).length > 0);
  assert.notStrictEqual(inst.variables['myNodeInstId'], 't', 'node.id (instance) differs from node.nodeId (definition)');
  assert.strictEqual(inst.variables['instAndKcontextIdMatch'], true, 'instance.id and kcontext.getProcessInstance().getId() agree');
});

test('instance.activeNodes reflects active tokens, matching kcontext.getProcessInstance().getNodeInstances()', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      { id: 'g', type: 'gateway', mode: 'parallel' },
      { id: 'probe', type: 'script', lang: 'js', code: 'kcontext.setVariable("activeCount", instance.activeNodes.length);' },
      { id: 'review', type: 'userTask', name: 'Review', group: 'ops' },
      { id: 'e1', type: 'end' }, { id: 'e2', type: 'end' },
    ],
    [
      { id: 'f1', from: 's', to: 'g' }, { id: 'f2', from: 'g', to: 'probe' }, { id: 'f3', from: 'g', to: 'review' },
      { id: 'f4', from: 'probe', to: 'e1' }, { id: 'f5', from: 'review', to: 'e2' },
    ],
  );
  assert.strictEqual(inst.status, 'waiting', JSON.stringify(inst.error || inst.history));
  assert.strictEqual(inst.variables['activeCount'], 2, "sees both probe's own token and the sibling userTask token");
});

test('instance.signal()/.broadcast()/.abort() are sugar over the same pending-action queue kcontext.getKieRuntime() uses', async () => {
  const ctx = newCtx();
  const catcher = await run(ctx,
    [{ id: 's', type: 'start' }, { id: 'c', type: 'catch', event: { signal: 'Ping' } }, { id: 'e', type: 'end' }],
    [{ id: 'f1', from: 's', to: 'c' }, { id: 'f2', from: 'c', to: 'e' }],
  );
  assert.strictEqual(catcher.status, 'waiting', JSON.stringify(catcher.error || catcher.history));
  const sender = await run(ctx,
    [
      { id: 's', type: 'start' },
      { id: 't', type: 'script', lang: 'js', code: `instance.signalOther("${catcher.id}", "Ping", "hello");` },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(sender.status, 'completed', JSON.stringify(sender.error));
  const resumedCatcher = await new InstanceService(ctx).get(catcher.id);
  assert.strictEqual(resumedCatcher.status, 'completed', 'instance.signalOther actually resumed the OTHER instance');

  const selfAborter = await run(newCtx(),
    [{ id: 's', type: 'start' }, { id: 't', type: 'script', lang: 'js', code: 'instance.abort();' }, { id: 'e', type: 'end' }],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(selfAborter.status, 'aborted', 'instance.abort() aborts the current instance');
});

test('instance/node also work in a JS gateway condition', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' }, { id: 'g', type: 'gateway', mode: 'exclusive' },
      { id: 'a', type: 'manual', name: 'A' }, { id: 'b', type: 'manual', name: 'B' }, { id: 'e', type: 'end' },
    ],
    [
      { id: 'f1', from: 's', to: 'g' },
      { id: 'f2', from: 'g', to: 'a', lang: 'js', when: 'instance.state === "running"' },
      { id: 'f3', from: 'g', to: 'b', lang: 'js', when: 'instance.state !== "running"' },
      { id: 'f4', from: 'a', to: 'e' }, { id: 'f5', from: 'b', to: 'e' },
    ],
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.ok(inst.history.some((h) => h.nodeId === 'a'));
  assert.ok(!inst.history.some((h) => h.nodeId === 'b'));
});

test('getVariable and setVariable top-level helpers work in JS script and gateway condition', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      { id: 't', type: 'script', lang: 'js', code: 'setVariable("status", "VALIDATED:" + getVariable("code")); setVariable("flag", true);' },
      { id: 'g', type: 'gateway', mode: 'exclusive' },
      { id: 'a', type: 'manual', name: 'A' }, { id: 'b', type: 'manual', name: 'B' }, { id: 'e', type: 'end' },
    ],
    [
      { id: 'f1', from: 's', to: 't' },
      { id: 'f2', from: 't', to: 'g' },
      { id: 'f3', from: 'g', to: 'a', lang: 'js', when: 'getVariable("flag") === true' },
      { id: 'f4', from: 'g', to: 'b', lang: 'js', when: 'getVariable("flag") !== true' },
      { id: 'f5', from: 'a', to: 'e' }, { id: 'f6', from: 'b', to: 'e' },
    ],
    { code: 'ABC' },
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['status'], 'VALIDATED:ABC');
  assert.ok(inst.history.some((h) => h.nodeId === 'a'));
});

test('bare variable names work directly in JS gateway condition', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' }, { id: 'g', type: 'gateway', mode: 'exclusive' },
      { id: 'a', type: 'manual', name: 'A' }, { id: 'b', type: 'manual', name: 'B' }, { id: 'e', type: 'end' },
    ],
    [
      { id: 'f1', from: 's', to: 'g' },
      { id: 'f2', from: 'g', to: 'a', lang: 'js', when: 'amount > 1000' },
      { id: 'f3', from: 'g', to: 'b', lang: 'js', when: 'amount <= 1000' },
      { id: 'f4', from: 'a', to: 'e' }, { id: 'f5', from: 'b', to: 'e' },
    ],
    { amount: 5000 },
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.ok(inst.history.some((h) => h.nodeId === 'a'));
});

test('KieFunctions full suite functions correctly in JS sandbox', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      {
        id: 't', type: 'script', lang: 'js', code: `
          vars.eq = KieFunctions.equalsTo(100, "100");
          vars.isT = KieFunctions.isTrue("true") && KieFunctions.isTrue(1);
          vars.isF = KieFunctions.isFalse("false") && KieFunctions.isFalse(0);
          vars.isN = KieFunctions.isNull(null) && !KieFunctions.isNull("hello");
          vars.notN = KieFunctions.notNull("hello") && !KieFunctions.notNull(undefined);
          vars.isEmp = KieFunctions.isEmpty("") && KieFunctions.isEmpty([]) && KieFunctions.isEmpty({});
          vars.containsArr = KieFunctions.contains(["apple", "banana"], "apple");
          vars.containsStr = KieFunctions.contains("hello world", "world");
          vars.sw = KieFunctions.startsWith("PRU-1234", "PRU");
          vars.ew = KieFunctions.endsWith("report.pdf", ".pdf");
          vars.gt = KieFunctions.greaterThan(50, 20);
          vars.gte = KieFunctions.greaterOrEqualThan(50, 50);
          vars.lt = KieFunctions.lessThan(10, 20);
          vars.lte = KieFunctions.lessOrEqualThan(20, 20);
          vars.btw = KieFunctions.between(25, 20, 30);
        `,
      },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['eq'], true);
  assert.strictEqual(inst.variables['isT'], true);
  assert.strictEqual(inst.variables['isF'], true);
  assert.strictEqual(inst.variables['isN'], true);
  assert.strictEqual(inst.variables['notN'], true);
  assert.strictEqual(inst.variables['isEmp'], true);
  assert.strictEqual(inst.variables['containsArr'], true);
  assert.strictEqual(inst.variables['containsStr'], true);
  assert.strictEqual(inst.variables['sw'], true);
  assert.strictEqual(inst.variables['ew'], true);
  assert.strictEqual(inst.variables['gt'], true);
  assert.strictEqual(inst.variables['gte'], true);
  assert.strictEqual(inst.variables['lt'], true);
  assert.strictEqual(inst.variables['lte'], true);
  assert.strictEqual(inst.variables['btw'], true);
});

test('instance and node convenience methods work in JS scripts and conditions', async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      {
        id: 'probe', type: 'script', name: 'ProbeNode', lang: 'js', code: `
          instance.setVariable("hasInit", instance.hasVariable("initVal"));
          instance.setVariable("fetchedVal", instance.getVariable("initVal"));
          instance.setVariable("thisNodeId", node.getNodeId());
          instance.setVariable("thisNodeName", node.getNodeName());
          instance.setVariable("metaInstId", instanceId.length > 0);
          instance.setVariable("metaProcId", processId.length > 0);
          instance.setVariable("metaNodeId", currentNodeId);
          instance.setVariable("metaNodeName", currentNodeName);
        `,
      },
      { id: 'g', type: 'gateway', mode: 'exclusive' },
      { id: 'a', type: 'manual', name: 'A' }, { id: 'b', type: 'manual', name: 'B' }, { id: 'e', type: 'end' },
    ],
    [
      { id: 'f1', from: 's', to: 'probe' },
      { id: 'f2', from: 'probe', to: 'g' },
      { id: 'f3', from: 'g', to: 'a', lang: 'js', when: 'instance.getVariable("fetchedVal") === 999 && node.getNodeId() === "g"' },
      { id: 'f4', from: 'g', to: 'b', lang: 'js', when: 'instance.getVariable("fetchedVal") !== 999' },
      { id: 'f5', from: 'a', to: 'e' }, { id: 'f6', from: 'b', to: 'e' },
    ],
    { initVal: 999 },
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['hasInit'], true);
  assert.strictEqual(inst.variables['fetchedVal'], 999);
  assert.strictEqual(inst.variables['thisNodeId'], 'probe');
  assert.strictEqual(inst.variables['thisNodeName'], 'ProbeNode');
  assert.strictEqual(inst.variables['metaInstId'], true);
  assert.strictEqual(inst.variables['metaProcId'], true);
  assert.strictEqual(inst.variables['metaNodeId'], 'probe');
  assert.strictEqual(inst.variables['metaNodeName'], 'ProbeNode');
  assert.ok(inst.history.some((h) => h.nodeId === 'a'), 'gateway successfully evaluated node.getNodeId() and instance.getVariable()');
});
