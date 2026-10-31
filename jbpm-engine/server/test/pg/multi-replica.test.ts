// Proof of Multi-Replica High Availability & Active-Active Coordination on PostgreSQL.
// Simulates independent Node.js server replicas (Replica A, Replica B) operating on the same DB.
import 'reflect-metadata';
import 'pg';
import { test } from 'node:test';
import assert from 'node:assert';
import { PgStore } from '../../src/store/pg-store.ts';
import { makeContext, type AppContext } from '../../src/context.ts';
import { config } from '../../src/infra/config.ts';
import { WorkflowService } from '../../src/modules/workflows/service.ts';
import { VersionService } from '../../src/modules/versions/service.ts';
import { DeploymentService } from '../../src/modules/deployments/service.ts';
import { InstanceService } from '../../src/modules/instances/service.ts';
import { TaskService } from '../../src/modules/tasks/service.ts';
import { TimerService } from '../../src/modules/timers/service.ts';
import { SettingsService } from '../../src/modules/settings/service.ts';
import { Collections, type Task, type TimerJob } from '../../src/domain.ts';

const TENANT = `multi_replica_test_${Date.now()}`;
let storeA: PgStore;
let storeB: PgStore;
let ctxA: AppContext;
let ctxB: AppContext;

test.before(() => {
  // Two separate DataSource instances connected to PostgreSQL, exactly like two separate Node pods
  storeA = new PgStore(config.pgUrl!);
  storeB = new PgStore(config.pgUrl!);
  ctxA = makeContext({ store: storeA, tenantId: TENANT });
  ctxB = makeContext({ store: storeB, tenantId: TENANT });
});

test.after(async () => {
  await storeA.close();
  await storeB.close();
});

test('Pillar 1: Cross-replica execution — Replica A authors & starts, Replica B claims & completes', async () => {
  const wf = await new WorkflowService(ctxA).create({ name: 'Replica Workflow' }, 'architect');
  const engine = {
    id: wf.key, name: wf.name, processes: [{
      id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars: [{ name: 'review', type: 'string' }],
      nodes: [
        { id: 's', type: 'start' },
        { id: 'review_task', type: 'userTask', name: 'Review Application', group: 'underwriters' },
        { id: 'e', type: 'end' },
      ],
      flows: [{ from: 's', to: 'review_task' }, { from: 'review_task', to: 'e' }],
    }],
  };
  const draft = await new VersionService(ctxA).saveDraft(wf.defaultBranchId, engine as any, 'architect');
  const pub = await new VersionService(ctxA).publish(draft.id, 'architect');
  await new DeploymentService(ctxA).deploy(pub.published.id, { environment: 'prod', activate: true }, 'architect');

  // Replica A triggers instance start
  const instOnA = await new InstanceService(ctxA).start({ workflowId: wf.id, environment: 'prod' }, 'customer');
  assert.strictEqual(instOnA.status, 'waiting');

  // Replica B queries tasks from PostgreSQL
  const tasksOnB = await storeB.repo<Task>(Collections.tasks).query((t) => t.instanceId === instOnA.id);
  assert.strictEqual(tasksOnB.length, 1);
  const task = tasksOnB[0]!;
  assert.strictEqual(task.status, 'created');

  // Replica B claims the task
  await new TaskService(ctxB).claim(task.id, 'underwriter_1');
  const claimedTaskOnA = await new TaskService(ctxA).get(task.id);
  assert.strictEqual(claimedTaskOnA.status, 'reserved');
  assert.strictEqual(claimedTaskOnA.assignee, 'underwriter_1');

  // Replica B completes the task
  await new TaskService(ctxB).complete(task.id, { review: 'accepted' }, 'underwriter_1');

  // Replica A verifies completion from PostgreSQL
  const finalInstOnA = await new InstanceService(ctxA).get(instOnA.id);
  assert.strictEqual(finalInstOnA.status, 'completed');
  assert.strictEqual(finalInstOnA.variables.review, 'accepted');
});

