// Proves 'java'-dialect script/condition nodes actually execute in the real JVM sidecar end to end
// through the full engine (workflow -> publish -> deploy -> start -> step), not just that the static
// validator accepts them. This spawns a real `java` child process (jbpm-engine/java-runtime).
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
import { stopJavaSidecar } from '../src/engine/java-sidecar.ts';

const newCtx = () => { let n = 0; return makeContext({ store: new MemoryStore(), tenantId: 't1', clock: fakeClock().clock, newId: () => `id${++n}` }); };

async function run(ctx: AppContext, nodes: any[], flows: any[], variables: Record<string, unknown> = {}, vars: Array<{ name: string; type: string }> = [], correlationKey?: string) {
  const wf = await new WorkflowService(ctx).create({ name: 'Java ' + nodes.map((n) => n.id).join('') }, 'a');
  const draft = await new VersionService(ctx).saveDraft(wf.defaultBranchId, { id: wf.key, name: wf.name, processes: [{ id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars, nodes, flows }] } as any, 'a');
  const pub = await new VersionService(ctx).publish(draft.id, 'a');
  await new DeploymentService(ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'a');
  return new InstanceService(ctx).start({ workflowId: wf.id, environment: 'prod', variables, correlationKey }, 'bob');
}

test.after(() => stopJavaSidecar());

test('a real Java script node runs in the JVM sidecar: kcontext + Jackson JSON + BigDecimal', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      {
        id: 'calc', type: 'script', name: 'Calc', lang: 'java', code:
          'com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();\n' +
          'com.fasterxml.jackson.databind.JsonNode root = mapper.readTree((String) kcontext.getVariable("payload"));\n' +
          'com.fasterxml.jackson.databind.node.ArrayNode items = (com.fasterxml.jackson.databind.node.ArrayNode) root.get("items");\n' +
          'java.math.BigDecimal total = java.math.BigDecimal.ZERO;\n' +
          'for (com.fasterxml.jackson.databind.JsonNode it : items) { total = total.add(new java.math.BigDecimal(it.get("amount").asText())); }\n' +
          'kcontext.setVariable("total", total.toString());\n' +
          'kcontext.setVariable("count", items.size());\n' +
          'System.out.println("computed total=" + total);',
      },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 'calc' }, { id: 'f2', from: 'calc', to: 'e' }],
    { payload: JSON.stringify({ items: [{ amount: '10.50' }, { amount: '5.25' }] }) },
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error || inst.history));
  assert.strictEqual(inst.variables['total'], '15.75');
  assert.strictEqual(inst.variables['count'], 2);
});

test('a real Java gateway condition (bare boolean expression, no return) picks the matching branch', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      { id: 'g', type: 'gateway', mode: 'exclusive' },
      { id: 'high', type: 'manual', name: 'High' },
      { id: 'low', type: 'manual', name: 'Low' },
      { id: 'e', type: 'end' },
    ],
    [
      { id: 'f1', from: 's', to: 'g' },
      { id: 'f2', from: 'g', to: 'high', lang: 'java', when: '((Number) kcontext.getVariable("amount")).doubleValue() > 1000' },
      { id: 'f3', from: 'g', to: 'low', lang: 'java', when: '((Number) kcontext.getVariable("amount")).doubleValue() <= 1000' },
      { id: 'f4', from: 'high', to: 'e' },
      { id: 'f5', from: 'low', to: 'e' },
    ],
    { amount: 1500.5 },
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error || inst.history));
  assert.ok(inst.history.some((h) => h.nodeId === 'high'), 'took the high branch');
  assert.ok(!inst.history.some((h) => h.nodeId === 'low'), 'did not take the low branch');
});

