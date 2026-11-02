import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeProject, parseProject } from '../dist/index.mjs';

test('from-scratch project generates project.imports and project.repositories', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-'));
  writeProject({ root: out, descriptor: { gav: { groupId: 'a', artifactId: 'b', version: '1' } }, processes: [] }, out);
  const imp = fs.readFileSync(path.join(out, 'project.imports'), 'utf8');
  const rep = fs.readFileSync(path.join(out, 'project.repositories'), 'utf8');
  assert.ok(imp.includes('<type>java.util.List</type>'), 'imports has default types');
  assert.ok(rep.includes('repo.maven.apache.org'), 'repositories has central');
  assert.ok(rep.includes('redhat.com/ga'), 'repositories has redhat-ga');
  fs.rmSync(out, { recursive: true, force: true });
});

test('existing project.imports/repositories are round-tripped verbatim (not overwritten)', () => {
  const PROJECT = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'prudential-project');
  const p = parseProject(PROJECT);
  const origImports = p.descriptor.files['project.imports'];
  const origRepos = p.descriptor.files['project.repositories'];
  assert.ok(origImports && origRepos, 'captured from the real project');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bc2-'));
  writeProject(p, out);
  assert.strictEqual(fs.readFileSync(path.join(out, 'project.imports'), 'utf8'), origImports, 'imports verbatim');
  assert.strictEqual(fs.readFileSync(path.join(out, 'project.repositories'), 'utf8'), origRepos, 'repositories verbatim');
  fs.rmSync(out, { recursive: true, force: true });
});
