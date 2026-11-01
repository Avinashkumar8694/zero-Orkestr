# 18 — Background (async) execution and jBPM node properties

Why this exists: a caller who starts a process instance is not always willing to wait for it, and the engine used to model only a
slice of what jBPM's designer lets you set on each node. This document records what jBPM offers, how it works, what was missing
here, the design that closes the gap, and what is deliberately left for later.

Research base: jBPM 7.74.1 documentation and source (`jbpm-flow`, `jbpm-bpmn2`, `jbpm-executor`, `jbpm-human-task`) plus the local
`bpmn-sdk`. Kogito / jBPM 8 was **not** researched. Statements below marked *(unverified)* come from the research notes' own
"unverified" list.

---

## 1. How jBPM does it

### 1.1 Where the designer extras live
Most "designer extras" are **not** XML attributes. Business Central writes them as
`<drools:metaData name="customXxx"><drools:metaValue>…</drools:metaValue></drools:metaData>` inside the element's
`extensionElements`: `customAsync` (Is Async), `customSLADueDate`, `customAutoStart`, `customDescription`, `customScope`,
`customTags`, `customActivationCondition`. `onEntry-script` / `onExit-script` are sibling extension elements.

### 1.2 Async ("Is Async" = `customAsync`)
1. The node is wrapped in an `AsyncEventNode` when it is an action (script), a state-based node (user / service / work-item task,
   call activity, sub-process, catch event) or an end event. **Not** start events, gateways or event sub-processes.
2. When the token arrives, an `AsyncEventNodeInstance` schedules a job on the **executor service** and parks the token on a random
   signal id. The caller's transaction commits: the instance is saved (state ACTIVE) and a `RequestInfo` row is written
   (QUEUED). `startProcess` returns the instance id at that point.
3. An executor thread runs the job later, signals the id and the real node runs in a new transaction.
4. Retries: statuses QUEUED → RUNNING → DONE, or RETRYING (retries left, delay between attempts) → ERROR; CANCELLED on cancel.
   Default retry count is 3 (`org.kie.executor.retry.count`). If no executor is registered jBPM silently runs the node
   synchronously.
5. Starting the *process itself* in the background has no designer flag; it is done by scheduling `AsyncStartProcessCommand`.
6. Call activity "fire and forget" is a different mechanism: `independent=true` plus `waitForCompletion=false`.

### 1.3 Per-node properties (what matters for parity)
| Node | jBPM properties beyond name / documentation |
|---|---|
| Every activity | onEntry, onExit, **Is Async**, **SLA Due Date**, AdHoc Autostart, metadata attributes, multi-instance (collection in/out, data in/out, **completion condition**, sequential/parallel), isForCompensation |
| Script task | script + dialect |
| User task | TaskName, ActorId, GroupId, BusinessAdministrator*, ExcludedOwnerId, Priority, Description, **Comment**, **Skippable (default true)**, Content, Locale, CreatedBy, `suspendUntil`, AssignmentStrategy, **NotStarted/NotCompleted × Reassign/Notify** |
| Service / work item | handler by `taskName`, free-form inputs/outputs; REST: Url, Method, ContentType, Content, **ConnectTimeout / ReadTimeout**, auth, HandleResponseErrors *(unverified key names)*; async executor task: CommandClass, Retries, RetryDelay, Delay, AutoComplete, Priority |
| Business rule | ruleFlowGroup or DMN (namespace, model, decision) |
| Send / receive / manual | message, implementation |
| Call activity | calledElement, **independent**, **waitForCompletion**, abortParent *(unverified)*, data mapping, multi-instance |
| Sub-process | embedded / event (isInterrupting) / ad-hoc (completionCondition, ordering) / transaction *(unverified)* |
| Boundary / catch events | cancelActivity (interrupting), timer (duration / cycle / date; language ISO, cron, mvel; `#{var}`), message, signal, error, escalation, conditional, compensation |
| Gateways | direction, default flow, flow priority, event-gateway type / instantiate, complex activation condition |
| Process | id, name, package, **version**, **adHoc**, imports, globals, **variable tags (required / readonly / restricted)**, **Process Instance Description (`#{var}`)**, **process SLA**, declarations (signal, message, error, escalation) |