test('a real Java gateway condition using BARE declared-variable names (real jBPM pattern, e.g. pru-api-error-handler.bpmn: "return retryCount < maxRetryCount;") picks the matching branch', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      { id: 'g', type: 'gateway', mode: 'exclusive' },
      { id: 'retry', type: 'manual', name: 'Retry' },
      { id: 'giveup', type: 'manual', name: 'GiveUp' },
      { id: 'e', type: 'end' },
    ],
    [
      { id: 'f1', from: 's', to: 'g' },
      { id: 'f2', from: 'g', to: 'retry', lang: 'java', when: 'return retryCount < maxRetryCount;' },
      { id: 'f3', from: 'g', to: 'giveup', lang: 'java', when: 'return retryCount >= maxRetryCount;' },
      { id: 'f4', from: 'retry', to: 'e' }, { id: 'f5', from: 'giveup', to: 'e' },
    ],
    { retryCount: 1, maxRetryCount: 3 },
    [{ name: 'retryCount', type: 'Integer' }, { name: 'maxRetryCount', type: 'Integer' }],
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error || inst.history));
  assert.ok(inst.history.some((h) => h.nodeId === 'retry'), 'took the retry branch (1 < 3)');
  assert.ok(!inst.history.some((h) => h.nodeId === 'giveup'));
});

test('kcontext.getProcessInstance() exposes processId/parentProcessInstanceId/state/correlationKey/getVariables (real jBPM ProcessInstance surface)', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      {
        id: 't', type: 'script', lang: 'java', code:
          'kcontext.setVariable("pid", kcontext.getProcessInstance().getProcessId());\n' +
          'kcontext.setVariable("parent", kcontext.getProcessInstance().getParentProcessInstanceId());\n' +
          'kcontext.setVariable("state", kcontext.getProcessInstance().getState());\n' +
          'kcontext.setVariable("corr", kcontext.getProcessInstance().getCorrelationKey());\n' +
          'kcontext.setVariable("varCount", kcontext.getProcessInstance().getVariables().size());',
      },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
    { caseId: 'CASE-1' },
    [],
    'CORR-ABC',
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['pid'], inst.processId, "getProcessId() matches the instance's own recorded processId");
  assert.strictEqual(inst.variables['parent'], null, 'a root instance has no parent');
  assert.strictEqual(inst.variables['state'], 1, 'ACTIVE while running (root-level state, distinct from any per-node wait)');
  assert.strictEqual(inst.variables['corr'], 'CORR-ABC');
  assert.ok((inst.variables['varCount'] as number) >= 1, 'getVariables() sees at least the caseId variable');
});

test("kcontext.getProcessInstance().getNodeInstances() reflects currently-active node instances, and NodeInstance.getId() (token id) differs from getNodeId() (node definition id)", { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      { id: 'g', type: 'gateway', mode: 'parallel' },
      {
        id: 'probe', type: 'script', lang: 'java', code:
          'kcontext.setVariable("activeCount", kcontext.getProcessInstance().getNodeInstances().size());\n' +
          'kcontext.setVariable("myInstId", kcontext.getNodeInstance().getId());\n' +
          'kcontext.setVariable("myDefId", kcontext.getNodeInstance().getNodeId());',
      },
      { id: 'review', type: 'userTask', name: 'Review', group: 'ops' },
      { id: 'e1', type: 'end' },
      { id: 'e2', type: 'end' },
    ],
    [
      { id: 'f1', from: 's', to: 'g' },
      { id: 'f2', from: 'g', to: 'probe' },
      { id: 'f3', from: 'g', to: 'review' },
      { id: 'f4', from: 'probe', to: 'e1' },
      { id: 'f5', from: 'review', to: 'e2' },
    ],
  );
  assert.strictEqual(inst.status, 'waiting', JSON.stringify(inst.error || inst.history));
  assert.strictEqual(inst.variables['activeCount'], 2, "sees both probe's own token and the sibling userTask token");
  assert.strictEqual(inst.variables['myDefId'], 'probe', 'getNodeId() is the node DEFINITION id declared in the process');
  assert.notStrictEqual(inst.variables['myInstId'], 'probe', 'getId() is the node INSTANCE (token) id — a generated id, not the definition id');
  assert.ok(typeof inst.variables['myInstId'] === 'number' && (inst.variables['myInstId'] as number) > 0, 'getId() is a long, as in jBPM');
});

