// onEntry-script/onExit-script — real jBPM's generic action-hook extensionElements, attachable to
// any activity. Previously only parsed/serialized for the REST-call-activity special case; this
// proves it now round-trips on ordinary activity nodes too (userTask here), both directions, with the
// same vars/instance/node/meta-locals preamble treatment already proven for script tasks.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseBpmn, serializeProcess, toEngine, fromEngine } from '../dist/index.mjs';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:drools="http://www.jboss.org/drools" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" id="_defs" targetNamespace="http://www.jboss.org/drools">
  <bpmn2:process id="p.process" drools:packageName="com.acme" name="P" isExecutable="true">
    <bpmn2:startEvent id="s"><bpmn2:outgoing>f1</bpmn2:outgoing></bpmn2:startEvent>
    <bpmn2:userTask id="t" name="Review">
      <bpmn2:extensionElements>
        <drools:metaData name="elementname"><drools:metaValue>Review</drools:metaValue></drools:metaData>
        <drools:onEntry-script scriptFormat="http://www.java.com/java"><drools:script>System.out.println("entering " + kcontext.getNodeInstance().getNodeName());</drools:script></drools:onEntry-script>
        <drools:onExit-script scriptFormat="http://www.java.com/java"><drools:script>kcontext.setVariable("reviewed", true);</drools:script></drools:onExit-script>
      </bpmn2:extensionElements>
      <bpmn2:incoming>f1</bpmn2:incoming><bpmn2:outgoing>f2</bpmn2:outgoing>
    </bpmn2:userTask>
    <bpmn2:endEvent id="e"><bpmn2:incoming>f2</bpmn2:incoming></bpmn2:endEvent>
    <bpmn2:sequenceFlow id="f1" sourceRef="s" targetRef="t"/>
    <bpmn2:sequenceFlow id="f2" sourceRef="t" targetRef="e"/>
  </bpmn2:process>
