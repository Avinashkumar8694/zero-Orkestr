// Client-side mirrors of the server domain (docs/04-data-model.md). Kept intentionally loose.
export interface EngineVar { name: string; type: string; }

export interface GlobalErrorHandlerRule {
  id: string;
  errorType: string;
  processId: string;
  strategy: 'spawn' | 'repair-and-resume' | 'compensate-and-abort';
  outputMappings?: Record<string, string>;
  rethrowOnFailure?: boolean;
}

export interface GlobalErrorHandlerConfig {
  enabled: boolean;
  rules?: GlobalErrorHandlerRule[];
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

export interface Workflow {
  id: string; name: string; key: string; description?: string;
  defaultBranchId: string;
  /** stored server-side but never enforced by any authz check (superseded by the IAM role/permission
   *  model) — kept here only because the field still round-trips through the API, no UI reads it. */
  permissions: any[];
  variables: EngineVar[];
  createdAt: string; updatedAt: string; archived?: boolean;
  /** Which Folder (Projects-page tree) this project is organized under; null/undefined = root/unfiled. */
  folderId?: string | null;
  /** Instance creation mode: 'both' | 'case-only' | 'process-only' | 'none' */
  instanceCreationMode?: 'both' | 'case-only' | 'process-only' | 'none';
  /** Project-level environment variables deployed to all environments */
  env?: Record<string, string>;
  /** Project-level Global Error Handler configuration */
  globalErrorHandler?: GlobalErrorHandlerConfig;
  /** Cached validation summary for visual danger indicators */
  validationSummary?: WorkflowValidationSummary;
}
/** Organizes Workflows into a tree on the Projects page — purely presentational. */
export interface Folder { id: string; name: string; parentId?: string | null; createdAt: string; updatedAt: string; }
export interface Branch { id: string; workflowId: string; name: string; headVersionId?: string; forkedFromVersionId?: string; protected?: boolean; }
export interface Version { id: string; workflowId: string; branchId: string; number: number; label?: string; state: 'draft' | 'published'; engine: any; message?: string; createdAt: string; }
export interface Deployment {
  id: string; workflowId: string; versionId: string; branchId: string;
  engine?: any;
  env: Record<string, string>; tags: string[]; status: 'active' | 'inactive' | 'archived';
  environment: string; versionNumber?: number; versionLabel?: string; deployedAt: string; deployedBy: string;
  snapshot?: {
    frozenAt: string;
    versionNumber?: number;
    versionLabel?: string;
    frozen: boolean;
  };
}
/** One process definition contained in a deployment (jBPM's "what's running in this container" view). */
export interface DeploymentProcessDef { id: string; name: string; nodes: number; startable: boolean; }
export interface Instance {
  id: string; deploymentId: string; workflowId: string; processId?: string; correlationKey?: string;
  status: 'running' | 'waiting' | 'completed' | 'aborted' | 'failed' | 'suspended';
  variables: Record<string, unknown>; tokens: Token[]; history: NodeVisit[];
  error?: { nodeId: string; message: string; at: string };
  parentInstanceId?: string; startedAt: string; startedBy: string; endedAt?: string;
  caseInstanceId?: string;
  caseWorkflowName?: string;
  caseStatus?: string;
  caseData?: Record<string, unknown>;
}
export interface Token { id: string; nodeId: string; state: 'active' | 'waiting'; waitFor?: any; enteredAt: string; }
export interface NodeVisit { tokenId: string; nodeId: string; type: string; enteredAt: string; exitedAt?: string; outcome?: string; }
export interface DiagramState { activeNodeIds: string[]; visitedNodeIds: string[]; status: string; }

export interface NodeSpec {
  key: string; label: string; category: string; icon: string; color: string;
  engineType: string; defaults: Record<string, unknown>; docFolder: string;
}
export type VarSource = 'own' | 'ownRef' | 'called';
export interface UiField {
  key: string; label: string; widget: string; options?: string[]; placeholder?: string; help?: string;
  assetKind?: string; varSource?: VarSource; keySource?: VarSource; valueSource?: VarSource;
  /** shown only while another field has one of these values (e.g. an operation's own parameters) */
  when?: { key: string; in: string[] };
}
export interface UiSection { title: string; fields: UiField[]; }
export interface Ports { maxIn?: number; maxOut?: number; }   // 0 = none, n = that many, undefined = unlimited
export interface Catalog {
  categories: string[];
  nodes: NodeSpec[];
  schemas: Record<string, UiSection[]>;   // engineType → property form (served by the backend)
  ports: Record<string, Ports>;           // engineType → connection points
  /** engineType → how it renders on a live diagram (icon = IconComponent name, not the palette's
   *  emoji; shape follows real BPMN 2.0 notation) — the single source of truth for every diagram/
   *  canvas, in place of a hand-rolled per-page map (two of which had already drifted apart before
   *  this existed). */
  diagram: Record<string, { icon: string; color: string; shape: 'circle' | 'diamond' | 'rectangle' }>;
  /** engineType → neutral display name for the type itself (e.g. "Gateway"), distinct from a palette
   *  tile's own more specific label (e.g. "Exclusive Gateway"). */
  typeLabels: Record<string, string>;
  docs?: Record<string, any>;
  readmes?: Record<string, string>;       // engineType → full markdown README
  assetReadmes?: Record<string, string>;  // assetKind → full markdown README
  cheatSheet?: string;                    // full JavaScript & flow variables cheat sheet markdown
  javaReference?: string;                 // full Java & imported script reference markdown
}

/** One process behind a currently-active deployment, tenant-wide — exactly what a 'call'/'forEach'
 *  node can resolve at runtime (see server's instances/service.ts resolveCalled). Backs the
 *  'processRef' widget's picker and, once one is chosen, the 'called' variable-source suggestions. */
export interface CallableProcess { id: string; name: string; workflowId: string; workflowName: string; environment: string; vars: { name: string; type?: string }[]; }

export interface Problem {
  rule: string;
  severity: 'error' | 'warning';
  message: string;
  nodeId?: string;
  nodeName?: string;
  flowId?: string;
  processId?: string;
  processName?: string;
  remedy?: string;
}
export interface ValidationResult { ok: boolean; errors: Problem[]; warnings: Problem[]; problems: Problem[]; }

export interface ImportResult {
  workflowId: string; processes: number;
  formsImported: string[];
  rulesetPlaceholders: { group: string; ruleNames: string[] }[];
  decisionsImported: string[];
  skipped: { path: string; kind: string; reason: string }[];
}

export interface Task {
  id: string; instanceId: string; nodeId: string; name: string; formName?: string;
  group?: string; assignee?: string;
  businessAdmin?: string; excludedOwners?: string[]; priority?: number;
  status: 'created' | 'reserved' | 'inprogress' | 'completed' | 'skipped' | 'error';
  inputs?: Record<string, unknown>; outputs?: Record<string, unknown>;
  createdAt: string; dueAt?: string; completedAt?: string; completedBy?: string;
}

// ---- operations: errors, jobs, audit, notifications, settings ----
export interface ExecutionError {
  id: string;
  type: 'process' | 'task' | 'job' | 'integration';
  instanceId?: string; taskId?: string; jobId?: string;
  workflowId?: string; deploymentId?: string; processId?: string;
  nodeId?: string; nodeName?: string; nodeType?: string;
  message: string; stack?: string;
  at: string; occurrences: number;
  acknowledged: boolean; acknowledgedBy?: string; acknowledgedAt?: string;
}
export interface ErrorSummary { total: number; unacknowledged: number; last24h: number; }

export interface TimerJob {
  id: string; instanceId: string; tokenId: string; nodeId: string;
  kind: 'duration' | 'cycle' | 'date' | 'start' | 'async';
  attempts?: number; maxAttempts?: number; lastError?: string;
  dueAt: string; cycle?: string; fired: number;
  status: 'scheduled' | 'fired' | 'cancelled';
  deploymentId?: string; processId?: string;
}

export interface AuditEvent {
  id: string; at: string; actor: string; kind: string;
  workflowId?: string; deploymentId?: string; instanceId?: string; taskId?: string; nodeId?: string;
  data?: Record<string, unknown>;
}

/** Named AppNotification (not Notification) to avoid colliding with the DOM Notification global. */
export interface AppNotification {
  id: string; userId: string;
  kind: 'task-assigned' | 'sla-at-risk' | 'sla-breached' | 'instance-failed'
      | 'deployment-succeeded' | 'deployment-failed' | 'task-reminder';
  title: string; body?: string; link?: string;
  instanceId?: string; taskId?: string; deploymentId?: string;
  read: boolean; at: string;
}

export interface TaskComment { id: string; taskId: string; author: string; body: string; at: string; }

export interface SystemSettings {
  defaultPageSize: number;
  instanceRetentionDays: number;
  auditRetentionDays: number;
  allowRunningVariableEdits: boolean;
  executorIntervalSeconds: number;
  timerBatchSize?: number;
  defaultJobRetries: number;
  jobRetryBackoffMultiplier?: number;
  scriptTimeoutSeconds?: number;
  slaWarnThresholdPct: number;
  defaultTaskSlaHours?: number;
  autoReleaseClaimedTaskHours?: number;
  httpTimeoutSeconds?: number;
  outboundAllowlist?: string;
  historyAuditLevel?: 'full' | 'activity' | 'minimal';
  logLevel?: 'debug' | 'info' | 'warn' | 'error';
  sessionTimeoutHours: number;
  emailEnabled: boolean;
  emailFrom?: string; smtpHost?: string; smtpPort?: number;
  smtpUser?: string; smtpPassword?: string; smtpPasswordConfigured?: boolean;
  instanceCreationMode?: 'both' | 'case-only' | 'process-only';
  /** per-tenant resource quotas; 0/undefined = unlimited. */
  maxActiveInstances?: number;
  maxActiveTimers?: number;
  maxConcurrentScripts?: number;
  scriptOverflowMode?: 'queue' | 'reject' | null;
  scriptPoolSize?: number;
  scriptQueueMax?: number;
  /** read-only, from the platform administrator: what this workspace may not exceed / what is really applied */
  limitCaps?: { scriptPoolMaxSize: number; scriptQueueMaxCap: number; maxActiveInstancesCap: number; maxActiveTimersCap: number; lockedOverflowMode?: 'queue' | 'reject' };
  effectiveLimits?: { scriptPoolSize: number; scriptQueueMax: number; scriptOverflowMode: 'queue' | 'reject'; maxActiveInstances: number; maxActiveTimers: number };
  /** read-only, computed by the server: what the script pool actually applies */
  effectiveScriptConcurrency?: number;
  effectiveScriptOverflowMode?: 'queue' | 'reject';
  updatedAt?: string; updatedBy?: string;
}

export interface VariableChange { name: string; from: unknown; to: unknown; at: string; actor: string; }

// ---- IAM (users/groups/roles) ----
export interface AppUser { id: string; username: string; roles: string[]; groups: string[]; active: boolean; createdAt: string; skills?: string[]; maxOpenTasks?: number; maxTasksPerDay?: number; available?: boolean; awayUntil?: string; }
export interface AppGroup { id: string; name: string; description?: string; memberCount?: number; }
export interface AppRole { id: string; name: string; permissions: string[]; builtIn?: boolean; overridden?: boolean; protected?: boolean; userCount?: number; memberCount?: number; }
export interface PermissionInfo { key: string; label: string; group: string; }

// ---- query / task-admin / analytics (docs/17) ----
export interface UserRow { user: string; groups: string[]; startedInstances: number; openTasks: number; completedTasks: number; }
export interface ProcessDef { processId: string; name: string; version?: string; environment: string; nodes: number; instances: { total: number; active: number }; deploymentId?: string; workflowId?: string; }
export interface DurStats { count: number; avgMs: number; minMs: number; maxMs: number; }
export interface Summary { instances: { total: number; byStatus: Record<string, number> }; tasks: { total: number; byStatus: Record<string, number> }; deployments: { total: number; active: number }; jobs: { scheduled: number; fired: number }; }
export interface TaskAnalytics {
  byTask: (DurStats & { name: string })[];
  byAssignee: (DurStats & { user: string })[];
  openByStatus: Record<string, number>;
  sla?: { totalWithDue: number; onTime: number; overdue: number; complianceRate: number };
  byGroup?: { group: string; count: number }[];
}
export interface ProcessAnalytics {
  byProcess: (DurStats & { processId: string })[];
  byStatus: Record<string, number>;
  dailyThroughput?: { date: string; started: number; completed: number; failed: number }[];
  failureRate?: number;
  total?: number;
}

// ---- Workflow Instance Management (Case Management) ----
export interface WorkflowDefinition {
  id: string; name: string; deploymentId: string; processId?: string;
  dataSchema: Record<string, unknown>; schemaValidationEnabled: boolean;
  createdAt: string; updatedAt: string;
}
export interface WorkflowInstance {
  id: string; workflowDefinitionId: string; workflowName: string; deploymentId: string;
  data: Record<string, unknown>; status: string; piid: string | null; startError?: string;
  createdAt: string; updatedAt: string;
  createdBy?: string; updatedBy?: string;
}
export interface WorkflowInstanceAggregate {
  workflowInstance: WorkflowInstance; bpmInstance: Instance | null; tasks: Task[];
  signals: { processId: string; listensFor: string[]; throws: string[] } | null;
  commentCount: number; auditCount: number;
}
export interface WorkflowInstanceAudit { id: string; workflowInstanceId: string; actor: string; kind: string; data?: Record<string, unknown>; at: string; }
export interface WorkflowInstanceComment { id: string; workflowInstanceId: string; author: string; body: string; at: string; }
export interface OwnershipSegment { holder: string; from: string; to: string; durationMs: number; }
export interface OwnershipTimeline { taskId: string; segments: OwnershipSegment[]; totalMs: number; }
export interface TasksAndProcesses { instances: Instance[]; tasks: Task[]; }
export interface WorkflowTat {
  byWorkflowName: (DurStats & { workflowName: string })[];
  byUser: (DurStats & { user: string })[];
}
export type QueryableEntity = 'workflowInstance' | 'workflowInstanceAudit' | 'workflowInstanceComment' | 'instance' | 'task';
export type QueryOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';
export interface QueryFilter { field: string; op: QueryOp; value: unknown; }
export interface QueryDefinition {
  entity: QueryableEntity; filters?: QueryFilter[]; groupBy?: string; metric?: 'count' | 'avgDurationMs';
  durationFrom?: string; durationTo?: string; sort?: { field: string; dir: 'asc' | 'desc' }; limit?: number;
}
export interface QueryRunResult { rows?: Record<string, unknown>[]; groups?: { key: string; count: number; avgDurationMs?: number }[]; }
export interface SavedQuery { id: string; ownerId?: string; name: string; definition: QueryDefinition; createdAt: string; createdBy: string; }
