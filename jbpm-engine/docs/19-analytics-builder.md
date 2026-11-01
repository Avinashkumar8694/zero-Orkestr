# 19 — Analytics Builder and the case / process instance flow nodes

Two related additions:

1. **Analytics Builder** — users compose analytics (case, process, task, project, workspace data, with joins, filters,
   grouping, metrics and call-tree recursion) in a query builder, give each a **slug**, publish it, and call it as an API.
2. **Case instance / Process instance flow nodes** — two nodes that expose every instance operation in a select list, with
   per-operation parameters, so a flow can read or act on any case, process or task at any time.

It extends the existing ad-hoc query engine (`/analytics/query/run`, saved queries) — which stays unchanged — and removes its
limits: one entity only, no joins, count / average only, no projections, no parameters, no recursion, no stable API handle.

---

## 1. Data model

### 1.1 Sources (entities) and their fields
Every field is declared in a server-side **catalogue** (type, label, filterable / groupable / aggregatable). The builder UI reads
it for autocomplete; the runner refuses anything not in it, so a query can never reach a field, entity or tenant it should not.

| Source | Backing data | Notable fields (besides ids and timestamps) |
|---|---|---|
| `case` | case record (`WorkflowInstance`) | `workflowName`, `status`, `piid`, `deploymentId`, `startError`, `data.*`, `roles.*`, `milestoneCount` |
| `process` | BPM instance | `status`, `workflowId`, `deploymentId`, `processId`, `correlationKey`, `parentInstanceId`, `startedBy`, `startedAt`, `endedAt`, **`durationMs`**, `waitingOn`, `errorMessage`, `errorNodeId`, `variables.*` |
| `task` | user task | `name`, `nodeId`, `status`, `group`, `assignee`, `priority`, `createdAt`, `claimedAt`, `completedAt`, `completedBy`, `dueAt`, **`overdue`**, **`waitMs`** (created→claimed), **`workMs`** (claimed→completed), **`totalMs`** |
| `audit` | case audit trail | `kind`, `actor`, `at`, `data.*` |
| `comment` | case comments | `author`, `body`, `at` |
| `project` | workflow / project | `name`, `key`, `archived`, `folderId` |
| `deployment` | deployment | `environment`, `status`, `versionNumber`, `versionLabel`, `tags`, `deployedAt`, `deployedBy` |
| `error` | execution error | `type`, `nodeId`, `nodeType`, `message`, `occurrences`, `acknowledged` |
| `workspace` | this workspace | `name`, `slug`, `plan`, `status` |

`data.*`, `variables.*`, `roles.*` accept a dotted path (`case.data.claimAmount`, `process.variables.customer.tier`), capped at 6
segments. Computed fields (`durationMs`, `overdue`, `waitMs`, …) are evaluated per row, never stored.

### 1.2 Relations (the join catalogue)
Joins are **named relations**, not free-form ON clauses: the server knows each key pair, which side is "many", and which side to
index. Aliases default to the source name.

| Relation | Keys | Cardinality |
|---|---|---|
| `case.process` | `case.piid = process.id` | one |
| `process.case` | `process.variables._caseInstanceId = case.id` | one |
| `process.tasks` / `case.tasks` | `task.instanceId = process.id` (case goes through its process) | many |
| `process.project` | `process.workflowId = project.id` | one |
| `process.deployment` | `process.deploymentId = deployment.id` | one |
| `process.errors` | `error.instanceId = process.id` | many |
| `process.children` | `child.parentInstanceId = process.id` | many (direct) |
| `process.descendants` | whole call-activity / sub-process tree | many, **recursive** (adds `depth`) |
| `process.root` | top-most ancestor | one |
| `process.ancestors` | parent chain | many (adds `depth`) |
| `case.audits`, `case.comments` | `audit/comment.workflowInstanceId = case.id` | many |
| `task.process` | `task.instanceId = process.id` | one |
| `any.workspace` | constant row | one |