test('kcontext.getKieRuntime().signalEvent(type,event,processInstanceId) delivers to a SPECIFIC other instance, not a broadcast', { timeout: 30000 }, async () => {
  const ctx = newCtx();
  const catcher = await run(ctx,
    [{ id: 's', type: 'start' }, { id: 'c', type: 'catch', event: { signal: 'Ping' } }, { id: 'e', type: 'end' }],
    [{ id: 'f1', from: 's', to: 'c' }, { id: 'f2', from: 'c', to: 'e' }],
  );
  assert.strictEqual(catcher.status, 'waiting', JSON.stringify(catcher.error || catcher.history));
  const sender = await run(ctx,
    [
      { id: 's', type: 'start' },
      { id: 't', type: 'script', lang: 'java', code: `kcontext.getKieRuntime().signalEvent("Ping", "hello", "${catcher.id}");` },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(sender.status, 'completed', JSON.stringify(sender.error));
  const resumedCatcher = await new InstanceService(ctx).get(catcher.id);
  assert.strictEqual(resumedCatcher.status, 'completed', 'the targeted signal actually resumed the OTHER instance');
});

test('kcontext.getKieRuntime().abortProcessInstance(selfId) aborts the current instance from within its own script', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      { id: 't', type: 'script', lang: 'java', code: 'kcontext.getKieRuntime().abortProcessInstance(kcontext.getProcessInstance().getId());' },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(inst.status, 'aborted', JSON.stringify(inst.error || inst.history));
});

test('Java meta-locals (instanceId/processName/correlationKey/currentNodeName/...) are this engine\'s simpler alternative to kcontext.getProcessInstance().getX() chains', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      {
        id: 't', type: 'script', lang: 'java', code:
          'kcontext.setVariable("iid", instanceId);\n' +
          'kcontext.setVariable("pid", processId);\n' +
          'kcontext.setVariable("pname", processName);\n' +
          'kcontext.setVariable("parent", parentInstanceId);\n' +
          'kcontext.setVariable("corr", correlationKey);\n' +
          'kcontext.setVariable("myNodeId", currentNodeId);\n' +
          'kcontext.setVariable("myNodeName", currentNodeName);',
      },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
    { caseId: 'CASE-1' }, [], 'CORR-META-1',
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['iid'], numericIdOf(inst.id), 'instanceId meta-local is the process INSTANCE id as jBPM numbers it (the API resolves it back)');
  assert.strictEqual(inst.variables['pid'], inst.processId, 'processId meta-local is the process DEFINITION id — distinct from instanceId');
  assert.strictEqual(inst.variables['pname'], 'Java ste', 'processName matches the workflow name used to build this test process');
  assert.strictEqual(inst.variables['parent'], null, 'a root instance has no parent');
  assert.strictEqual(inst.variables['corr'], 'CORR-META-1');
  assert.strictEqual(inst.variables['myNodeId'], 't');
  assert.strictEqual(inst.variables['myNodeName'], '', 'node "t" has no explicit name in this test process — KContext.getNodeName() returns "", not null');
});

test('a Java condition referencing a meta-local works without any explicit `return` (matches the bare-boolean-expression convention)', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' }, { id: 'g', type: 'gateway', mode: 'exclusive' },
      { id: 'here', type: 'manual', name: 'Here' }, { id: 'there', type: 'manual', name: 'There' }, { id: 'e', type: 'end' },
    ],
    [
      { id: 'f1', from: 's', to: 'g' },
      { id: 'f2', from: 'g', to: 'here', lang: 'java', when: 'currentNodeId.equals("g")' },
      { id: 'f3', from: 'g', to: 'there', lang: 'java', when: '!currentNodeId.equals("g")' },
      { id: 'f4', from: 'here', to: 'e' }, { id: 'f5', from: 'there', to: 'e' },
    ],
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error || inst.history));
  assert.ok(inst.history.some((h) => h.nodeId === 'here'), 'currentNodeId resolved to the gateway node evaluating the condition');
  assert.ok(!inst.history.some((h) => h.nodeId === 'there'));
});

test('a declared process variable named like a meta-local (e.g. "processId") wins — the meta-local binding is skipped, not a compile clash', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      { id: 't', type: 'script', lang: 'java', code: 'kcontext.setVariable("echo", processId);' },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
    { processId: 'MY-OWN-VALUE' }, [{ name: 'processId', type: 'String' }],
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['processId'], 'MY-OWN-VALUE', 'the declared variable itself is untouched');
  assert.strictEqual(inst.variables['echo'], 'MY-OWN-VALUE', 'the bare name bound to the DECLARED variable, not the synthetic processId meta-local');
});

