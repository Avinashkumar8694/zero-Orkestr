// Runs the analytics seed migrations for a workspace, or for every workspace (startup). Never throws: a failed seed must not stop
// the server or a signup — the migration simply stays pending and is retried on the next start.
import type { Store } from '../store/repository.ts';
import { makeContext } from '../context.ts';
import { Collections, type Tenant } from '../domain.ts';
import { config } from '../infra/config.ts';
import { logger } from '../infra/logger.ts';
import { resolveWorkflowServiceStore } from '../workflow-service/store/index.ts';
import { runAnalyticsSeedMigrations } from './service.ts';

export async function migrateAnalyticsFor(store: Store, tenantId: string): Promise<void> {
  try {
    const r = await runAnalyticsSeedMigrations(makeContext({ store, tenantId }), resolveWorkflowServiceStore(store));
    if (r.created.length) logger.info('analytics seed applied', { tenantId, versions: r.applied, created: r.created.length });
  } catch (e) { logger.warn('analytics seed failed (will retry next start)', { tenantId, err: (e as Error).message }); }
}

/** startup: the default workspace and every active one */
export async function migrateAnalyticsAll(store: Store): Promise<void> {
  const tenants = await store.repo<Tenant>(Collections.tenants).query((t) => t.status === 'active');
  for (const id of new Set([config.defaultTenant, ...tenants.map((t) => t.id)])) await migrateAnalyticsFor(store, id);
}
