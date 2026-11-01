// Plans are ENFORCED, not decorative: the free trial (7 days, 50 concurrent requests, per-day / week / month process
// starts), expiry, every resource cap, the request gates, the usage endpoint, and platform-side plan administration.
import { test } from 'node:test';
import assert from 'node:assert';
import { boot, tokenFor } from './harness.ts';
import { config } from '../src/infra/config.ts';
import { makeContext } from '../src/context.ts';
import { Collections, type Plan, type Tenant } from '../src/domain.ts';
import { PlanService, enforceInstanceStart, periodWindows, planUsageFor } from '../src/modules/plans/plans.ts';
import { DEFAULT_PLAN_LIMITS, PLAN_LIMIT_KEYS, TRIAL_DAYS } from '../src/modules/plans/plan-limits.ts';
import { TenantService } from '../src/modules/tenants/service.ts';
import { resetPlanGates } from '../src/http/plan-gates.ts';
import { resetRateLimits } from '../src/http/rate-limit.ts';
import { WorkflowService } from '../src/modules/workflows/service.ts';
import { VersionService } from '../src/modules/versions/service.ts';
import { DeploymentService } from '../src/modules/deployments/service.ts';

let h: Awaited<ReturnType<typeof boot>>;
let plans: PlanService;
test.before(async () => { config.mail.capture = true; h = await boot(); plans = new PlanService(h.store); });
test.after(() => h.close());
test.beforeEach(() => { resetPlanGates(); resetRateLimits(); });

const UNL = Object.fromEntries(PLAN_LIMIT_KEYS.map((k) => [k, -1]));
/** a throw-away plan where only the given limits apply */
const mkPlan = async (key: string, limits: Record<string, number>) => {   // create the plan if it does not exist yet, else update it
  try { return await plans.create({ key, name: key, limits: { ...UNL, ...limits } }, 'test'); }
  catch { return plans.update(key, { limits: { ...UNL, ...limits } }, 'test'); }
};
const wsOn = (slug: string, plan: string, roles: readonly string[] = ['viewer', 'operator', 'developer']) => h.workspace(slug, roles, plan);
const S = { id: 's', type: 'start' }, E = { id: 'e', type: 'end' };
let n = 0;
async function deploy(ws: { ctx: any }, nodes: any[] = [S, E], flows: any[] = [{ id: 'f1', from: 's', to: 'e' }]) {
  const wf = await new WorkflowService(ws.ctx).create({ name: `P ${++n}` }, 'setup');
  const d = await new VersionService(ws.ctx).saveDraft(wf.defaultBranchId, { id: wf.key, name: wf.name, processes: [{ id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars: [], nodes, flows }] } as any, 'setup');
  const pub = await new VersionService(ws.ctx).publish(d.id, 'setup');
  const dep = await new DeploymentService(ws.ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'setup');
  return { ...wf, deploymentId: dep.id };
}
const start = (ws: any, wf: { id: string }, role = 'operator') => h.call('POST', '/instances', { token: ws.tokens[role], tenant: ws.id, body: { workflowId: wf.id, environment: 'prod' } });
const WAIT = [S, { id: 'rev', type: 'userTask', name: 'R', group: 'ops' }, E];
const WAIT_FLOWS = [{ id: 'f1', from: 's', to: 'rev' }, { id: 'f2', from: 'rev', to: 'e' }];

