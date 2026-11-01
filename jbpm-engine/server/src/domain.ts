// Domain entities — see docs/04-data-model.md. Persisted via Repository<T>.
import type { EngineProject, EngineVar } from './sdk/index.ts';
import type { Entity } from './store/repository.ts';
import type { Problem } from './modules/validation/rules.ts';

export interface Audited { createdAt: string; createdBy: string; updatedAt: string; updatedBy: string; }

export interface WorkflowPermission { role: string; actions: ('view' | 'edit' | 'deploy' | 'run' | 'admin')[]; }

export interface GlobalErrorHandlerRule {
  id: string;
  /** Error type/code: 'SERVICE_ERROR' | 'SCRIPT_ERROR' | 'RULE_ERROR' | 'TASK_ERROR' | '*' | custom code */
  errorType: string;
  /** Process ID in this project that executes to handle this error type */
  processId: string;
  /** Resolution strategy when error occurs */
  strategy: 'spawn' | 'repair-and-resume' | 'compensate-and-abort';
  /** Mapping from error process output variable to original instance variable */
  outputMappings?: Record<string, string>;
  /** Whether unhandled errors inside the error handler process rethrow to system log */
  rethrowOnFailure?: boolean;
}

export interface GlobalErrorHandlerConfig {
  enabled: boolean;
  /** Configured error handler rules by error type */
  rules?: GlobalErrorHandlerRule[];
  /** Legacy single-process fallback (kept for backward compatibility) */
  processId?: string;
  strategy?: 'spawn' | 'repair-and-resume' | 'compensate-and-abort';
  outputMappings?: Record<string, string>;
  filter?: string[];
  rethrowOnFailure?: boolean;
}

export interface WorkflowValidationSummary {
  hasErrors: boolean;
  errorCount: number;
  warningCount: number;
  problems?: Problem[];
}

export interface Workflow extends Entity, Audited {
  id: string; tenantId: string;
  name: string; key: string; description?: string;
  defaultBranchId: string;
  permissions: WorkflowPermission[];
  variables: EngineVar[];
  archived?: boolean;
  /** Project-organizing folder (see Folder below); undefined/null means "root", no folder. */
  folderId?: string | null;
  /** Instance creation mode allowed for this project ('both' | 'case-only' | 'process-only') */
  instanceCreationMode?: 'both' | 'case-only' | 'process-only';
  /** Arbitrary project-level environment variables deployed to all environments */
  env?: Record<string, string>;
  /** Project-level Global Error Handler configuration */
  globalErrorHandler?: GlobalErrorHandlerConfig;
  /** Cached validation summary for project head draft */
  validationSummary?: WorkflowValidationSummary;
}

/** Organizes Workflows into a tree for the Projects page — purely presentational, no effect on
 *  execution/permissions (a workflow's folder is not consulted by any authz check). */
export interface Folder extends Entity, Audited {
  id: string; tenantId: string;
  name: string;
  parentId?: string | null;
}

export interface Branch extends Entity {
  id: string; tenantId: string; workflowId: string;
  name: string;
  forkedFromVersionId?: string;
  headVersionId?: string;
  protected?: boolean;
  createdAt: string; createdBy: string;
}

export type VersionState = 'draft' | 'published';
export interface Version extends Entity {
  id: string; tenantId: string; workflowId: string; branchId: string;
  number: number; label?: string; state: VersionState;
  engine: EngineProject;
  parentVersionId?: string;
  message?: string;
  createdAt: string; createdBy: string;
}

export type DeploymentStatus = 'active' | 'inactive' | 'archived';
export interface Deployment extends Entity {
  id: string; tenantId: string; workflowId: string; versionId: string; branchId: string;
  engine: EngineProject;
  env: Record<string, string>;
  globalErrorHandler?: GlobalErrorHandlerConfig;
  tags: string[];
  status: DeploymentStatus;
  environment: string;
  versionNumber?: number; versionLabel?: string;   // shown as "Version" in the instance list
  deployedAt: string; deployedBy: string;
  undeployedAt?: string; archivedAt?: string;
  snapshot?: {
    frozenAt: string;
    versionNumber?: number;
    versionLabel?: string;
    frozen: boolean;
  };
}

