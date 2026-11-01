// The Analytics Builder's catalogue: every source (entity), field and relation a query may touch. The runner refuses anything not
// declared here, so a query can never reach a field, an entity or another workspace's data that it should not. The UI reads the
// same catalogue (served by GET /analytics-builder/catalog) to drive its autocomplete.
import type { AppContext } from '../context.ts';
import { Collections, type Deployment, type ExecutionError, type Instance, type Task, type Tenant, type Workflow } from '../domain.ts';
import type { WorkflowInstance, WorkflowInstanceAudit, WorkflowInstanceComment } from '../workflow-service/domain.ts';
import type { WorkflowServiceStore } from '../workflow-service/store/types.ts';
import { findRows, matchesSpec, type FindSpec } from '../store/find.ts';

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'json';
export type SourceKey = 'case' | 'process' | 'task' | 'audit' | 'comment' | 'project' | 'deployment' | 'error' | 'workspace';

type Rec = Record<string, any>;
export interface FieldDef { key: string; label: string; type: FieldType; computed?: boolean; get: (r: Rec, now: number) => unknown }
export interface SourceDef {
  key: SourceKey; label: string;
  fields: FieldDef[];
  /** open-ended JSON roots: `data.claim.amount` -> record.data, then the dotted rest */
  dynamic: Array<{ key: string; label: string; get: (r: Rec) => unknown }>;
  /** stored top-level fields that are ALWAYS present, so an `=` / `in` on them can be answered by the store (index) instead of in memory */
  pushable?: string[];
}

/** what a run needs from the outside world — every read is tenant-scoped by the context only, and bounded: rows come by key or in pages,
 *  never as a whole table (except the single workspace row). */
export interface Env {
  ctx: AppContext; wf: WorkflowServiceStore; nowMs: number;
  /** rows whose top-level `field` is one of `keys` (an indexed lookup on stores that have one) */
  lookup(src: SourceKey, field: string, keys: string[]): Promise<Rec[]>;
  /** the source's rows in pages of `pageSize`, optionally narrowed by `spec` (an `=` / `in` push-down); id order */
  scan(src: SourceKey, spec: FindSpec | undefined, pageSize?: number): AsyncGenerator<Rec[]>;
  /** the single workspace row */
  workspace(): Promise<Rec[]>;
}

const f = (key: string, label: string, type: FieldType, get: (r: Rec, now: number) => unknown, computed = false): FieldDef => ({ key, label, type, get, computed });
const ms = (a?: string, b?: string): number | null => {
  const x = Date.parse(a ?? ''), y = Date.parse(b ?? '');
  return Number.isNaN(x) || Number.isNaN(y) ? null : Math.max(0, y - x);
};
const std = (extra: FieldDef[]) => extra;