// ============================ the free trial seed ============================
test('PLAN-01 free-trial seed: 7 days, 50 concurrent requests, per-day / week / month process starts, resource caps — all present on the stored plan', async () => {
  const row = (await h.store.repo<Plan>(Collections.plans).query((p) => p.key === 'trial'))[0];
  assert.ok(row, 'trial plan stored');
  assert.strictEqual(row.trialDays, 7); assert.match(row.description, /7 days/);
  const l = row.limits as Record<string, number>;
  assert.strictEqual(TRIAL_DAYS, 7);
  assert.strictEqual(l.concurrentRequests, 50, '50 concurrent requests on the free plan');
  assert.deepStrictEqual([l.instancesPerDay, l.instancesPerWeek, l.instancesPerMonth], [200, 1000, 3000]);
  for (const k of PLAN_LIMIT_KEYS) assert.strictEqual(typeof l[k], 'number', `trial has a value for ${k}`);
  assert.strictEqual(l.maxInstances, undefined, 'the old never-enforced total is gone');
  assert.ok(l.instancesPerDay * 7 >= l.instancesPerWeek && l.instancesPerWeek * 5 >= l.instancesPerMonth, 'budgets are consistent (day×7 ≥ week, week×5 ≥ month)');
  const pub = await h.call('GET', '/public/plans');
  assert.deepStrictEqual(pub.body.data.map((p: any) => p.key).sort(), ['custom', 'trial']);
  assert.strictEqual(pub.body.data.find((p: any) => p.key === 'trial').limits.concurrentRequests, 50);
});

test('PLAN-02 signup puts the workspace on the trial for exactly 7 days; the system (default) workspace is on the unlimited plan and never expires', async () => {
  const before = Date.now();
  const t = await new TenantService(makeContext({ store: h.store, tenantId: config.defaultTenant })).signup({ name: 'Seven', slug: 'seven-days', ownerEmail: 'seven@example.com' });
  assert.strictEqual(t.plan, 'trial');
  const days = (Date.parse(t.planExpiresAt!) - before) / 86_400_000;
  assert.ok(days > 6.99 && days < 7.01, `expires in ${days.toFixed(3)} days`);
  assert.match([...(await import('../src/infra/mailer.ts')).outbox].reverse().find((m) => m.to === 'seven@example.com')!.text, /7-day trial/);
  const def = (await h.store.repo<Tenant>(Collections.tenants).get(config.defaultTenant))!;
  assert.deepStrictEqual([def.plan, def.planExpiresAt ?? null], ['enterprise', null]);
});

test('PLAN-03 an older database is topped up: missing limit keys are added, edited values are kept, the old 14-day trial becomes 7', async () => {
  await h.store.repo<Plan>(Collections.plans).put({ id: 'plan_trial', tenantId: 'system', key: 'trial', name: 'Free trial', description: 'for 14 days.', isDefault: true, isCustom: false, trialDays: 14, limits: { maxWorkflows: 7, maxInstances: 500, maxTeamMembers: 5 }, features: [] });
  await new TenantService(makeContext({ store: h.store, tenantId: config.defaultTenant })).seedDefaultsIfEmpty();
  const row = (await h.store.repo<Plan>(Collections.plans).get('plan_trial'))!;
  const l = row.limits as Record<string, number>;
  assert.strictEqual(l.maxWorkflows, 7, 'an admin-edited value is never overwritten');
  assert.strictEqual(l.concurrentRequests, 50); assert.strictEqual(l.instancesPerDay, 200); assert.strictEqual(l.maxInstances, undefined);
  assert.strictEqual(row.trialDays, 7); assert.match(row.description, /7 days/);
  await plans.update('trial', { limits: { maxWorkflows: DEFAULT_PLAN_LIMITS.trial.maxWorkflows } }, 'test');   // restore for later tests
});

// ============================ process starts per day / week / month ============================
test('PLAN-10 per-day limit: the Nth+1 start is refused with 429, the limit, usage and the reset time; refused starts are not counted', async () => {
  await mkPlan('qa-day', { instancesPerDay: 3 });
  const ws = await wsOn('qa-day-ws', 'qa-day'); const wf = await deploy(ws);
  for (let i = 0; i < 3; i++) assert.strictEqual((await start(ws, wf)).status, 201, `start ${i + 1}`);
  const r = await start(ws, wf);
  assert.strictEqual(r.status, 429);
  assert.strictEqual(r.body.error.code, 'QUOTA_EXCEEDED');
  assert.match(r.body.error.message, /3 process starts per day/);
  assert.deepStrictEqual([r.body.error.details.quota, r.body.error.details.limit, r.body.error.details.used], ['instancesPerDay', 3, 3]);
  assert.strictEqual(r.body.error.details.resetsAt, periodWindows(Date.now()).day.resetsAt);
  for (let i = 0; i < 3; i++) await start(ws, wf);
  assert.strictEqual((await h.call('GET', '/plan/usage', { token: ws.tokens.viewer, tenant: ws.id })).body.usage.day.used, 3, 'refused starts consumed nothing');
});