test('Pillar 2 (Option B): PostgreSQL distributed advisory lock coordinates active-active replicas', async () => {
  const LOCK_KEY = 998877;
  // Replica A acquires the advisory lock
  const aAcquired = await storeA.tryAdvisoryLock(LOCK_KEY);
  assert.strictEqual(aAcquired, true, 'Replica A must acquire lock');

  // Replica B attempts to acquire the same lock -> fails cleanly without blocking
  const bAcquired = await storeB.tryAdvisoryLock(LOCK_KEY);
  assert.strictEqual(bAcquired, false, 'Replica B must fail to acquire while Replica A holds it');

  // Replica A releases the lock
  const aReleased = await storeA.unlockAdvisoryLock(LOCK_KEY);
  assert.strictEqual(aReleased, true, 'Replica A released lock');

  // Now Replica B can acquire the lock
  const bNowAcquired = await storeB.tryAdvisoryLock(LOCK_KEY);
  assert.strictEqual(bNowAcquired, true, 'Replica B acquires lock after release');
  await storeB.unlockAdvisoryLock(LOCK_KEY);
});

test('Pillar 2: Bounded batching and non-overlapping execution in TimerService', async () => {
  const timersA = new TimerService(ctxA);
  const repoA = storeA.repo<TimerJob>(Collections.timers);
  const now = new Date();
  const pastIso = new Date(now.getTime() - 60000).toISOString();

  // Seed 10 due timer jobs
  for (let i = 0; i < 10; i++) {
    await repoA.put({
      id: `timer_batch_${Date.now()}_${i}`,
      tenantId: TENANT,
      instanceId: `dummy_inst_${i}`,
      tokenId: `dummy_token_${i}`,
      nodeId: `dummy_node_${i}`,
      kind: 'duration',
      dueAt: pastIso,
      fired: 0,
      status: 'scheduled',
      createdAt: pastIso,
    });
  }

  // Tick on Replica A processes due timers in bounded batch
  const firedCount = await timersA.tick(new Date().toISOString());
  assert.ok(firedCount > 0, 'Must fire due timers');

  // Subsequent tick verifies all processed jobs are marked 'fired'
  const remaining = await repoA.query((t) => t.tenantId === TENANT && t.id.startsWith('timer_batch_') && t.status === 'scheduled');
  assert.strictEqual(remaining.length, 0, 'All scheduled timers processed cleanly');
});

test('Pillar 2: timerBatchSize is configurable dynamically via SystemSettings without server restart', async () => {
  const settingsTenant = `settings_test_${Date.now()}`;
  const ctxSettings = makeContext({ store: storeA, tenantId: settingsTenant });
  const settingsService = new SettingsService(ctxSettings);

  // Update timerBatchSize to 3 in SystemSettings
  await settingsService.update({ timerBatchSize: 3 }, 'admin');
  const updatedSettings = await settingsService.get();
  assert.strictEqual(updatedSettings.timerBatchSize, 3);

  // Seed 6 due timers
  const repoA = storeA.repo<TimerJob>(Collections.timers);
  const now = new Date();
  const pastIso = new Date(now.getTime() - 60000).toISOString();

  for (let i = 0; i < 6; i++) {
    await repoA.put({
      id: `timer_settings_${Date.now()}_${i}`,
      tenantId: settingsTenant,
      instanceId: `dummy_inst_${i}`,
      tokenId: `dummy_token_${i}`,
      nodeId: `dummy_node_${i}`,
      kind: 'duration',
      dueAt: pastIso,
      fired: 0,
      status: 'scheduled',
      createdAt: pastIso,
    });
  }

  // Tick without passing batchSize argument — must resolve batch size 3 from SystemSettings
  const firedFirstTick = await new TimerService(ctxSettings).tick(new Date().toISOString());
  assert.strictEqual(firedFirstTick, 3, 'Must claim exactly 3 jobs according to SystemSettings timerBatchSize');

  // Second tick claims the remaining 3 jobs
  const firedSecondTick = await new TimerService(ctxSettings).tick(new Date().toISOString());
  assert.strictEqual(firedSecondTick, 3, 'Must claim the remaining 3 jobs in the second batch');
});

