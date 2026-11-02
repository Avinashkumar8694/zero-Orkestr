// Boot: HTTP server + WebSocket hub.
import { onAllocatorKick } from './engine/allocator-kick.ts';
import { AllocationService } from './modules/allocation/service.ts';
import { onKick } from './engine/async-kick.ts';
import { migrateAnalyticsAll } from './analytics/migrate.ts';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createApp } from './app.ts';
import { config, assertProductionConfig } from './infra/config.ts';
import { hub } from './infra/ws-hub.ts';
import { logger } from './infra/logger.ts';
import { makeContext } from './context.ts';
import { TimerService } from './modules/timers/service.ts';
import { TaskService } from './modules/tasks/service.ts';
import { IamService } from './modules/iam/service.ts';
import { TenantService } from './modules/tenants/service.ts';
import { authenticateWsUpgrade, authorizeWsTenant, canSubscribe } from './infra/ws-auth.ts';
import { Collections, type Tenant } from './domain.ts';
import { ensurePlatformAdmin } from './modules/tenants/identity.ts';
import { initCoordinator, coordinator } from './infra/coordinator.ts';
import { maxReplicasFor, PlatformLimitsService } from './modules/platform/limits.ts';
import { SettingsService } from './modules/settings/service.ts';

assertProductionConfig();   // refuse to boot in production on insecure defaults

const { app, store } = createApp();
await initCoordinator();      // Redis (REDIS_URL) or a private in-memory backend; heartbeats start here
const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: config.wsPath });
wss.on('connection', async (ws, req) => {
  // Messages may arrive while the (async) token/tenant checks are still running — buffer them so none is lost.
  const queued: any[][] = [];
  const early = (...args: any[]) => { queued.push(args); };
  ws.on('message', early);
  try {
    const claims = await authenticateWsUpgrade(req);
    if (!claims) { ws.close(4001, 'unauthorized'); return; }
    const session = await authorizeWsTenant(store, claims, req);
    if (!session) { ws.close(4003, 'forbidden'); return; }
    ws.off('message', early);
    hub.add(ws, (topic) => canSubscribe(store, session, topic));
    for (const args of queued) ws.emit('message', ...args);
  } catch { ws.close(1011, 'error'); }
});

// durable timer scheduler — fires due catch/boundary timers for EVERY active workspace (each tick runs under that
// workspace's own context, so a timer never resumes a token under the wrong tenant). Enabled in the 'all' and 'worker'
// roles, disabled in the stateless 'api' role (a dedicated worker replica runs it). Chained setTimeout, so a slow tick
// never overlaps the next one; the cadence, batch size and idle-task release come from each workspace's settings.
let stopped = false;
const isWorkerEnabled = config.role === 'all' || config.role === 'worker';
const isAllocatorEnabled = config.role === 'all' || config.role === 'worker' || config.role === 'allocator';
if (isWorkerEnabled) {
  let passRunning = false;
  /** one scheduler pass over every workspace; returns the delay before the next scheduled pass */
  const runPass = async (): Promise<number> => {
    let nextIntervalMs = config.timerTickIntervalMs;
    if (passRunning) return nextIntervalMs;
    passRunning = true;
    try {
      const defaults = await new SettingsService(makeContext({ store, tenantId: config.defaultTenant })).get().catch(() => null);
      if (defaults?.executorIntervalSeconds && defaults.executorIntervalSeconds > 0) nextIntervalMs = defaults.executorIntervalSeconds * 1000;
      const now = new Date().toISOString();
      const tenants = await store.repo<Tenant>(Collections.tenants).query((t) => t.status === 'active');
      const ids = new Set([config.defaultTenant, ...tenants.map((t) => t.id)]);
      for (const tenantId of ids) {
        const ctx = makeContext({ store, tenantId });
        // with several replicas: only a replica that may serve this workspace (maxReplicas) works its timers, and each
        // job is claimed by exactly one of them — a timer fires once however many pods run
        const co = coordinator();
        const settings = await new SettingsService(ctx).get().catch(() => null);
        await new TimerService(ctx, hub.engineEmit).tick(now, {
          batchSize: settings?.timerBatchSize || config.timerBatchSize,
          admit: async () => (await co.place(tenantId, await maxReplicasFor(store, tenantId))).ok,
          claim: (job) => co.claim(`timer:${job.id}`),
        }).catch((e) => logger.error('timer tick failed', { tenantId, err: (e as Error).message }));
        if (settings?.autoReleaseClaimedTaskHours && settings.autoReleaseClaimedTaskHours > 0) {
          await new TaskService(ctx, hub.engineEmit).autoReleaseIdle(settings.autoReleaseClaimedTaskHours)
            .catch((e) => logger.error('auto-release of idle tasks failed', { tenantId, err: (e as Error).message }));
        }
      }
    } catch (e) {
      logger.error('timer tick failed', { err: (e as Error).message });
    } finally {
      passRunning = false;
    }
    return nextIntervalMs;
  };
  const runTick = async () => {
    if (stopped) return;
    const next = await runPass();
    if (!stopped) setTimeout(runTick, next);
  };
  setTimeout(runTick, config.timerTickIntervalMs);
  // an async job was just queued in this process: run a pass now (debounced) instead of waiting for the next tick
  let kicking = false;
  onKick(() => {
    if (kicking || stopped) return;
    kicking = true;
    setTimeout(() => { kicking = false; void runPass(); }, 25);
  });
  logger.info('timer worker scheduler enabled', { role: config.role, intervalMs: config.timerTickIntervalMs, batchSize: config.timerBatchSize });
} else {
  logger.info('timer worker scheduler disabled (stateless API role)', { role: config.role });
}

