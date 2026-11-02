import { test } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProject, parseBpmn, serializeProcess, validateModel } from '../dist/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, 'fixtures', 'prudential-project');   // a real Business Central project kept as a fixture

test('parses the BPM project', () => {
  const project = parseProject(PROJECT);
  assert.ok(project.processes.length >= 4, `expected >=4 processes, got ${project.processes.length}`);
});

test('every process round-trips (parse -> serialize -> parse) with equal structure', () => {
  const project = parseProject(PROJECT);
  for (const m of project.processes) {
    const m2 = parseBpmn(serializeProcess(m));
    assert.strictEqual(m2.id, m.id, `id ${m.id}`);
    assert.deepStrictEqual(m2.nodes.map((n) => n.id).sort(), m.nodes.map((n) => n.id).sort(), `node ids ${m.id}`);
    assert.deepStrictEqual(m2.flows.map((f) => f.id).sort(), m.flows.map((f) => f.id).sort(), `flow ids ${m.id}`);
    assert.deepStrictEqual(m2.variables.map((v) => v.name).sort(), m.variables.map((v) => v.name).sort(), `vars ${m.id}`);
    const key = (f) => `${f.id}:${f.sourceRef}->${f.targetRef}`;
    assert.deepStrictEqual(m2.flows.map(key).sort(), m.flows.map(key).sort(), `flow endpoints ${m.id}`);
    assert.ok(validateModel(m2).ok, `validate ${m.id}: ${validateModel(m2).errors.join('; ')}`);
  }
});

test('serialized XML is non-trivial and declares the process', () => {
  const project = parseProject(PROJECT);
  for (const m of project.processes) {
    const xml = serializeProcess(m);
    assert.ok(xml.includes(`<bpmn2:process id="${m.id}"`), `process decl ${m.id}`);
    assert.ok(xml.length > 300);
  }
});