Joins are `left` (default) or `inner`. A *many* join multiplies rows exactly like SQL, which is what you want when grouping tasks
by assignee or counting descendants per root.

**Recursion.** `descendants`, `ancestors` and `root` walk the parent links iteratively with a visited set and a depth cap of 20
(cycle-safe, no recursion in the call stack). The joined row exposes `depth` (1 = direct child), so "average duration of
sub-processes at depth 2 under process X" is a normal filter + metric.

### 1.3 The query
```jsonc
{
  "from": "case",
  "joins":   [{ "rel": "case.process" }, { "rel": "process.tasks", "as": "task", "type": "left" }],
  "where":   { "op": "and", "items": [
                { "field": "case.status", "op": "eq", "value": "active" },
                { "field": "case.createdAt", "op": "gte", "value": { "now": "-30d" } },
                { "field": "task.assignee", "op": "eq", "value": { "param": "assignee" } } ] },
  "select":  [{ "field": "case.id", "as": "caseId" }, { "field": "task.name" }],     // row mode
  "groupBy": [{ "field": "task.completedAt", "bucket": "day", "as": "day" }],        // aggregate mode
  "metrics": [{ "fn": "count", "as": "tasks" }, { "fn": "avg", "field": "task.totalMs", "as": "avgMs" }],
  "having":  [{ "field": "tasks", "op": "gt", "value": 5 }],
  "sort":    [{ "field": "day", "dir": "desc" }],
  "limit": 100, "offset": 0
}
```
* **Filters** — nested `and` / `or` groups of conditions. Operators: `eq ne gt gte lt lte in nin contains startsWith between isNull notNull`.
  A value is a literal, `{ "param": "name" }` or `{ "now": "-7d" }` (`s m h d w`, optional sign).
* **Row mode** (`select`) or **aggregate mode** (`groupBy` and/or `metrics`); not both.
* **Metrics** — `count`, `countDistinct`, `sum`, `avg`, `min`, `max`, `p50`, `p90`, `p95`, `p99`.
* **Buckets** for dates — `hour`, `day`, `week` (ISO Monday), `month`.
* **Params** are declared on the API (`name`, `type`: string / number / boolean / date / list, `required`, `default`) and coerced
  and validated before the query runs.

---

## 2. Execution — fast by construction
1. **Compile once.** The query is validated against the catalogue and turned into a plan: which entities are actually needed
   (only those referenced by joins, `select`, `where`, `groupBy`, `metrics` or `sort`), and which conditions can be pushed down.
2. **Tenant scope is applied by the fetch itself**, from the authenticated context only. Nothing in a query can widen it.
3. **Push-down.** Top-level `and` conditions that touch only the `from` source are evaluated inside the fetch predicate: rows that
   cannot match are never materialised.
4. **Semi-join + hash-join.** For each join the left keys are collected into a set, the right side is fetched restricted to those
   keys, indexed by its join key in a `Map`, and probed: O(left + right), no nested loops.
5. **Early exit.** With no joins, sort, grouping or metrics, evaluation stops after `offset + limit` rows. A one-cardinality left
   join that nothing in the query reads is skipped.
6. **Streaming aggregation.** Groups accumulate in a map (count / sum / min / max / distinct sets); rows are not kept. Only
   percentile metrics keep a numeric array, and only for their own group.
7. **Guards.** Max rows scanned (200 000), max rows returned (1 000), time budget (10 s). Hitting a guard returns the result so
   far with `truncated: true` and the reason, never a hang.
8. **Result cache.** Keyed by (workspace, API id, version, params hash), TTL `cacheSeconds` per API (default 30, 0 = off),
   bounded LRU. Editing the API bumps its version, so stale results are never served.
9. The storage layer is the existing one (memory / file / Postgres generic store), so this runs everywhere the product runs. The
   plan is backend-neutral, so a Postgres push-down (SQL for the same plan) can be added later without changing the API.