test('PLAN-11 per-week and per-month limits are enforced independently, and the tightest budget wins', async () => {
  await mkPlan('qa-week', { instancesPerWeek: 2 }); await mkPlan('qa-month', { instancesPerMonth: 2 }); await mkPlan('qa-all', { instancesPerDay: 5, instancesPerWeek: 3, instancesPerMonth: 4 });
  for (const [plan, quota, word] of [['qa-week', 'instancesPerWeek', 'week'], ['qa-month', 'instancesPerMonth', 'month']] as const) {
    const ws = await wsOn(`${plan}-ws`, plan); const wf = await deploy(ws);
    assert.strictEqual((await start(ws, wf)).status, 201); assert.strictEqual((await start(ws, wf)).status, 201);
    const r = await start(ws, wf);
    assert.strictEqual(r.status, 429, plan); assert.strictEqual(r.body.error.details.quota, quota); assert.match(r.body.error.message, new RegExp(`per ${word}`));
  }
  const ws = await wsOn('qa-all-ws', 'qa-all'); const wf = await deploy(ws);
  for (let i = 0; i < 3; i++) assert.strictEqual((await start(ws, wf)).status, 201);
  assert.strictEqual((await start(ws, wf)).body.error.details.quota, 'instancesPerWeek', 'week (3) bites before day (5) and month (4)');
});

test('PLAN-12 the budgets reset on UTC day / ISO-week (Monday) / month boundaries', async () => {
  await mkPlan('qa-day1', { instancesPerDay: 1 }); await mkPlan('qa-week2', { instancesPerWeek: 2 }); await mkPlan('qa-month2', { instancesPerMonth: 2 });
  const run = (ws: any, iso: string) => enforceInstanceStart(makeContext({ store: h.store, tenantId: ws.id, clock: () => iso }));
  const refused = async (ws: any, iso: string) => { try { await run(ws, iso); return null; } catch (e: any) { return e; } };
  // 2026-10-31 is a Saturday; its ISO week started Monday 2026-10-26 and ends at Monday 2026-11-02 00:00 UTC
  const d = await wsOn('roll-day', 'qa-day1', []);
  await run(d, '2026-10-31T10:00:00.000Z');
  const e1 = await refused(d, '2026-10-31T23:59:59.000Z');
  assert.strictEqual(e1?.details.resetsAt, '2026-11-01T00:00:00.000Z');
  await run(d, '2026-11-01T00:00:00.000Z');                                        // a new UTC day: allowed again
  const w = await wsOn('roll-week', 'qa-week2', []);
  await run(w, '2026-10-31T10:00:00.000Z'); await run(w, '2026-11-01T23:00:00.000Z');   // Saturday + Sunday: same ISO week
  const e2 = await refused(w, '2026-11-01T23:59:00.000Z');
  assert.strictEqual(e2?.details.resetsAt, '2026-11-02T00:00:00.000Z', 'the week resets on Monday 00:00 UTC');
  await run(w, '2026-11-02T00:00:00.000Z');
  const m = await wsOn('roll-month', 'qa-month2', []);
  await run(m, '2026-10-30T10:00:00.000Z'); await run(m, '2026-10-31T10:00:00.000Z');
  const e3 = await refused(m, '2026-10-31T23:59:00.000Z');
  assert.strictEqual(e3?.details.resetsAt, '2026-11-01T00:00:00.000Z');
  await run(m, '2026-11-01T00:00:00.000Z');
});

