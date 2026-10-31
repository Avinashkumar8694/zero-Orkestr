// Workflow Instance Management module — its own domain types, deliberately separate from
// ../domain.ts's generic blob-store entities (Workflow/Instance/Task/...). This module owns a real
// Postgres schema (`workflow_service`) with typed tables, per an explicit decision (see
// docs/usage_docs/14-workflow-instance-management.md) rather than the generic kv_store blob pattern
// every pre-existing module uses. `WorkflowInstance` here is a business-facing CASE record — distinct
// from the pre-existing runtime `Instance` (BPM token-execution state, ../domain.ts) — a
// WorkflowInstance.piid points AT an Instance.id. Every type/comment in this module says "BPM
// instance (piid)" rather than bare "instance" specifically to keep that distinction unambiguous.

export interface WfEntity { id: string; tenantId: string; }

/** The stable, human-named handle a client app holds onto across redeployments. `name` never
 *  changes; `deploymentId` is repointed via update() as new versions get deployed — this is what
 *  makes "we get a new workflowId on every deploy" a non-problem for callers of this module. */
export interface WorkflowDefinition extends WfEntity {
  id: string; tenantId: string;
  name: string;                      // unique per tenant; the "workflow_name" used at case-create time
  deploymentId: string;
  processId?: string;                // specific process definition within the deployed project
  /** JSON Schema (draft-07-ish; validated with ajv) describing the shape of a case's `data`. */
  dataSchema: Record<string, unknown>;
  schemaValidationEnabled: boolean;
  createdAt: string; createdBy: string;
  updatedAt: string; updatedBy: string;
}

export type WorkflowInstanceStatus = string;   // free-form business status — distinct from BPM Instance.status

/** A business-facing case record. `piid` (Process Instance ID) points at the underlying BPM
 *  `Instance.id`, backfilled once that instance is actually created — null only in the brief window
 *  between this row's creation and the BPM start call (or permanently, if that start failed — see
 *  `status: 'failed'` and `startError`). `deploymentId`/`workflowName` are denormalized from the
 *  WorkflowDefinition at creation time so this record stays self-sufficient for tracing even if the
 *  definition is later repointed or removed. */
export interface WorkflowInstance extends WfEntity {
  id: string; tenantId: string;
  workflowDefinitionId: string;
  workflowName: string;
  deploymentId: string;
  data: Record<string, unknown>;
  status: WorkflowInstanceStatus;
  piid: string | null;
  startError?: string;
  /** Case role assignments: roleName -> array of usernames or group names (e.g. claimant, examiner, approver). */
  roles?: Record<string, string[]>;
  /** Case milestones achieved/tracked during case execution. */
  milestones?: Array<{ id: string; name: string; status: string; achievedAt?: string; achievedBy?: string }>;
  createdAt: string; createdBy: string;
  updatedAt: string; updatedBy: string;
}

export interface WorkflowInstanceAudit extends WfEntity {
  id: string; tenantId: string;
  workflowInstanceId: string;
  actor: string;
  kind: string;
  data?: Record<string, unknown>;
  at: string;
}

export interface WorkflowInstanceComment extends WfEntity {
  id: string; tenantId: string;
  workflowInstanceId: string;
  author: string;
  body: string;
  at: string;
}

/** A queryable entity the generic query engine is allowed to touch — see
 *  workflow-service/services/query-engine-service.ts's ENTITY_REGISTRY. Kept here (not inline in the
 *  service) so the saved-query `definition` shape has one canonical set of valid `entity` values. */
export type QueryableEntity = 'workflowInstance' | 'workflowInstanceAudit' | 'workflowInstanceComment' | 'instance' | 'task';

export type QueryOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'contains';
export interface QueryFilter { field: string; op: QueryOp; value: unknown; }
export interface QueryDefinition {
  entity: QueryableEntity;
  filters?: QueryFilter[];
  groupBy?: string;
  metric?: 'count' | 'avgDurationMs';
  /** only meaningful with metric:'avgDurationMs' — the two field paths bounding the duration. */
  durationFrom?: string;
  durationTo?: string;
  sort?: { field: string; dir: 'asc' | 'desc' };
  limit?: number;
}

/** A saved, reusable ad-hoc query. `ownerId: undefined` = shared with the whole tenant. */
export interface SavedQuery extends WfEntity {
  id: string; tenantId: string;
  ownerId?: string;
  name: string;
  definition: QueryDefinition;
  createdAt: string; createdBy: string;
}
