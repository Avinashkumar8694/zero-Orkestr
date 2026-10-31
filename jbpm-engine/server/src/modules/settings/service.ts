// Global configuration: one singleton SystemSettings row (id 'system' per tenant). Reads always
// succeed — a missing row yields the documented defaults — so the client never needs a seed step.
import { effectiveLimitsFor, assertWithinCaps } from '../platform/limits.ts';
import type { AppContext } from '../../context.ts';
import { Collections, type SystemSettings } from '../../domain.ts';
import { validation } from '../../infra/errors.ts';
import { encryptAtRest, decryptAtRest } from '../../infra/crypto.ts';
import { logger } from '../../infra/logger.ts';
import { config } from '../../infra/config.ts';

export const DEFAULT_SETTINGS: Omit<SystemSettings, 'id' | 'tenantId'> = {
  defaultPageSize: 20,
  instanceRetentionDays: 90,
  auditRetentionDays: 365,
  allowRunningVariableEdits: true,
  executorIntervalSeconds: 5,
  timerBatchSize: 50,
  defaultJobRetries: 3,
  jobRetryBackoffMultiplier: 2,
  scriptTimeoutSeconds: 5,
  slaWarnThresholdPct: 80,
  defaultTaskSlaHours: 48,
  autoReleaseClaimedTaskHours: 0,
  httpTimeoutSeconds: 10,
  outboundAllowlist: '',
  historyAuditLevel: 'full' as const,
  logLevel: 'info' as const,
  sessionTimeoutHours: 8,
  emailEnabled: false,
  instanceCreationMode: 'both' as const,
  // 0 = unlimited — see SystemSettings' own doc comment (domain.ts).
  maxActiveInstances: 0,
  maxActiveTimers: 0,
  maxConcurrentScripts: 0,
};

const PAGE_SIZES = [10, 20, 50, 100];

// keys a workspace admin may write; everything else is read-only (id/tenantId/audit stamps) or platform-only (caps).
const EDITABLE: ReadonlySet<string> = new Set([
  'defaultPageSize', 'instanceRetentionDays', 'auditRetentionDays', 'allowRunningVariableEdits', 'executorIntervalSeconds',
  'defaultJobRetries', 'slaWarnThresholdPct', 'sessionTimeoutHours', 'emailEnabled', 'emailFrom', 'smtpHost', 'smtpPort',
  'maxActiveInstances', 'maxActiveTimers', 'maxConcurrentScripts', 'scriptPoolSize', 'scriptQueueMax', 'scriptOverflowMode',
  'timerBatchSize', 'jobRetryBackoffMultiplier', 'scriptTimeoutSeconds', 'defaultTaskSlaHours', 'autoReleaseClaimedTaskHours',
  'httpTimeoutSeconds', 'historyAuditLevel', 'logLevel', 'instanceCreationMode', 'smtpUser', 'smtpPassword',
  'outboundAllowlist',   // the ROUTE restricts who may change it (platform administrator only — it widens the SSRF guard)
]);
// echoed back by clients that PUT the whole object they GET — harmless, silently dropped
const ECHOED: ReadonlySet<string> = new Set(['id', 'tenantId', 'updatedAt', 'updatedBy', 'effectiveScriptConcurrency', 'effectiveScriptOverflowMode', 'smtpPasswordConfigured', 'effectiveLimits', 'limitCaps']);

export class SettingsService {
  constructor(private ctx: AppContext) {}
  private repo() { return this.ctx.store.repo<SystemSettings>(Collections.settings); }
  private rowId() { return `system:${this.ctx.tenantId}`; }

  /** The stored row of THIS workspace, if any. One row PER workspace; the legacy single row id 'system' is still read for the
   *  workspace it names, so existing data survives (it used to be shared by every workspace, so one save clobbered another's). */
  private async stored(): Promise<SystemSettings | undefined> {
    const own = await this.repo().get(this.rowId());
    if (own) return { ...own, id: 'system' };
    const legacy = await this.repo().get('system');
    return legacy && legacy.tenantId === this.ctx.tenantId ? legacy : undefined;
  }

  /** Secrets (SMTP password, outbound allow-list) are masked unless the reader administers the workspace. */
  async get(isAdmin = true): Promise<SystemSettings> {
    const existing = await this.stored();
    if (existing) {
      return {
        ...existing,
        outboundAllowlist: isAdmin ? existing.outboundAllowlist : (existing.outboundAllowlist ? '***' : ''),
        smtpPasswordConfigured: Boolean(existing.smtpPassword),
        smtpPassword: existing.smtpPassword ? '••••••••' : undefined,
      };
    }
    return { id: 'system', tenantId: this.ctx.tenantId, ...DEFAULT_SETTINGS };
  }

