// jBPM designer extras (<drools:metaData name="customAsync|customSLADueDate|customAutoStart|…">) survive engine -> BPMN -> engine.
import { test } from 'node:test';
import assert from 'node:assert';
import { fromEngine, toEngine, serializeProcess, parseBpmn } from '../dist/index.mjs';

const engine = {
  id: 'p.process', name: 'P', package: 'com.acme', vars: [],
  nodes: [
    { id: 's', type: 'start' },
    { id: 'u', type: 'userTask', name: 'Review', group: 'g', async: true, slaDueDate: '2h', asyncRetries: 5, asyncRetryDelay: 'PT30S' },
    { id: 'e', type: 'end' },
  ],
  flows: [{ id: 'f1', from: 's', to: 'u' }, { id: 'f2', from: 'u', to: 'e' }],
};

test('Is Async and SLA Due Date are written as the jBPM metaData entries', () => {
  const xml = serializeProcess(fromEngine(engine));
  assert.match(xml, /<drools:metaData name="customAsync"><drools:metaValue><!\[CDATA\[true\]\]><\/drools:metaValue>/);
  assert.match(xml, /<drools:metaData name="customSLADueDate"><drools:metaValue><!\[CDATA\[2h\]\]>/);
  assert.match(xml, /<drools:metaData name="elementname">/, 'the node name is still written');
});

test('they round-trip: BPMN -> model -> engine keeps async, SLA and the engine-only retry settings', () => {
  const back = toEngine(parseBpmn(serializeProcess(fromEngine(engine))));
  const u = back.nodes.find((n) => n.id === 'u');
  assert.strictEqual(u.async, true); assert.strictEqual(u.slaDueDate, '2h');
  assert.strictEqual(u.asyncRetries, 5); assert.strictEqual(u.asyncRetryDelay, 'PT30S');
  assert.strictEqual(u.name, 'Review');
});

test('unknown metaData (customTags, customAutoStart, vendor keys) is preserved, not dropped', () => {
  const model = fromEngine(engine);
  const node = model.nodes.find((n) => n.id === 'u');
  node.autoStart = true; node.metaData = { ...(node.metaData || {}), customTags: 'a,b', vendorKey: 'x' };
  const parsed = parseBpmn(serializeProcess(model));
  const p = parsed.nodes.find((n) => n.id === 'u');
  assert.strictEqual(p.autoStart, true); assert.strictEqual(p.metaData.customTags, 'a,b'); assert.strictEqual(p.metaData.vendorKey, 'x');
  assert.strictEqual(p.async, true);
});
