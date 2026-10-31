# Workflow Instance Management

An additive layer on top of everything in [Deployments & environments](05-deployments-and-environments.md),
[Running & monitoring instances](06-running-and-monitoring-instances.md), and
[Human tasks](07-human-tasks.md) — it exists to solve one problem: **every redeploy mints a brand-new
`deploymentId`/`workflowId`**, so a client app that wants a stable name to start cases against, business
data with its own schema, and a case-centric view (status + data + tasks-at-any-depth + comments +
audit + signals in one place) has nowhere to hang any of that today. Nothing here replaces the raw BPM
APIs — a caller who wants `POST /instances`, `GET /query/instances/:id/tasks`, etc. directly can keep
using them exactly as before; this module wraps them.

Backed by `workflow-service/services/*`, mounted from `src/http/routes/workflow-instances.ts`. Three new
permissions gate it (see [Authentication & authorization](03-authentication-and-authorization.md) for
how roles grant permissions):

| Permission | Grants |
|---|---|
| `workflowInstance:admin` | Create/list/get/repoint a `WorkflowDefinition` |
| `workflowInstance:manage` | Everything on a case: create, status/data, comments, audits, signal, decision, delegate |
| `analytics:query` | The generic ad-hoc query engine + saved queries (default dashboards only need `query:read`) |

## The model

```
WorkflowDefinition (stable "workflowName", e.g. "claim-review-v1")
  ├─ points at exactly ONE deploymentId at a time — repointed via PATCH as new versions ship
  ├─ dataSchema (JSON Schema, ajv) + schemaValidationEnabled
  └─ WorkflowInstance (a "case" — one per POST /workflow-instances call)
       ├─ data           — business fields, validated against dataSchema if enabled
       ├─ status         — free-form business status ("Pending Review", …), independent of BPM status
       ├─ piid           — the underlying BPM Instance.id, backfilled once the process actually starts
       ├─ WorkflowInstanceAudit[]   — dedicated table, system- AND user-addable
       └─ WorkflowInstanceComment[] — dedicated table
```

**`WorkflowInstance` (case) vs. `Instance` (BPM process instance) are different things.** A case is a
business record; `piid` is a pointer from that record at the BPM instance actually doing the work. This
split is what lets `workflowName` stay constant forever while `deploymentId` changes underneath it on
every redeploy — a `WorkflowDefinition.update({ deploymentId: NEW_DEP })` call is the entire migration.

### Storage: a real, separate Postgres schema

Unlike every pre-existing module (`Workflow`, `Instance`, `Task`, … — all one generic `kv_store`
blob-per-collection table), this module's five tables (`workflow_definition`, `workflow_instance`,
`workflow_instance_audit`, `workflow_instance_comment`, `saved_query`) live in their **own real
Postgres schema**, `workflow_service`, with real typed columns — a deliberate choice made for this
module specifically, not a change to how anything else is stored. When `STORE=pg`
(see [Configuration reference](02-configuration.md)), the schema is created automatically
(`CREATE SCHEMA IF NOT EXISTS workflow_service`) the first time the server starts — no migration step,
no new environment variable. Under `STORE=file` (dev/test), the same `WorkflowServiceStore` interface is
backed by the existing file/memory store instead — service-layer code never branches on which backend is
active.

## Workflow Management — create/repoint a definition

**Workflow Management** in the sidebar (`workflowInstance:admin`). **Create Workflow Definition** opens a modal featuring a structured project-and-process binding workflow:

- **Deployment & Process Binding tab**:
  - `workflowName`: Stable identifier (e.g. `claim-assessment-flow`), immutable after creation.
  - **Two-Step Project & Process Hierarchy**: The modal first lists all available Projects. When a project is selected, all constituent processes of that project are displayed. Selecting the target process binds both the `deploymentId` and the specific `processId` to this workflow definition.
- **Schema tab**:
  - A recursive field-builder: each row is a name + type (`string`/`number`/`boolean`/`array`/`object`) + required flag.
  - Supports arbitrarily nested JSON Schema (objects with nested properties, arrays of objects).
  - **Schema Validation Toggle**: Enforces AJV schema validation on incoming `workflowData` during case creation and mutation.

Editing an existing definition round-trips a hand-authored or previously builder-authored `dataSchema`
back into the field-builder tree exactly, at every depth.

```bash
curl -s -X POST http://localhost:4000/api/workflow-definitions \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "name": "claim-review-v1",
    "deploymentId": "'"$DEP_ID"'",
    "processId": "claim-assessment-process",
    "schemaValidationEnabled": true,
    "dataSchema": {
      "type": "object",
      "properties": {
        "claimAmount": { "type": "number" },
        "applicant": { "type": "object", "properties": { "fullName": { "type": "string" } } },
        "tags": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["claimAmount"]
    }
  }'
```