export type InstanceStatus = 'running' | 'waiting' | 'completed' | 'aborted' | 'failed' | 'suspended';
export type TokenState = 'active' | 'waiting';
// 'multiInstance': a forEach node waiting on 2+ children at once (a plain 'child' wait only ever
// tracks one). No `ref` — siblings are found by querying for Instance.parentTokenId === this token's
// id (see execution-engine.ts's tryResumeParent/tryFailParent), so nothing about which children are
// still outstanding needs to be stored on the token itself.
export interface WaitSpec { kind: 'timer' | 'task' | 'message' | 'signal' | 'condition' | 'child' | 'multiInstance' | 'async' | 'adhoc'; ref?: string; dueAt?: string; }
export interface Token {
  id: string; nodeId: string; state: TokenState; scopeId?: string; waitFor?: WaitSpec; enteredAt: string;
  /** set when an async job released this token: the node now runs for real (it is not parked a second time) */
  asyncReady?: boolean;
  /** an event sub-process waiting for its trigger: it lives as long as the instance, but never keeps the instance alive by itself */
  listener?: boolean;
  /** the node's SLA clock, started when the node was triggered (it survives an async hop) */
  sla?: NodeSla;
}
/** jBPM "SLA Due Date" (customSLADueDate) compliance for one node visit */
export interface NodeSla { dueAt: string; status: 'pending' | 'met' | 'violated'; at?: string }
export interface NodeVisit { tokenId: string; nodeId: string; type: string; enteredAt: string; exitedAt?: string; outcome?: string; sla?: NodeSla; }
export interface Instance extends Entity {
  id: string; tenantId: string; deploymentId: string; workflowId: string;
  processId?: string;              // which process (definition) in the deployment this instance runs
  numericId?: string;              // numericIdOf(id): the long a Java script sees as ProcessInstance.getId(); accepted wherever the id is
  correlationKey?: string;
  status: InstanceStatus;
  variables: Record<string, unknown>;
  tokens: Token[];
  history: NodeVisit[];
  /** per-node count of visits dropped from `history` when it outgrew the cap (see engine/history-cap.ts); keeps join counting and the diagram right */
  historyCompacted?: Record<string, number>;
  /** readable title rendered once at start from the process's `description` template (`#{var}` filled from the start variables) */
  /** a transaction sub-process ended through a cancel end event (compensation ran); the parent sees TRANSACTION_CANCELLED */
  cancelled?: boolean;
  /** complex gateway joins: tokens arrived in the current round and whether the activation condition already fired */
  joinState?: Record<string, { count: number; fired: boolean }>;
  description?: string;
  /** process-level SLA (the process's `slaDueDate`): pending -> met when it completes in time, violated when the job fires first */
  sla?: NodeSla;
  error?: { nodeId: string; message: string; stack?: string; at: string };
  parentInstanceId?: string; parentTokenId?: string;
  // Set when spawned by a call activity with independent:true (fire-and-forget) — this child's
  // lifecycle is decoupled from its parent's: it survives the parent's completion/abort instead of
  // being cascade-torn-down with it (see execution-engine.ts's abortDescendants).
  independent?: boolean;
  // Compensation stack: activities completed successfully that have a compensation handler attached,
  // in completion order. A compensate throw runs the matching entries in reverse (LIFO).
  compensations?: Array<{ host: string; handler: string }>;
  /** Set if this instance is running as a Global Error Handler (prevents recursion loops) */
  isErrorHandler?: boolean;
  /** ID of the failed instance this error handler instance is processing */
  handlingInstanceId?: string;
  startedAt: string; startedBy: string; endedAt?: string;
}

// 'exited' = jBPM's own term for "the process moved on without you" — the task's host activity was
// cancelled by an interrupting boundary event, or its instance reached a terminal state (completed
// via a terminate/other branch, aborted, or failed) while this task was still open. Distinct from
// 'skipped' (an explicit human/API action on the task itself) and 'error' (the task's OWN execution
// failed) — 'exited' is something that happened to the PROCESS, not to the task.
export type TaskStatus = 'created' | 'reserved' | 'inprogress' | 'completed' | 'skipped' | 'error' | 'exited' | 'failed' | 'suspended';
export interface Task extends Entity {
  id: string; tenantId: string; instanceId: string; tokenId: string; nodeId: string;
  name: string; formName?: string; group?: string; assignee?: string;
  /** may act on this task (reassign/claim/complete) regardless of group/assignee/excludedOwners. */
  businessAdmin?: string;
  /** several users / groups offered the task (jBPM ActorId / GroupId lists); `group` and `assignee` above keep working */
  actors?: string[]; groups?: string[];
  /** groups whose members may reassign and manage the task; people who merely follow it (no right to claim or complete) */
  businessAdminGroups?: string[]; stakeholders?: string[];
  locale?: string; createdBy?: string;
  /** swimlane name (jBPM): the task goes to whoever completed the previous task of the same lane, when `autoClaim` is on */
  swimlane?: string;
  /** users who may NOT claim/complete this task even if they're in `group` (segregation of duties,
   *  e.g. the claim's own submitter can't also approve it) — not enforced against `businessAdmin`. */
  excludedOwners?: string[];
  /** higher = more urgent; used for inbox sort order only, no behavioral effect. */
  priority?: number;
  status: TaskStatus;
  inputs: Record<string, unknown>; outputs?: Record<string, unknown>;
  createdAt: string; claimedAt?: string; dueAt?: string; completedAt?: string; completedBy?: string;
}

