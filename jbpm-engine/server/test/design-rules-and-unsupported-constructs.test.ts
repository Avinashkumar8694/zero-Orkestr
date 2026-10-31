// Tests for BPMN / Engine Design Rules: Ensuring whatever is not supported
// cannot be validated, published, or deployed, and surfaces clear recommendations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ValidationService } from '../src/modules/validation/service.ts';
import { NODE_DEF_BY_TYPE } from '../src/engine/nodes/index.ts';
import type { EngineProject, EngineProcess } from '../src/sdk/index.ts';

const valService = new ValidationService();

test('Design Rule: Unsupported node constructs are strictly rejected with recommendation', async () => {
  const invalidProcess: EngineProcess = {
    id: 'unsupported.proc',
    name: 'Unsupported Construct Process',
    package: 'com.acme',
    vars: [],
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'unsupp1', type: 'raw', name: 'Raw jBPM Blob' },
      { id: 'unsupp2', type: 'adHocSubProcess', name: 'Ad-hoc Subprocess' },
      { id: 'end', type: 'end' },
    ],
    flows: [
      { id: 'f1', from: 'start', to: 'unsupp1' },
      { id: 'f2', from: 'unsupp1', to: 'unsupp2' },
      { id: 'f3', from: 'unsupp2', to: 'end' },
    ],
  };

  const project: EngineProject = { id: 'test_unsupported', name: 'Unsupported', processes: [invalidProcess] };
  const report = await valService.validateProject(project);

  assert.equal(report.ok, false);
  const unsuppErrors = report.errors.filter((e) => e.rule === 'unsupported-construct');
  assert.equal(unsuppErrors.length, 2, 'both raw and adHocSubProcess caught');

  // Verify actionable recommendation is attached
  assert.ok(unsuppErrors[0].remedy?.includes('Replace this unsupported construct'));
  assert.ok(unsuppErrors[1].remedy?.includes('standard BPMN 2.0 Task, Gateway, or Sub-process'));

  // Verify assertValidProject throws validation failure with VALIDATION_FAILED code
  await assert.rejects(
    async () => valService.assertValidProject(project, 'deploy'),
    (err: any) => err.code === 'VALIDATION_FAILED' && err.message.includes('Cannot deploy')
  );
});

test('Design Rule: Flow direction enforcement (No flow into Start, No flow out of End)', async () => {
  const backwardsProcess: EngineProcess = {
    id: 'direction.proc',
    name: 'Backwards Process',
    package: 'com.acme',
    vars: [],
    nodes: [
      { id: 's', type: 'start' },
      { id: 't', type: 'manual' },
      { id: 'e', type: 'end' },
    ],
    flows: [
      { id: 'f1', from: 's', to: 't' },
      { id: 'f2', from: 't', to: 'e' },
      { id: 'f_bad_end', from: 'e', to: 't' },   // ILLEGAL: outgoing from End
      { id: 'f_bad_start', from: 't', to: 's' }, // ILLEGAL: incoming to Start
    ],
  };

  const report = await valService.validateProject({ id: 'proj', name: 'Proj', processes: [backwardsProcess] });
  assert.equal(report.ok, false);
  const dirErrors = report.errors.filter((e) => e.rule === 'flow-direction' || e.rule === 'start-connections' || e.rule === 'end-connections');
  assert.ok(dirErrors.length >= 2);
  assert.ok(dirErrors.some((e) => e.message.includes('has no outgoing connection point') || e.message.includes('must not have outgoing connections')));
  assert.ok(dirErrors.some((e) => e.message.includes('has no incoming connection point') || e.message.includes('must not have incoming connections')));
});

test('Design Rule: Connection cardinality requires gateways for branching and merging', async () => {
  const invalidBranchingProcess: EngineProcess = {
    id: 'cardinality.proc',
    name: 'Cardinality Breach Process',
    package: 'com.acme',
    vars: [],
    nodes: [
      { id: 's', type: 'start' },
      { id: 'task1', type: 'script', code: 'kcontext.setVariable("x", 1);' },
      { id: 'task2', type: 'manual' },
      { id: 'task3', type: 'manual' },
      { id: 'e', type: 'end' },
    ],
    flows: [
      { id: 'f1', from: 's', to: 'task1' },
      // ILLEGAL: standard task branching directly into multiple sequence flows without a gateway
      { id: 'f2a', from: 'task1', to: 'task2' },
      { id: 'f2b', from: 'task1', to: 'task3' },
      { id: 'f3a', from: 'task2', to: 'e' },
      { id: 'f3b', from: 'task3', to: 'e' },
    ],
  };

  const report = await valService.validateProject({ id: 'proj', name: 'Proj', processes: [invalidBranchingProcess] });
  assert.equal(report.ok, false);
  const cardErrors = report.errors.filter((e) => e.rule === 'connection-cardinality');
  assert.ok(cardErrors.length > 0);
  assert.ok(cardErrors[0].message.includes('allows at most 1 outgoing connection'));
  assert.ok(cardErrors[0].remedy?.includes('Use diverging Gateways'));
});

test('Design Rule: Floating or disconnected island nodes are blocked', async () => {
  const islandProcess: EngineProcess = {
    id: 'island.proc',
    name: 'Island Process',
    package: 'com.acme',
    vars: [],
    nodes: [
      { id: 's', type: 'start' },
      { id: 'e', type: 'end' },
      { id: 'floating_task', type: 'manual', name: 'Floating Island' },
    ],
    flows: [
      { id: 'f1', from: 's', to: 'e' },
    ],
  };

  const report = await valService.validateProject({ id: 'proj', name: 'Proj', processes: [islandProcess] });
  assert.equal(report.ok, false);
  const connErrors = report.errors.filter((e) => e.rule === 'node-connected');
  assert.equal(connErrors.length, 1);
  assert.ok(connErrors[0].message.includes('Floating Island'));
  assert.ok(connErrors[0].remedy?.includes('Connect this floating activity'));
});

test('Design Rule: Valid palette nodes all pass validation and compile cleanly', async () => {
  const cleanProcess: EngineProcess = {
    id: 'clean.proc',
    name: 'Clean Process',
    package: 'com.acme',
    vars: [{ name: 'flag', type: 'boolean' }],
    nodes: [
      { id: 'start', type: 'start' },
      { id: 'script', type: 'script', code: 'kcontext.setVariable("flag", true);' },
      { id: 'gw', type: 'gateway', mode: 'exclusive', default: 'f_default' },
      { id: 'manual', type: 'manual' },
      { id: 'end', type: 'end' },
    ],
    flows: [
      { id: 'f1', from: 'start', to: 'script' },
      { id: 'f2', from: 'script', to: 'gw' },
      { id: 'f_default', from: 'gw', to: 'manual' },
      { id: 'f3', from: 'manual', to: 'end' },
    ],
  };

  const report = await valService.validateProject({ id: 'proj', name: 'Proj', processes: [cleanProcess] });
  assert.equal(report.ok, true);
  assert.equal(report.errors.length, 0);
});
