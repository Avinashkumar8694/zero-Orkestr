// AppContext bundles the injectable dependencies every service/engine needs. Constructed once at boot
// (and freshly per-test with a MemoryStore + fakeClock for determinism).
import type { Store } from './store/repository.ts';
import { systemClock, newId as defaultNewId, type Clock } from './infra/ids.ts';
import { Collections, type AuditEvent } from './domain.ts';

export interface AppContext {
  store: Store;
  clock: Clock;
  newId: () => string;
  tenantId: string;
  /** set by the HTTP layer for the platform administrator: plan limits and trial expiry do not apply to them */
  planExempt?: boolean;
  audit: (e: Omit<AuditEvent, 'id' | 'tenantId' | 'at'>) => Promise<void>;
}

export function makeContext(opts: { store: Store; tenantId: string; clock?: Clock; newId?: () => string }): AppContext {
  const clock = opts.clock || systemClock;
  const newId = opts.newId || (() => defaultNewId());
  const ctx: AppContext = {
    store: opts.store,
    clock,
    newId,
    tenantId: opts.tenantId,
    audit: async (e) => {
      try {
        // one settings row PER workspace (id `system:<tenant>`); the legacy shared row `system` still applies to the workspace it names
        const settingsRepo = opts.store.repo<any>(Collections.settings);
        const own = await settingsRepo.get(`system:${opts.tenantId}`);
        const legacy = own ? undefined : await settingsRepo.get('system');
        const settings = own ?? (legacy && legacy.tenantId === opts.tenantId ? legacy : undefined);
        const level = settings?.historyAuditLevel || 'full';
        if (level === 'minimal') {
          const allowed = ['instance.started', 'instance.aborted', 'instance.failed', 'deployment.activated', 'deployment.undeployed', 'settings.updated', 'user.', 'role.', 'group.', 'error.'];
          if (!allowed.some((prefix) => e.kind.startsWith(prefix) || e.kind === prefix)) return;
        } else if (level === 'activity') {
          const skipped = ['instance.variables.updated', 'task.reminded', 'job.rescheduled'];
          if (skipped.includes(e.kind)) return;
        }
      } catch {
        // If settings read fails, continue to record audit event
      }
      const ev: AuditEvent = { id: newId(), tenantId: opts.tenantId, at: clock(), ...e };
      await opts.store.repo<AuditEvent>(Collections.audit).put(ev);
    },
  };
  return ctx;
}