export interface TimerJob extends Entity {
  id: string; tenantId: string; instanceId: string; tokenId: string; nodeId: string;
  kind: 'duration' | 'cycle' | 'date' | 'start' | 'async' | 'sla' | 'deadline';
  dueAt: string; cycle?: string; fired: number;
  // kind 'async' (jBPM's "Is Async" / a background start): run the parked token's node in the worker. A job that could not
  // run (store/lock/engine exception — not a business error, which follows the normal error model) is retried.
  attempts?: number; maxAttempts?: number; retryDelayMs?: number; lastError?: string;
  // kind 'deadline' (user task NotStarted/NotCompleted Reassign/Notify): act on a task that is still open at dueAt
  taskId?: string; deadline?: { type: 'notStartedReassign' | 'notCompletedReassign' | 'notStartedNotify' | 'notCompletedNotify' | 'resumeTask'; action: Record<string, string> };
  status: 'scheduled' | 'fired' | 'cancelled';
  // kind 'start' (timer/cron start event): begin a new instance instead of resuming a token.
  deploymentId?: string; processId?: string;
}

export interface AuditEvent extends Entity {
  id: string; tenantId: string; at: string; actor: string; kind: string;
  workflowId?: string; deploymentId?: string; instanceId?: string; taskId?: string; nodeId?: string;
  data?: Record<string, unknown>;
}

/**
 * A persisted, queryable failure record.
 *
 * `Instance.error` only ever holds the MOST RECENT failure for an instance, which is enough to
 * render a status badge but useless as an operational work queue: it can't be listed across
 * instances, can't be acknowledged, and is overwritten by the next failure. ExecutionError is the
 * append-only log that backs the Execution Errors screen — one row per occurrence, acknowledged
 * explicitly so an unacked list is a real queue rather than noise.
 */
export interface ExecutionError extends Entity {
  id: string; tenantId: string;
  /** what failed — mirrors the filter facet on the Execution Errors screen */
  type: 'process' | 'task' | 'job' | 'integration';
  instanceId?: string; taskId?: string; jobId?: string;
  workflowId?: string; deploymentId?: string; processId?: string;
  nodeId?: string; nodeName?: string; nodeType?: string;
  message: string; stack?: string;
  at: string;
  /** repeat count for an identical (instance, node, message) triple — avoids flooding the list */
  occurrences: number;
  /** unacknowledged until someone takes ownership; ack records who and when */
  acknowledged: boolean; acknowledgedBy?: string; acknowledgedAt?: string;
}

/** A comment on a task. Separate entity (not a Task field) so it can be paged and audited. */
export interface TaskComment extends Entity {
  id: string; tenantId: string; taskId: string;
  author: string; body: string; at: string;
}

/** An attachment / file evidence associated with a task (e.g. proof of death, medical records, ID). */
export interface TaskAttachment extends Entity {
  id: string; tenantId: string; taskId: string;
  name: string; mimeType?: string; url?: string; sizeBytes?: number;
  author: string; at: string;
}

/** In-app notification. Persisted so the bell survives a reload and "mark read" is real state. */
export interface Notification extends Entity {
  id: string; tenantId: string; userId: string;
  kind: 'task-assigned' | 'sla-at-risk' | 'sla-breached' | 'instance-failed'
      | 'deployment-succeeded' | 'deployment-failed' | 'task-reminder';
  title: string; body?: string;
  /** where clicking it should land — kept as a route path so the client needs no mapping table */
  link?: string;
  instanceId?: string; taskId?: string; deploymentId?: string;
  read: boolean; at: string;
}