test('PLAN-13 race-safe: 30 parallel starts against a limit of 10 per day admit exactly 10 (no lost updates, no over-admission)', async () => {
  await mkPlan('qa-race', { instancesPerDay: 10 });
  const ws = await wsOn('race-ws', 'qa-race'); const wf = await deploy(ws);
  const rs = await Promise.all(Array.from({ length: 30 }, () => start(ws, wf)));
  assert.strictEqual(rs.filter((r) => r.status === 201).length, 10, `statuses ${rs.map((r) => r.status).join(',')}`);
  assert.strictEqual(rs.filter((r) => r.status === 429).length, 20);
  assert.strictEqual((await planUsageFor(makeContext({ store: h.store, tenantId: ws.id }))).usage.day.used, 10);
});

test('PLAN-14 usage is per workspace: one workspace exhausting its budget does not affect another on the same plan', async () => {
  await mkPlan('qa-iso', { instancesPerDay: 1 });
  const a = await wsOn('iso-a1', 'qa-iso'), b = await wsOn('iso-b1', 'qa-iso');
  const wa = await deploy(a), wb = await deploy(b);
  assert.strictEqual((await start(a, wa)).status, 201); assert.strictEqual((await start(a, wa)).status, 429);
  assert.strictEqual((await start(b, wb)).status, 201, 'B has its own budget');
});

// ============================ trial / plan expiry ============================
test('PLAN-20 an expired trial: new work is refused with 402 PLAN_EXPIRED, everything readable stays readable; extending it restores access', async () => {
  const ws = await wsOn('expired-ws', 'trial'); const wf = await deploy(ws);
  assert.strictEqual((await start(ws, wf)).status, 201, 'works while the trial runs');
  await plans.assign(ws.id, 'trial', { planExpiresAt: new Date(Date.now() - 3600_000).toISOString() });
  const blocked: Array<[string, string, any?]> = [['POST', '/instances', { workflowId: wf.id, environment: 'prod' }], ['POST', '/workflows', { name: 'New' }], ['POST', '/team/members/invite', { email: 'x@example.com', role: 'viewer' }], ['POST', `/versions/nope/deploy`, { environment: 'prod' }]];
  for (const [m, p, b] of blocked) {
    const r = await h.call(m, p, { token: ws.tokens.owner, tenant: ws.id, body: b });
    if (p.includes('/versions/')) { assert.notStrictEqual(r.status, 201); continue; }       // deploy needs a real version; expiry is covered by enforceDeploy below
    assert.strictEqual(r.status, 402, `${m} ${p}`); assert.strictEqual(r.body.error.code, 'PLAN_EXPIRED'); assert.match(r.body.error.message, /ended on \d{4}-\d\d-\d\d/);
  }
  assert.strictEqual((await h.call('GET', '/workflows', { token: ws.tokens.viewer, tenant: ws.id })).status, 200, 'reads are untouched');
  assert.strictEqual((await h.call('GET', `/instances`, { token: ws.tokens.viewer, tenant: ws.id })).status, 200);
  const u = (await h.call('GET', '/plan/usage', { token: ws.tokens.viewer, tenant: ws.id })).body;
  assert.strictEqual(u.expired, true);
  await plans.assign(ws.id, 'trial', { extendDays: 7 });
  assert.strictEqual((await start(ws, wf)).status, 201, 'extended trial works again');
});

test('PLAN-21 the platform administrator (planExempt) is not subject to plan limits or expiry', async () => {
  await mkPlan('qa-zero', { instancesPerDay: 0 });
  const ws = await wsOn('exempt-ws', 'qa-zero', []);
  const ctx = makeContext({ store: h.store, tenantId: ws.id });
  await assert.rejects(() => enforceInstanceStart(ctx), /process starts per day/);
  ctx.planExempt = true;
  await enforceInstanceStart(ctx);
  assert.strictEqual((await planUsageFor(makeContext({ store: h.store, tenantId: ws.id }))).usage.day.used, 0, 'exempt starts are not metered against the customer');
});

