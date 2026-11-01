# 16 — jBPM Feature Parity & Capability Report

How this Node engine compares to jBPM / Business Central, per feature area, with the evidence that
proves each claim. **Legend:** ✅ full · 🟡 partial · ⛔ not yet · ➖ Node-native (intentionally different).

**Verification base:** `server` unit suite **28/28** (`npm test`) + a live end-to-end **12/12**
(`node server/e2e/parity.mjs` against a running server). Re-run both to reproduce.

## A. Authoring / Designer
| jBPM (Business Central) | This engine | Status | Evidence |
|---|---|---|---|
| Visual process designer (palette, canvas, properties) | Angular builder: palette, canvas, per-node properties | ✅ | app builds; catalog API |
| BPMN palette of node types | Catalog served from per-node `def.ts` (`GET /catalog/nodes`) | ✅ | E2E: catalog |
| Node property forms | Schema-driven panel (server-provided per node) | ✅ | catalog `schemas` |
| Connection rules per node | Per-node `ports {in,out}`; UI + backend enforce | ✅ | test 27; E2E: catalog ports |
| Process variables | Header Variables editor (typed) | ✅ | builder |
| Diagram validation ("Problems") | Rules engine + Problems panel; blocks publish | ✅ | tests 21–28; E2E: validation gate |
| Auto-layout, multi-select, undo | auto-layout + drag; undo/copy | 🟡 | builder |

