# 20 — Release 2.0.0: jBPM property parity — plan and test plan

Goal: close every jBPM property gap listed in the audit (doc 18 §7 and the follow-up audit), **without breaking anything that works
today**. This document is the single register: every gap has an id, a design, a risk and the tests that prove it. A gap is "done"
only when its tests are green and its docs are updated (§7).

Branch: `release/2.0.0` (built on top of the async / node-properties / analytics work). Nothing is merged to `master` or
`release/1.0.1` from here.

---

## 1. Ground rules — "nothing should break"

| # | Rule | How it is enforced |
|---|---|---|
| R1 | **Additive only.** Every new property is optional. A process that does not set it behaves exactly as before. | Compat harness (§5.1): old process JSON must produce identical results. |
| R2 | **Defaults never change.** Where jBPM's default differs from ours (e.g. `skippable`), we keep ours unless the process opts in. | Per-gap "default" column; a test per gap asserts the unset case. |
| R3 | **No destructive migration.** New fields are absent on existing rows; readers treat absent as "off". The only data work is additive, versioned backfills (F2), run once per workspace, with the old code path kept until the backfill is marked done. Engine JSON stays valid for the SDK. | Load-old-data tests (§5.2). |
| R4 | **Security can only get tighter.** Multi-owner tasks must never widen who can claim or complete. | Dedicated authorization tests (§5.5). |
| R5 | **One gap, one commit, one test file section.** Each commit leaves the whole suite green. | Phase exit criteria (§4). |
| R6 | **Honest non-goals.** Anything that cannot make sense in a JavaScript engine is documented as unsupported, and import reports it explicitly. | §6, and the SDK import report (S08). |
| R7 | **Docs move with code.** Node reference, parity table, in-app node docs and API spec are updated in the same change. | Phase exit checklist (§7). |
| R8 | **Nothing waits in memory.** Every wait (timer, condition, listener, suspended task, SLA, deadline, async hop) is a durable row or token in the store; a restart or a different replica can always continue it. In-process state is only ever a hint (a kick, a cache). | §9 principles, restart and replica tests (§5.9). |
| R9 | **Bounded memory.** A request may not load a whole collection to answer a question about a few rows; every result, scan, join and history has a hard cap enforced *while fetching*, not after. | §9 foundations F1, F2, F4; memory tests (§5.9). |