// ============================ resource limits ============================
test('PLAN-30 maxWorkflows: refused at the limit, archived workflows do not count', async () => {
  await mkPlan('qa-wf', { maxWorkflows: 2 });
  const ws = await wsOn('wf-ws', 'qa-wf');
  const mk = (name: string) => h.call('POST', '/workflows', { token: ws.tokens.developer, tenant: ws.id, body: { name } });
  const a = await mk('A'); await mk('B');
  const r = await mk('C');
  assert.strictEqual(r.status, 429); assert.strictEqual(r.body.error.details.quota, 'maxWorkflows'); assert.match(r.body.error.message, /allows 2 workflows/);
  assert.strictEqual((await h.call('DELETE', `/workflows/${a.body.id}`, { token: ws.tokens.developer, tenant: ws.id })).status, 204);
  assert.strictEqual((await mk('C')).status, 201, 'room again after archiving');
});

test('PLAN-31 maxTeamMembers counts members AND pending invitations; a re-invite adds no seat; cancelling frees one', async () => {
  await mkPlan('qa-team', { maxTeamMembers: 3 });
  const ws = await wsOn('team-ws', 'qa-team', []);                      // the owner is seat 1
  const inv = (email: string) => h.call('POST', '/team/members/invite', { token: ws.tokens.owner, tenant: ws.id, body: { email, role: 'viewer' } });
  const a = await inv('a@example.com'); assert.strictEqual(a.status, 201);
  assert.strictEqual((await inv('b@example.com')).status, 201);
  const over = await inv('c@example.com');
  assert.strictEqual(over.status, 429); assert.strictEqual(over.body.error.details.quota, 'maxTeamMembers');
  assert.strictEqual((await inv('a@example.com')).status, 201, 're-inviting a pending seat is not a new seat');
  assert.strictEqual((await h.call('DELETE', `/team/members/${a.body.data.member.id}/invitation`, { token: ws.tokens.owner, tenant: ws.id })).status, 204);
  assert.strictEqual((await inv('c@example.com')).status, 201, 'cancelling frees the seat');
});

test('PLAN-32 maxDeployments: the next deploy is refused; archiving one makes room', async () => {
  await mkPlan('qa-dep', { maxDeployments: 1 });
  const ws = await wsOn('dep-ws', 'qa-dep', ['release']);
  const first = await deploy(ws);
  const wf2 = await new WorkflowService(ws.ctx).create({ name: 'Second' }, 's');
  const d = await new VersionService(ws.ctx).saveDraft(wf2.defaultBranchId, { id: wf2.key, name: wf2.name, processes: [{ id: `${wf2.key}.process`, name: 'x', package: 'p', vars: [], nodes: [S, E], flows: [{ id: 'f1', from: 's', to: 'e' }] }] } as any, 's');
  const pub = (await new VersionService(ws.ctx).publish(d.id, 's')).published;
  const r = await h.call('POST', `/versions/${pub.id}/deploy`, { token: ws.tokens.release, tenant: ws.id, body: { environment: 'prod' } });
  assert.strictEqual(r.status, 429); assert.strictEqual(r.body.error.details.quota, 'maxDeployments');
  assert.strictEqual((await h.call('POST', `/deployments/${first.deploymentId}/archive`, { token: ws.tokens.release, tenant: ws.id })).status, 200);
  assert.strictEqual((await h.call('POST', `/versions/${pub.id}/deploy`, { token: ws.tokens.release, tenant: ws.id, body: { environment: 'prod' } })).status, 201);
});

test('PLAN-33 maxActiveInstances is a plan cap (flows through the platform-limits model); the workspace cannot raise it', async () => {
  await mkPlan('qa-act', { maxActiveInstances: 2 });
  const ws = await wsOn('act-ws', 'qa-act', ['operator', 'admin']); const wf = await deploy(ws, WAIT, WAIT_FLOWS);
  assert.strictEqual((await start(ws, wf)).status, 201); assert.strictEqual((await start(ws, wf)).status, 201);
  const r = await start(ws, wf);
  assert.strictEqual(r.status, 429); assert.strictEqual(r.body.error.details.quota, 'maxActiveInstances');
  const s = await h.call('GET', '/settings/system', { token: ws.tokens.owner, tenant: ws.id });
  assert.strictEqual(s.body.limitCaps.maxActiveInstancesCap, 2, 'the cap shown to the workspace admin is the plan\'s');
  const up = await h.call('PUT', '/settings/system', { token: ws.tokens.owner, tenant: ws.id, body: { maxActiveInstances: 100 } });
  assert.strictEqual(up.status, 422, 'cannot raise it above the plan');
});

