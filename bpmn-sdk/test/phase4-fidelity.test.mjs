// Release 2.0.0 phase 4: engine <-> jBPM BPMN fidelity for the newer properties. Where jBPM has a field it is used (so Business Central
// shows it); engine-only features ride in one metaData entry; either way a round trip loses nothing.
import { test } from 'node:test';
import assert from 'node:assert';
import { fromEngine, toEngine, serializeProcess, parseBpmn } from '../dist/index.mjs';

const engine = {
  id: 'claims.process', name: 'Claims', package: 'com.acme', version: '2.1', adHoc: true, slaDueDate: '2d', description: 'Claim #{claimId}',
  vars: [{ name: 'claimId', type: 'String', tags: ['required'] }, { name: 'amount', type: 'Number', tags: ['readonly', 'restricted'] }, { name: 'items', type: 'Object' }, { name: 'free', type: 'String' }],
  nodes: [
    { id: 's', type: 'start' },
    { id: 'u', type: 'userTask', name: 'Review', group: 'claims', groups: ['audit'], actors: ['dan', 'zed'], businessAdmin: 'boss', businessAdminGroups: ['managers'], stakeholders: ['cat'], excludedOwners: ['eve'],
      comment: 'Please review', content: 'see file', locale: 'en-GB', createdBy: 'bot', suspendUntil: 'PT1H', priority: 7, description: 'Review the claim',
      notStartedReassign: '[users:john]@[4h]', notCompletedNotify: '[tousers:a]@[1d]', assignmentStrategy: 'leastLoaded', swimlane: 'uw', autoClaim: true, metaData: { team: 'claims' }, slaDueDate: '1d', async: true, autoStart: false },
    { id: 'c', type: 'catch', name: 'Nightly', event: { timer: { cron: '0 9 * * MON-FRI' } } },
    { id: 'call', type: 'call', name: 'Verify', process: 'verify.process', onChildFailure: 'abort' },
    { id: 'call2', type: 'call', name: 'Verify soft', process: 'verify.process', onChildFailure: 'continue', errorVar: 'why' },
    { id: 'fe', type: 'forEach', name: 'Each', process: 'item.process', over: 'items', as: 'item', collectInto: 'results', itemResult: 'r', parallel: true, completionCondition: 'completed >= 2' },
    { id: 'mi', type: 'script', name: 'Per item', lang: 'js', code: 'vars.r = 1;', multiInstance: { over: 'items', as: 'item', parallel: true, collectInto: 'out', itemResult: 'r' } },
    { id: 'gw', type: 'gateway', mode: 'event', instantiate: true },
    { id: 'cx', type: 'gateway', mode: 'complex', activationCondition: 'arrived >= 2' },
    { id: 'ev', type: 'subprocess', name: 'On alert', on: { signal: 'ALERT' }, interrupting: false, nodes: [{ id: 'es', type: 'start' }, { id: 'ee', type: 'end' }], flows: [{ id: 'ef', from: 'es', to: 'ee' }] },
    { id: 'ah', type: 'subprocess', name: 'Ad hoc', adHoc: true, completionCondition: 'completed >= 3', nodes: [{ id: 'a1', type: 'script', lang: 'js', code: 'x=1', autoStart: true }], flows: [] },
    { id: 'tx', type: 'subprocess', name: 'Payment', transaction: true, nodes: [{ id: 'ts', type: 'start' }, { id: 'cancel', type: 'end', result: 'cancel' }], flows: [{ id: 'tf', from: 'ts', to: 'cancel' }] },
    { id: 'e', type: 'end' },
  ],
  flows: [{ id: 'f0', from: 's', to: 'u' }, { id: 'f1', from: 'u', to: 'e' }],
};
const xml = serializeProcess(fromEngine(engine));
const back = toEngine(parseBpmn(xml));
const node = (id) => back.nodes.find((n) => n.id === id);