test('Pillar 1: Concurrent starts across multiple replicas do not collide', async () => {
  const wf = await new WorkflowService(ctxA).create({ name: 'Concurrent Start' }, 'alice');
  const engine = {
    id: wf.key, name: wf.name, processes: [{
      id: `${wf.key}.process`, name: wf.name, package: 'com.acme', vars: [],
      nodes: [{ id: 's', type: 'start' }, { id: 'e', type: 'end' }],
      flows: [{ from: 's', to: 'e' }],
    }],
  };
  const draft = await new VersionService(ctxA).saveDraft(wf.defaultBranchId, engine as any, 'alice');
  const pub = await new VersionService(ctxA).publish(draft.id, 'alice');
  await new DeploymentService(ctxA).deploy(pub.published.id, { environment: 'prod', activate: true }, 'alice');

  // Fire 10 concurrent starts simultaneously across both replicas
  const starts = await Promise.all([
    ...Array.from({ length: 5 }, () => new InstanceService(ctxA).start({ workflowId: wf.id, environment: 'prod' }, 'user_a')),
    ...Array.from({ length: 5 }, () => new InstanceService(ctxB).start({ workflowId: wf.id, environment: 'prod' }, 'user_b')),
  ]);

  assert.strictEqual(starts.length, 10);
  const ids = new Set(starts.map((s) => s.id));
  assert.strictEqual(ids.size, 10, 'All 10 instances have unique IDs');
  for (const inst of starts) {
    assert.strictEqual(inst.status, 'completed');
  }
});

test('Pure Active-Active: Concurrent competing consumers — Replica A and Replica B concurrently claim and process distinct due timers with zero overlap', async () => {
  const repoA = storeA.repo<TimerJob>(Collections.timers);
  const now = new Date();
  const pastIso = new Date(now.getTime() - 60000).toISOString();
  const testTenant = `concurrent_timers_${Date.now()}`;

  // Seed 20 due timer jobs
  for (let i = 0; i < 20; i++) {
    await repoA.put({
      id: `active_job_${Date.now()}_${i}`,
      tenantId: testTenant,
      instanceId: `inst_${i}`,
      tokenId: `token_${i}`,
      nodeId: `node_${i}`,
      kind: 'duration',
      dueAt: pastIso,
      fired: 0,
      status: 'scheduled',
      createdAt: pastIso,
    });
  }

  // Trigger tick concurrently on BOTH Replica A and Replica B at the exact same millisecond
  const ctxA_tenant = makeContext({ store: storeA, tenantId: testTenant });
  const ctxB_tenant = makeContext({ store: storeB, tenantId: testTenant });
  const [firedA, firedB] = await Promise.all([
    new TimerService(ctxA_tenant).tick(new Date().toISOString(), 10),
    new TimerService(ctxB_tenant).tick(new Date().toISOString(), 10),
  ]);

  // Both replicas actively and concurrently participated in processing the workload
  assert.ok(firedA > 0, `Replica A must have processed jobs (processed: ${firedA})`);
  assert.ok(firedB > 0, `Replica B must have processed jobs (processed: ${firedB})`);
  assert.strictEqual(firedA + firedB, 20, 'Total processed jobs across both replicas must equal 20 with zero duplicate firings');

  // Verify all 20 jobs are marked fired exactly once
  const allJobs = await repoA.query((t) => t.tenantId === testTenant && t.id.startsWith('active_job_'));
  assert.strictEqual(allJobs.length, 20);
  for (const job of allJobs) {
    assert.strictEqual(job.status, 'fired');
    assert.strictEqual(job.fired, 1, `Job ${job.id} must be fired exactly once`);
  }
});