export const SOURCES: Record<SourceKey, SourceDef> = {
  case: {
    key: 'case', label: 'Case instance',
    fields: std([
      f('id', 'Case id', 'string', (r) => r.id), f('workflowName', 'Workflow name', 'string', (r) => r.workflowName), f('status', 'Status', 'string', (r) => r.status),
      f('piid', 'Process instance id (piid)', 'string', (r) => r.piid), f('deploymentId', 'Deployment id', 'string', (r) => r.deploymentId),
      f('workflowDefinitionId', 'Workflow definition id', 'string', (r) => r.workflowDefinitionId), f('startError', 'Start error', 'string', (r) => r.startError),
      f('createdAt', 'Created at', 'date', (r) => r.createdAt), f('createdBy', 'Created by', 'string', (r) => r.createdBy),
      f('updatedAt', 'Updated at', 'date', (r) => r.updatedAt), f('updatedBy', 'Updated by', 'string', (r) => r.updatedBy),
      f('milestoneCount', 'Milestones', 'number', (r) => (r.milestones ?? []).length, true),
      f('ageMs', 'Age (ms)', 'number', (r, now) => Math.max(0, now - Date.parse(r.createdAt)), true),
    ]),
    dynamic: [{ key: 'data', label: 'Case data', get: (r) => r.data }, { key: 'roles', label: 'Case roles', get: (r) => r.roles }],
  },
  process: {
    key: 'process', label: 'Process instance',
    fields: std([
      f('id', 'Process instance id', 'string', (r) => r.id), f('status', 'Status', 'string', (r) => r.status), f('workflowId', 'Project id', 'string', (r) => r.workflowId),
      f('deploymentId', 'Deployment id', 'string', (r) => r.deploymentId), f('processId', 'Process id', 'string', (r) => r.processId),
      f('correlationKey', 'Correlation key', 'string', (r) => r.correlationKey), f('parentInstanceId', 'Parent instance id', 'string', (r) => r.parentInstanceId),
      f('startedBy', 'Started by', 'string', (r) => r.startedBy), f('startedAt', 'Started at', 'date', (r) => r.startedAt), f('endedAt', 'Ended at', 'date', (r) => r.endedAt),
      f('durationMs', 'Duration (ms)', 'number', (r) => ms(r.startedAt, r.endedAt) ?? undefined, true),
      f('waitingOn', 'Waiting on (node ids)', 'string', (r) => (r.tokens ?? []).filter((t: Rec) => t.state === 'waiting').map((t: Rec) => t.nodeId).join(','), true),
      f('errorMessage', 'Error message', 'string', (r) => r.error?.message), f('errorNodeId', 'Error node id', 'string', (r) => r.error?.nodeId),
      f('visitCount', 'Nodes visited', 'number', (r) => (r.history ?? []).length, true),
      f('independent', 'Independent child', 'boolean', (r) => !!r.independent),
      f('depth', 'Depth (recursive joins only)', 'number', (r) => r.depth, true),
    ]),
    dynamic: [{ key: 'variables', label: 'Process variables', get: (r) => r.variables }],

    pushable: ['status', 'workflowId', 'deploymentId', 'processId', 'parentInstanceId', 'startedBy', 'correlationKey'],
  },
  task: {
    key: 'task', label: 'Task',
    fields: std([
      f('id', 'Task id', 'string', (r) => r.id), f('instanceId', 'Process instance id', 'string', (r) => r.instanceId), f('nodeId', 'Node id', 'string', (r) => r.nodeId),
      f('name', 'Name', 'string', (r) => r.name), f('status', 'Status', 'string', (r) => r.status), f('group', 'Group', 'string', (r) => r.group),
      f('assignee', 'Assignee', 'string', (r) => r.assignee), f('priority', 'Priority', 'number', (r) => r.priority),
      f('createdAt', 'Created at', 'date', (r) => r.createdAt), f('claimedAt', 'Claimed at', 'date', (r) => r.claimedAt),
      f('completedAt', 'Completed at', 'date', (r) => r.completedAt), f('completedBy', 'Completed by', 'string', (r) => r.completedBy), f('dueAt', 'Due at', 'date', (r) => r.dueAt),
      f('overdue', 'Overdue', 'boolean', (r, now) => (r.completedAt ? Date.parse(r.completedAt) > Date.parse(r.dueAt ?? '9999') : !!r.dueAt && Date.parse(r.dueAt) < now), true),
      f('waitMs', 'Wait before claim (ms)', 'number', (r) => ms(r.createdAt, r.claimedAt) ?? undefined, true),
      f('workMs', 'Work time (ms)', 'number', (r) => ms(r.claimedAt, r.completedAt) ?? undefined, true),
      f('totalMs', 'Total time (ms)', 'number', (r) => ms(r.createdAt, r.completedAt) ?? undefined, true),
    ]),
    dynamic: [{ key: 'inputs', label: 'Task inputs', get: (r) => r.inputs }, { key: 'outputs', label: 'Task outputs', get: (r) => r.outputs }],

    pushable: ['status', 'assignee', 'group', 'instanceId', 'nodeId', 'completedBy', 'name'],
  },
  audit: {
    key: 'audit', label: 'Case audit entry',
    fields: std([f('id', 'Id', 'string', (r) => r.id), f('workflowInstanceId', 'Case id', 'string', (r) => r.workflowInstanceId), f('kind', 'Kind', 'string', (r) => r.kind), f('actor', 'Actor', 'string', (r) => r.actor), f('at', 'At', 'date', (r) => r.at)]),
    dynamic: [{ key: 'data', label: 'Audit data', get: (r) => r.data }],
  },
  comment: {
    key: 'comment', label: 'Case comment',
    fields: std([f('id', 'Id', 'string', (r) => r.id), f('workflowInstanceId', 'Case id', 'string', (r) => r.workflowInstanceId), f('author', 'Author', 'string', (r) => r.author), f('body', 'Body', 'string', (r) => r.body), f('at', 'At', 'date', (r) => r.at)]),
    dynamic: [],
  },
  project: {
    key: 'project', label: 'Project (workflow)',
    fields: std([f('id', 'Project id', 'string', (r) => r.id), f('name', 'Name', 'string', (r) => r.name), f('key', 'Key', 'string', (r) => r.key), f('description', 'Description', 'string', (r) => r.description),
      f('archived', 'Archived', 'boolean', (r) => !!r.archived), f('folderId', 'Folder id', 'string', (r) => r.folderId), f('createdAt', 'Created at', 'date', (r) => r.createdAt)]),
    dynamic: [],
  },
  deployment: {
    key: 'deployment', label: 'Deployment',
    fields: std([f('id', 'Deployment id', 'string', (r) => r.id), f('workflowId', 'Project id', 'string', (r) => r.workflowId), f('environment', 'Environment', 'string', (r) => r.environment), f('status', 'Status', 'string', (r) => r.status),
      f('versionNumber', 'Version number', 'number', (r) => r.versionNumber), f('versionLabel', 'Version label', 'string', (r) => r.versionLabel), f('tags', 'Tags', 'string', (r) => (r.tags ?? []).join(',')),
      f('deployedAt', 'Deployed at', 'date', (r) => r.deployedAt), f('deployedBy', 'Deployed by', 'string', (r) => r.deployedBy)]),
    dynamic: [],

    pushable: ['status', 'environment', 'workflowId'],
  },
  error: {
    key: 'error', label: 'Execution error',
    fields: std([f('id', 'Id', 'string', (r) => r.id), f('type', 'Type', 'string', (r) => r.type), f('instanceId', 'Process instance id', 'string', (r) => r.instanceId), f('workflowId', 'Project id', 'string', (r) => r.workflowId),
      f('nodeId', 'Node id', 'string', (r) => r.nodeId), f('nodeName', 'Node name', 'string', (r) => r.nodeName), f('nodeType', 'Node type', 'string', (r) => r.nodeType), f('message', 'Message', 'string', (r) => r.message),
      f('at', 'At', 'date', (r) => r.at), f('occurrences', 'Occurrences', 'number', (r) => r.occurrences), f('acknowledged', 'Acknowledged', 'boolean', (r) => !!r.acknowledged)]),
    dynamic: [],

    pushable: ['type', 'instanceId', 'nodeId', 'acknowledged'],
  },
  workspace: {
    key: 'workspace', label: 'Workspace',
    fields: std([f('id', 'Workspace id', 'string', (r) => r.id), f('name', 'Name', 'string', (r) => r.name), f('slug', 'Slug', 'string', (r) => r.slug), f('plan', 'Plan', 'string', (r) => r.plan), f('status', 'Status', 'string', (r) => r.status)]),
    dynamic: [],
  },
};