test('jBPM-native elements are written where jBPM has a field for the property', () => {
  assert.match(xml, /drools:version="2.1"/); assert.match(xml, /drools:adHoc="true"/);
  assert.match(xml, /<drools:metaData name="customSLADueDate"><drools:metaValue><!\[CDATA\[2d\]\]>/);
  assert.match(xml, /<drools:metaData name="customDescription"><drools:metaValue><!\[CDATA\[Claim #\{claimId\}\]\]>/);
  assert.match(xml, /<bpmn2:property id="claimId"[^>]*><bpmn2:extensionElements><drools:metaData name="customTags"><drools:metaValue><!\[CDATA\[required\]\]>/);
  assert.match(xml, /customTags"><drools:metaValue><!\[CDATA\[readonly,restricted\]\]>/);
  assert.match(xml, /name="ActorId"/); assert.match(xml, /<bpmn2:from [^>]*><!\[CDATA\[dan,zed\]\]>/);
  for (const n of ['BusinessAdministratorGroupId', 'TaskStakeholderId', 'ExcludedOwnerId', 'Comment', 'Content', 'Locale', 'CreatedBy', 'suspendUntil', 'Priority', 'NotStartedReassign', 'NotCompletedNotify']) assert.match(xml, new RegExp(`name="${n}"`), n);
  assert.match(xml, /<bpmn2:timeCycle [^>]*language="cron"[^>]*>0 9 \* \* MON-FRI</);
  assert.match(xml, /<bpmn2:completionCondition [^>]*><!\[CDATA\[completed >= 2\]\]>/);
  assert.match(xml, /drools:abortParent="true"/);
});

test('the engine process survives engine -> BPMN -> engine (process properties and variable tags)', () => {
  assert.strictEqual(back.version, '2.1'); assert.strictEqual(back.adHoc, true); assert.strictEqual(back.slaDueDate, '2d'); assert.strictEqual(back.description, 'Claim #{claimId}');
  assert.deepStrictEqual(back.vars.find((v) => v.name === 'claimId').tags, ['required']);
  assert.deepStrictEqual(back.vars.find((v) => v.name === 'amount').tags, ['readonly', 'restricted']);
  assert.strictEqual(back.vars.find((v) => v.name === 'free').tags, undefined);
});

test('a user task keeps every owner, field and deadline', () => {
  const u = node('u');
  assert.strictEqual(u.group, 'claims'); assert.deepStrictEqual(u.groups, ['audit']); assert.deepStrictEqual(u.actors, ['dan', 'zed']);
  assert.strictEqual(u.businessAdmin, 'boss'); assert.deepStrictEqual(u.businessAdminGroups, ['managers']); assert.deepStrictEqual(u.stakeholders, ['cat']); assert.deepStrictEqual(u.excludedOwners, ['eve']);
  assert.deepStrictEqual([u.comment, u.content, u.locale, u.createdBy, u.suspendUntil, u.description, u.priority], ['Please review', 'see file', 'en-GB', 'bot', 'PT1H', 'Review the claim', 7]);
  assert.strictEqual(u.notStartedReassign, '[users:john]@[4h]'); assert.strictEqual(u.notCompletedNotify, '[tousers:a]@[1d]');
  assert.strictEqual(u.assignmentStrategy, 'leastLoaded'); assert.strictEqual(u.swimlane, 'uw'); assert.strictEqual(u.autoClaim, true);
  assert.deepStrictEqual(u.metaData, { team: 'claims' }); assert.strictEqual(u.slaDueDate, '1d'); assert.strictEqual(u.async, true);
});

test('timers, call failure policy, for-each completion, multi-instance tasks and gateways round-trip', () => {
  assert.deepStrictEqual(node('c').event.timer, { cron: '0 9 * * MON-FRI' });
  assert.strictEqual(node('call').onChildFailure, 'abort'); assert.strictEqual(node('call2').onChildFailure, 'continue'); assert.strictEqual(node('call2').errorVar, 'why');
  assert.strictEqual(node('fe').completionCondition, 'completed >= 2');
  assert.deepStrictEqual(node('mi').multiInstance, { over: 'items', as: 'item', parallel: true, collectInto: 'out', itemResult: 'r' });
  assert.strictEqual(node('gw').instantiate, true); assert.strictEqual(node('gw').mode, 'event');
  assert.strictEqual(node('cx').mode, 'complex'); assert.strictEqual(node('cx').activationCondition, 'arrived >= 2');
});

test('event, ad-hoc and transaction sub-processes and the cancel end round-trip', () => {
  assert.deepStrictEqual(node('ev').on, { signal: 'ALERT' }); assert.strictEqual(node('ev').interrupting, false);
  assert.strictEqual(node('ah').adHoc, true); assert.strictEqual(node('ah').completionCondition, 'completed >= 3'); assert.strictEqual(node('ah').nodes[0].autoStart, true);
  assert.strictEqual(node('tx').transaction, true);
  assert.strictEqual(node('tx').nodes.find((n) => n.id === 'cancel').result, 'cancel');
});

test('importing a plain jBPM process (no engine extras) still works and adds nothing', () => {
  const plain = { id: 'p', name: 'P', package: 'x', vars: [{ name: 'a', type: 'String' }], nodes: [{ id: 's', type: 'start' }, { id: 't', type: 'script', lang: 'js', code: 'x=1' }, { id: 'e', type: 'end' }], flows: [{ id: 'f1', from: 's', to: 't' }, { id: 'f2', from: 't', to: 'e' }] };
  const out = toEngine(parseBpmn(serializeProcess(fromEngine(plain))));
  assert.strictEqual(out.version, undefined); assert.strictEqual(out.adHoc, undefined); assert.strictEqual(out.slaDueDate, undefined);
  assert.strictEqual(out.nodes.find((n) => n.id === 't').metaData, undefined);
  assert.ok(!/engine\.extras/.test(serializeProcess(fromEngine(plain))), 'no extras entry unless something needs it');
});

test('potentialOwner / businessAdministrator in jBPM BPMN become ActorId / BusinessAdministratorId and survive a round trip', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:drools="http://www.jboss.org/drools" id="d" targetNamespace="http://www.omg.org/bpmn20">
<bpmn2:process id="p" drools:packageName="x" name="p" isExecutable="true">
<bpmn2:startEvent id="s"><bpmn2:outgoing>f0</bpmn2:outgoing></bpmn2:startEvent>
<bpmn2:userTask id="u" name="Review"><bpmn2:incoming>f0</bpmn2:incoming><bpmn2:outgoing>f1</bpmn2:outgoing>
<bpmn2:potentialOwner><bpmn2:resourceAssignmentExpression><bpmn2:formalExpression>krisv, Reviewers</bpmn2:formalExpression></bpmn2:resourceAssignmentExpression></bpmn2:potentialOwner>
<bpmn2:businessAdministrator><bpmn2:resourceAssignmentExpression><bpmn2:formalExpression>boss</bpmn2:formalExpression></bpmn2:resourceAssignmentExpression></bpmn2:businessAdministrator></bpmn2:userTask>
<bpmn2:endEvent id="e"><bpmn2:incoming>f1</bpmn2:incoming></bpmn2:endEvent>
<bpmn2:sequenceFlow id="f0" sourceRef="s" targetRef="u"/><bpmn2:sequenceFlow id="f1" sourceRef="u" targetRef="e"/></bpmn2:process></bpmn2:definitions>`;
  const eng = toEngine(parseBpmn(xml));
  const u = eng.nodes.find((n) => n.id === 'u');
  assert.deepStrictEqual(u.actors, ['krisv', 'Reviewers']);
  assert.strictEqual(u.businessAdmin, 'boss');
  const again = toEngine(parseBpmn(serializeProcess(fromEngine(eng))));
  const u2 = again.nodes.find((n) => n.id === 'u');
  assert.deepStrictEqual(u2.actors, ['krisv', 'Reviewers']);
  assert.strictEqual(u2.businessAdmin, 'boss');
});