// Regression: withVarBindings used to bind EVERY declared process variable unconditionally (even one
// the condition/script never references as a bare word — only inside a kcontext.getVariable("name")
// STRING argument, which a naive \bname\b scan still matches). A declared `double` variable holding a
// whole number (this engine's own JSON parser prefers Integer for whole numbers — see JsonIO.Parser)
// then threw ClassCastException on the auto-generated `(Double) kcontext.getVariable("amount")` cast,
// silently making the WHOLE condition evaluate false (or the script fail SCRIPT_ERROR) — regardless of
// whether the condition/script actually used "amount". Fixed by blanking string/comment contents
// before the bare-word scan, so a name appearing only inside a string literal doesn't count.
test('a condition using ONLY kcontext.getVariable("name") (never as a bare word) is unaffected by that variable being declared with a mismatched-at-runtime type', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' }, { id: 'g', type: 'gateway', mode: 'exclusive' },
      { id: 'high', type: 'manual', name: 'High' }, { id: 'low', type: 'manual', name: 'Low' }, { id: 'e', type: 'end' },
    ],
    [
      { id: 'f1', from: 's', to: 'g' },
      // "amount" appears only inside the getVariable(...) string argument, never as a bare identifier —
      // declaring it `double` while the actual value (1500, a whole number) parses as Integer must NOT
      // break this condition.
      { id: 'f2', from: 'g', to: 'high', lang: 'java', when: '((Number) kcontext.getVariable("amount")).doubleValue() > 1000' },
      { id: 'f3', from: 'g', to: 'low', lang: 'java', when: '!(((Number) kcontext.getVariable("amount")).doubleValue() > 1000)' },
      { id: 'f4', from: 'high', to: 'e' }, { id: 'f5', from: 'low', to: 'e' },
    ],
    { amount: 1500, claimType: 'DEATH' }, [{ name: 'amount', type: 'double' }, { name: 'claimType', type: 'string' }],
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error || inst.history));
  assert.ok(inst.history.some((h) => h.nodeId === 'high'), 'condition correctly evaluated true — not silently swallowed to false');
  assert.ok(!inst.history.some((h) => h.nodeId === 'low'));
});

test('a script using ONLY kcontext.getVariable("name") (never as a bare word) does not fail SCRIPT_ERROR from an unrelated declared variable\'s type mismatch', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      { id: 't', type: 'script', lang: 'java', code: 'kcontext.setVariable("big", ((Number) kcontext.getVariable("amount")).doubleValue() > 1000);' },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
    { amount: 1500 }, [{ name: 'amount', type: 'double' }],
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['big'], true);
});

test('onEntry/onExit scripts get the same fix — a type-mismatched unrelated declared variable never referenced as a bare word does not break them', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      {
        id: 't', type: 'manual', name: 'Approve',
        onEntry: 'kcontext.setVariable("entryBig", ((Number) kcontext.getVariable("amount")).doubleValue() > 1000);',
        onExit: 'kcontext.setVariable("exitBig", ((Number) kcontext.getVariable("amount")).doubleValue() > 1000);',
        onEntryLang: 'java', onExitLang: 'java',
      },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
    { amount: 1500 }, [{ name: 'amount', type: 'double' }],
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['entryBig'], true, 'onEntry unaffected by the unrelated declared-var type mismatch');
  assert.strictEqual(inst.variables['exitBig'], true, 'onExit unaffected too');
});