// the task-allocation runner: assigns tasks flagged 'pending' (modules/allocation). A loop of its own, so it can run in a dedicated replica (ROLE=allocator) apart from
// the API and the timer worker. One runner works a workspace at a time (a short lease), so replicas never decide the same task twice.
if (isAllocatorEnabled) {
  let allocating = false;
  const allocatePass = async () => {
    if (allocating || stopped) return;
    allocating = true;
    try {
      const tenants = await store.repo<Tenant>(Collections.tenants).query((t) => t.status === 'active');
      for (const tenantId of new Set([config.defaultTenant, ...tenants.map((t) => t.id)])) {
        const release = await coordinator().claim(`allocator:${tenantId}`, 30_000);
        if (!release) continue;                                                       // another replica is working this workspace
        try {
          // bounded batches, repeated while there is more new work and the time budget (kept well inside the 30 s lease) lasts; the rest waits for the next pass
          const started = Date.now();
          for (;;) {
            const r = await new AllocationService(makeContext({ store, tenantId })).runOnce(config.allocatorBatchSize);
            if (!r.more || stopped || Date.now() - started > config.allocatorPassBudgetMs) break;
          }
        }
        catch (e) { logger.error('task allocation failed', { tenantId, err: (e as Error).message }); }
        finally { await release(); }
      }
    } catch (e) { logger.error('task allocation pass failed', { err: (e as Error).message }); }
    finally { allocating = false; }
  };
  const loop = async () => { if (stopped) return; await allocatePass(); if (!stopped) setTimeout(loop, config.allocatorIntervalMs); };
  setTimeout(loop, config.allocatorIntervalMs);
  let allocKick = false;
  onAllocatorKick(() => { if (allocKick || stopped) return; allocKick = true; setTimeout(() => { allocKick = false; void allocatePass(); }, 50); });
  logger.info('task allocation runner enabled', { role: config.role, intervalMs: config.allocatorIntervalMs });
}

// every replica re-applies the stored limits to its own live pools: an admin change made on ANY replica reaches all of them
// (limits live in the shared store, not in memory), and a replica joining/leaving rebalances each workspace's share.
setInterval(() => { new PlatformLimitsService(store).applyLive().catch((e) => logger.error('limits reconcile failed', { err: (e as Error).message })); }, config.cluster.heartbeatMs).unref?.();

// graceful stop: give the replica's workspace slots back at once instead of waiting for them to expire
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => { stopped = true; server.close(); coordinator().stop().finally(() => process.exit(0)); });
}

const iamCtx = makeContext({ store, tenantId: config.defaultTenant });
new IamService(iamCtx).ensureSeeded(config.adminInitialPassword).then(async ({ seededAdmin }) => {
  await new TenantService(iamCtx).seedDefaultsIfEmpty();   // default workspace first, so the platform-admin bootstrap has somewhere to land
  await ensurePlatformAdmin(store, new Date().toISOString(), () => iamCtx.newId());
  await migrateAnalyticsAll(store);                        // seed migrations (built-in analytics APIs): each version once per workspace, nothing on a plain restart
  if (seededAdmin) logger.info('seeded initial admin user', { username: 'admin', note: 'set ADMIN_INITIAL_PASSWORD before first boot in anything but local dev' });
  server.listen(config.port, () => {
    logger.info('jbpm-engine server up', { port: config.port, ws: config.wsPath, store: config.store, role: config.role, dataDir: config.dataDir, sso: !!config.oidc.issuer, localLogin: config.localLogin });
  });
}).catch((e) => { logger.error('IAM seeding failed — refusing to start', { err: (e as Error).message }); process.exit(1); });
