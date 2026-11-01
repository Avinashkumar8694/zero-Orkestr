// Export-time preambles for this engine's OWN additive `instance`/`node` (JS) and meta-locals (Java)
// convenience globals — see jbpm-engine/server/src/engine/sandbox.ts (buildInstanceGlobal/
// buildNodeGlobal) and java-runtime/src/bpmscript/ScriptRunner.java (META_LOCALS) for the
// execution-side twins these preambles must stay consistent with. Mirrors the existing `vars`/
// bare-name preamble strategy: a no-op unless the engine-only name is actually referenced, so a
// script/condition that never uses them exports byte-for-byte unchanged (beyond the `vars`/bare-name
// preambles, tested implicitly here too since some cases combine both).
import { test } from 'node:test';
import assert from 'node:assert';
import { fromEngine } from '../dist/index.mjs';

const proc = (overrides) => ({
  id: 'p.process', name: 'P', package: 'com.acme',
  vars: [], nodes: [], flows: [],
  ...overrides,
});

test('JS script using instance.* gets a preamble computing instance from real kcontext', () => {
  const ep = proc({
    nodes: [{ id: 't', type: 'script', lang: 'js', code: 'kcontext.setVariable("pid", instance.processId);' }],
  });
  const m = fromEngine(ep);
  const t = m.nodes.find((n) => n.id === 't');
  assert.ok(t.script.includes('var instance = {'), 'instance preamble injected');
  assert.ok(t.script.includes('kcontext.getProcessInstance().getProcessId()'), 'built from real kcontext calls');
  assert.ok(!t.script.includes('var node = {'), 'node preamble NOT injected — node is never referenced');
  assert.ok(!t.script.includes('var vars = {'), 'vars preamble NOT injected — vars is never referenced');
  assert.ok(t.script.trim().endsWith('instance.processId);'), 'original code preserved verbatim at the end');
});

test('JS script using node.* gets a preamble computing node from real kcontext, independent of instance', () => {
  const ep = proc({
    nodes: [{ id: 't', type: 'script', lang: 'js', code: 'kcontext.setVariable("nid", node.nodeId);' }],
  });
  const m = fromEngine(ep);
  const t = m.nodes.find((n) => n.id === 't');
  assert.ok(t.script.includes('var node = {'), 'node preamble injected');
  assert.ok(!t.script.includes('var instance = {'), 'instance preamble NOT injected');
});

test('JS script using instance.signal()/abort() exports to plain kieRuntime calls', () => {
  const ep = proc({
    nodes: [{ id: 't', type: 'script', lang: 'js', code: 'instance.signal("Ping", 1); instance.abort();' }],
  });
  const m = fromEngine(ep);
  const t = m.nodes.find((n) => n.id === 't');
  assert.ok(t.script.includes('signal: function(type, payload){ kcontext.getKieRuntime().signalEvent(type, payload, kcontext.getProcessInstance().getId()); }'));
  assert.ok(t.script.includes('abort: function(){ kcontext.getKieRuntime().abortProcessInstance(kcontext.getProcessInstance().getId()); }'));
});

test('JS script using neither vars/instance/node is exported completely untouched', () => {
  const code = 'kcontext.setVariable("x", 1);';
  const ep = proc({ nodes: [{ id: 't', type: 'script', lang: 'js', code }] });
  const m = fromEngine(ep);
  assert.strictEqual(m.nodes.find((n) => n.id === 't').script, code);
});

test('Java script using meta-locals gets String local declarations from real kcontext', () => {
  const ep = proc({
    nodes: [{ id: 't', type: 'script', lang: 'java', code: 'System.out.println(instanceId + "/" + currentNodeName);' }],
  });
  const m = fromEngine(ep);
  const t = m.nodes.find((n) => n.id === 't');
  assert.ok(t.script.includes('String instanceId = String.valueOf(kcontext.getProcessInstance().getId());'));
  assert.ok(t.script.includes('String currentNodeName = kcontext.getNodeInstance().getNodeName();'));
  assert.ok(!t.script.includes('processName'), 'unreferenced meta-locals are not injected');
});

test('Java script: a declared process variable of the same name wins over the synthetic meta-local', () => {
  const ep = proc({
    vars: [{ name: 'processId', type: 'string' }],
    nodes: [{ id: 't', type: 'script', lang: 'java', code: 'System.out.println(processId);' }],
  });
  const m = fromEngine(ep);
  const t = m.nodes.find((n) => n.id === 't');
  assert.ok(t.script.includes('kcontext.getVariable("processId")'), 'bound via the declared-variable bare-name path');
  assert.ok(!t.script.includes('kcontext.getProcessInstance().getProcessId()'), 'meta-local binding skipped — declared var wins');
});

test('Java gateway condition (no explicit return) using a meta-local gets wrapped: bindings THEN return(...)', () => {
  const ep = proc({
    nodes: [{ id: 'a', type: 'manual' }, { id: 'b', type: 'manual' }],
    flows: [{ id: 'f1', from: 'a', to: 'b', lang: 'java', when: 'currentNodeId.equals("a")' }],
  });
  const m = fromEngine(ep);
  const f = m.flows.find((x) => x.id === 'f1');
  assert.ok(f.condition.startsWith('String currentNodeId = kcontext.getNodeInstance().getNodeId();\n'), 'binding precedes the return statement');
  assert.ok(f.condition.includes('return (currentNodeId.equals("a"));'), 'original bare expression wrapped in return(...)');
});

test('Java gateway condition WITHOUT any meta-local reference is untouched (no return forced)', () => {
  const ep = proc({
    nodes: [{ id: 'a', type: 'manual' }, { id: 'b', type: 'manual' }],
    flows: [{ id: 'f1', from: 'a', to: 'b', lang: 'java', when: 'true' }],
  });
  const m = fromEngine(ep);
  assert.strictEqual(m.flows.find((x) => x.id === 'f1').condition, 'true');
});

test('JS gateway condition using instance.* gets a preamble but is NOT forced into a return(...) wrapper', () => {
  const ep = proc({
    nodes: [{ id: 'a', type: 'manual' }, { id: 'b', type: 'manual' }],
    flows: [{ id: 'f1', from: 'a', to: 'b', lang: 'js', when: 'instance.state === "running"' }],
  });
  const m = fromEngine(ep);
  const f = m.flows.find((x) => x.id === 'f1');
  assert.ok(f.condition.includes('var instance = {'), 'instance preamble present');
  assert.ok(f.condition.trim().endsWith('instance.state === "running"'), 'bare expression preserved as-is, no return() wrapper injected');
});

test('JS gateway condition using vars.* (previously an unhandled export gap) gets the vars preamble too', () => {
  const ep = proc({
    vars: [{ name: 'claimType', type: 'string' }],
    nodes: [{ id: 'a', type: 'manual' }, { id: 'b', type: 'manual' }],
    flows: [{ id: 'f1', from: 'a', to: 'b', lang: 'js', when: 'vars.claimType === "DEATH"' }],
  });
  const m = fromEngine(ep);
  const f = m.flows.find((x) => x.id === 'f1');
  assert.ok(f.condition.includes('var vars = {};'));
  assert.ok(f.condition.includes('Object.defineProperty(vars, "claimType"'));
});
