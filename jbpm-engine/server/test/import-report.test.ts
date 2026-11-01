// Phase 4 (S08): an import never drops anything silently — what did not map is listed per process.
import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { buildImportReport, kjarToEngine } from '../src/modules/import/service.ts';

test('S08 report: raw constructs, unavailable work-item handlers, conditional starts, Java imports/globals, web-service tasks, Java scripts', () => {
  const engine = { id: 'proj', processes: [{ id: 'p1', name: 'P1', nodes: [
    { id: 's', type: 'start' }, { id: 'raw1', type: 'raw', name: 'Group box', raw: '<bpmn2:group id="g"/>' },
    { id: 'w1', type: 'workItem', name: 'Send mail', handler: 'Email' }, { id: 'w2', type: 'workItem', name: 'Legacy', handler: 'CustomLegacyHandler' },
    { id: 'j', type: 'script', name: 'Calc', lang: 'java', code: 'x' }, { id: 'cs', type: 'start', name: 'When rich', on: { condition: 'balance > 1' } },
    { id: 'sub', type: 'subprocess', name: 'Inner', nodes: [{ id: 'raw2', type: 'raw', name: 'Pool', raw: '<bpmn2:participant id="p"/>' }], flows: [] },
  ], flows: [] }] } as any;
  const files = { 'src/main/resources/p1.bpmn': '<bpmn2:definitions><bpmn2:process id="p1"><drools:import name="java.util.List"/><drools:global identifier="g" type="X"/><bpmn2:serviceTask id="a" implementation="##WebService"/></bpmn2:process></bpmn2:definitions>', 'readme.txt': 'ignored' };
  const r = buildImportReport(engine, files);
  const by = (code: string) => r.items.filter((i) => i.code === code);
  assert.strictEqual(by('unsupported-construct').length, 2, 'including the one nested in a sub-process');
  assert.match(by('unsupported-construct')[0]!.message, /\(group\) is not converted/);
  assert.strictEqual(by('work-item-handler').length, 1); assert.match(by('work-item-handler')[0]!.message, /"CustomLegacyHandler" is not available/);
  assert.strictEqual(by('conditional-start').length, 1); assert.strictEqual(by('java-script').length, 1);
  assert.match(by('java-imports')[0]!.message, /java\.util\.List/); assert.strictEqual(by('globals').length, 1); assert.strictEqual(by('service-task').length, 1);
  assert.deepStrictEqual(r.summary, { unsupported: 2, warnings: 3, info: 3 });
  assert.ok(r.items.every((i) => i.process));
});

test('S08 a clean engine project reports nothing; the real policy kjar reports only what it genuinely contains', () => {
  assert.deepStrictEqual(buildImportReport({ id: 'x', processes: [{ id: 'p', nodes: [{ id: 's', type: 'start' }, { id: 'e', type: 'end' }], flows: [] }] } as any).items, []);
  const dir = path.resolve(import.meta.dirname, '../../../extracted_projects/policy_system');
  if (!fs.existsSync(path.join(dir, 'pom.xml'))) return;                       // prepared by scripts/prepare-tests.sh
  const files: Record<string, string> = {};
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (/\.(bpmn2?|xml|properties|json|wid|drl|dmn|java|frm|form)$/i.test(e.name)) files[path.relative(dir, f)] = fs.readFileSync(f, 'utf8'); } };
  walk(dir);
  const r = buildImportReport(kjarToEngine(files), files);
  assert.strictEqual(r.summary.unsupported, 0, JSON.stringify(r.items.filter((i) => i.severity === 'unsupported')));
  assert.ok(r.items.every((i) => ['info', 'warning'].includes(i.severity)));
});
after(() => setTimeout(() => process.exit(0), 50).unref());
