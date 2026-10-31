// AssetsService: kind-specific `fields` payload merged onto each kind's seed() shape, scoped to keys
// the kind actually supports (its seed shape is the only schema that exists — see src/assets/types.ts).
import { test } from 'node:test';
import assert from 'node:assert';
import { MemoryStore } from '../src/store/memory-store.ts';
import { fakeClock } from '../src/infra/ids.ts';
import { makeContext } from '../src/context.ts';
import { Collections, type AuditEvent } from '../src/domain.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { AssetsService } from '../src/modules/assets/service.ts';

const newCtx = () => { let n = 0; return makeContext({ store: new MemoryStore(), tenantId: 't1', clock: fakeClock().clock, newId: () => `id${++n}` }); };

test('AssetsService.list reports each kind\'s nameField', async () => {
  const ctx = newCtx();
  const wf = await new WorkflowService(ctx).create({ name: 'Claims' }, 'a');
  const { kinds } = await new AssetsService(ctx).list(wf.id);
  const byKey = Object.fromEntries(kinds.map((k) => [k.key, k.nameField]));
  assert.strictEqual(byKey.forms, 'name');
  assert.strictEqual(byKey.rulesets, 'group');
  assert.strictEqual(byKey.scorecards, 'name');
});

test('AssetsService.add: a bare name still works (fields is optional)', async () => {
  const ctx = newCtx();
  const wf = await new WorkflowService(ctx).create({ name: 'Claims' }, 'a');
  const assets = new AssetsService(ctx);
  await assets.add(wf.id, 'messages', 'ClaimApproved', 'a');
  const { assets: byKind } = await assets.list(wf.id);
  assert.deepStrictEqual(byKind.messages.map((m) => m.name), ['ClaimApproved']);
});

test('AssetsService.add: kind-specific fields are merged onto the seed, scoped to that kind\'s own shape', async () => {
  const ctx = newCtx();
  const wf = await new WorkflowService(ctx).create({ name: 'Claims' }, 'a');
  const assets = new AssetsService(ctx);

  await assets.add(wf.id, 'forms', 'ClaimIntake', 'a', { model: { className: 'com.acme.ClaimIntake' } });
  await assets.add(wf.id, 'scorecards', 'RiskScore', 'a', { fact: 'Claim', baseline: '5', target: 'riskScore' });
  await assets.add(wf.id, 'rulesets', 'claim-triage', 'a'); // group IS the nameField — no extra fields needed

  const { engine } = await (assets as any).head(wf.id);
  assert.deepStrictEqual(engine.forms[0].model, { className: 'com.acme.ClaimIntake' });
  assert.strictEqual(engine.scorecards[0].fact, 'Claim');
  assert.strictEqual(engine.scorecards[0].baseline, 5, 'numeric seed fields are coerced from string input');
  assert.strictEqual(engine.scorecards[0].target, 'riskScore');
  assert.strictEqual(engine.rulesets[0].group, 'claim-triage');
});

test('AssetsService.add: fields cannot inject keys outside the kind\'s seed shape or overwrite the name field', async () => {
  const ctx = newCtx();
  const wf = await new WorkflowService(ctx).create({ name: 'Claims' }, 'a');
  const assets = new AssetsService(ctx);

  await assets.add(wf.id, 'messages', 'ClaimApproved', 'a', { name: 'Hijacked', evil: 'nope', __proto__: { polluted: true } } as any);
  const { engine } = await (assets as any).head(wf.id);
  assert.strictEqual(engine.messages[0].name, 'ClaimApproved', 'nameField itself is not overwritable via fields');
  assert.strictEqual(engine.messages[0].evil, undefined, 'keys not in the seed shape are dropped');
  assert.strictEqual(({} as any).polluted, undefined, 'no prototype pollution');
});

test('AssetsService.testAsset evaluates guided decision tables', async () => {
  const ctx = newCtx();
  const wf = await new WorkflowService(ctx).create({ name: 'Claims' }, 'a');
  const assets = new AssetsService(ctx);

  await assets.add(wf.id, 'guidedTables', 'DiscountTable', 'a', { fact: 'Claim' });
  const res: any = await assets.testAsset(wf.id, 'guidedTables', 'DiscountTable', { vars: { amount: 500 } });
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.outputs.approved, true);
  assert.strictEqual(res.outputs.discount, 0.1);
});

test('AssetsService.testAsset runs test scenarios against decisions', async () => {
  const ctx = newCtx();
  const wf = await new WorkflowService(ctx).create({ name: 'Claims' }, 'a');
  const assets = new AssetsService(ctx);

  await assets.add(wf.id, 'decisions', 'Eligibility', 'a');
  await assets.add(wf.id, 'tests', 'EligibilityTests', 'a', { target: 'Eligibility' });
  const res: any = await assets.testAsset(wf.id, 'tests', 'EligibilityTests', {});
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.total, 2);
  assert.strictEqual(res.passed, 2);
  assert.strictEqual(res.failed, 0);
});