Every response carries `meta: { tookMs, scanned, returned, truncated, cached }` so users can see the cost of their analytics.

---

## 3. Publishing as an API — slugs
An analytics definition has a **slug** (`^[a-z][a-z0-9-]{2,47}$`, unique per workspace) and a status:

| status | meaning |
|---|---|
| `draft` | editable, runnable only from the builder preview |
| `published` | callable at `/api/analytics/run/<slug>` |

```
GET|POST /api/analytics/run/:slug            params in the query string or JSON body
  → 200 { slug, version, mode:"rows"|"aggregate", columns:[{key,label,type}], rows:[…], meta:{…} }
  → 403 not permitted · 404 unknown, not published, or private to someone else · 422 bad / missing / unknown parameter
```
Builder management:
```
GET    /api/analytics-builder/catalog         entities, fields, relations, functions, operators, buckets (drives autocomplete)
POST   /api/analytics-builder/preview         { query, params? } → result (never cached, never saved)
GET    /api/analytics-builder/apis            list           POST /apis  create
GET    /api/analytics-builder/apis/:id        read           PUT  /apis/:id  update (bumps version)    DELETE /apis/:id
```
Permissions: building needs `analytics:query`; running a published API needs `query:read`. An API may be `private` (owner only)
or `workspace`. Every create / update / delete / publish is written to the audit log.

The existing `/analytics/query/run` and saved queries are untouched.

---

## 3a. Security — who may see what
Analytics reads real business data, so every layer enforces authorization; none of it trusts the request body.

| Layer | Rule |
|---|---|
| **Workspace** | The workspace comes only from the authenticated context (membership check on `x-tenant-id`). Every table is loaded with that tenant filter, so no filter, join, relation or recursive walk can reach another workspace: a process in workspace B that *claims* A's case, or a child that names A's parent, is simply not found. The platform-wide "all workspaces" scope is refused (analytics needs one workspace). |
| **Role / permission to build** | Designing and previewing needs `analytics:query` (operator and admin by default). |
| **Role / permission to read data** | Each source needs the permission that guards the same data elsewhere: **case, audit, comment → `workflowInstance:manage`** · **process, task, error → `query:read`** · **project, deployment → `workflow:view`** · **workspace → `team:read`**. A query is refused (403, naming the missing permission) unless the caller holds the permission for **every** source it touches, including joined ones — joining a source is reading it. Checked on preview, on save and on every run, using the caller's real permissions in this workspace (member role, explicit permissions, IAM roles; `*` for administrators). |
| **Calling a published API** | `query:read` on the route **plus** the source permissions above **plus** the API's own optional `requires` permission. Source permissions are checked **before the cache is consulted**, and cache keys carry workspace, API id and version, so a cached result can never be served to someone who may not read it. |
| **Publishing** | You cannot publish a query over data you may not read yourself, and you cannot set `requires` to a permission you do not hold. |
| **Ownership / visibility** | `private` APIs are invisible (404) to everyone but the owner; editing or deleting needs the owner or `admin:iam`. |
| **Flows** | A Case / Process instance node runs `analytics.run` with the engine's authority, so an API is callable from a flow **only if its owner enabled "allow flows"**, and still only inside that workspace. |
| **Abuse limits** | Scan, join-expansion, row and time guards (§2), bounded cache, parameter validation with type coercion, reserved slugs, filter-depth and path-depth caps. |
| **Audit** | create / update / delete and every run are written to the audit log (who, slug, version, rows, via http or flow). |

Not implemented (and why it is not needed yet): per-project row filtering. The project-level `permissions` list exists on a project
but nothing in the product enforces it on instances or tasks today, so analytics follows the same rules as the existing screens.
If project-scoped visibility is introduced there, it belongs in the catalogue's table loaders so every analytics query inherits it.

---

## 4. Case instance / Process instance flow nodes
Two nodes in the palette (category *Instances*): **Case instance** (`caseInstance`) and **Process instance** (`processInstance`).