User-task deadline text (from `HumanTaskHandlerHelper`): components joined by `^`; each `[<action>]@[<expiry>(,<expiry>…)]`;
action is `key:value|key:value` (values may be comma lists). Reassign keys: `users`, `groups`. Notify keys: `tousers`,
`togroups`, `toemails`, `from`, `replyto`, `subject`, `body`, `locale`. Expiry: `4h`, `2d`, `1h 30m`, `PT30M`, `R/PT1H`.

---

## 2. What the engine had, and the gaps

| Area | Before | Gap |
|---|---|---|
| Starting an instance | always synchronous: the response is the instance after it ran to its first wait or end | no way to start and walk away |
| Async node | none | slow script / HTTP / call blocked the caller |
| Background retries | timer jobs retried nothing | no retry policy |
| SLA | user task `dueDate` only set `dueAt`; nothing happened when it passed | no violation tracking on any node |
| User-task deadlines | none | no reassign / notify on a late task |
| Call activity | `independent: true` meant *both* "child outlives parent" and "parent does not wait" | `waitForCompletion` missing; the two switches were fused |
| HTTP task | timeout only from the workspace setting | no per-node timeout |
| bpmn-sdk | read / wrote only the `elementname` metaData | async, SLA, autostart, tags and every other `drools:metaData` were **dropped** on modeled nodes |
| Variable tags, MI completion condition, process SLA / description / version / adHoc, signal scope, cron timer language, user-task content properties | none | listed in §7 |

---

## 3. Design

### 3.1 One mechanism for all background work
Background work reuses the existing **durable timer job** (`TimerJob`) and the existing worker loop, instead of adding a second
queue. That buys, for free: persistence in the same store, multi-replica safety (each job is claimed by exactly one replica; with
Redis coordination or `SKIP LOCKED`), visibility on the Jobs & Timers screen, cancellation when an instance ends, and the
workspace's `defaultJobRetries` / `timerBatchSize` settings.

`TimerJob.kind` gained three values:

| kind | purpose | fired by |
|---|---|---|
| `async` | run a parked node, or the first node of a background start | `InstanceService.fireAsync` → `ExecutionEngine.fireAsync` |
| `sla` | a node's SLA clock ran out | `ExecutionEngine.fireSla` |
| `deadline` | a user-task deadline came due | `TaskService.fireDeadline` |

New job fields: `attempts`, `maxAttempts`, `retryDelayMs`, `lastError` (async), `taskId`, `deadline{type,action}` (deadline).

### 3.2 Node-level async (`async: true`)
```
token reaches node ──► node.async && node type is async-capable && token not already released?
        │ yes                                                              │ no
        ▼                                                                  ▼
 park token (waitFor: async), history visit outcome "queued",         run node inline (unchanged)
 enqueue `async` job (due now), save instance, return to caller
        │
        ▼   worker tick (or the in-process kick, ~25 ms)
 fireAsync: drop the "queued" visit, token → active + asyncReady, run node for real, continue until the
 instance waits or ends
```
* **Eligible nodes** (`ASYNC_CAPABLE`): script, http, workItem, rule, send, call, forEach, subprocess. Events, gateways, user
  tasks and receive already wait or have nothing to defer. jBPM's eligibility is similar; ours excludes user task because it
  already parks. Async on any other type is a validation **warning** and is ignored.
* `asyncReady` on the token stops the node from being parked a second time when the worker releases it.
* The history keeps **one** visit per run (the queued marker is removed), so execution-count badges stay correct.
* **Retry semantics (deliberate):** the job is retried only when the *worker cannot run it* (store error, lock, engine
  exception). A script/HTTP error is a business error and follows the normal error model (error boundary, global handler, or the
  instance fails and appears in Execution Errors) — retrying it blindly could repeat side effects. Between attempts the instance
  stays `waiting`. After `maxAttempts` the instance fails at that node with `async job failed after N attempt(s): …`.
* `asyncRetries` (0–20, default = workspace `defaultJobRetries`, else 3) and `asyncRetryDelay` (ISO-8601, default `PT10S`,
  multiplied by the attempt number) are properties of the node.
* Suspend: a suspended instance's job is left scheduled and runs on resume. Abort: the job is cancelled with the instance.