test('AssetsService.testAsset validates form submission against form fields', async () => {
  const ctx = newCtx();
  const wf = await new WorkflowService(ctx).create({ name: 'Claims' }, 'a');
  const assets = new AssetsService(ctx);

  await assets.add(wf.id, 'forms', 'ClaimForm', 'a');
  const validRes: any = await assets.testAsset(wf.id, 'forms', 'ClaimForm', { submission: { amount: 100, description: 'Medical expense' } });
  assert.strictEqual(validRes.valid, true);
  assert.strictEqual(validRes.errors.length, 0);

  const invalidRes: any = await assets.testAsset(wf.id, 'forms', 'ClaimForm', { submission: { amount: '' } });
  assert.strictEqual(invalidRes.valid, false);
  assert.strictEqual(invalidRes.errors.length, 1);
});

test('AssetsService.duplicate: clones asset within project with new name', async () => {
  const ctx = newCtx();
  const wf = await new WorkflowService(ctx).create({ name: 'Claims' }, 'a');
  const assets = new AssetsService(ctx);

  await assets.add(wf.id, 'decisions', 'Eligibility', 'a');
  const dupRes = await assets.duplicate(wf.id, 'decisions', 'Eligibility', 'Eligibility_V2', 'a');
  assert.strictEqual(dupRes.kind, 'decisions');
  assert.strictEqual(dupRes.name, 'Eligibility_V2');

  const { assets: byKind } = await assets.list(wf.id);
  assert.strictEqual(byKind.decisions.length, 2);
  assert(byKind.decisions.some((d) => d.name === 'Eligibility'));
  assert(byKind.decisions.some((d) => d.name === 'Eligibility_V2'));

  // Verify DMN model content was properly cloned and namespace updated
  const original = await assets.get(wf.id, 'decisions', 'Eligibility');
  const cloned = await assets.get(wf.id, 'decisions', 'Eligibility_V2');
  assert.strictEqual(cloned.asset.name, 'Eligibility_V2');
  assert.strictEqual(cloned.asset.decisions[0].name, 'Eligibility_V2');
  assert.deepStrictEqual(cloned.asset.decisions[0].rules, original.asset.decisions[0].rules);
  assert(cloned.asset.namespace.includes('eligibility-v2'));
});

test('AssetsService.duplicate edge cases: rejects blank name, identical name, existing name, non-existent asset, and handles non-default nameField + deep clone', async () => {
  const ctx = newCtx();
  const wf = await new WorkflowService(ctx).create({ name: 'Claims' }, 'a');
  const assets = new AssetsService(ctx);

  await assets.add(wf.id, 'forms', 'ClaimForm', 'a');
  await assets.add(wf.id, 'rulesets', 'triage-rules', 'a');

  // 1. Rejects blank / whitespace name
  await assert.rejects(
    () => assets.duplicate(wf.id, 'forms', 'ClaimForm', '   ', 'a'),
    (err: any) => err.code === 'VALIDATION_FAILED' && err.message.includes('new asset name is required'),
  );

  // 2. Rejects identical name
  await assert.rejects(
    () => assets.duplicate(wf.id, 'forms', 'ClaimForm', 'ClaimForm', 'a'),
    (err: any) => err.code === 'VALIDATION_FAILED' && err.message.includes('must be different from current name'),
  );

  // 3. Rejects collision with existing asset name
  await assets.add(wf.id, 'forms', 'ExistingForm', 'a');
  await assert.rejects(
    () => assets.duplicate(wf.id, 'forms', 'ClaimForm', 'ExistingForm', 'a'),
    (err: any) => err.code === 'VALIDATION_FAILED' && err.message.includes('already exists'),
  );

  // 4. Rejects non-existent source asset
  await assert.rejects(
    () => assets.duplicate(wf.id, 'forms', 'NonExistent', 'NewForm', 'a'),
    (err: any) => err.code === 'NOT_FOUND',
  );

  // 5. Handles non-default nameField (e.g. rulesets uses 'group')
  const dupRuleset = await assets.duplicate(wf.id, 'rulesets', 'triage-rules', 'triage-rules-v2', 'a');
  assert.strictEqual(dupRuleset.name, 'triage-rules-v2');
  const clonedRuleset = await assets.get(wf.id, 'rulesets', 'triage-rules-v2');
  assert.strictEqual(clonedRuleset.asset.group, 'triage-rules-v2');

  // 6. Deep clone mutation isolation
  await assets.update(wf.id, 'rulesets', 'triage-rules-v2', { customMeta: 'mutated' }, 'a');
  const origRuleset = await assets.get(wf.id, 'rulesets', 'triage-rules');
  assert.strictEqual((origRuleset.asset as any).customMeta, undefined, 'original asset was not mutated');

  // 7. Audit log verification
  const auditEntries = await ctx.store.repo<AuditEvent>(Collections.audit).list();
  const dupAudit = auditEntries.find((e: any) => e.kind === 'asset.duplicated' && e.data?.name === 'triage-rules-v2');
  assert(dupAudit, 'audit log entry created for asset.duplicated');
  assert.strictEqual(dupAudit.data.source, 'triage-rules');
});