// Regression: kcontext.getVariable(name) now coerces a declared variable's value to its declared
// type on every read (KContext.coerce, using the same varTypes map bare-name binding already relies
// on). Before this fix, a BigDecimal a script computed and stored via kcontext.setVariable(...) came
// back as a plain JSON number the next time a DIFFERENT script/condition read it (each /execute call
// round-trips the whole variable set through JSON) — so `(BigDecimal) kcontext.getVariable("fee")` in
// that LATER node threw ClassCastException. This only helps DECLARED variables (real jBPM has no
// concept of an undeclared one either, so this isn't a new gap relative to real jBPM).
test('a BigDecimal computed and stored in one script node survives, as a real BigDecimal, into a LATER script/condition node — declared-type coercion on kcontext.getVariable', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      {
        id: 'compute', type: 'script', lang: 'java', code:
          'java.math.BigDecimal computedFee = new java.math.BigDecimal(String.valueOf(kcontext.getVariable("amount"))).multiply(new java.math.BigDecimal("0.02"));\n' +
          'kcontext.setVariable("fee", computedFee);',
      },
      { id: 'g', type: 'gateway', mode: 'exclusive' },
      { id: 'high', type: 'manual', name: 'High' }, { id: 'low', type: 'manual', name: 'Low' },
      { id: 'e', type: 'end' },
    ],
    [
      { id: 'f1', from: 's', to: 'compute' }, { id: 'f2', from: 'compute', to: 'g' },
      // "fee" is read back with a direct (BigDecimal) cast in a SEPARATE node's condition — the exact
      // pattern that used to throw ClassCastException, since it was a plain number by this point.
      { id: 'f3', from: 'g', to: 'high', lang: 'java', when: '((java.math.BigDecimal) kcontext.getVariable("fee")).compareTo(java.math.BigDecimal.TEN) > 0' },
      { id: 'f4', from: 'g', to: 'low', lang: 'java', when: '!(((java.math.BigDecimal) kcontext.getVariable("fee")).compareTo(java.math.BigDecimal.TEN) > 0)' },
      { id: 'f5', from: 'high', to: 'e' }, { id: 'f6', from: 'low', to: 'e' },
    ],
    { amount: 600 }, [{ name: 'amount', type: 'double' }, { name: 'fee', type: 'BigDecimal' }],
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error || inst.history));
  assert.ok(inst.history.some((h) => h.nodeId === 'high'), 'fee=12 > 10, condition correctly true across a separate node execution');
  assert.ok(!inst.history.some((h) => h.nodeId === 'low'));
});

test('an UNDECLARED variable (not in the process\'s own vars list) is still returned as its raw JSON-shaped value — coercion only applies to declared variables, matching real jBPM (every variable there is declared by construction)', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      { id: 't', type: 'script', lang: 'java', code: 'kcontext.setVariable("cls", kcontext.getVariable("scratch").getClass().getSimpleName());' },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
    { scratch: 5 }, [], // "scratch" is NOT declared
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  assert.strictEqual(inst.variables['cls'], 'Integer', 'no declared type to coerce to, so it stays whatever the JSON parser produced');
});

// Regression: found via the real-project sweep (engine-real-project-sweep.test.ts) — a real onEntry
// script in the bundled sample project's pru-verification-process.bpmn calls ObjectNode.putArray(...)
// to build a JSON array field, which the Jackson shim didn't implement at all (compile error: cannot
// find symbol). Added putArray/putObject to ObjectNode.java, matching real Jackson: both create a new
// empty node, attach it under the given field, and return THAT node (not `this`) as a live reference —
// further mutations on the returned node ARE reflected in the parent, since they share the same
// backing collection.
test('ObjectNode.putArray()/.putObject() create-and-attach a live child node, matching real Jackson', { timeout: 30000 }, async () => {
  const inst = await run(newCtx(),
    [
      { id: 's', type: 'start' },
      {
        id: 't', type: 'script', lang: 'java', code:
          'com.fasterxml.jackson.databind.node.ObjectNode root = new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode();\n' +
          'com.fasterxml.jackson.databind.node.ArrayNode items = root.putArray("items");\n' +
          'items.add("a"); items.add("b");\n' +
          'com.fasterxml.jackson.databind.node.ObjectNode nested = root.putObject("meta");\n' +
          'nested.put("k", "v");\n' +
          'kcontext.setVariable("json", root.toString());',
      },
      { id: 'e', type: 'end' },
    ],
    [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  );
  assert.strictEqual(inst.status, 'completed', JSON.stringify(inst.error));
  const parsed = JSON.parse(inst.variables['json'] as string);
  assert.deepStrictEqual(parsed.items, ['a', 'b'], 'putArray-returned node\'s .add() calls are reflected in the parent');
  assert.deepStrictEqual(parsed.meta, { k: 'v' }, 'putObject-returned node\'s .put() calls are reflected in the parent');
});
