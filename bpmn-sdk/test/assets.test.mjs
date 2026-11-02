import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProject, writeProject, parseWid, widMvel } from '../dist/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, 'fixtures', 'prudential-project');   // a real Business Central project kept as a fixture

test('real project: form (.frm) and .wid are captured into descriptor.files', () => {
  const p = parseProject(PROJECT);
  const files = p.descriptor.files || {};
  const frm = Object.keys(files).find((f) => f.endsWith('.frm'));
  assert.ok(frm, 'the .frm form file is captured');
  assert.ok(files['global/WorkDefinitions.wid'], '.wid captured');
});

test('parseWid extracts the standard work items from the real .wid', () => {
  const p = parseProject(PROJECT);
  const defs = p.descriptor.workDefinitions || [];
  const names = defs.map((d) => d.name).sort();
  for (const n of ['BusinessRuleTask', 'DecisionTask', 'Email', 'Log', 'Milestone', 'Rest', 'WebService'])
    assert.ok(names.includes(n), `missing work item ${n}`);
  const rest = defs.find((d) => d.name === 'Rest');
  assert.ok(rest && rest.parameters && Object.keys(rest.parameters).length > 0, 'Rest params parsed');
});

test('synthetic project with rules/java/forms round-trips those assets verbatim', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmsrc-'));
  const drl = 'package a;\nrule "r" ruleflow-group "g" when then end\n';
  const java = 'package a;\npublic class H {}\n';
  const frm = '<form id="f"/>\n';
  fs.mkdirSync(path.join(src, 'src/main/resources/a'), { recursive: true });
  fs.mkdirSync(path.join(src, 'src/main/java/a'), { recursive: true });
  fs.writeFileSync(path.join(src, 'src/main/resources/a/rules.drl'), drl);
  fs.writeFileSync(path.join(src, 'src/main/java/a/H.java'), java);
  fs.writeFileSync(path.join(src, 'src/main/resources/task.frm'), frm);
  // minimal process so parseProject has something
  fs.mkdirSync(path.join(src, 'src/main/resources/org/jbpm'), { recursive: true });
  fs.writeFileSync(path.join(src, 'src/main/resources/org/jbpm/p.bpmn'),
    '<?xml version="1.0"?><bpmn2:definitions xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL"><bpmn2:process id="p" name="p"><bpmn2:startEvent id="_s"/></bpmn2:process></bpmn2:definitions>');

  const proj = parseProject(src);
  const files = proj.descriptor.files || {};
  assert.ok(files['src/main/resources/a/rules.drl'] === drl, 'drl captured');
  assert.ok(files['src/main/java/a/H.java'] === java, 'java captured');
  assert.ok(files['src/main/resources/task.frm'] === frm, 'frm captured');

  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmout-'));
  writeProject(proj, out);
  assert.strictEqual(fs.readFileSync(path.join(out, 'src/main/resources/a/rules.drl'), 'utf8'), drl, 'drl reproduced');
  assert.strictEqual(fs.readFileSync(path.join(out, 'src/main/java/a/H.java'), 'utf8'), java, 'java reproduced');
  assert.strictEqual(fs.readFileSync(path.join(out, 'src/main/resources/task.frm'), 'utf8'), frm, 'frm reproduced');
  fs.rmSync(src, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
});

test('.wid generated from a JSON work-item-definition model, then re-parsed', () => {
  const defs = [{ name: 'MyTask', displayName: 'My Task', category: 'Custom',
    defaultHandler: 'mvel: new com.acme.H()', parameters: { input: 'StringDataType' }, results: { output: 'StringDataType' } }];
  const wid = widMvel(defs);
  assert.ok(wid.includes('"name" : "MyTask"'));
  assert.ok(wid.includes('"input" : new StringDataType()'));
  const back = parseWid(wid);
  assert.strictEqual(back[0].name, 'MyTask');
  assert.strictEqual(back[0].parameters.input, 'StringDataType');
  assert.strictEqual(back[0].results.output, 'StringDataType');
});

test('from-scratch project generates a .wid from descriptor.workDefinitions', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmwid-'));
  writeProject({
    root: out,
    descriptor: { gav: { groupId: 'a', artifactId: 'b', version: '1' },
      workDefinitions: [{ name: 'Zed', parameters: { x: 'StringDataType' } }] },
    processes: [],
  }, out);
  const wid = fs.readFileSync(path.join(out, 'global/WorkDefinitions.wid'), 'utf8');
  assert.ok(wid.includes('"name" : "Zed"'), 'generated .wid contains the definition');
  fs.rmSync(out, { recursive: true, force: true });
});
