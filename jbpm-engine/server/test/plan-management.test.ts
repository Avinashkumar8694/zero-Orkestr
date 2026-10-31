// Plan management (modelled on payment-ms): create / edit / delete, status (active · disabled · coming soon · hidden), the default plan,
// the workspace-side catalogue and self-service plan selection, and the public pricing list.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { boot, tokenFor } from './harness.ts';
import { config } from '../src/infra/config.ts';
import { Collections, type TenantMember } from '../src/domain.ts';

const h = await boot();
after(() => h.close());
// the platform administrator for these tests: a REAL local account holding the bootstrap `system_admin` seat (the dev-only
// PLATFORM_ADMIN_ALLOW_LOCAL path); SSO itself is covered by platform-limits.test.ts
await h.store.repo<TenantMember>(Collections.tenantMembers).put({ id: 'm-plat', tenantId: config.defaultTenant, userId: 'plat-sa', email: 'plat-sa@local', role: 'system_admin', status: 'active', joinedAt: new Date().toISOString() });
const ROOT = tokenFor('plat-sa');
const admin = (m: string, p: string, body?: unknown) => h.call(m, `/platform${p}`, { token: ROOT, body });
const a = await h.workspace('pm-a', ['viewer'], 'trial');
const owner = { token: a.tokens.owner, tenant: a.id };
const plan = async (key: string) => (await admin('GET', '/plans')).body.data.plans.find((p: any) => p.key === key);

test('PM-01 create: validation, hidden by default, unique key; list shows status, default, workspace counts', async () => {
  assert.strictEqual((await admin('POST', '/plans', { key: 'Bad Key', name: 'x' })).status, 422);
  assert.strictEqual((await admin('POST', '/plans', { key: 'growth', name: 'G' })).status, 422, 'name 2+ chars');
  assert.strictEqual((await admin('POST', '/plans', { key: 'growth', name: 'Growth', status: 'nope' })).status, 422);
  assert.strictEqual((await admin('POST', '/plans', { key: 'growth', name: 'Growth', trialDays: 0 })).status, 422);
  assert.strictEqual((await admin('POST', '/plans', { key: 'growth', name: 'Growth', limits: { bogus: 1 } })).status, 422);
  const ok = await admin('POST', '/plans', { key: 'growth', name: 'Growth', description: 'For teams', features: ['SSO', 'Priority support'], limits: { maxWorkflows: 25 }, sortOrder: 5 });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.body.data.status, 'hidden', 'a new plan is invisible until published');
  assert.strictEqual(ok.body.data.limits.maxWorkflows, 25);
  assert.strictEqual((await admin('POST', '/plans', { key: 'growth', name: 'Again' })).status, 409, 'unique key');
  assert.strictEqual((await admin('POST', '/plans', { key: 'starter', name: 'Starter again' })).status, 409, 'built-in keys are taken too');
  const p = await plan('growth'); assert.ok(p.stored); assert.strictEqual(p.workspaces, 0); assert.strictEqual(p.isDefault, false);
});

test('PM-02 status controls who sees and who can select the plan', async () => {
  const catalogue = async () => (await h.call('GET', '/plan/options', owner)).body.items as any[];
  const pub = async () => ((await h.call('GET', '/public/plans')).body.data as any[]).map((x) => x.key);
  assert.ok(!(await catalogue()).some((p) => p.key === 'growth'), 'hidden: not offered to the workspace');
  assert.ok(!(await pub()).includes('growth'), 'hidden: not on the public pricing page');
  await admin('PUT', '/plans/growth', { status: 'upcoming' });
  assert.deepStrictEqual((await catalogue()).find((p) => p.key === 'growth').selectable, false);
  assert.strictEqual((await catalogue()).find((p) => p.key === 'growth').status, 'upcoming');
  assert.ok((await pub()).includes('growth'), 'coming soon is listed publicly');
  assert.strictEqual((await h.call('PUT', '/plan', { ...owner, body: { planKey: 'growth' } })).status, 409, 'cannot select a coming-soon plan');
  await admin('PUT', '/plans/growth', { status: 'disabled' });
  assert.strictEqual((await h.call('PUT', '/plan', { ...owner, body: { planKey: 'growth' } })).status, 409, 'cannot select a disabled plan');
  await admin('PUT', '/plans/growth', { status: 'active' });
  assert.strictEqual((await catalogue()).find((p) => p.key === 'growth').selectable, true);
  assert.strictEqual((await admin('PUT', '/plans/growth', { status: 'active', name: '<b>x</b>' })).status, 422, 'no markup in names');
});

test('PM-03 a workspace selects an active plan itself — owner/admin only, refused while over the new plan\'s limits', async () => {
  assert.strictEqual((await h.call('PUT', '/plan', { token: a.tokens.viewer, tenant: a.id, body: { planKey: 'growth' } })).status, 403, 'viewers cannot change the plan');
  // two workflows exist → a plan allowing only 1 is refused, naming what to reduce
  await h.call('POST', '/workflows', { ...owner, body: { name: 'one' } }); await h.call('POST', '/workflows', { ...owner, body: { name: 'two' } });
  await admin('POST', '/plans', { key: 'tiny', name: 'Tiny', status: 'active', limits: { maxWorkflows: 1 } });
  const refused = await h.call('PUT', '/plan', { ...owner, body: { planKey: 'tiny' } });
  assert.strictEqual(refused.status, 409); assert.match(refused.body.error.message, /Workflows: you have 2, "Tiny" allows 1/);
  const ok = await h.call('PUT', '/plan', { ...owner, body: { planKey: 'growth' } });
  assert.strictEqual(ok.status, 200); assert.strictEqual(ok.body.data.plan, 'growth');
  assert.strictEqual((await h.call('PUT', '/plan', { ...owner, body: { planKey: 'growth' } })).status, 409, 'already on it');
  assert.strictEqual((await h.call('PUT', '/plan', { ...owner, body: { planKey: 'does-not-exist' } })).status, 404);
  assert.strictEqual((await plan('growth')).workspaces, 1);
});