  /** Internal retrieval for background runners (e.g. mail delivery) with decrypted secrets */
  async getDecrypted(): Promise<SystemSettings> {
    const existing = await this.stored();
    if (existing) {
      return { ...existing, smtpPassword: existing.smtpPassword ? decryptAtRest(existing.smtpPassword) : undefined };
    }
    return { id: 'system', tenantId: this.ctx.tenantId, ...DEFAULT_SETTINGS };
  }

  async update(patch: Partial<SystemSettings>, actor: string): Promise<SystemSettings> {
    patch = { ...patch };
    for (const k of Object.keys(patch)) {
      if (ECHOED.has(k)) delete (patch as Record<string, unknown>)[k];
      else if (!EDITABLE.has(k)) throw validation(`"${k}" is not a workspace setting (read-only or platform-controlled)`, { field: k });
    }
    if (patch.defaultPageSize !== undefined && !PAGE_SIZES.includes(patch.defaultPageSize)) {
      throw validation(`defaultPageSize must be one of ${PAGE_SIZES.join(', ')}`);
    }
    if (patch.instanceCreationMode !== undefined && !['both', 'case-only', 'process-only'].includes(patch.instanceCreationMode)) {
      throw validation(`instanceCreationMode must be 'both', 'case-only', or 'process-only'`);
    }
    for (const k of ['instanceRetentionDays', 'auditRetentionDays', 'executorIntervalSeconds', 'timerBatchSize', 'defaultJobRetries', 'sessionTimeoutHours', 'scriptTimeoutSeconds', 'jobRetryBackoffMultiplier', 'httpTimeoutSeconds', 'defaultTaskSlaHours'] as const) {
      const v = patch[k];
      if (v !== undefined && (typeof v !== 'number' || v <= 0)) throw validation(`${k} must be a positive number`);
    }
    if (patch.autoReleaseClaimedTaskHours !== undefined && (typeof patch.autoReleaseClaimedTaskHours !== 'number' || patch.autoReleaseClaimedTaskHours < 0)) {
      throw validation('autoReleaseClaimedTaskHours must be a non-negative number');
    }
    if (patch.historyAuditLevel !== undefined && !['full', 'activity', 'minimal'].includes(patch.historyAuditLevel)) {
      throw validation(`historyAuditLevel must be 'full', 'activity', or 'minimal'`);
    }
    if (patch.logLevel !== undefined) {
      if (!['debug', 'info', 'warn', 'error'].includes(patch.logLevel)) {
        throw validation(`logLevel must be 'debug', 'info', 'warn', or 'error'`);
      }
      // the log level is process-wide, so only the default (platform's own) workspace may move it
      if (this.ctx.tenantId === config.defaultTenant) logger.setLevel(patch.logLevel);
    }
    if (patch.slaWarnThresholdPct !== undefined && (patch.slaWarnThresholdPct < 1 || patch.slaWarnThresholdPct > 100)) {
      throw validation('slaWarnThresholdPct must be between 1 and 100');
    }
    // limits: integer/enum validation + the platform caps (a workspace may always go lower, never above the cap)
    // caps = platform global ∩ per-workspace override ∩ the workspace's PLAN (a workspace can only go lower)
    assertWithinCaps(patch, (await effectiveLimitsFor(this.ctx)).caps);
    const currentRaw = (await this.stored()) || { id: 'system', tenantId: this.ctx.tenantId, ...DEFAULT_SETTINGS };

    // Encrypt secrets at rest before persisting
    const preparedPatch = { ...patch };
    if (preparedPatch.smtpPassword) {
      if (preparedPatch.smtpPassword === '••••••••' || !preparedPatch.smtpPassword.trim()) {
        delete preparedPatch.smtpPassword; // preserve current
      } else {
        preparedPatch.smtpPassword = encryptAtRest(preparedPatch.smtpPassword);
      }
    }
    const next: SystemSettings = {
      ...currentRaw, ...preparedPatch,
      id: 'system', tenantId: this.ctx.tenantId,
      updatedAt: this.ctx.clock(), updatedBy: actor,
    };
    // null = clear back to the platform default
    for (const k of ['scriptOverflowMode', 'scriptPoolSize', 'scriptQueueMax'] as const) if (next[k] == null) delete next[k];
    await this.repo().put({ ...next, id: this.rowId() });
    await this.ctx.audit({ actor, kind: 'settings.updated', data: { changed: Object.keys(patch) } });
    return this.get();
  }
}