/** Singleton row of global configuration (id is always 'system'). */
export interface SystemSettings extends Entity {
  id: string; tenantId: string;
  defaultPageSize: number;                 // 10 | 20 | 50 | 100
  instanceRetentionDays: number;
  auditRetentionDays: number;
  allowRunningVariableEdits: boolean;
  executorIntervalSeconds: number;
  timerBatchSize?: number;                 // max due timers claimed & processed per batch (default: 50)
  defaultJobRetries: number;
  jobRetryBackoffMultiplier?: number;      // backoff multiplier for retryable jobs (default: 2, min: 1)
  scriptTimeoutSeconds?: number;           // max runtime for script execution in seconds (default: 5, min: 1)
  slaWarnThresholdPct: number;             // e.g. 80 → amber at 80% of time-to-due elapsed
  defaultTaskSlaHours?: number;            // fallback task SLA deadline in hours if not set in node (default: 48, min: 1)
  autoReleaseClaimedTaskHours?: number;    // auto-release idle claimed tasks after X hours back to group pool (0 = disabled)
  httpTimeoutSeconds?: number;             // outbound REST / service task HTTP timeout in seconds (default: 10, min: 1)
  outboundAllowlist?: string;              // comma-separated hostnames or .domain suffixes allowed for outbound HTTP
  historyAuditLevel?: 'full' | 'activity' | 'minimal'; // audit trail verbosity (default: 'full')
  logLevel?: 'debug' | 'info' | 'warn' | 'error';       // system log level (default: 'info')
  sessionTimeoutHours: number;
  emailEnabled: boolean;
  emailFrom?: string; smtpHost?: string; smtpPort?: number;
  smtpUser?: string; smtpPassword?: string; smtpPasswordConfigured?: boolean;
  /** System-wide instance creation mode allowed ('both' | 'case-only' | 'process-only') */
  instanceCreationMode?: 'both' | 'case-only' | 'process-only';
  /** per-tenant resource quotas — undefined/0 means unlimited (default, so existing tenants are
   *  unaffected until an admin opts in). Enforced at the point of creation, not retroactively. */
  maxActiveInstances?: number;   // top-level (root) instances concurrently running/waiting
  maxActiveTimers?: number;      // scheduled TimerJobs (boundary/catch timers) at once
  maxConcurrentScripts?: number; // DEPRECATED alias of scriptPoolSize (0 = platform default)
  /** what happens when maxConcurrentScripts executions are already running: 'queue' (wait, bounded) or 'reject'
   *  (QUOTA_EXCEEDED immediately). Unset = the SCRIPT_OVERFLOW_MODE env default. */
  scriptOverflowMode?: 'queue' | 'reject';
  /** requested script parallelism = isolate-pool size (memory ≈ size × 64 MB worst case). `maxConcurrentScripts` is its
   *  deprecated alias. Always clamped by the platform caps (modules/platform/limits.ts). */
  scriptPoolSize?: number;
  /** how many script executions may wait when all isolates are busy (queue mode); clamped by the platform cap. */
  scriptQueueMax?: number;
  updatedAt?: string; updatedBy?: string;
}

// Collection names (repository keys)
// ---- IAM: users, groups, roles/permissions (single-tenant — see docs/07-security.md) ----
export interface Role extends Entity {
  id: string; tenantId: string;
  name: string;   // 'admin' | 'author' | 'release' | 'operator' | 'worker' | 'viewer', or a custom name
  /** action strings this role grants (e.g. 'workflow:edit', 'instance:abort'); '*' grants everything. */
  permissions: string[];
}

export interface Group extends Entity {
  id: string; tenantId: string;
  name: string;   // matches the plain-string names userTask.group / Task.group already use
  description?: string;
}

export interface User extends Entity {
  id: string; tenantId: string;
  username: string;         // login name, unique within the tenant
  passwordHash: string;     // scrypt-hashed; never serialized back out by the API
  roles: string[];          // Role names
  groups: string[];         // Group names
  active: boolean;
  createdAt: string;
  /** contact address; for a self-registered account it equals `username` */
  email?: string;
  /** false until the mailbox is proven (verification link or password-reset link). Absent = legacy/admin-provisioned = trusted. */
  emailVerified?: boolean;
  /** brute-force protection */
  failedLogins?: number;
  lockedUntil?: string | null;
  /** single-use, hashed, expiring tokens (SHA-256 hex) */
  verificationHash?: string | null;
  verificationExpiresAt?: string | null;
  passwordResetHash?: string | null;
  passwordResetExpiresAt?: string | null;
  passwordResetSentAt?: string | null;
  /** tokens issued before this instant are rejected (password changed/reset) */
  passwordChangedAt?: string | null;
  displayName?: string;
  /** temp-password onboarding: the stored password is an emailed temporary one; the first sign-in must replace it */
  mustResetPassword?: boolean;
  tempPasswordExpiresAt?: string | null;
  /** emailed one-time sign-in code (hashed) */
  otpHash?: string | null;
  otpExpiresAt?: string | null;
  otpAttempts?: number;
  otpSentAt?: string | null;
  tosAcceptedAt?: string | null;
}