### 4.1 Using a node
1. Pick an **Operation** from the select (grouped, typeable for autocomplete).
2. Only that operation's parameters appear (`when` rules in the property schema). A target id defaults to the current instance
   (`$instance.id` / the case id kept in `_caseInstanceId`).
3. Parameters accept literals or `$variable` (dotted paths allowed, `$claim.id`).
4. **Result → variable** (`resultTo`) with an optional **Result path** to keep only part of the answer.
5. **On error**: fail the node (default, catchable by an error boundary with code `INSTANCE_OP_ERROR`) or store
   `{ error, code }` in the variable and carry on.

### 4.2 Operations
| Node | Operation | Does |
|---|---|---|
| Case | `get` | full case view (aggregate) |
| Case | `data.get` / `data.update` | read / merge-update case data |
| Case | `status.set`, `close`, `reopen` | business status lifecycle |
| Case | `flag.add`, `role.set`, `milestone.achieve`, `comment.add` | case annotations |
| Case | `tasks` | every task under the case |
| Case | `signal` | signal the case's process |
| Case | `create` | start a new case from a workflow name |
| Process | `get`, `history`, `related` | instance, visits, parent / children |
| Process | `variables.get`, `variables.set` | read / write variables of an instance |
| Process | `tasks` | tasks of an instance |
| Process | `start` | start another process instance |
| Process | `signal`, `abort`, `suspend`, `resume`, `retry` | control another instance |
| Both | `analytics.run` | call a published analytics API (slug + params) and keep the result |

### 4.3 Safety rules
* **Self-targeting.** A flow may *read* its own instance (served from the in-memory state, so it is current). Operations that
  *write* to the running instance (`variables.set`, `signal`, `abort`, `suspend`, `retry`…) are refused with `SELF_TARGET`:
  the engine is mid-run on that object and writing around it would be overwritten. Use script nodes or other nodes for that.
  Case operations act on the case record, which is separate, so they are allowed on the flow's own case.
* **Tenant.** Every operation resolves the workspace from the engine context; ids from another workspace are "not found".
* **Permissions.** The node acts with the engine's own authority, as every other node does; who may *design* such a flow is
  governed by `workflow:edit`. `analytics.run` is the exception that is stricter: it only runs APIs whose owner enabled "allow
  flows" (§3a).
* **jBPM export.** These two nodes are engine-native (jBPM has no equivalent). Exported to jBPM they become a placeholder, like
  other engine-only constructs.
* **Size.** A result stored in a variable is capped (1 MB serialised); larger results fail the node with a clear message so a
  runaway query cannot bloat an instance.

---

## 5. Implementation map
| Piece | Where |
|---|---|
| Catalogue (entities, fields, relations) | `server/src/analytics/catalog.ts` |
| Query validation + compile + run (joins, aggregation, cache) | `server/src/analytics/engine.ts` |
| Definitions, slugs, params, versions | `server/src/analytics/service.ts` |
| HTTP routes | `server/src/http/routes/analytics-builder.ts` |
| Operation registry shared by both nodes | `server/src/engine/nodes/instance-ops/ops.ts` |
| Nodes | `server/src/engine/nodes/case-instance/`, `process-instance/` |
| Conditional property fields (`when`) | `def-types.ts` (`UiField.when`) + properties panel |
| UI | Analytics Builder page (list, editor, preview, call snippet) |

## 6. Tests
Query semantics (filters, operators, params, `now`), joins (one / many / left / inner), recursion (depth, cycle safety), aggregation
and buckets, row vs aggregate mode, guards and `truncated`, tenant isolation, slug rules, publish / run, cache and version bump,
catalogue refusal of unknown fields, node operations (read, write, self-target refusal, error modes).

## 7. Later
Postgres SQL push-down for the same plan · scheduled / emailed analytics · saved dashboards and charts over published APIs ·
per-API rate limits and API keys for external callers · more sources (timers, notifications, assets).