// ------------------------------------------------------------------------------------------------ authorization
/** The permission a caller needs to read each source: the same ones that guard the equivalent screens / APIs today
 *  (cases: workflowInstance:manage · instances, tasks, errors, reports: query:read · projects & deployments: workflow:view ·
 *  workspace details: team:read). A query is refused unless the caller holds the permission for EVERY source it touches. */
export const SOURCE_PERMISSION: Record<SourceKey, string> = {
  case: 'workflowInstance:manage', audit: 'workflowInstance:manage', comment: 'workflowInstance:manage',
  process: 'query:read', task: 'query:read', error: 'query:read',
  project: 'workflow:view', deployment: 'workflow:view',
  workspace: 'team:read',
};

// ------------------------------------------------------------------------------------------------ relations
/** `fetch` returns left-key -> right records for exactly the left records given (a semi-join); the runner does the row expansion. */
export interface Relation {
  key: string; label: string; from: SourceKey; to: SourceKey; many: boolean; recursive?: boolean;
  leftKey(left: Rec): string | undefined;
  fetch(env: Env, lefts: Rec[]): Promise<Map<string, Rec[]>>;
}

const MAX_DEPTH = 20;
const keyOf = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));

/** one-to-one / one-to-many by a plain key on the right table */
function byKey(key: string, label: string, from: SourceKey, to: SourceKey, many: boolean, leftKey: (l: Rec) => unknown, rightField: string, _rightKey: (r: Rec) => unknown): Relation {
  return {
    key, label, from, to, many, leftKey: (l) => keyOf(leftKey(l)),
    async fetch(env, lefts) {
      const keys = [...new Set(lefts.map((l) => keyOf(leftKey(l))).filter((k): k is string => k !== undefined))];
      const rows = await env.lookup(to, rightField, keys);                 // only the rows these lefts point at
      const grouped = new Map<string, Rec[]>(keys.map((k) => [k, []]));
      for (const r of rows) grouped.get(String(r[rightField]))?.push(r);
      return grouped;
    },
  };
}