Response (`201`):
```json
{
  "id": "WFDEF_ID", "name": "claim-review-v1", "deploymentId": "DEP_ID",
  "processId": "claim-assessment-process",
  "schemaValidationEnabled": true,
  "dataSchema": { "type": "object", "properties": { "...": "..." }, "required": ["claimAmount"] },
  "createdAt": "2026-08-09T10:00:00.000Z", "createdBy": "admin"
}
```

## Unified Instance Management (Processes + Cases)

Rather than keeping process instances and case instances fragmented across disconnected screens, the **Instances** view integrates both into a single pane:

1. **Combined Listing & Case Binding**:
   - The instance table displays both BPM Process Instances and Case Instances.
   - When a case instance initiates an underlying process instance, the process instance record is bound to the `caseInstanceId`.
   - Table columns display Instance ID, Case ID (if bound), Process/Workflow Name, Environment, Status, Started By, and Timestamps.
   - Comprehensive filtering supports filtering by Mode (All, Process Only, Case Only), Status, Date Range, and Search terms.

2. **Project-Level Instance Creation Configuration**:
   - Projects can be configured with system-level policies governing how instances are spawned:
     - `Both` (default): Authors and operators can trigger standalone Process instances or structured Case instances.
     - `Case Only`: Enforces all work to originate as a governed Case instance with business schema validation.
     - `Process Only`: Operates strictly as a traditional BPM process engine.

3. **Instance Details: Parent / Child Rail & Hierarchy**:
   - The Instance Details view features a dedicated **280px left navigation rail** displaying the complete hierarchical execution tree:
     - Root / Parent Process Instance card showing status, duration, and metadata.
     - Tree-branching list of Child Process Instances (spawned via `call` activities or multi-instance `forEach` tasks).
     - Visual pulse indicator highlighting the actively executing node.
     - One-click navigation between parent and child execution timelines.
   - **Strict On-Demand Lazy-Loading**: Detail tabs (Variables, Tasks, Node History, Sub-processes, Audit) only trigger API calls when actively clicked, eliminating background network overhead.

**Repointing after a redeploy** — the only thing that changes; `name` stays fixed, every existing case
still resolves to the correct history (each case denormalizes its own `deploymentId` at creation time,
so past cases keep tracing correctly even after the definition moves on):

```bash
curl -s -X PATCH http://localhost:4000/api/workflow-definitions/$WFDEF_ID \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"deploymentId":"'"$NEW_DEP_ID"'"}'
```

`name` must stay unique per tenant (`409` on a duplicate); `dataSchema`/`schemaValidationEnabled` are
also patchable independently, e.g. to turn validation on/off without touching the deployment pointer.

## Starting and running a case