</bpmn2:definitions>`;

test('parseBpmn extracts onEntry-script/onExit-script from a userTask (previously only worked for the REST callActivity case)', () => {
  const m = parseBpmn(XML);
  const t = m.nodes.find((n) => n.id === 't');
  assert.strictEqual(t.onEntry, 'System.out.println("entering " + kcontext.getNodeInstance().getNodeName());');
  assert.strictEqual(t.onExit, 'kcontext.setVariable("reviewed", true);');
  assert.strictEqual(t.onEntryFormat, 'http://www.java.com/java');
  assert.strictEqual(t.onExitFormat, 'http://www.java.com/java');
});

test('toEngine preserves onEntry/onExit on a userTask byte-for-byte, with the right lang', () => {
  const m = parseBpmn(XML);
  const ep = toEngine(m);
  const t = ep.nodes.find((n) => n.id === 't');
  assert.strictEqual(t.type, 'userTask');
  assert.strictEqual(t.onEntry, 'System.out.println("entering " + kcontext.getNodeInstance().getNodeName());');
  assert.strictEqual(t.onExit, 'kcontext.setVariable("reviewed", true);');
  assert.strictEqual(t.onEntryLang, 'java');
  assert.strictEqual(t.onExitLang, 'java');
});

test('serializeProcess re-emits onEntry-script/onExit-script for a userTask, and it survives a second parse', () => {
  const m = parseBpmn(XML);
  const xml2 = serializeProcess(m);
  assert.ok(xml2.includes('<drools:onEntry-script'), 'onEntry-script re-emitted');
  assert.ok(xml2.includes('<drools:onExit-script'), 'onExit-script re-emitted');
  const m2 = parseBpmn(xml2);
  const t2 = m2.nodes.find((n) => n.id === 't');
  assert.strictEqual(t2.onEntry, 'System.out.println("entering " + kcontext.getNodeInstance().getNodeName());');
  assert.strictEqual(t2.onExit, 'kcontext.setVariable("reviewed", true);');
});

test('fromEngine: authoring onEntry/onExit fresh on a userTask using instance/vars gets the same preamble treatment as script tasks', () => {
  const ep = {
    id: 'p.process', name: 'P', package: 'com.acme', vars: [{ name: 'caseId', type: 'string' }],
    nodes: [
      { id: 's', type: 'start' },
      { id: 't', type: 'userTask', name: 'Review', group: 'ops', onEntryLang: 'js', onEntry: 'vars.status = "seen:" + vars.caseId;', onExitLang: 'js', onExit: 'kcontext.setVariable("reviewedInstance", instance.id);' },
      { id: 'e', type: 'end' },
    ],
    flows: [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  };
  const m = fromEngine(ep);
  const t = m.nodes.find((n) => n.id === 't');
  assert.ok(t.onEntry.includes('var vars = {};'), 'vars preamble injected for onEntry (JS)');
  assert.ok(t.onExit.includes('var instance = {'), 'instance preamble injected for onExit (JS)');
  assert.strictEqual(t.onEntryFormat, 'http://www.javascript.com/javascript');
  assert.strictEqual(t.onExitFormat, 'http://www.javascript.com/javascript');
});

// Real jBPM's JS dialect uses the SAME action class for script tasks AND onEntry/onExit —
// org.jbpm.process.instance.impl.JavaScriptAction (confirmed against jBPM source, see
// docs/bpm-nodes/_scripting-reference.md's source citations) — so a JS-format onEntry-script is
// exactly as real/importable as a Java one, just a different scriptFormat URI.
const JS_XML = XML
  .replace(/scriptFormat="http:\/\/www\.java\.com\/java"/g, 'scriptFormat="http://www.javascript.com/javascript"')
  .replace('System.out.println("entering " + kcontext.getNodeInstance().getNodeName());', 'console.log("entering " + kcontext.getNodeInstance().getNodeName());')
  .replace('kcontext.setVariable("reviewed", true);', 'vars.reviewed = true;');

test('parseBpmn + toEngine handle a JS-dialect onEntry-script/onExit-script on a userTask identically to Java, just a different lang', () => {
  const m = parseBpmn(JS_XML);
  const t = m.nodes.find((n) => n.id === 't');
  assert.strictEqual(t.onEntry, 'console.log("entering " + kcontext.getNodeInstance().getNodeName());');
  assert.strictEqual(t.onExit, 'vars.reviewed = true;');
  assert.strictEqual(t.onEntryFormat, 'http://www.javascript.com/javascript');

  const ep = toEngine(m);
  const et = ep.nodes.find((n) => n.id === 't');
  assert.strictEqual(et.onEntryLang, 'js');
  assert.strictEqual(et.onExitLang, 'js');
  assert.strictEqual(et.onEntry, 'console.log("entering " + kcontext.getNodeInstance().getNodeName());', 'byte-for-byte, same as the Java case');
});

test('JS onEntry/onExit using vars.* survive a full round trip (parse -> toEngine -> fromEngine -> serialize -> parse), preamble injected on export and stable after that', () => {
  const m1 = parseBpmn(JS_XML);
  const ep = toEngine(m1);
  // declare "reviewed" so the vars preamble has something to bind
  ep.vars = [{ name: 'reviewed', type: 'bool' }];
  const m2 = fromEngine(ep);
  const t2 = m2.nodes.find((n) => n.id === 't');
  assert.ok(t2.onExit.includes('var vars = {};'), 'vars preamble injected on export, since vars.reviewed is this engine\'s own addition');
  assert.ok(t2.onExit.trim().endsWith('vars.reviewed = true;'), 'original JS text preserved verbatim after the preamble');
  const xml2 = serializeProcess(m2);
  const m3 = parseBpmn(xml2);
  const t3 = m3.nodes.find((n) => n.id === 't');
  assert.strictEqual(t3.onExit, t2.onExit, 'stable across a second parse/serialize pass');
});

test('fromEngine: Java onEntry/onExit using bare declared-var names + meta-locals gets the SAME preamble treatment as a Java script task', () => {
  const ep = {
    id: 'p.process', name: 'P', package: 'com.acme', vars: [{ name: 'claimType', type: 'string' }],
    nodes: [
      { id: 's', type: 'start' },
      {
        id: 't', type: 'userTask', name: 'Review', group: 'ops',
        onEntryLang: 'java', onEntry: 'System.out.println(currentNodeName + "/" + claimType);',
        onExitLang: 'java', onExit: 'kcontext.setVariable("reviewedBy", instanceId);',
      },
      { id: 'e', type: 'end' },
    ],
    flows: [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  };
  const m = fromEngine(ep);
  const t = m.nodes.find((n) => n.id === 't');
  assert.ok(t.onEntry.includes('String currentNodeName = kcontext.getNodeInstance().getNodeName();'), 'meta-local bound for onEntry');
  assert.ok(t.onEntry.includes('String claimType = (String) kcontext.getVariable("claimType");'), 'declared bare-name var bound for onEntry (matches real jBPM\'s own auto-binding for scripts/onEntry/onExit)');
  assert.ok(t.onExit.includes('String instanceId = String.valueOf(kcontext.getProcessInstance().getId());'), 'meta-local bound for onExit');
  assert.strictEqual(t.onEntryFormat, 'http://www.java.com/java');
  assert.strictEqual(t.onExitFormat, 'http://www.java.com/java');
});

test('fromEngine: a userTask with no onEntry/onExit set emits neither (no accidental extensionElements)', () => {
  const ep = {
    id: 'p.process', name: 'P', package: 'com.acme', vars: [],
    nodes: [{ id: 's', type: 'start' }, { id: 't', type: 'userTask', name: 'Review', group: 'ops' }, { id: 'e', type: 'end' }],
    flows: [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }],
  };
  const m = fromEngine(ep);
  const xml = serializeProcess(m);
  assert.ok(!xml.includes('onEntry-script'));
  assert.ok(!xml.includes('onExit-script'));
});