test('PM-04 "contact us" plans cannot be self-selected; the default plan rules', async () => {
  await admin('POST', '/plans', { key: 'bespoke', name: 'Bespoke', status: 'active', isCustom: true, contactConfig: { type: 'email', value: 'sales@example.com', label: 'Talk to sales' } });
  assert.strictEqual((await h.call('PUT', '/plan', { ...owner, body: { planKey: 'bespoke' } })).status, 409);
  assert.strictEqual((await admin('PUT', '/plans/bespoke', { contactConfig: { type: 'email', value: 'not-an-email' } })).status, 422);
  assert.strictEqual((await admin('PUT', '/plans/bespoke', { trialDays: 14 })).status, 422, 'a contact-us plan has no trial');
  assert.strictEqual((await admin('PUT', '/plans/bespoke', { isDefault: true })).status, 422, 'a contact-us plan cannot be the default');
  assert.strictEqual((await admin('PUT', '/plans/tiny', { status: 'hidden', isDefault: true })).status, 422, 'the default plan must be active');
  assert.strictEqual((await admin('PUT', '/plans/tiny', { isDefault: true })).status, 200);
  assert.strictEqual((await plan('tiny')).isDefault, true);
  assert.strictEqual((await plan('trial')).isDefault, false, 'exactly one default');
  assert.strictEqual((await admin('PUT', '/plans/tiny', { isDefault: false })).status, 422, 'make another plan the default instead');
  // a new workspace starts on the default plan, with that plan's trial
  const t = await h.tenants.signup({ name: 'Starts On Default', slug: 'starts-on-default', ownerEmail: 'sod@example.com' });
  assert.strictEqual(t.plan, 'tiny');
  await admin('PUT', '/plans/tiny', { status: 'active', trialDays: 10 });
  const t2 = await h.tenants.signup({ name: 'Trial Days', slug: 'trial-days', ownerEmail: 'td@example.com' });
  assert.ok(t2.planExpiresAt && Math.abs(Date.parse(t2.planExpiresAt) - Date.now() - 10 * 86_400_000) < 120_000, 'the trial length is the plan\'s own');
  await admin('PUT', '/plans/trial', { isDefault: true });   // restore for later tests
});

test('PM-05 delete: not the default, not while workspaces are on it; built-in plans can be deleted too', async () => {
  assert.strictEqual((await admin('DELETE', '/plans/trial')).status, 409, 'the default plan');
  assert.strictEqual((await admin('DELETE', '/plans/growth')).status, 409, 'a workspace is on it');
  assert.match((await admin('DELETE', '/plans/growth')).body.error.message, /1 workspace\(s\) are on this plan/);
  assert.strictEqual((await admin('DELETE', '/plans/bespoke')).status, 204);
  assert.ok(!(await plan('bespoke')));
  assert.strictEqual((await admin('DELETE', '/plans/bespoke')).status, 404);
  assert.strictEqual((await admin('DELETE', '/plans/pro')).status, 204, 'a built-in plan nobody is on');
  assert.ok(!(await plan('pro')), 'and it is gone from the catalogue');
  assert.strictEqual((await admin('POST', '/plans', { key: 'pro', name: 'Pro again' })).status, 201, 'its key can be reused');
});

test('PM-06 only the platform administrator manages plans', async () => {
  for (const [m, p, b] of [['POST', '/plans', { key: 'x1', name: 'X1' }], ['PUT', '/plans/growth', { name: 'Renamed' }], ['DELETE', '/plans/growth']] as const) {
    assert.strictEqual((await h.call(m, `/platform${p}`, { ...owner, body: b })).status, 403, `${m} ${p} as workspace owner`);
    assert.strictEqual((await h.call(m, `/platform${p}`, { body: b })).status, 401);
  }
});

test('PM-07 the dev-only local platform admin is tightly scoped', async () => {
  // a token that merely CARRIES the platform e-mail is not enough, nor is a seat that is not system_admin
  const carry = tokenFor(config.platformAdminEmail);
  assert.strictEqual((await h.call('GET', '/platform/plans', { token: carry })).status, 403, 'a local token with the platform e-mail');
  await h.store.repo<TenantMember>(Collections.tenantMembers).put({ id: 'm-adm', tenantId: config.defaultTenant, userId: 'plain-admin', email: 'pa@local', role: 'admin', status: 'active', joinedAt: new Date().toISOString() });
  assert.strictEqual((await h.call('GET', '/platform/plans', { token: tokenFor('plain-admin') })).status, 403, 'an admin seat is not a system_admin seat');
  assert.strictEqual((await h.call('GET', '/platform/plans', { token: ROOT })).status, 200);
  const profile = await h.call('GET', '/me/profile', { token: ROOT, tenant: config.defaultTenant });
  assert.strictEqual(profile.body.data.platformAdmin, true, 'the UI is told by the server');
  const ownerProfile = await h.call('GET', '/me/profile', owner);
  assert.strictEqual(ownerProfile.body.data.platformAdmin, false);
});