### Baseline to protect (measured on this branch)
* Server suite via `npm test`: **584 pass / 0 fail**. `npm test` first runs `scripts/prepare-tests.sh`, which compiles the Java sidecar (any JDK 17+, Homebrew's `openjdk@17/21` is found automatically — the macOS `/usr/bin/javac` stub is skipped), extracts the policy kjar from the zip in the repo root into `extracted_projects/policy_system`, and installs the mock integration server's dependencies; the journey tests start and stop that mock server themselves. (Earlier notes called 30 failures "environmental": they were exactly these three missing preparations, now automated. Any failure is a regression.)
* bpmn-sdk suite: **195 pass / 0 fail**.
* Angular production build: clean.
* The real project `policy_system_node_project.json` (23 processes, ~365 nodes): validates the same before and after (`test/golden.test.ts`), and its 5 end-to-end journeys run.

---

## 2. Gap register

Legend — **Risk**: L low (isolated, optional field) · M medium (touches a shared engine path) · H high (new execution concept).
**Default** = behaviour when the property is not set.

### 2.1 Phase 1 — small, isolated, high value (all Risk L unless noted)

| Id | Area | Property | What it does | Design (where) | Default | Risk |
|---|---|---|---|---|---|---|
| G01 | User task | Several **actors** and **groups** (`actors[]`, `groups[]`) | Offer a task to many users and many groups | `Task.actors/groups`; `assertOwnable`, claim, inbox filters accept any match; legacy `group`/`assignee` still honoured and merged | one group / assignee as today | **M** (authorization) |
| G02 | User task | **Stakeholders**, **business-admin groups** | Extra roles that may view / manage a task | `Task.stakeholders[]`, `businessAdminGroups[]`; view + admin checks | none | M |
| G03 | User task | **Comment**, **Content**, **Locale**, **Created by** | Initial comment, extra form data, notification language, creator | first `TaskComment` from `comment`; `Content` → `inputs.Content`; `Task.locale/createdBy` | absent | L |
| G05 | Call activity | **When the called process fails** (`onChildFailure`: `fail` \| `continue` \| `abort`) — jBPM "abort parent" | Choose fail-with-error (today), carry on, or abort the parent at once | `tryFailParent` + call handler sync branch; `continue` writes `{error}` to an optional result var | `fail` (today) | M |
| G05b | Call activity | **Called element by name** (`processName`) | Find the process by name, not id | `makeResolveCalled` second lookup by `name` | by id | L |
| G06 | Gateway / flow | **Flow priority** (`priority` on flows) | Decides which outgoing flow wins when several conditions are true | gateway handler sorts candidates by priority (stable, ascending) | drawn order | L |
| G07 | For-each | **Completion condition** (`completionCondition`) | Stop remaining runs once an expression is true | evaluated after each child settles in `buildMultiInstanceResult`; cancels the rest | none | M |
| G08 | Variables | **Tags** `required`, `readonly` | `required`: start fails if absent; `readonly`: set once | `EngineVar.tags`; check at start, in `updateVariables`, and after each node (snapshot compare) | no tags | M |
| G09 | Process | **Process SLA** (`slaDueDate`) | Instance-level due time, met / violated | reuse the `sla` job on the instance; `Instance.sla` | none | L |
| G10 | Process | **Instance description** (`#{var}` template) | Readable title filled at start | `Instance.description` rendered once; shown in lists | none | L |
| G11 | Process | **Version label**, **ad-hoc flag** | Version string on the definition; make a process ad-hoc | stored on the process JSON, shown in UI | none | L |
| G12 | Activity | **AdHoc autostart** (`autoStart`) | In an ad-hoc process, nodes without incoming flow start by themselves | `engine.start` seeds tokens for them | off | L |
| G13 | Activity | **Tags / metadata attributes** (`metaData`) | Free labels readable from scripts | `GENERAL` schema keyval; exposed as `node.metaData` | none | L |
| G14 | HTTP / REST | **Content type**, **basic / bearer auth** | Right headers without hand-writing them | http handler builds headers; secrets via `$var` / env | headers as today | L |
| G15 | Async | **Initial delay**, **priority** (`asyncDelay`, `asyncPriority`) | Wait before a background run; order jobs | `scheduleAsync` dueAt + job priority ordering in tick | immediate | L |
| G16 | Activity | **isForCompensation** | Marks a node as a compensation handler | validation skips "unreachable" for it; engine ignores it in normal flow | off | L |

### 2.2 Phase 2 — timers and events (Risk M: shared timer machinery)

| Id | Area | Property | What it does | Design | Default | Risk |
|---|---|---|---|---|---|---|
| G17 | Timers | **Cron** (`language: cron`; Quartz-style 6/7 fields and 5-field) | Fire on a schedule | `cronNext()` in `duration.ts`; `computeDue`; reschedule path; start / boundary / catch | ISO only | M |
| G18 | Timers | **`#{variable}`** in any timer value | Delay / date from a variable | `computeDue(spec, now, vars)` at the three call sites | literal | L |
| G19 | Timers | **Short delay form** (`1h 30m`) | Friendlier durations | `parseDelay` fallback in `computeDue` | ISO | L |
| G20 | Events | **Link events** (throw ↔ catch by name) | "Go to" inside one process | throw returns `next:[catch id]`; catch with `link` passes through; validation pairs them | n/a | L |
| G21 | Events | **Conditional catch** | Wait until a condition becomes true | re-evaluate waiting condition tokens whenever variables change (node end, API edit, signal) | n/a | **M** |
| G22 | Events | **Conditional boundary** | Interrupt / run beside a host when a condition becomes true | reuse the message-boundary token mechanism with kind `condition` | n/a | M |
| G23 | Events | **Conditional start** | Start when a condition becomes true | *Decision needed:* no rule engine; offer "condition evaluated on variable change of a *running* instance" only, or defer. Default plan: **not supported**, documented | n/a | H |
| G24 | Events | **Signal scope** (`scope`: `workspace` \| `instance`) | Signal reaches only this instance, or everyone | throw / end pass `scope`; `instance` → targeted delivery | `workspace` (today) | M |
| G25 | User task | **Suspend until** | Task hidden until a time | task created `suspended`; one `deadline` job resumes it | immediate | L |

### 2.3 Phase 3 — structural (Risk H: new execution concepts; each lands behind its own tests)

| Id | Area | Property | What it does | Design | Default | Risk |
|---|---|---|---|---|---|---|
| G27 | Sub-process | **Event sub-process by signal / message / timer / escalation** | Handler that starts when the event happens during the parent's life | register waiting listener tokens at scope start; firing starts the nested instance; cancelled at scope end | error only (today) | **H** |
| G28 | Sub-process | **Interrupting vs non-interrupting** event sub-process | Stop the parent, or run beside it | flag on G27 | n/a | H |
| G29 | Sub-process | **Ad-hoc sub-process** (`completionCondition`, `ordering`) | Tasks started by people in any order until done | nested scope with unconnected nodes started via API; completes when condition true | n/a | H |
| G30 | User task | **Assignment strategy** | Auto-pick owner (round-robin, least-loaded) | pluggable picker at task creation | manual claim | M |
| G31 | User task | **Swimlane autoclaim** | Same person as the previous task in the lane gets it | lane lookup of last completer | off | M |
| G32 | Gateway | **Event-based gateway "instantiate"** | Process starts on first of several events | start-time listeners (shares G27 machinery) | n/a | H |
| G33 | Sub-process | **Transaction cancel** | Cancel end triggers compensation of the scope | cancel end → run recorded handlers for the scope, then abort scope | n/a | M |
| G34 | Activity | **Multi-instance on any task** | Run a user task / script / HTTP once per item | generic `multiInstance` property expanded by the engine into the existing for-each machinery | none | H |
| G35 | Gateway | **Complex gateway activation condition** | Custom rule for when a join fires | evaluate expression over arrived-token counts | n/a | M |

### 2.4 Phase 4 — jBPM import / export (bpmn-sdk)

| Id | Item | Notes |
|---|---|---|
| S01 | Process-level `drools:metaData` (SLA, description) | read / write; engine ⇄ BPMN |
| S02 | Variable tags (`customTags`) | `required` / `readonly` |
| S03 | `drools:version`, `drools:adHoc` | attributes on the process |
| S04 | User-task data inputs (`ActorId`, `GroupId`, `Comment`, `Content`, `Locale`, `CreatedBy`, `BusinessAdministratorGroupId`, `TaskStakeholderId`, `suspendUntil`, `NotStarted…`, `NotCompleted…`) | mapped to G01–G03, G25 and the existing deadlines |
| S05 | Timer `language` (cron / mvel) | G17 |
| S06 | MI completion condition | G07 |
| S07 | `abortParent`, `calledElementByName` | G05, G05b |
| S08 | **Import report**: every construct that could not be mapped (non-goals in §6, anything still `raw`) is listed per process, never silently dropped | new, shown in the import UI |

### 2.5 Phase 5 — UI and tooling
| Id | Item |
|---|---|
| U01 | Properties-panel fields for every new node property (schema-driven, with help text) |
| U02 | Process properties: version, ad-hoc, SLA, description template, variable tags |
| U03 | Variable editor: `required` / `readonly` checkboxes |
| U04 | User-task form: owners as chips (many users / groups) |
| U05 | Instance views: SLA state, description, queued / suspended task markers |
| U06 | In-app node documentation updated (`def.ts` docs blocks) |

---

## 3. Delivery order and why
1. **Phase 0 — safety net first** (no behaviour change): golden fixtures and compat harness (§5.1–5.2), so every later phase is checked against today's behaviour.
1b. **Phase 0b — scale foundations** (§9): indexed store access, durable wait subscriptions, per-instance lease + revision, bounded analytics, bounded timer tick, instance size guards. Done **before** the features that depend on them (conditional events, event sub-processes, multi-owner tasks, analytics at scale), so no new feature is built on a memory-bound or single-replica-only base.
2. **Phase 1** — the small items (and G01, the one with a security angle, early so it gets the longest soak).
3. **Phase 2** — timers and events (shared machinery, done together so the timer code is touched once).
4. **Phase 3** — structural items, one at a time, each only after the previous is green.
5. **Phase 4** — SDK, once the engine surface is final (otherwise the SDK chases a moving target).
6. **Phase 5** — UI, then docs / release notes, then a full regression + live smoke pass.

Each phase ends with its **exit gate** (§4). A failed gate blocks the next phase.

---

## 4. Exit gate for every phase
1. Server suite: pass count ≥ previous + the phase's new tests; **failures = exactly the 30 environmental ones**.
2. bpmn-sdk suite green (195 + new).
3. `ng build` (development and production) clean.
4. Golden harness (§5.1) unchanged.
5. Live smoke (§5.6) passes on a restarted server.
5b. Replica and memory gates (§5.9) pass for every gap that adds waiting state, jobs or queries.
6. Docs checklist (§7) ticked for every gap in the phase.
7. One commit per gap, message names the gap id.

---

## 5. Test plan

### 5.1 Compat harness (Phase 0) — "old things behave the same"
* **Validation golden:** run `validateProcess` on all 23 processes of `policy_system_node_project.json` and on every process fixture in
  `server/test`, store the problem lists as `test/fixtures/golden-validation.json`; the test fails on any difference.
* **Execution golden:** a set of ~25 representative flows (script, gateways of every mode, call + wait, sub-process, for-each,
  boundary timer / error, event sub-process, error handler, user task + complete, signal / message, compensation, terminate,
  async node, SLA). For each, record the **instance trace** (node ids and outcomes in order, final status, variables) under a fake
  clock as `test/fixtures/golden-traces.json`. The test replays and compares exactly. This is what proves R1 / R2.
* Each phase may *add* golden flows for its new behaviour; it may never edit an existing golden entry (a diff there is a regression
  unless the user has approved a behaviour change).

### 5.2 Old-data tests
Load instances, tasks, timer jobs, deployments and analytics definitions written **before** each phase (fixtures captured now) and
confirm they read, resume and finish unchanged: an instance waiting on a user task / timer / child resumes; an old task is claimable
exactly as before; an old `TimerJob` fires.

### 5.3 Per-gap tests
Every gap gets (a) *unset ⇒ unchanged*, (b) *happy path*, (c) *edge / invalid input*, (d) *interaction* cases. Ids are `T-<gap>-<n>`.

| Gap | Must-have cases |
|---|---|
| G01 | unset ⇒ same as today · task offered to 2 actors + 2 groups; each can claim, a non-member cannot · `excludedOwners` still wins · group-only member can claim, user listed in `actors` can claim · inbox shows the task to every owner and to no one else · legacy `group` + new `groups` merge · claim by second person while reserved ⇒ 409 as today · business admin override unchanged |
| G02 | stakeholder can view but not complete · admin group member can reassign · neither widens `complete` |
| G03 | comment becomes first comment · content reaches form inputs · locale / createdBy stored · all absent ⇒ unchanged |
| G05 | `fail` identical to today (golden) · `continue`: parent proceeds, error stored in var · `abort`: parent ends `aborted`, children cascade, no boundary needed · sync-failing and waiting child both covered · independent child unaffected · `calledByName`: found by name, ambiguous name ⇒ clear error, unknown ⇒ same as today |
| G06 | two true conditions: higher priority wins · equal priority ⇒ drawn order · priority on inclusive orders the fan-out list but still takes all matches · unset ⇒ golden |
| G07 | stops at N completed · remaining children aborted · parallel and sequential · invalid expression ⇒ node error · unset ⇒ golden |
| G08 | `required` missing ⇒ start refused (422), present ⇒ ok · `readonly` second write via API refused · via script refused with `VARIABLE_READONLY` · first write allowed · tags absent ⇒ golden |
| G09–G11 | process SLA met / violated / ignored when unreadable · description renders `#{var}` (missing var ⇒ empty) · version / ad-hoc round-trip |
| G12 | ad-hoc process starts unconnected autoStart nodes only · non-ad-hoc ignores the flag |
| G13 | metadata saved, readable as `node.metaData` in a script, never affects routing |
| G14 | content type header sent · basic / bearer built from `$var`, secrets not logged · explicit header still wins |
| G15 | delayed job not run before its time · priority orders within one tick |
| G16 | validation does not flag the handler as unreachable · normal flow ignores it |
| G17 | next-fire correctness table (≥ 25 expressions incl. month ends, DST-free UTC, leap day, `L`/`?`, names, steps) · cron start timer reschedules · cron boundary / catch · invalid cron ⇒ validation error |
| G18–G19 | `#{x}` resolved for duration / date / cycle · missing var ⇒ error not hang · `1h 30m`, `2d`, ISO equivalent · unset ⇒ golden |
| G20 | throw jumps to the matching catch · unmatched name ⇒ validation error · duplicate catch name ⇒ validation error · jump inside a sub-process only |
| G21–G22 | already-true condition passes at once · becomes true after a variable edit / script / signal · boundary interrupting and non-interrupting · condition never true ⇒ stays waiting (no spin) · evaluation cost bounded |
| G24 | `instance` scope reaches only a parallel branch of this instance · `workspace` as today |
| G25 | task hidden / not claimable until the time · then appears · aborted instance cancels the job |
| G27–G28 | signal / message / timer / escalation fire during parent · interrupting stops the parent, non-interrupting runs beside · listener removed when the scope ends · nested event sub-process · event never fires ⇒ no leak · parent abort cancels listeners |
| G29 | tasks start in any order · ends when condition true · remaining cancelled · ordering `parallel` / `sequential` |
| G30–G31 | strategy picks per rule · tie-breaks deterministic · autoclaim only for same lane · falls back to normal queue |
| G32–G35 | instantiate: first event creates exactly one instance · cancel runs compensation once · MI on user task creates N tasks and collects outputs · complex condition fires on the stated count |
| S01–S08 | each property survives engine → BPMN → engine · unknown metaData preserved · import report lists every dropped construct and counts match |
| U01–U06 | `ng build`; schema-driven fields render for every new key; conditional fields hide; screenshots of each new panel / page stored under `docs/ui-screenshots/` |

### 5.4 Cross-cutting scenarios (combinations break things)
* async node + SLA + user-task deadline + cron boundary in one process;
* event sub-process + error boundary + global error handler on the same failure;
* multi-owner task + deadline reassign + `suspendUntil`;
* for-each with completion condition + async + call with `onChildFailure: continue`;
* variable tags + background start + case operations;
* suspend / resume / abort of an instance holding listeners, timers, async jobs and deadlines — nothing may fire after.

### 5.5 Security tests (R4)
Every ownership change is tested from the attacker's side: user not in `actors` / `groups`, a group member of a *different* workspace,
an excluded owner who is also in a listed group, a stakeholder trying to complete, a platform admin in the all-workspaces scope,
and an unauthenticated call. Tasks can never become visible or claimable to someone who could not see them before.

### 5.6 Live smoke (after every phase, on a restarted server)
Start server + UI; sign in; run a scripted pass through the real HTTP API: create → publish → deploy → start (sync and background) →
complete a task → read the instance → run two built-in analytics → open the builder page and the node panels; zero server errors in
the log. Screenshots are saved for UI-facing changes.

### 5.7 Performance guard
A micro-benchmark (1 000 instances of a 20-node flow, and a 200-node flow) is recorded now; after each phase the time may not grow
by more than 15 %. Conditional-event evaluation and event-sub-process listeners are the two places this can regress, so they get
their own bounded-cost tests (no per-node full scan; evaluation only on variable change).

### 5.8 Release checks (end of Phase 5)
Full server + SDK + UI builds; full golden harness; fresh-install test (empty store ⇒ seeds, default plans, built-in analytics);
upgrade test (data from the pre-2.0.0 branch loads and runs); docs link check; changelog reviewed.

---

### 5.9 Scale and multi-replica tests (new, from §9)

**Replica harness.** `replicas(n)` builds *n* independent engine instances (each with its own `Coordinator`, worker tick and
in-process caches) over **one shared store and one shared coordinator backend**, so tests can run real concurrency without Redis.
When `TEST_PG_URL` / `TEST_REDIS_URL` are set the same suite runs against real Postgres / Redis; otherwise those variants are
skipped (never silently passed). A **fault injector** can drop a replica's claim without releasing it (simulating a crash) and
advance the fake clock past the lease TTL.

| Area | Tests |
|---|---|
| **Exactly-once jobs** | 3 replicas tick concurrently over 200 due jobs (async, SLA, deadline, cron, suspend-until): each fires once; total fires = 200; no job lost |
| **Cron under downtime** | stop all workers for 3 simulated hours, restart: the cron job fires **once**, next row exists, no catch-up storm (P7) |
| **Instance lease (F3)** | randomized interleavings of {signal, timer fire, task complete, variable edit, abort} on one instance from 2–3 replicas, 500 runs: no lost update (every accepted write visible), `rev` strictly increasing, final state equals one valid serial order |
| **Parent / child across replicas** | child completes on replica A while replica B holds the parent lease: the parent is resumed by a durable `resume-parent` job, no deadlock, no double resume; deep chain (depth 50) does not grow the call stack |
| **Crash takeover** | replica dies mid-step holding an instance lease: after TTL another replica continues; the step is idempotent (P3), the history shows no duplicate visit |
| **Subscriptions (F2)** | invariant checker run after every randomized scenario: *every waiting listening token has exactly one `wait_subs` row, and every row points to a waiting token*; a signal reads only subscriber rows (store read counter ≤ subscribers + constant) with 50 000 unrelated waiting instances present |
| **Backfill** | old waiting instances (fixtures from before F2) still receive signals before and after the backfill; backfill is idempotent and runs once per workspace (marker); two replicas backfilling at once produce no duplicates |
| **Restart survival** | for each waiting kind (timer, condition, event sub-process listener, suspended task, SLA, deadline, async hop, cron): create state, drop every in-memory object, rebuild the engine from the store only, and the item still fires / resumes |
| **Bounded analytics (F4)** | 200 000 synthetic process rows + 400 000 tasks: peak heap growth stays under the budget (target ≤ 150 MB, measured with `--expose-gc` and `process.memoryUsage`), result identical to the reference evaluator on a 5 000-row sample (differential test), scan cap reported as `truncated` *before* memory is spent, recursion over a 100 000-node tree touches only the frontier |
| **Bounded tick (F5)** | 50 000 due jobs: tick memory stays flat, batch honoured, backlog drains across ticks, no tick longer than its budget |
| **Size guards (F6)** | a loop producing 100 000 visits ends with a compacted history (≤ limit) and the audit trail intact; an over-size variable write is refused with a clear message; both limits can be switched off to reproduce old behaviour |
| **Cache** | per-replica cache bytes bounded (insert 10 000 results, size ≤ budget); shared cache (when Redis) returns a result computed by another replica; never served across workspaces or to an unauthorized caller (existing SEC-6 still green) |
| **Cap enforcement** | MI-on-any-task with 5 000 items is refused or chunked per the cap, never allocates 5 000 children at once; event sub-process listeners per instance are capped |
| **Latency guard** | p95 start-to-first-wait and signal-delivery latency measured with 1, 2, 3 replicas; may not exceed baseline + 15 % |

**Exit gate additions (apply to every gap that adds waiting state, jobs, or queries):** it appears in the restart test, the
exactly-once test (if it uses jobs), the subscription invariant (if it listens), and the memory test (if it queries); and its row in
§9.4 is true.

## 6. Explicit non-goals (documented, reported on import, never silent)
| jBPM feature | Why not | What we do instead |
|---|---|---|
| Imports and globals (Java classes, rule globals) | the engine runs JavaScript / JVM sidecar scripts, not a Drools session | listed in the import report; scripts keep working through `kcontext` helpers |
| Web-service / Java service task (interface + operation) | needs a Java object model | use the HTTP node or a work item; reported on import |
| Conditional **start** that depends on rule-engine facts (G23) | no rule-engine session to watch | start by signal, message or timer; decision recorded at Phase 2 start |
| `kie-deployment-descriptor` handler wiring beyond named work items | deployment model differs | existing work-item registry |

## 7. Documentation checklist (per gap, same commit)
- [ ] `docs/16-jbpm-parity.md` row moves to ✅ with the test id.
- [ ] Node `def.ts`: schema field with help text, and the `docs` block (fields, scenarios, gotchas).
- [ ] `docs/18` §7 entry removed or pointed here.
- [ ] `docs/05-api-spec.md` / OpenAPI when an API shape changes (the OpenAPI test enforces this).
- [ ] This file: gap status table (§8) updated.
- [ ] `docs/bpm-nodes` reference for any SDK-visible property.
- [ ] Release notes entry for 2.0.0 with the compatibility statement.

## 8. Status board (updated as work lands)
| Phase | Gaps | Status |
|---|---|---|
| 0 | compat harness, golden fixtures | **done** — `test/golden.test.ts` (23 real processes + 16 flow traces), `test/flow-kit.ts` |
| 0b | F1 indexed store · F2 signal delivery · F3 instance lock · F4 bounded analytics · F5 bounded tick · F6 size guards | **done** — see §9.6 |
| 1 | G01 G02 G03 G05 G05b G06 G07 G08 G09 G10 G11 G12 G13 G14 G15 G16 | **done** (see §10) |
| 2 | G17 G18 G19 G20 G21 G22 G24 G25 (G23 decision) | **done** (see §11) |
| 3 | G27 G28 G29 G30 G31 G32 G33 G34 G35 | not started |
| 4 | S01–S08 | not started |
| 5 | U01–U06, docs, release checks | not started |

---

## 9. Memory and multi-replica design

This section exists because the same question applies to every gap: *what is held in memory, what is durable, and what happens
with two or more replicas?* The answer for timers is the model to copy — a durable row, claimed atomically by exactly one
replica, safe across restarts. Below: what the code does **today** (verified), the principles, the foundation work that makes the
principles true, and how every gap behaves.

### 9.1 Findings in the current code (verified)
| # | Finding | Consequence |
|---|---|---|
| A | The Postgres store's `query(pred)` **loads every row of the collection** and filters in JavaScript. The only SQL-level exception is `claimDueTimers` (`SKIP LOCKED`). | Any `query(pred)` on instances / tasks / audit is O(collection) in memory per call. |
| B | `broadcastSignal` (every signal, message and throw) **loads all running and waiting instances of the workspace** (full blobs: variables, tokens, history) to find the few waiting on a name. | Cost grows with total live instances, not with subscribers; one signal on a big workspace can spike memory. |
| C | There is **no per-instance lock and no revision** on `Instance`. The coordinator's `mutex()` just runs the function when state is not shared, and nothing in the engine takes an instance lease. `maxReplicasCap` defaults to 0 (no cap), so several replicas can serve one workspace. | Two replicas mutating the same instance at once (a signal and a timer, two task completions, an API edit during a run) can **lose an update**. Today this is safe only when a workspace is pinned to one replica. |
| D | The Analytics Builder (built earlier in this release) loads **whole tenant tables** per run (`env.table`) before filtering, builds join indexes over them, and the recursive relations load the entire process table; its result cache is **per replica, counted in entries not bytes**. | Correct but not memory-safe on large workspaces: the scan cap truncates *after* the load. Must be fixed before it is relied on at scale. |
| E | `tick()` with a replica gate loads **all due jobs** of the workspace then slices to the batch size; the non-gate path uses the bounded SQL claim. | A backlog (for example after downtime) can load thousands of job rows at once. |
| F | An instance's `history` array grows with every node visit and is stored inside the instance row; loops make it unbounded. Instance lists page **after** loading all rows. | Large rows, slow loads, memory spikes in list screens. |
| G | What already works and is the pattern to reuse: timer jobs are durable and claimed per job (Redis lease or SQL); async / SLA / deadline jobs ride the same path; seed migrations use deterministic ids; the worker kick is only a hint. | Reuse, do not reinvent. |

### 9.2 Principles
* **P1 Durable first.** State that must survive lives in the store: tokens (`waitFor`), `TimerJob` rows, subscription rows. No business
  `setTimeout`, no in-memory queues, no "listeners" held by a process.
* **P2 One owner at a time.** A job or an instance mutation is performed by one replica at a time, enforced by an atomic claim /
  lease with a TTL (a dead replica's claim expires; another continues). Never "check then act" without the claim.
* **P3 Idempotent steps.** Every step re-checks the state it expects (token still waiting, job not yet fired, task still open) so a
  retry, a double delivery or a takeover cannot do it twice.
* **P4 Index, don't scan.** Look rows up by the key you have (instance id, name, parent id, due time) through an indexed query;
  page with a cursor; never `query(() => true)` for a request path.
* **P5 Cap while fetching.** Row, join, group, depth, history and result limits are enforced at fetch time and reported as
  `truncated`; memory is O(page + group map), not O(table).
* **P6 Never block while holding.** A step that holds one instance lease never waits for another; if the second lease is busy the
  work becomes a durable job and the first lease is released (no deadlocks).
* **P7 Missed work is bounded.** After downtime a recurring job fires **once** and reschedules from "now" (no catch-up storm); a
  backlog is drained in bounded batches.

### 9.3 Foundations (Phase 0b)
| Id | Foundation | Design | Fixes |
|---|---|---|---|
| F1 | **Indexed store access** (optional capability, same pattern as `claimDueTimers`) | `Store.findBy?(collection, tenantId, field, values[], {limit, afterId})` returning a page + cursor; Postgres implements it in SQL on the jsonb column with lazily created expression indexes (tenantId + status / parentInstanceId / instanceId / name / dueAt); memory and file stores fall back to `query`. A helper picks the capability so callers do not care. `list()` of instances / tasks pages in the store. | A, F |
| F2 | **Durable wait subscriptions** | New collection `wait_subs`: one row per waiting token that listens for a name (signal, message, condition, event sub-process, link-free). Written in the same step that parks the token, removed when it resumes, is cancelled, or the instance ends (exactly like timer cancellation). `broadcastSignal` becomes `findBy('wait_subs', name)` → deliver to only those instances, each under its lease. **Backfill migration** (versioned, once per workspace, like the analytics seed) writes rows for tokens already waiting; until it has run for a workspace the old scan is used, so nothing existing breaks. A reconciler (rare, bounded) repairs any drift. | B |
| F3 | **Per-instance lease + revision** | `Instance.rev` incremented on every save. Every load-mutate-save of an instance (resume, signal, timer / async / SLA fire, task complete, API edit, abort, retry) runs inside `withInstance(id, fn)`: `coordinator.claim('inst:'+id)` (Redis lease with TTL + heartbeat when shared, in-process mutex otherwise) **plus** an optional `Store.putIfRev` (SQL `WHERE rev = old`) as a second line of defence. Contention: short bounded retry; for jobs, leave the job scheduled and try next tick. A child finishing never *blocks* on its parent's lease (P6): try-lock, and if busy enqueue a durable `resume-parent` job. This also removes deep recursive in-process resume chains. | C |
| F4 | **Bounded analytics** | Source rows come from `findBy` pages with the from-source conditions pushed down; joins are page-wise semi-joins (batch of ≤1 000 keys per fetch) hash-joined for that page only; aggregation streams over pages into the group map (cap 50 000 groups); row mode keeps a **top-K heap** (K = offset + limit) instead of sorting everything; recursive relations walk **level by level** with `findBy(parentInstanceId in frontier)` (cap 50 000 nodes, depth 20); scan caps are enforced while paging. Cache: shared through the coordinator backend when Redis is configured, otherwise per-replica **bounded by bytes** (default 8 MB) with TTL; the key already carries workspace + version. | D |
| F5 | **Bounded tick** | The tick path always uses the atomic claim (`claimDueTimers`) or `findBy(timers, status, dueAt ≤ now, limit)`; never loads all due rows. Batch size and a per-tick time budget are honoured; backlog drains over ticks. | E |
| F6 | **Instance size guards** | `maxHistoryEntries` (default 5 000): older visits are compacted into a count + first/last record, audit keeps the full trail; per-instance variable size cap (default 1 MB) checked on write with a clear error; list endpoints use F1 paging. All limits configurable per workspace and off-able for compatibility. | F |

### 9.4 How every gap behaves (memory · durable state · multi-replica · restart)
| Gap | Memory | Durable state | Multi-replica | After restart / replica loss |
|---|---|---|---|---|
| G01–G03 multi-owner task fields | O(owners) per task | on the `Task` row | claim / complete go through the task + instance lease (F3); authorization evaluated per request | unchanged |
| G05 child-failure policy | none extra | the parent token's wait + the child row | parent resumed under its lease; busy ⇒ durable `resume-parent` job (P6) | job survives |
| G06 flow priority | sort of the outgoing list | none | none | n/a |
| G07 MI completion | counters on the parent token | token | evaluated under the parent lease; remaining children aborted idempotently | resumes from token |
| G08 variable tags | snapshot of *tagged* variables only | none | n/a | n/a |
| G09–G11 process SLA / description / version | none | `sla` job (existing pattern) | claimed per job | job survives |
| G12 autostart | none | tokens | n/a | n/a |
| G14–G15 REST auth / async delay | none | the async job (dueAt = now + delay) | claimed per job | job survives |
| G17 cron | O(1) | one `scheduled` row = next fire; the next row is created when it fires | claimed per job; **fires once** across replicas; after downtime fires once then reschedules from now (P7) | survives |
| G18–G19 `#{var}` / short delay | none | resolved at schedule time, stored as `dueAt` | n/a | survives |
| G20 link events | none | n/a (a jump) | n/a | n/a |
| G21 conditional catch | evaluated per instance on variable change only; **no polling, no global scan** | token `waitFor: condition` + a `wait_subs` row | evaluated by whichever replica changed the variables, under the instance lease | survives; backfill covers old tokens |
| G22 conditional boundary | same | boundary token + sub row | same | survives |
| G24 signal scope | none | n/a | `instance` scope never leaves the instance (no cross-replica traffic) | n/a |
| G25 suspend until | none | one `deadline` job | claimed per job | survives |
| G27–G28 event sub-process | O(listeners) per instance | listener tokens + `wait_subs` rows, removed when the scope ends | delivery per subscriber under its lease; **no scan of all instances (F2)** | survives |
| G29 ad-hoc sub-process | O(open nodes) | tokens | API actions take the instance lease | survives |
| G30 assignment strategy | needs per-user open-task counts: **indexed count** (`findBy` count by assignee + status), never a scan | task rows | counts may be momentarily stale across replicas; documented, ties broken deterministically | n/a |
| G31 swimlane autoclaim | one lookup by (instance, lane) | task history | n/a | n/a |
| G32 gateway instantiate | none | start-subscription rows | one instance per event: dedupe by event id under a claim | survives |
| G33 transaction cancel | recorded compensation list on the instance | instance | under the instance lease | survives |
| G34 MI on any task | **cap N per node** (default 1 000) and chunked creation; sequential mode holds one child at a time | child instances | children are ordinary instances; parent counters under lease | survives |
| G35 complex gateway | counts of arrived tokens | history count | n/a | n/a |
| S01–S08 SDK | streaming parse is per process file | n/a | n/a | n/a |
| Analytics (existing) | F4: O(page + groups) | definitions + seed marker | cache shared (Redis) or per-replica bounded | n/a |
| Async / SLA / deadline (existing) | none | jobs | claimed per job | survive |

### 9.6 Phase 0b — what was built, and what it does not cover
| Id | Built as | Where | Tests |
|---|---|---|---|
| F1 | Optional store capability `findBy` (SQL on Postgres, same filter in JS elsewhere) behind one helper `findRows`; indexes created idempotently | `store/find.ts`, `store/pg-store.ts` | `store-find.test.ts` |
| F2 | **Simplified:** instead of a separate subscription table (backfill + drift risk), signal / message delivery uses an indexed *containment* lookup on the instance's tokens (`tokens @> [{waitFor:{ref:name}}]`, GIN index on Postgres). Same cost (only subscribers are read), works on existing data with no migration. A subscription table stays an option if profiling ever shows a need. | `engine/execution-engine.ts` (`broadcastSignal`) | `FIND-5` |
| F3 | Per-instance lock: FIFO queue per instance in-process + coordinator lease across replicas (Redis when configured, expires if a replica dies); re-entrant per call chain; child → parent notification runs *after* the lock is released so two instances never wait on each other; a busy timer job is put back, not lost | `engine/instance-lock.ts`, wrapper at the end of `modules/instances/service.ts` | `instance-lock.test.ts` (failed before the fix, passes after) |
| F4 | Analytics reads by key or in pages of 2 000 with `=` / `in` conditions pushed to the store; joins look up only the rows the current page points at; recursion goes level by level (one lookup per level for all roots); row mode keeps top-K; group cap 50 000; result cache bounded by bytes (8 MB, one result ≤ ¼) | `analytics/catalog.ts`, `engine.ts`, `service.ts` | `analytics-scale.test.ts` + the 25 existing analytics tests unchanged |
| F5 | Replica-gated tick reads one batch of due jobs, oldest first | `modules/timers/service.ts` | `FIND-6` |
| F6 | History cap (default 5 000, 0 = off) with per-node counts of dropped visits so parallel joins and the diagram stay correct | `engine/history-cap.ts` | `history-cap.test.ts` |

**Not covered yet (honest limits):**
* The Postgres SQL (`findBy`, indexes) is unit-tested as generated text and the filter semantics are shared with the in-memory path, but it has **not been executed against a live Postgres** in this environment. First action when a Postgres is available: run `store-find` and the analytics suites against it.
* The cross-replica lease is exercised in-process (one coordinator); the Redis variant is the existing, separately tested `claim` primitive but was not run against a live Redis here.
* Case, audit and comment analytics sources still come from the workflow-service store (typed tables): lookups by id are direct reads, other lookups are one workspace-scoped read. SQL push-down for those tables is a follow-up.
* Instance list screens still load rows before paging (F1 makes the fix easy; not yet applied).
* Per-instance variable size cap (F6, second half) is not done yet.

### 9.5 Compatibility of the foundations
* F1: purely additive; stores without the capability keep working.
* F2: guarded by a per-workspace backfill marker; old scan remains the fallback until the marker is set.
* F3: `rev` absent on old rows is read as 0; the lease adds no behaviour change on a single replica beyond a tiny in-process lock.
* F4: same query language and results (verified by the analytics golden tests); only the execution strategy changes.
* F5, F6: limits are configurable and default to values far above current usage; F6's compaction only touches instances over the limit.

## 10. Phase 1 — what was built, and where it differs from the plan
All in `test/phase1.test.ts` (12 tests) with the golden fixtures unchanged. Property reference: [21-jbpm-properties-reference.md](21-jbpm-properties-reference.md).

| Gap | Result |
|---|---|
| G01 G02 G03 | done: `actors`, `groups`, `businessAdminGroups`, `stakeholders`, `comment`, `content`, `locale`, `createdBy` on user tasks; ownership checks tightened for tasks that use them (an unregistered stranger cannot claim a task offered to named actors); legacy single-group tasks behave exactly as before |
| G05 G05b | done: `onChildFailure` = `fail` (default) / `continue` / `abort`, both when the child fails during the call and when it fails later; `errorVar`; the `process` field accepts a process **id or name** |
| G06 | done: flow `priority` (lowest number first; unprioritised flows keep drawn order after prioritised ones) |
| G07 | done: for-each `completionCondition` (sees `completed`, `total`, `results`, variables); remaining items aborted without raising an error into the parent |
| G08 | done: variable tags `required` (start refused, 422) and `readonly` (scripts and API edits refused; a script's change is undone) |
| G09 G10 | done: process `slaDueDate` (pending → met / violated, audit + notification) and `description` template (`#{var}`) |
| G11 | the `version` label and `adHoc` flag are stored with the process; `adHoc` drives G12 (no other runtime effect) |
| G12 | done: `autoStart` nodes with no incoming flow start with an ad-hoc process; validation accepts them only in ad-hoc processes |
| G13 | done: free `metaData` on every node, readable in JS scripts as `node.metaData` / `node.getMetaData(key)` (Java scripts do not see it: sidecar change deferred) |
| G14 | done: `contentType` (JSON default, form-urlencoded supported), `authType` basic / bearer with `$var` / `${ENV}` values; an explicit header wins in any letter case |
| G15 | done for `asyncDelay`; **`asyncPriority` dropped**: jobs already run oldest-due-first, and a delay covers the real need |
| G16 | done: `isForCompensation` nodes are not reported as unconnected / unreachable |

Also fixed on the way (found by running the real project journeys): a **declared process variable that has no value yet is now in scope as `null`** inside scripts (jBPM behaviour) instead of raising `ReferenceError`.

Still for Phase 5 (UI): flow priority and the process-level properties (description, SLA, version, ad-hoc, variable tags) are honoured by the engine and the API but have no editor control yet (U01–U03).

## 11. Phase 2 — timers and events
All in `test/phase2.test.ts` (10 tests; the cron test alone checks 23 expressions) with the golden fixtures unchanged.

| Gap | Result |
|---|---|
| G17 | done: cron timers, POSIX (5 fields) and Quartz (6–7 fields, seconds first), names, ranges, steps, `?`, `L`, day-of-month OR weekday, leap day, year. Works for start timers, catch and boundary timers (interrupting or not). A recurring cron job is one durable row; after downtime it fires **once** and reschedules from now (no catch-up storm). Invalid or never-firing expressions are validation errors |
| G18 | done: `#{variable}` (dotted paths) in any timer value; a missing variable fails the node with a clear message instead of firing at once |
| G19 | done: short delays (`1h 30m`, `90m`, `2d`) alongside ISO-8601 |
| G20 | done: link throw / catch pairs; the validator checks pairing and treats the jump as an edge, so nothing after the catch is reported unreachable |
| G21 | done: conditional catch — passes at once when true, otherwise waits and is released when a variable change (an edit through the API, a task's outputs, a script, a signal payload) makes it true. Only the instance's own waiting tokens are examined, so there is no polling and no scan of other instances |
| G22 | done: conditional boundary, interrupting or not, same mechanism |
| G23 | **decision: conditional *start* is not supported.** It needs a rule engine watching facts across all data. Start by signal, message or timer, or start the process and use a conditional catch as its first step. Documented, and an import report entry (S08) |
| G24 | done: `scope: "instance"` on signal / message / escalation throws and ends delivers only inside the instance, reliably, including to its own parallel branches (delivered after the current step settles). The default workspace-wide behaviour is unchanged (it has never reached the sender's own running branches, because the running instance is not stored yet; scope `instance` is the way to do that) |
| G25 | done: `suspendUntil` — the task exists but is suspended (not claimable) until its time, then becomes available via one durable job |

Also: the event-trigger validation rule now accepts `cron` timers and link events.