const NODE_CAP = 50_000;
/** Every descendant of each root, level by level: one indexed lookup per LEVEL (for all roots together), a per-root visited set (cycle-safe),
 *  a depth cap and a node cap. Never loads the process table. */
async function descendantsMany(env: Env, roots: string[]): Promise<Map<string, Array<Rec & { depth: number }>>> {
  const out = new Map<string, Array<Rec & { depth: number }>>(roots.map((r) => [r, []]));
  const seen = new Map<string, Set<string>>(roots.map((r) => [r, new Set([r])]));
  let frontier: Array<[string, string]> = roots.map((r) => [r, r]);          // [process id, root it belongs to]
  let depth = 0, visited = 0;
  while (frontier.length && depth < MAX_DEPTH && visited < NODE_CAP) {
    depth++;
    const kids = await env.lookup('process', 'parentInstanceId', [...new Set(frontier.map(([id]) => id))]);
    const rootsOf = new Map<string, string[]>();
    for (const [id, root] of frontier) (rootsOf.get(id) ?? rootsOf.set(id, []).get(id)!).push(root);
    const next: Array<[string, string]> = [];
    for (const c of kids) for (const root of rootsOf.get(c.parentInstanceId) ?? []) {
      const sn = seen.get(root)!;
      if (sn.has(c.id)) continue;
      sn.add(c.id); out.get(root)!.push({ ...c, depth }); next.push([c.id, root]); visited++;
    }
    frontier = next;
  }
  return out;
}
/** the parent chain of each process (nearest first), one lookup per level */
async function ancestorsMany(env: Env, starts: Rec[]): Promise<Map<string, Array<Rec & { depth: number }>>> {
  const out = new Map<string, Array<Rec & { depth: number }>>(starts.map((l) => [l.id, []]));
  let cur: Array<[string, Rec]> = starts.map((l) => [l.id, l]);
  const seen = new Map<string, Set<string>>(starts.map((l) => [l.id, new Set([l.id])]));
  for (let depth = 1; depth <= MAX_DEPTH && cur.length; depth++) {
    const want = [...new Set(cur.map(([, r]) => keyOf(r.parentInstanceId)).filter((k): k is string => k !== undefined))];
    if (!want.length) break;
    const byId = new Map((await env.lookup('process', 'id', want)).map((r) => [r.id, r]));
    const next: Array<[string, Rec]> = [];
    for (const [start, r] of cur) {
      const parent = byId.get(String(r.parentInstanceId ?? ''));
      if (!parent || seen.get(start)!.has(parent.id)) continue;
      seen.get(start)!.add(parent.id); out.get(start)!.push({ ...parent, depth }); next.push([start, parent]);
    }
    cur = next;
  }
  return out;
}