### 3.3 Background instance start
`POST /api/instances` with `async: true` in the body **or** the standard `Prefer: respond-async` header:

```
202 Accepted
Location: /api/instances/<id>
Preference-Applied: respond-async
{ …instance: status "running", no history, token parked on `async` }
```
The instance is created, audited and persisted immediately (so it is visible and addressable), its first token is parked and one
`async` job is queued. The worker runs the process from the start node on. Plan limits and the instance quota are checked
**before** the 202, so a refusal is still synchronous (402 / 409 / 429). The default (no flag) is unchanged: `201` after the
inline run.

Callers follow the instance with `GET /api/instances/:id`, the instance event stream, or a signal/task as usual. There is no
callback URL yet (§7).

### 3.4 Worker kick
`scheduleAsync` calls `kickWorker()`; the worker (roles `all` / `worker`) listens and runs a scheduler pass after ~25 ms instead
of waiting for the next tick. Without a listener (the stateless `api` role, tests) it is a no-op and the job waits for a worker
tick: durability never depends on the kick. A `passRunning` guard stops a kick overlapping a tick.

### 3.5 SLA Due Date (`slaDueDate`)
* Value: a duration (`2h`, `1d`, `1h 30m`, `PT30M`), an absolute date, or `#{variable}` (resolved from process variables when the
  node starts).
* The clock starts when a node **waits or is queued** (a node that finishes inline has nothing to measure). It is stored on the
  token (`token.sla`) so it survives an async hop, and mirrored on the history visit (`visit.sla`).
* Compliance: `pending` → `met` (node completed in time; its `sla` job is cancelled) or `violated` (the job fired first).
  Finishing late does not undo a violation.
* On violation: the visit is flagged, an audit event `node.sla.violated` is written, an `instance.updated` event is emitted, and the
  person who started the instance gets an `sla-breached` notification. **The process keeps running** — jBPM's behaviour.
* An unreadable SLA never blocks the process; validation reports it as an error at publish.

### 3.6 User-task deadlines
Four optional properties on a user task — `notStartedReassign`, `notCompletedReassign`, `notStartedNotify`, `notCompletedNotify`
— in jBPM's text syntax (§1.3). On task creation one `deadline` job is queued per (component, expiry).

At fire time the engine acts **only if the task is still in the state the deadline watches**:
* *not started* → task is `created` or `reserved`; *not completed* → task is not finished.
* a started task ignores "not started"; a completed/skipped/exited task ignores everything. Starting a task also cancels its
  *not started* jobs; completing it cancels the rest (they are bound to the task's token).
* **Reassign:** `groups` → the task goes back to the group's queue; `users` → reserved for the first user; the new owner is notified.
* **Notify:** `tousers` get a bell notification, `toemails` get an e-mail (existing mailer; delivery never fails the job), `subject`
  and `body` default to a sensible message. `togroups` is recorded in the audit event only (no group-membership fan-out yet).
* Audit: `task.reassigned.deadline` / `task.notified.deadline`.
* Repeating expiries (`R/PT1H`) fire **once** at the first period (§7).

### 3.7 Call activity: `waitForCompletion`
`waitForCompletion` (default true) is now separate from `independent`:

| independent | waitForCompletion | behaviour |
|---|---|---|
| unset / false | unset / true | parent waits (default) |
| any | **false** | parent continues at once (fire-and-forget) |
| **true** | unset | **legacy**: still fire-and-forget, so existing flows do not change |
| true | **true** | parent waits, but the child survives the parent's abort (jBPM's meaning) |

### 3.8 HTTP task: `timeoutSeconds`
Per-node timeout (1–300 s). Empty uses the workspace `httpTimeoutSeconds`; the cap stops a node holding a worker indefinitely.

### 3.9 Validation (design-time)
* `async-config` — warning when `async` is on a node that cannot run in the background; error for `asyncRetries` outside 0–20 or
  a non-duration `asyncRetryDelay`.
* `node-timing` — error for an unreadable `slaDueDate`, or a user-task deadline that is not `[action]@[expiry]`, uses a key not
  valid for its kind, lacks users/groups (reassign) or recipients (notify), or has an expiry that is not a duration.