## B. Process constructs (nodes)
| jBPM | This engine | Status | Evidence |
|---|---|---|---|
| Start / End (none, terminate, error, signal, message) | all triggers modelled + executed | ✅ | tests 5,21; nodes/* |
| Script task | JavaScript in a sandbox | ✅ | E2E: STANDARD path |
| Service (REST) task | real HTTP call, `$var` body, `resultTo`, SERVICE_ERROR | ✅ | tests 7,8; E2E |
| User task | work item + wait/claim/complete | ✅ | tests 5,11; E2E |
| Business rule (DRL) + DMN | DRL rulesets + DMN decision tables evaluated | ✅ | tests 14,15; E2E |
| Exclusive/Parallel/Inclusive/Event/Complex gateway | all modes (fork/join/conditions) | ✅ | test 5; E2E HIGH/STD |
| Intermediate catch/throw (timer/msg/signal/cond) | catch waits; throw broadcasts | ✅ | tests 9,12,17; E2E |
| Boundary events | error boundary (interrupting) + attach config | ✅ | tests 1–4; E2E error catch |
| Call activity (reusable) | child instance + I/O mapping + related | ✅ | test 11; E2E |
| Multi-instance | child per item, collect results | ✅ (v1 sequential) | test 10; E2E |
| Send / Receive | broadcast + wait | ✅ | test 9 |
| Embedded / transaction sub-process | nested instance over the node's own graph; shared variable scope; waits/resumes | ✅ | engine-subprocess test (sync + waiting) |
| Manual task, Data object, Lanes | modelled | ✅ / 🟡 | nodes; lanes P1 |

## C. Error handling
| jBPM | This engine | Status | Evidence |
|---|---|---|---|
| Boundary error events (per activity) | Error Catch attached to node(s) | ✅ | tests 1–4 |
| Event sub-process (process-wide) | global Error Catch (`on:['*']`) | ✅ | test 2; E2E |
| Error codes / catch-all | code match + `*` any | ✅ | tests 3,4 |
| Compensation | compensation boundary records handlers; compensate throw/end runs them LIFO (all or by ref) | ✅ | engine-compensation test |

## D. Rules & decisions
| jBPM | This engine | Status | Evidence |
|---|---|---|---|
| DMN decision tables (hit policies) | FIRST/UNIQUE/ANY/COLLECT + input tests | ✅ | test 14 |
| DRL rules (ruleflow-group) | basic condition→action over variables | 🟡 | test 15 |
| Guided decision table / tree / scorecard | table (DMN) + **tree traversal** + **additive scorecard** evaluated at runtime | ✅ | engine-decisioning test |

## E. Deployment / KIE
| jBPM (KIE server, kjar) | This engine | Status | Evidence |
|---|---|---|---|
| Build & deploy a kjar | deploy a published version snapshot | ✅ | test 5; E2E |
| Container aliases / active target | one **active** deployment per environment | ✅ | test 6; E2E swap |
| Deployment labels | tags | ✅ | E2E |
| Promote / rollback / undeploy | active-pointer moves; undeploy/archive | ✅ | test 6; E2E rollback |
| Versions per project | branches + immutable published versions | ✅ | test 20 |
| Process definitions per version | `/deployments/:id/definitions` | ✅ | processes module |
| **Export to jBPM kjar** (pom + bpmn + kmodule + assets) | `GET /versions|deployments/:id/export` | ✅ | E2E: export |
| Import a jBPM project | SDK `toEngineProject` (not yet wired to an endpoint) | 🟡 | SDK |

## F. Runtime / process instances
| jBPM | This engine | Status | Evidence |
|---|---|---|---|
| Start instance (by active deployment) | start by env / deployment / processId | ✅ | tests 5,20 |
| Instance statuses (active/complete/aborted/…) | running/waiting/completed/aborted/failed/suspended | ✅ | domain; instances UI |
| Lifecycle cascade / no orphans | terminal parent aborts active children (recursive); aborted/failed child unblocks parent (error-boundary route or fail-up); **suspend/resume pauses & restores the whole subtree** — a paused tree refuses tasks/timers; terminate clears siblings | ✅ | engine-cascade + engine-suspend-cascade tests |
| Instance list (state filters, Version, Errors, Last update columns) | jBPM-style list: All/Active/Completed/Aborted/Errors/Suspended + counts | ✅ | instances UI |
| Instance detail tabs (Details, Variables, Logs, Diagram) | all four tabs | ✅ | instances UI |
| **Diagram with instance badges (per-node execution count)** | count badge per node + active/visited highlight | ✅ | `graph.counts`; counts-check |
| Parent / sub-process instances panel | related() panel in the Diagram tab | ✅ | related API |
| Re-trigger a node (incl. after completion) | select node → re-trigger; count increments | ✅ | counts-check (t:2 after complete) |
| Live redraw as tokens move | WS `instance:<id>` events → open diagram auto-refreshes (RealtimeService) | ✅ | ws-hub + realtime.service |
| Signal / message to instance | `/instances/:id/signal` + broadcast | ✅ | test 12; E2E |
| Retry / suspend / resume / abort | all present | ✅ | test 13; E2E |
| Related instances (parent/children) | `/instances/:id/related` | ✅ | test 11; E2E |
| Timers / async jobs | durable TimerJob + scheduler: catch, boundary, **start-timer & recurring cron** | ✅ | engine-timers/-boundary-timer/-start-timer tests |
| Is Async (`customAsync`) on a node | `async: true` parks the token, a worker runs the node; infra retries with delay | ✅ | async-execution tests; doc 18 |
| Start a process in the background | `POST /instances` `async:true` / `Prefer: respond-async` → 202 + Location | ✅ (jBPM: command only) | async-execution tests |
| SLA Due Date (`customSLADueDate`) | pending → met / violated, audit + notification, process continues | ✅ | node-properties tests |
| User-task NotStarted/NotCompleted Reassign/Notify | jBPM deadline syntax, acts only while the task is in the watched state | ✅ (repeating expiries fire once) | node-properties tests |
| Call activity `waitForCompletion` | separate from `independent` (legacy `independent:true` still fire-and-forget) | ✅ | node-properties tests |
| Designer metaData in import / export | async, SLA, autostart, other metaData round-trip through bpmn-sdk | ✅ | bpmn-sdk async-sla-metadata test |
| Variable tags, MI completion condition, process SLA/description/version/adHoc | — | ⛔ planned (doc 18 §7) | — |

## G. Human tasks
| jBPM | This engine | Status | Evidence |
|---|---|---|---|
| Task inbox, claim/complete | Task service + APIs | ✅ | tests 5,11; E2E |
| Actors / groups / business admin | assignment fields | ✅ | user-task def |
| Task forms | form linked by name; SDK form model/runtime | 🟡 | asset; renderer P1 |
| Task inbox UI | list exists; dedicated inbox UI | 🟡 | — |

## H. Platform / admin / security
| jBPM | This engine | Status | Evidence |
|---|---|---|---|
| Users / roles / groups | RBAC design; actor via header today | 🟡 | docs/07 |
| Multi-tenant spaces | tenant on every entity; single default wired | 🟡 | domain |
| Auth (login, KIE realms) | JWT/RBAC designed, not enforced yet | ⛔ | docs/07 (Phase 6) |
| Audit log | append-only audit on all lifecycle events | ✅ | audit module |
| Secrets / env per deployment | deployment `env`; secrets store designed | 🟡 | http uses env; secrets P6 |

## I. Assets management
| jBPM | This engine | Status | Evidence |
|---|---|---|---|
| Forms, DRL, DMN, tables, trees, scorecards, enums, data types, tests | per-kind asset folders; list/add; SDK export | ✅ (list/add) | assets module; E2E |
| Dedicated asset editors (form builder, DRL/DMN editors) | — | ⛔ | Phase 8 |

## Done since first draft
- ✅ **Work-item nodes** (Email/SMS/DB/Compute/Log) via a pluggable handler framework.
- ✅ **Boundary-timer** firing (interrupting cancels host + runs recovery; cancel on host completion).
- ✅ **kjar import** endpoint + UI (round-trips with export).
- ✅ Instance screen with **execution-count badges**, tabs, post-completion re-trigger.
- ✅ Connection **direction + cardinality** (per-node maxIn/maxOut); **ends-at-end** validation.

## Not yet (tracked in the checklist)
- **Auth/RBAC enforcement**, multi-tenant admin, **secrets encryption**, **Postgres** store.
- **Asset editors**, **task inbox UI**, **automated UI e2e** (Playwright).

## How to reproduce
```bash
cd jbpm-engine/server && npm test            # 28/28 unit
# with the server running on :4000:
node e2e/parity.mjs                          # 12/12 live feature scenarios
```
UI: `npm run dev:app` → the builder/deployments/instances views exercise the same APIs verified above.