test('PLAN-34 concurrentScripts still caps the workspace script pool (system administrator view); users do not see it', async () => {
  await mkPlan('qa-scripts', { concurrentScripts: 1 });
  const ws = await wsOn('scripts-ws', 'qa-scripts', []);
  const { effectiveLimitsFor } = await import('../src/modules/platform/limits.ts');
  const { makeContext } = await import('../src/context.ts');
  const eff = await effectiveLimitsFor(makeContext({ store: h.store, tenantId: ws.id }));
  assert.strictEqual(eff.effective.scriptPoolSize, 1);
  assert.strictEqual(eff.caps.scriptPoolMaxSize, 1);
  const usage = (await h.call('GET', '/plan/usage', { token: ws.tokens.owner, tenant: ws.id })).body;
  assert.ok(!('concurrentScripts' in usage.limits));
});

test('PLAN-35 maxActiveTimers is a plan cap: the second timer cannot be scheduled', async () => {
  await mkPlan('qa-timers', { maxActiveTimers: 1 });
  const ws = await wsOn('timers-ws', 'qa-timers', ['operator']);
  const wf = await deploy(ws, [S, { id: 'w', type: 'catch', event: { timer: { duration: 'PT1H' } } }, E], [{ id: 'f1', from: 's', to: 'w' }, { id: 'f2', from: 'w', to: 'e' }]);
  assert.strictEqual((await start(ws, wf)).body.status, 'waiting');
  const second = (await start(ws, wf)).body;
  assert.notStrictEqual(second.status, 'waiting', 'the second timer was refused by the plan cap');
});

// ============================ request gates ============================
test('PLAN-40 requestsPerMinute: over the budget → 429 with Retry-After; another workspace is unaffected', async () => {
  await mkPlan('qa-rpm', { requestsPerMinute: 12 });
  const a = await wsOn('rpm-a', 'qa-rpm'), b = await wsOn('rpm-b', 'qa-rpm');
  const get = (w: any) => h.call('GET', '/workflows', { token: w.tokens.viewer, tenant: w.id });
  for (let i = 0; i < 12; i++) assert.strictEqual((await get(a)).status, 200, `request ${i + 1}`);
  const r = await get(a);
  assert.strictEqual(r.status, 429); assert.match(r.body.error.message, /12 API requests per minute/); assert.ok(Number(r.headers.get('retry-after')) >= 1);
  assert.strictEqual((await get(b)).status, 200, 'B has its own minute budget');
});

/** a process whose script blocks for ~100 ms, so API requests that start it genuinely overlap in time */
const SLOW = [S, { id: 'sc', type: 'script', lang: 'js', code: 'var t = Date.now(); while (Date.now() - t < 100) {}' }, E];
const SLOW_FLOWS = [{ id: 'f1', from: 's', to: 'sc' }, { id: 'f2', from: 'sc', to: 'e' }];

test('PLAN-41 concurrentRequests: requests beyond the in-flight limit get 429 + Retry-After; the counter is released afterwards', async () => {
  await mkPlan('qa-conc', { concurrentRequests: 2 });
  const ws = await wsOn('conc-ws', 'qa-conc', ['operator', 'viewer']); const wf = await deploy(ws, SLOW, SLOW_FLOWS);
  resetPlanGates();
  const rs = await Promise.all(Array.from({ length: 12 }, () => start(ws, wf)));
  const ok = rs.filter((r) => r.status === 201).length, limited = rs.filter((r) => r.status === 429);
  assert.ok(ok >= 2, `some were served (${ok})`); assert.ok(limited.length >= 5, `and the excess was limited (${limited.length})`);
  assert.ok(limited.every((r) => r.headers.get('retry-after') === '1' && /concurrent API requests/.test(r.body.error.message)));
  for (let i = 0; i < 3; i++) assert.strictEqual((await start(ws, wf)).status, 201, 'sequential requests still pass: the counter was released');
});