### 3.10 bpmn-sdk (jBPM import / export)
The SDK dropped every `drools:metaData` except `elementname`. It now:
* **parses** all of them on activity nodes into `Node.async` (`customAsync`), `Node.slaDueDate` (`customSLADueDate`),
  `Node.autoStart` (`customAutoStart`) and `Node.metaData` (everything else, including `customTags` and vendor keys);
* **serializes** them back as `<drools:metaData>` entries (also on the REST call-activity wrapper);
* maps engine ⇄ BPMN: `async`, `slaDueDate`, and the engine-only `asyncRetries` / `asyncRetryDelay` (kept as metaData so a jBPM
  file still opens in Business Central, which ignores unknown keys).

Round-tripping a jBPM project therefore keeps Is Async and the SLA, and an engine process exports them for Business Central.

---

## 4. Data model changes
| Where | Change |
|---|---|
| `Token` | `asyncReady?`, `sla?: {dueAt,status,at}` |
| `WaitSpec.kind` | + `async` |
| `NodeVisit` | `sla?` |
| `TimerJob` | `kind` + `async` / `sla` / `deadline`; `attempts`, `maxAttempts`, `retryDelayMs`, `lastError`, `taskId`, `deadline` |
| Engine node (JSON) | `async`, `asyncRetries`, `asyncRetryDelay`, `slaDueDate`; call: `waitForCompletion`; http: `timeoutSeconds`; userTask: the four deadline strings |

No migration is needed: every new field is optional and absent on existing data.

## 5. API
| Call | Change |
|---|---|
| `POST /api/instances` | `async: true` or `Prefer: respond-async` → **202** + `Location` + `Preference-Applied`; otherwise unchanged (201) |
| Jobs & Timers screen / timer-job list | shows `Background run` rows with attempt count and last error |

## 6. Tests
* `server/test/async-execution.test.ts` — ASYNC-1…8: park/run, default unchanged, background start, business error not retried,
  infrastructure retry then fail, abort cancels the job, HTTP 202 / `Prefer`, validation.
* `server/test/node-properties.test.ts` — NP-1…8: delay parsing, deadline syntax, SLA met / violated, SLA across an async hop,
  reassign / notify deadlines (and a started or completed task ignoring them), `waitForCompletion` matrix, validation.
* `bpmn-sdk/test/async-sla-metadata.test.mjs` — metaData round trip.

## 7. Not done yet (and the plan)
| Item | jBPM | Proposed approach |
|---|---|---|
| Variable tags | `required` / `readonly` / `restricted` | `EngineVar.tags`; reject a start missing a `required` variable (400); reject API edits to a set `readonly` variable |
| Multi-instance completion condition | `completionCondition` | JS expression evaluated after each child completes (forEach); when true, cancel the remaining children |
| Process SLA / instance description / version / adHoc | `customSLADueDate`, `customDescription` (`#{var}`), `drools:version`, `drools:adHoc` | process-level fields; reuse the `sla` job for the instance; render the description once at start |
| Background start callback | none in jBPM | optional `callbackUrl` posted when the instance ends |
| Repeating deadlines / reminders | `R/PT1H` expiry | reschedule the `deadline` job like a cycle timer |
| `togroups` fan-out | notify groups | resolve members through the IAM group store, then notify |
| User-task content properties | Comment, Content, Locale, CreatedBy, `suspendUntil`, AssignmentStrategy | add to the task model and the form |
| Timer `language` (cron / mvel) | `timeCycle language` | add a cron parser to `duration.ts`; keep ISO as the default |
| Signal scope | `customScope` | targeted vs broadcast signal on throw nodes |
| Abort parent / calledElementByName | call activity | flag on the child to fail its parent; resolve by name |
| Async eligibility for end events and user-task creation | jBPM allows it | extend `ASYNC_CAPABLE` once there is a use for it |
| Kogito / jBPM 8 differences | — | not researched |

## 8. Operating notes
* The worker must be running (`ROLE=all` or `worker`). With only `api` replicas, async jobs sit `scheduled` until a worker starts.
* Several worker replicas are safe: each job is claimed by exactly one.
* The Jobs & Timers screen can cancel, trigger now, or reschedule an async job like any other.
* Latency of a background run is the kick (~25 ms) in the same process, otherwise up to `timerTickIntervalMs` (default 5 s).