const rels: Relation[] = [
  byKey('case.process', 'Case → its process instance', 'case', 'process', false, (l) => l.piid, 'id', (r) => r.id),
  byKey('process.case', 'Process → its case', 'process', 'case', false, (l) => l.variables?._caseInstanceId, 'id', (r) => r.id),
  byKey('process.tasks', 'Process → its tasks', 'process', 'task', true, (l) => l.id, 'instanceId', (r) => r.instanceId),
  byKey('task.process', 'Task → its process', 'task', 'process', false, (l) => l.instanceId, 'id', (r) => r.id),
  byKey('process.project', 'Process → its project', 'process', 'project', false, (l) => l.workflowId, 'id', (r) => r.id),
  byKey('process.deployment', 'Process → its deployment', 'process', 'deployment', false, (l) => l.deploymentId, 'id', (r) => r.id),
  byKey('deployment.project', 'Deployment → its project', 'deployment', 'project', false, (l) => l.workflowId, 'id', (r) => r.id),
  byKey('project.deployments', 'Project → its deployments', 'project', 'deployment', true, (l) => l.id, 'workflowId', (r) => r.workflowId),
  byKey('project.processes', 'Project → its process instances', 'project', 'process', true, (l) => l.id, 'workflowId', (r) => r.workflowId),
  byKey('process.errors', 'Process → its execution errors', 'process', 'error', true, (l) => l.id, 'instanceId', (r) => r.instanceId),
  byKey('process.children', 'Process → direct child processes', 'process', 'process', true, (l) => l.id, 'parentInstanceId', (r) => r.parentInstanceId),
  byKey('case.audits', 'Case → audit entries', 'case', 'audit', true, (l) => l.id, 'workflowInstanceId', (r) => r.workflowInstanceId),
  byKey('case.comments', 'Case → comments', 'case', 'comment', true, (l) => l.id, 'workflowInstanceId', (r) => r.workflowInstanceId),
  {
    key: 'process.descendants', label: 'Process → every descendant (recursive, adds depth)', from: 'process', to: 'process', many: true, recursive: true,
    leftKey: (l) => keyOf(l.id),
    async fetch(env, lefts) { return descendantsMany(env, lefts.map((l) => l.id)); },
  },
  {
    key: 'process.ancestors', label: 'Process → its parent chain (recursive, adds depth)', from: 'process', to: 'process', many: true, recursive: true,
    leftKey: (l) => keyOf(l.id),
    async fetch(env, lefts) { return ancestorsMany(env, lefts); },
  },
  {
    key: 'process.root', label: 'Process → top-most ancestor', from: 'process', to: 'process', many: false, recursive: true,
    leftKey: (l) => keyOf(l.id),
    async fetch(env, lefts) {
      const chains = await ancestorsMany(env, lefts);
      return new Map(lefts.map((l) => { const c = chains.get(l.id) ?? []; const top = c.length ? c[c.length - 1]! : l; return [l.id, [top]] as [string, Rec[]]; }));
    },
  },
  {
    // a case's tasks are those of its process AND of everything beneath it (call activities, sub-processes, multi-instance fan-out)
    key: 'case.tasks', label: 'Case → every task under it', from: 'case', to: 'task', many: true,
    leftKey: (l) => keyOf(l.id),
    async fetch(env, lefts) {
      const withProcess = lefts.filter((l) => l.piid);
      const tree = await descendantsMany(env, withProcess.map((l) => String(l.piid)));
      const ids = new Set<string>(); for (const l of withProcess) { ids.add(String(l.piid)); for (const d of tree.get(String(l.piid)) ?? []) ids.add(d.id); }
      const byInst = new Map<string, Rec[]>();
      for (const t of await env.lookup('task', 'instanceId', [...ids])) (byInst.get(t.instanceId) ?? byInst.set(t.instanceId, []).get(t.instanceId)!).push(t);
      const out = new Map<string, Rec[]>();
      for (const l of lefts) out.set(l.id, l.piid ? [String(l.piid), ...(tree.get(String(l.piid)) ?? []).map((d) => d.id)].flatMap((i) => byInst.get(i) ?? []) : []);
      return out;
    },
  },
];
// every source can reach the single workspace row
for (const s of ['case', 'process', 'task', 'audit', 'comment', 'project', 'deployment', 'error'] as SourceKey[]) {
  rels.push({
    key: `${s}.workspace`, label: `${SOURCES[s].label} → this workspace`, from: s, to: 'workspace', many: false,
    leftKey: () => '1',
    async fetch(env) { return new Map([['1', await env.workspace()]]); },
  });
}
export const RELATIONS: Record<string, Relation> = Object.fromEntries(rels.map((r) => [r.key, r]));