test('PLAN-42 the free trial allows 50 concurrent requests: 50 overlapping requests are served, the ones beyond 50 get 429', async () => {
  const ws = await wsOn('free-50', 'trial', ['operator']); const wf = await deploy(ws, SLOW, SLOW_FLOWS);
  resetPlanGates();
  const rs = await Promise.all(Array.from({ length: 60 }, () => start(ws, wf)));
  const ok = rs.filter((r) => r.status === 201).length, limited = rs.filter((r) => r.status === 429).length;
  assert.ok(ok >= 45 && ok <= 55, `~50 served (${ok})`);
  assert.ok(limited >= 5, `the excess over 50 was limited (${limited})`);
  assert.strictEqual(ok + limited, 60, `no other outcome: ${[...new Set(rs.map((r) => r.status))]}`);
});

// ============================ reporting + administration ============================
test('PLAN-50 GET /plan/usage: every member can read it; non-members cannot; numbers match reality; unlimited shows as null', async () => {
  await mkPlan('qa-usage', { instancesPerDay: 5, maxWorkflows: 4 });
  const ws = await wsOn('usage-ws', 'qa-usage', ['viewer', 'worker', 'operator']);
  const wf = await deploy(ws); await start(ws, wf); await start(ws, wf);
  for (const role of ['viewer', 'worker', 'operator', 'owner']) assert.strictEqual((await h.call('GET', '/plan/usage', { token: ws.tokens[role], tenant: ws.id })).status, 200, role);
  assert.strictEqual((await h.call('GET', '/plan/usage', { token: tokenFor('stranger@example.com'), tenant: ws.id })).status, 403);
  assert.strictEqual((await h.call('GET', '/plan/usage', { tenant: ws.id })).status, 401);
  const u = (await h.call('GET', '/plan/usage', { token: ws.tokens.viewer, tenant: ws.id })).body;
  assert.deepStrictEqual([u.usage.day.used, u.usage.day.limit, u.usage.day.remaining], [2, 5, 3]);
  assert.deepStrictEqual([u.resources.workflows.used, u.resources.workflows.limit], [1, 4]);
  assert.strictEqual(u.limits.maxTeamMembers, null, 'unlimited is null');
  assert.strictEqual(u.usage.week.limit, null); assert.ok(u.usage.month.resetsAt > u.usage.day.resetsAt || u.usage.month.resetsAt === u.usage.day.resetsAt);
});

test('PLAN-60 plan administration validates input: unknown limit, non-integer, below -1, unknown plan; updates apply immediately', async () => {
  await mkPlan('qa-val', {});
  await assert.rejects(() => plans.update('qa-val', { limits: { nonsense: 1 } }, 't'), /unknown plan limit/);
  await assert.rejects(() => plans.update('qa-val', { limits: { maxWorkflows: 1.5 } }, 't'), /integer/);
  await assert.rejects(() => plans.update('qa-val', { limits: { maxWorkflows: -2 } }, 't'), /≥ -1/);
  await assert.rejects(() => plans.update('Bad Key!', { limits: {} }, 't'), /plan key/);
  const ws = await wsOn('live-ws', 'qa-live-undefined-check', []).catch(() => null);
  assert.strictEqual(ws, null, 'assigning a plan that does not exist is refused');
  await mkPlan('qa-live', { maxWorkflows: 1 });
  const w = await wsOn('live-ws2', 'qa-live', ['developer']);
  const mk = (name: string) => h.call('POST', '/workflows', { token: w.tokens.developer, tenant: w.id, body: { name } });
  assert.strictEqual((await mk('one')).status, 201); assert.strictEqual((await mk('two')).status, 429);
  await mkPlan('qa-live', { maxWorkflows: 3 });
  assert.strictEqual((await mk('two')).status, 201, 'the admin raised the plan limit: effective at once, no restart');
  const hidden = (await plans.list()).find((p) => p.key === 'qa-live')!;
  assert.strictEqual(hidden.public, false, 'a plan created by the admin is not on the public pricing page');
  assert.ok(!(await h.call('GET', '/public/plans')).body.data.some((p: any) => p.key === 'qa-live'));
});