**Workflow Instances** in the sidebar (`workflowInstance:manage`) — **Start Case** takes a
`workflowName`, optional `variables` (handed straight through to the BPM engine's process variables,
same as [`POST /instances`](06-running-and-monitoring-instances.md)), and optional `workflowData` (the
case's own business data):

```bash
curl -s -X POST http://localhost:4000/api/workflow-instances \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{
    "workflowName": "claim-review-v1",
    "variables": { "amount": 500 },
    "workflowData": { "claimAmount": 500, "applicant": { "fullName": "Jane Doe" }, "tags": ["urgent"] }
  }'
```

What happens, in order (`WorkflowInstanceService.create`):

1. Resolve the `WorkflowDefinition` by `workflowName` (`404` if it doesn't exist).
2. Validate `workflowData` against `dataSchema` — a no-op if `schemaValidationEnabled` is `false`;
   raises `422` with ajv's own error list if it's `true` and the data doesn't match.
3. Create the case row: `status:"initiated"`, `piid:null`. Record `workflowInstance.created` in the
   case's own audit trail.
4. Call the existing `InstanceService.start()` against the definition's `deploymentId`.
5. Backfill `piid` and flip `status` to `"active"` (or `"failed"` if the BPM start itself came back
   `failed`) and record `workflowInstance.bpmStarted`.

**A BPM-start failure never leaves an orphaned or stuck row.** If step 4 throws outright (bad deployment,
quota exceeded, etc.), the case is marked `status:"failed"` with `startError` set and a
`workflowInstance.startFailed` audit entry — the same terminal, explainable state as a `bpm.status ===
'failed'` response, just via a different path. Either way, `GET /workflow-instances/:id` always shows a
resolved state, never an indefinite `"initiated"`.

Response (`201`, success path):
```json
{
  "id": "WI_ID", "workflowDefinitionId": "WFDEF_ID", "workflowName": "claim-review-v1",
  "deploymentId": "DEP_ID", "data": { "claimAmount": 500, "...": "..." },
  "status": "active", "piid": "PIID_ID",
  "createdAt": "2026-08-09T10:00:00.000Z", "createdBy": "admin"
}
```

### The case detail aggregate

`GET /workflow-instances/:id` is the one-call case view — everything the detail page's five tabs need,
built on top of the *existing* BPM/task/query services (nothing new is re-implemented):

```json
{
  "workflowInstance": { "id": "WI_ID", "status": "active", "piid": "PIID_ID", "data": { "...": "..." } },
  "bpmInstance": { "id": "PIID_ID", "status": "waiting", "variables": { "amount": 500 } },
  "tasks": [{ "id": "TASK_ID", "name": "Review claim", "status": "created", "group": "ops" }],
  "signals": { "listensFor": ["DocumentsReceived"], "throws": ["ReviewComplete"] },
  "commentCount": 0, "auditCount": 2
}
```

`tasks` is **every task at any depth** under this case's BPM subtree — inside a call activity, an
embedded sub-process, a multi-instance fan-out, however many levels down, active or long completed (see
[Descendant traversal](#tasks-processes-and-subprocesses-at-any-depth) below for how). Lighter-weight
polling forms of the same data exist standalone: `GET /workflow-instances/:id/tasks`,
`GET /workflow-instances/:id/signals`.

### Status vs. data

```bash
# business-level status — independent of BPM Instance.status, which stays whatever the engine reports
curl -s -X PATCH http://localhost:4000/api/workflow-instances/$WI_ID/status \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"status":"Escalated"}'

# replaces `data` wholesale (PUT) — schema-validated if the definition has validation enabled
curl -s -X PUT http://localhost:4000/api/workflow-instances/$WI_ID/data \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"claimAmount":750,"applicant":{"fullName":"Jane Doe"},"tags":["urgent","reviewed"]}'
```

### Acting on tasks through the case

Two passthroughs, both scoped **through the case** (not a bare `taskId` you could point at an unrelated
instance by guessing an id) — the case's own task list is checked first, and a `404`/`409` comes back if
the target task doesn't actually belong to it:

```bash
# complete a specific task belonging to this case
curl -s -X POST http://localhost:4000/api/workflow-instances/$WI_ID/tasks/$TASK_ID/decision \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"outputs":{"approved":true}}'

# delegate the case's current open task — taskId only needed if more than one task is open
curl -s -X POST http://localhost:4000/api/workflow-instances/$WI_ID/delegate \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"to":"reviewer2"}'
```

Both record their own audit entry (`workflowInstance.decision` / `workflowInstance.delegated`) alongside
whatever the underlying [Human Tasks](07-human-tasks.md) engine itself already logs.

### Signaling a case

```bash
curl -s -X POST http://localhost:4000/api/workflow-instances/$WI_ID/signal \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"DocumentsReceived","payload":{"documentId":"DOC1"}}'
```

Thin passthrough to `InstanceService.signal(piid, ...)` — `409` if the case has no `piid` yet (start
still failed or hasn't run).

### Comments and audit — both user-addable, both dedicated tables

Per an explicit design decision, this module does **not** reuse the shared `Collections.comments`/
`Collections.audit` every other feature writes to — cases get their own
`workflow_instance_comment`/`workflow_instance_audit` tables. Audit entries are not only
system-generated: any caller with `workflowInstance:manage` can add a free-form note.

```bash
curl -s -X POST http://localhost:4000/api/workflow-instances/$WI_ID/comments \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"body":"Escalating this claim to senior adjuster pending handler fix."}'

curl -s -X POST http://localhost:4000/api/workflow-instances/$WI_ID/audits \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"kind":"workflowInstance.note","data":{"reason":"escalated to senior adjuster"}}'
```

`kind` defaults to `"workflowInstance.note"` if omitted. Deleting a comment requires being its author;
deleting an audit entry only requires `workflowInstance:manage` (no author restriction — audit entries
are a record of what happened, not a personal note).

System-generated `kind`s you'll see interleaved with your own custom ones, oldest first as an example
timeline: `workflowInstance.created` → `workflowInstance.bpmStarted` (or `.startFailed`) →
`workflowInstance.statusChanged` / `.dataUpdated` / `.signaled` / `.decision` / `.delegated` /
`.commented` / `.comment.deleted`.

### Finding cases by their own business data

`GET /workflow-instances` supports flat filters (`workflowName`, `workflowDefinitionId`, `status`,
`piid`) as query params. `POST /workflow-instances/search` adds a plain-equality search into `data`
itself, for "find every case where `data.claimType === 'auto'`" without reaching for the full ad-hoc
query engine below:

```bash
curl -s -X POST http://localhost:4000/api/workflow-instances/search \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"workflowName":"claim-review-v1","data":{"tags":"urgent"}}'
```

## Tasks, processes, and subprocesses at any depth

`InstanceService.descendants(rootId)` is a read-only, depth-first walk of the exact same
`parentInstanceId` chain `abortDescendants` already uses to cascade terminations
(see [Running & monitoring instances](06-running-and-monitoring-instances.md)) — but with no status
filter, so it returns every descendant `Instance` (active **and** completed/aborted) at any depth below
a root, plus the root itself. Two things are built on it:

- The case aggregate's `tasks` list (above) — every task under a case's BPM subtree.
- `GET /analytics/tasks-and-processes/:piid` — the standalone cross-cutting view, keyed by a raw BPM
  instance id rather than a case, useful when you're starting from
  [Running & monitoring instances](06-running-and-monitoring-instances.md) directly rather than a case:

```bash
curl -s http://localhost:4000/api/analytics/tasks-and-processes/$PIID \
  -H "Authorization: Bearer $TOKEN"
```
```json
{
  "instances": [
    { "id": "PIID", "status": "completed", "processId": "claim-review.process" },
    { "id": "SUB_PIID", "status": "completed", "parentInstanceId": "PIID", "processId": "escalate.process" }
  ],
  "tasks": [{ "id": "TASK_1", "instanceId": "SUB_PIID", "name": "Escalated review", "status": "completed" }]
}
```

## Workflow Analytics

**Workflow Analytics** in the sidebar. Three default dashboards need only `query:read` — the same
permission [Reports & analytics](12-reports-and-analytics.md) already requires:

```bash
curl -s http://localhost:4000/api/workflow-analytics/summary -H "Authorization: Bearer $TOKEN"
# { "total": 2, "byStatus": { "failed": 1, "active": 1 }, "withoutPiid": 0 }

curl -s http://localhost:4000/api/workflow-analytics/tat -H "Authorization: Bearer $TOKEN"
# { "byWorkflowName": [{ "workflowName": "claim-review-v1", "count": 1, "avgMs": 3, "minMs": 3, "maxMs": 3 }],
#   "byUser": { "admin": { "count": 25, "avgMs": 86524 } } }
```

`tat.byWorkflowName` measures the underlying **BPM instance's** own `startedAt`/`endedAt` (well-defined
regardless of a case's free-form business `status`); `tat.byUser` is the *existing*
`QueryService.taskAnalytics()` output, unchanged — this module never alters what that endpoint already
reports.

### Delegation-aware ownership timeline

`QueryService.taskAnalytics()`'s per-assignee TAT credits 100% of a task's duration to whoever holds it
right now — accurate with zero hand-offs, but silently wrong the moment a task is delegated or
forwarded, since `Task.assignee` is overwritten in place and the only surviving history is the audit
trail. This endpoint is **purely additive** — it changes nothing about the numbers above — and instead
reconstructs, per task, exactly who held it and for how long:

```bash
curl -s http://localhost:4000/api/workflow-instances/$WI_ID/tasks/$TASK_ID/ownership-timeline \
  -H "Authorization: Bearer $TOKEN"
```
```json
{
  "taskId": "TASK_ID",
  "segments": [
    { "holder": "ops",       "from": "2026-08-09T15:03:08Z", "to": "2026-08-09T15:04:18Z", "durationMs": 70000 },
    { "holder": "reviewer2", "from": "2026-08-09T15:04:18Z", "to": "2026-08-09T15:04:44Z", "durationMs": 26000 }
  ],
  "totalMs": 96000
}
```

Segments are built by walking the task's own `task.delegated`/`task.forwarded` audit events
chronologically, pairing each `{from, to}` transition into a contiguous, non-overlapping window —
`segments` always sums exactly to `totalMs` (the task's full `createdAt` → `completedAt`-or-now span) by
construction. With zero hand-offs this collapses to a single segment identical to what
`taskAnalytics()` already attributes to `completedBy || assignee` — a strict refinement, not a
contradiction of the existing number.

### The generic ad-hoc query engine

A fully generic, entity/field-allowlisted query builder — `entity` + optional `filters`/`groupBy`/
`metric`/`sort`/`limit` — for anything the fixed dashboards above don't cover. **The one rule every code
path in `QueryEngineService` exists to enforce: `tenantId` is resolved server-side from the
authenticated context and injected unconditionally — nothing in a caller-supplied query can widen,
override, or escape it.** This is proven directly by an adversarial test
(`server/test/workflow-instance.test.ts`): a crafted filter that exactly matches another tenant's row
data still returns zero rows, because the tenant scope is a structural `WHERE` clause applied *before*
any caller filter is even considered, not a convention a filter could accidentally (or deliberately)
override.

Every query needs `analytics:query`, a strictly more powerful permission than the `query:read` the
default dashboards use.

```bash
curl -s -X POST http://localhost:4000/api/analytics/query/run \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"entity":"workflowInstance","groupBy":"status","metric":"count"}'
```
```json
{ "groups": [ { "key": "failed", "count": 1 }, { "key": "active", "count": 1 } ] }
```

Queryable entities:

| Entity | Backing | Allowlisted filter/group fields |
|---|---|---|
| `workflowInstance` | Real SQL (`workflow_instance` table) | `workflowDefinitionId`, `workflowName`, `status`, `piid`, `deploymentId`, `createdAt`, `updatedAt`, plus any `data.<key>` (or `data.<a>.<b>`) dotted path — translated to a jsonb path expression, not a raw column |
| `workflowInstanceAudit` | Real SQL | `workflowInstanceId`, `actor`, `kind`, `at` |
| `workflowInstanceComment` | Real SQL | `workflowInstanceId`, `author`, `at` |
| `instance` | Existing generic blob store, tenant-prefiltered, evaluated in JS | any dotted path, e.g. `variables.claimAmount`, `status`, `processId` — safe by construction: rows are already scoped to this tenant before any field is read, so there's no SQL string to inject into |
| `task` | Same as `instance` | any dotted path, e.g. `inputs.<name>`, `outputs.<name>`, `assignee`, `group`, `status` |

Anything not on the allowlist for the three real-SQL entities is **silently dropped**, not errored — a
crafted `field` can never reach raw SQL beyond the exact, hand-written expressions in
`store/pg-store.ts`'s `COLUMNS` map. `op` is one of `eq`/`ne`/`gt`/`gte`/`lt`/`lte`/`in`/`contains`;
`metric` is `count` or `avgDurationMs` (the latter needs `durationFrom`/`durationTo` field paths that
resolve to parseable timestamps — rows where either side is missing are excluded from that bucket's
average, not treated as zero). Results are capped at `limit` (default `100`, hard max `500`).

Saved queries persist a `QueryDefinition` for reuse — `ownerId` unset means shared with the whole tenant:

```bash
curl -s -X POST http://localhost:4000/api/analytics/queries \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"cases-by-status","shared":true,
       "definition":{"entity":"workflowInstance","groupBy":"status","metric":"count"}}'

curl -s -X POST http://localhost:4000/api/analytics/queries/$QUERY_ID/run -H "Authorization: Bearer $TOKEN"
```

Deleting a saved query is restricted to its creator, regardless of `shared`.

## Swagger

Every route above is documented under two new tags in `GET /api/docs` — **WorkflowInstance**
(definitions + cases + comments/audits/tasks/signals) and **Workflow Analytics** (summary/TAT/ownership
timeline/tasks-and-processes/query engine/saved queries) — with named component schemas
(`WorkflowDefinition`, `WorkflowInstance`, `WorkflowInstanceAudit`, `WorkflowInstanceComment`,
`OwnershipTimeline`, `QueryDefinition`, `SavedQuery`) rather than bare `{type:'object'}` placeholders.
`server/test/openapi.test.ts` asserts every routed endpoint here is documented and every documented path
is actually registered, so the spec can't silently drift from the real router.

Like every other endpoint, `/api/docs` itself sits behind `requireAuth` — reach it with a `Bearer` token
already attached (e.g. via a browser extension, or `curl` for `/api/openapi.json` directly) rather than
a bare, unauthenticated page load.

## What this module deliberately does not change

- The raw BPM APIs (`/instances/*`, `/tasks/*`, `/query/*`) are completely untouched and remain fully
  usable on their own — this is an additive layer, not a replacement.
- `QueryService.taskAnalytics()`'s existing per-assignee numbers are unchanged; the ownership timeline
  is a new, separate endpoint precisely so nothing that already depends on today's TAT figures breaks.
- Comments/audit here are intentionally **not** the same rows as a raw BPM `Task`'s own comments/audit
  (see [Human tasks](07-human-tasks.md)) — a case's audit trail and a task's own audit trail answer
  different questions and are kept as separate tables on purpose.