// ------------------------------------------------------------------------------------------------ environment
const PAGE = 2000;
const LOOKUP_BATCH = 500;
/** sources kept in the generic store (indexed lookups + paging through findRows) */
const COLLECTION: Partial<Record<SourceKey, string>> = { process: Collections.instances, task: Collections.tasks, project: Collections.workflows, deployment: Collections.deployments, error: Collections.errors };

export function makeEnv(ctx: AppContext, wf: WorkflowServiceStore, nowMs = Date.now()): Env {
  const t = ctx.tenantId;
  /** case / audit / comment live in the workflow-service store (typed tables on Postgres): by id → direct reads; other keys → one tenant-scoped read */
  const wfRepo = (src: SourceKey) => (src === 'case' ? wf.instances() : src === 'audit' ? wf.audits() : wf.comments()) as any;
  return {
    ctx, wf, nowMs,
    async lookup(src, field, keys) {
      if (!keys.length) return [];
      const coll = COLLECTION[src];
      const out: Rec[] = [];
      for (let i = 0; i < keys.length; i += LOOKUP_BATCH) {
        const batch = keys.slice(i, i + LOOKUP_BATCH);
        if (coll) out.push(...(await findRows<any>(ctx.store, coll, t, { eq: { [field]: batch } })));
        else if (field === 'id') { for (const id of batch) { const r = await wfRepo(src).get(id); if (r && r.tenantId === t) out.push(r); } }
        else { const set = new Set(batch); out.push(...(await wfRepo(src).query((r: Rec) => r.tenantId === t && set.has(String(r[field]))))); }
      }
      return out;
    },
    async *scan(src, spec, pageSize = PAGE) {
      const coll = COLLECTION[src];
      if (coll) {
        let afterId: string | undefined;
        for (;;) {
          const page = await findRows<any>(ctx.store, coll, t, { ...(spec ?? {}), limit: pageSize, afterId });
          if (!page.length) return;
          yield page;
          if (page.length < pageSize) return;
          afterId = page[page.length - 1]!.id;
        }
      }
      const rows = (await wfRepo(src).query((r: Rec) => r.tenantId === t && (!spec || matchesSpec(r, spec)))) as Rec[];
      rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      for (let i = 0; i < rows.length; i += pageSize) yield rows.slice(i, i + pageSize);
    },
    async workspace() { const x = await ctx.store.repo<Tenant>(Collections.tenants).get(t); return x ? [x as Rec] : []; },
  };
}

// ------------------------------------------------------------------------------------------------ what the UI gets
export const FUNCTIONS = ['count', 'countDistinct', 'sum', 'avg', 'min', 'max', 'p50', 'p90', 'p95', 'p99'] as const;
export const OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'nin', 'contains', 'startsWith', 'between', 'isNull', 'notNull'] as const;
export const BUCKETS = ['hour', 'day', 'week', 'month'] as const;

export function catalogView() {
  return {
    sources: Object.values(SOURCES).map((s) => ({
      key: s.key, label: s.label, permission: SOURCE_PERMISSION[s.key],
      fields: s.fields.map((x) => ({ key: x.key, label: x.label, type: x.type, computed: !!x.computed })),
      dynamic: s.dynamic.map((d) => ({ key: d.key, label: d.label })),
    })),
    relations: Object.values(RELATIONS).map((r) => ({ key: r.key, label: r.label, from: r.from, to: r.to, many: r.many, recursive: !!r.recursive })),
    functions: FUNCTIONS, operators: OPERATORS, buckets: BUCKETS,
  };
}

export type { WorkflowInstance, WorkflowInstanceAudit, WorkflowInstanceComment };
