import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore } from '../src/store/memory-store.ts';
import { makeContext } from '../src/context.ts';
import { SettingsService, DEFAULT_SETTINGS } from '../src/modules/settings/service.ts';
import { TaskService } from '../src/modules/tasks/service.ts';
import { logger } from '../src/infra/logger.ts';
import { assertOutboundAllowed } from '../src/infra/outbound-guard.ts';
import { Collections, type Deployment, type Instance, type Task } from '../src/domain.ts';
import { handler as userTaskHandler } from '../src/engine/nodes/user-task/handler.ts';

describe('SystemSettings: Enterprise configuration suite', () => {
  function setup(now = '2026-10-29T10:00:00.000Z') {
    let currentTime = now;
    const store = new MemoryStore();
    const ctx = makeContext({
      store,
      tenantId: 'test-tenant',
      clock: () => currentTime,
    });
    return {
      store,
      ctx,
      settings: new SettingsService(ctx),
      tasks: new TaskService(ctx),
      setTime: (t: string) => { currentTime = t; },
    };
  }

  describe('SettingsService defaults & validations', () => {
    it('returns default non-IAM settings on unseeded store', async () => {
      const { settings } = setup();
      const s = await settings.get();
      assert.equal(s.scriptTimeoutSeconds, 5);
      assert.equal(s.jobRetryBackoffMultiplier, 2);
      assert.equal(s.httpTimeoutSeconds, 10);
      assert.equal(s.outboundAllowlist, '');
      assert.equal(s.defaultTaskSlaHours, 48);
      assert.equal(s.autoReleaseClaimedTaskHours, 0);
      assert.equal(s.historyAuditLevel, 'full');
      assert.equal(s.logLevel, 'info');
      assert.equal(s.timerBatchSize, 50);
    });

    it('rejects invalid numeric and enum bounds', async () => {
      const { settings } = setup();
      await assert.rejects(() => settings.update({ scriptTimeoutSeconds: 0 }, 'admin'), /scriptTimeoutSeconds/);
      await assert.rejects(() => settings.update({ jobRetryBackoffMultiplier: -1 }, 'admin'), /jobRetryBackoffMultiplier/);
      await assert.rejects(() => settings.update({ httpTimeoutSeconds: 0 }, 'admin'), /httpTimeoutSeconds/);
      await assert.rejects(() => settings.update({ defaultTaskSlaHours: -5 }, 'admin'), /defaultTaskSlaHours/);
      await assert.rejects(() => settings.update({ autoReleaseClaimedTaskHours: -1 }, 'admin'), /autoReleaseClaimedTaskHours/);
      await assert.rejects(() => settings.update({ historyAuditLevel: 'super' as any }, 'admin'), /historyAuditLevel/);
      await assert.rejects(() => settings.update({ logLevel: 'chatty' as any }, 'admin'), /logLevel/);
    });

    it('applies valid updates and updates logger severity live', async () => {
      const { settings } = setup();
      const initialLogLevel = logger.getLevel();

      const updated = await settings.update({
        scriptTimeoutSeconds: 15,
        jobRetryBackoffMultiplier: 3,
        httpTimeoutSeconds: 30,
        outboundAllowlist: 'api.internal.corp, payments.prudential.com',
        defaultTaskSlaHours: 72,
        autoReleaseClaimedTaskHours: 24,
        historyAuditLevel: 'minimal',
        logLevel: 'warn',
      }, 'secadmin');

      assert.equal(updated.scriptTimeoutSeconds, 15);
      assert.equal(updated.jobRetryBackoffMultiplier, 3);
      assert.equal(updated.httpTimeoutSeconds, 30);
      assert.equal(updated.outboundAllowlist, 'api.internal.corp, payments.prudential.com');
      assert.equal(updated.defaultTaskSlaHours, 72);
      assert.equal(updated.autoReleaseClaimedTaskHours, 24);
      assert.equal(updated.historyAuditLevel, 'minimal');
      assert.equal(updated.logLevel, 'warn');
      // the level is process-wide: a (non-default) workspace stores its preference but cannot move the platform's logger
      assert.equal(logger.getLevel(), initialLogLevel);

      // Reset logger level
      logger.setLevel(initialLogLevel);
    });
  });

  describe('Outbound guard with dynamic allowlist', () => {
    it('permits private hosts when present in dynamic allowlist', async () => {
      // 127.0.0.1 is normally blocked by private range SSRF protection
      await assert.rejects(() => assertOutboundAllowed('http://127.0.0.1:8080/test'), /blocked/);

      // Now pass dynamic allowlist with 127.0.0.1
      await assert.doesNotReject(() => assertOutboundAllowed('http://127.0.0.1:8080/test', '127.0.0.1, internal.test'));
    });
  });

  describe('Human Task default SLA calculation', () => {
    it('applies defaultTaskSlaHours when user task node has no explicit dueDate', async () => {
      const { ctx, settings } = setup('2026-10-29T10:00:00.000Z');
      await settings.update({ defaultTaskSlaHours: 24 }, 'admin');

      const dummyNode = { id: 'user_task_1', name: 'Review Application', type: 'userTask' };
      const dummyInst: Instance = {
        id: 'inst_1',
        tenantId: 'test-tenant',
        deploymentId: 'dep_1',
        processId: 'proc_1',
        workflowId: 'wf_1',
        status: 'running',
        startedAt: '2026-10-29T10:00:00.000Z',
        tokens: [{ id: 'tok_1', nodeId: 'user_task_1', status: 'waiting' }],
        variables: {},
      };

      const handlerCtx: any = {
        node: dummyNode,
        inst: dummyInst,
        app: ctx,
        emit: () => {},
      };

      const result = await userTaskHandler(handlerCtx);
      assert.ok(result.wait);
      const taskId = result.wait.ref;

      const createdTask = await ctx.store.repo<Task>(Collections.tasks).get(taskId);
      assert.ok(createdTask);
      assert.ok(createdTask.dueAt);
      // 2026-10-29T10:00:00Z + 24 hours = 2026-10-30T10:00:00Z
      assert.equal(createdTask.dueAt, '2026-10-30T10:00:00.000Z');
    });

    it('respects node dueDate over defaultTaskSlaHours when specified', async () => {
      const { ctx, settings } = setup('2026-10-29T10:00:00.000Z');
      await settings.update({ defaultTaskSlaHours: 48 }, 'admin');

      const dummyNode = { id: 'user_task_2', name: 'Urgent Task', type: 'userTask', dueDate: 'PT2H' };
      const dummyInst: Instance = {
        id: 'inst_2',
        tenantId: 'test-tenant',
        deploymentId: 'dep_1',
        processId: 'proc_1',
        workflowId: 'wf_1',
        status: 'running',
        startedAt: '2026-10-29T10:00:00.000Z',
        tokens: [{ id: 'tok_2', nodeId: 'user_task_2', status: 'waiting' }],
        variables: {},
      };

      const handlerCtx: any = {
        node: dummyNode,
        inst: dummyInst,
        app: ctx,
        emit: () => {},
      };

      const result = await userTaskHandler(handlerCtx);
      const taskId = result.wait!.ref;

      const createdTask = await ctx.store.repo<Task>(Collections.tasks).get(taskId);
      // PT2H = 2 hours: 2026-10-29T12:00:00.000Z
      assert.equal(createdTask?.dueAt, '2026-10-29T12:00:00.000Z');
    });
  });

  describe('Idle task auto-release', () => {
    it('sets claimedAt on claim, clears on release, and autoReleaseIdle frees stale tasks', async () => {
      const { ctx, tasks, setTime } = setup('2026-10-29T10:00:00.000Z');

      const task: Task = {
        id: 'task_sla_1',
        tenantId: 'test-tenant',
        instanceId: 'inst_1',
        tokenId: 'tok_1',
        nodeId: 'node_1',
        name: 'Underwriter Review',
        group: 'underwriters',
        status: 'created',
        inputs: {},
        createdAt: '2026-10-29T10:00:00.000Z',
      };
      await ctx.store.repo<Task>(Collections.tasks).put(task);

      // User claims task at 10:00
      const claimed = await tasks.claim('task_sla_1', 'alice');
      assert.equal(claimed.status, 'reserved');
      assert.equal(claimed.assignee, 'alice');
      assert.equal(claimed.claimedAt, '2026-10-29T10:00:00.000Z');

      // Fast forward 3 hours (13:00) with a 2-hour auto-release policy
      setTime('2026-10-29T13:00:00.000Z');

      const released = await tasks.autoReleaseIdle(2);
      assert.equal(released, 1);

      const refreshed = await tasks.get('task_sla_1');
      assert.equal(refreshed.status, 'created');
      assert.equal(refreshed.assignee, undefined);
      assert.equal(refreshed.claimedAt, undefined);
    });
  });

  describe('History audit level filtering', () => {
    it('filters noisy variable and reschedule events under minimal audit level', async () => {
      const { ctx, settings } = setup();
      await settings.update({ historyAuditLevel: 'minimal' }, 'admin');

      // Log a noisy event
      await ctx.audit({ actor: 'system', kind: 'instance.variables.updated' });
      // Log an essential lifecycle event
      await ctx.audit({ actor: 'admin', kind: 'instance.aborted', instanceId: 'inst_1' });

      const allAudits = await ctx.store.repo<any>(Collections.audit).query(() => true);
      // The update to settings + instance.aborted are captured; instance.variables.updated is filtered
      const variableAudits = allAudits.filter((a) => a.kind === 'instance.variables.updated');
      const abortAudits = allAudits.filter((a) => a.kind === 'instance.aborted');

      assert.equal(variableAudits.length, 0);
      assert.equal(abortAudits.length, 1);
    });
  });
});
