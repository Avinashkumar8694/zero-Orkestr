import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProject, writeProject } from '../dist/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, 'fixtures', 'prudential-project');   // a real Business Central project kept as a fixture

test('captures kjar scaffolding (gav + deployment + files)', () => {
  const p = parseProject(PROJECT);
  assert.ok(p.descriptor, 'descriptor present');
  assert.ok(p.descriptor.gav, 'gav parsed');
  assert.strictEqual(p.descriptor.gav.packaging, 'kjar');
  assert.ok(p.descriptor.deployment, 'deployment parsed');
  const wih = p.descriptor.deployment.workItemHandlers || [];
  assert.ok(wih.some((h) => h.name === 'Rest'), 'Rest handler captured');
  const env = p.descriptor.deployment.environmentEntries || [];
  assert.ok(env.some((e) => e.name === 'INTEGRATION_LAYER_URL'), 'env entry captured');
});

test('writes a complete project (scaffolding + bpmn) to a temp dir', () => {
  const p = parseProject(PROJECT);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bpmproj-'));
  const written = writeProject(p, out);
  const has = (rel) => fs.existsSync(path.join(out, rel));
  assert.ok(has('pom.xml'), 'pom.xml written');
  assert.ok(has('src/main/resources/META-INF/kmodule.xml'), 'kmodule written');
  assert.ok(has('src/main/resources/META-INF/kie-deployment-descriptor.xml'), 'deployment written');
  assert.ok(written.some((f) => f.endsWith('.bpmn')), 'bpmn written');
  assert.ok(has('project.imports'), 'project.imports present');
  assert.ok(has('project.repositories'), 'project.repositories present');
  // deployment descriptor regenerated with the Rest handler
  const dd = fs.readFileSync(path.join(out, 'src/main/resources/META-INF/kie-deployment-descriptor.xml'), 'utf8');
  assert.ok(dd.includes('RESTWorkItemHandler'), 'Rest handler regenerated');
  fs.rmSync(out, { recursive: true, force: true });
});