/** Metered usage of one workspace in one calendar period (UTC): process starts per day / ISO week / month. */
export interface Usage extends Entity {
  id: string; tenantId: string;
  period: 'day' | 'week' | 'month';
  key: string;            // 2026-10-31 | 2026-10-26 (Monday of the week) | 2026-10
  count: number;
  resetsAt: string;
}

/** A self-registration that has not been confirmed yet: the person has been emailed a temporary password, and the
 *  account does NOT exist until they sign in with it (so an unconfirmed address can neither squat nor be matched to seats). */
export interface PendingRegistration extends Entity {
  id: string; tenantId: string;
  email: string;
  displayName: string;
  tempHash: string;            // scrypt hash of the emailed temporary password
  expiresAt: string;
  createdAt: string;
  lastSentAt: string;
  failedAttempts?: number;
  lockedUntil?: string | null;
  tosAcceptedAt?: string | null;
}

// ---- Multi-tenancy & Workspaces ----
export type TenantStatus = 'active' | 'pending_verification' | 'suspended' | 'deleted';
export type TenantPlan = 'trial' | 'starter' | 'pro' | 'custom' | 'enterprise';

export interface TenantSettings {
  timezone?: string;
  dateFormat?: string;
  brandName?: string;
  brandColor?: string;
  [key: string]: unknown;
}

export interface Tenant extends Entity {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  status: TenantStatus;
  plan: string;
  planExpiresAt?: string | null;
  settings?: TenantSettings;
  ownerEmail?: string;
  ownerName?: string;
  createdAt: string;
  updatedAt: string;
}

export type TenantMemberRole = 'system_admin' | 'owner' | 'admin' | 'developer' | 'operator' | 'worker' | 'viewer';
export type TenantMemberStatus = 'active' | 'invited' | 'suspended';

export interface TenantMember extends Entity {
  id: string;
  tenantId: string;
  userId: string;
  email?: string;
  role: string;
  status: TenantMemberStatus;
  displayName?: string | null;
  permissions?: string[];
  joinedAt: string;
  lastActiveAt?: string;
  /** invitation tracking (status 'invited'): who invited, SHA-256 of the single-use token, and its expiry */
  invitedBy?: string;
  invitationTokenHash?: string | null;
  invitationExpiresAt?: string | null;
}

export interface PublicPlanContactConfig {
  type: 'email' | 'url';
  value: string;
  label?: string;
}

export interface Plan extends Entity {
  id: string;
  tenantId: string;
  key: string;
  name: string;
  description: string;
  isDefault: boolean;
  isCustom: boolean;
  trialDays: number | null;
  contactConfig?: PublicPlanContactConfig | null;
  limits?: Record<string, unknown>;
  features: string[];
  /** not listed on the public pricing page (legacy flag; `status: 'hidden'` is the real thing) */
  hidden?: boolean;
  /** active: workspaces can select it · disabled: listed, cannot be selected · upcoming: listed as coming soon ·
   *  hidden: not listed, an administrator assigns it. Absent = active (or hidden when the legacy `hidden` flag is set). */
  status?: 'active' | 'disabled' | 'upcoming' | 'hidden';
  /** display order (ascending) */
  sortOrder?: number;
}

export const Collections = {
  workflows: 'workflows', folders: 'folders', branches: 'branches', versions: 'versions', deployments: 'deployments',
  instances: 'instances', tasks: 'tasks', timers: 'timers', audit: 'audit',
  users: 'users', groups: 'groups', roles: 'roles',
  tenants: 'tenants', tenantMembers: 'tenantMembers', plans: 'plans',
  errors: 'errors', comments: 'comments', notifications: 'notifications', settings: 'settings',
  pendingRegistrations: 'pendingRegistrations', usage: 'usage',
  taskAttachments: 'task_attachments',
} as const;
