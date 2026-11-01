# 08 — Execution Engine

A Node token-based interpreter that runs the SDK **engine JSON** directly. Deterministic core (clock &
IDs injected), durable (persist after each committed step), resumable (wait states rehydrate).

## 1. Token semantics

- An **instance** starts with one token on the (a) start node.
- A token is **advanced** by the handler for its node's `type`. Advancing yields zero or more
  **outgoing tokens** placed on target nodes (per outgoing flows), or a **wait**.
- The engine runs a **step loop**: pop a runnable (active) token → run its handler → apply effects
  (new tokens / waits / variable writes / events) → persist → repeat until no active tokens remain
  (instance is `waiting`, `completed`, `aborted`, or `failed`).
- Parallelism (parallel gateway, event subprocess, boundary) = multiple concurrent tokens.

## 2. Node handlers (one per engine `type`)

| type | Behavior |
|------|----------|
| `start` | Seed variables; emit token on outgoing. `on.timer` (+ recurring `cycle`) and `on.signal`/`on.message` all begin a **fresh instance** when triggered — timers via a scheduled `TimerJob` reconciled on deploy/activate, signal/message via the same broadcast a mid-flow `throw`/`send`/end-throw uses. `on.condition` is accepted by the schema but **not yet implemented** — no expression is ever evaluated, so a condition-start process is never triggered |
| `end` | Consume token. `result:'terminate'` → cancel all tokens & complete. `throw` → raise signal/error/escalation/message (signal/message/escalation broadcast the same way an intermediate `throw` does, but the path ends here instead of continuing) |
| `script` | `lang:'js'` → run sandboxed against a `kcontext` shim (get/setVariable). `lang:'java'` → sent to a real JVM sidecar, compiled and executed as actual Java (see `15-scripting-and-jbpm-export.md`). Any other dialect (e.g. `mvel`) → **not executed**; recorded as skipped (export-only) |
| `http` | Build request from `body`/`$var`, call `env.INTEGRATION_LAYER_URL + url`, map `resultTo` (JSONPath) → variables |
| `rule` | `ruleflowGroup` → run **rule-engine** over matching facts; `dmn` → **dmn-engine** decision; write results back |
| `call` | Start a child instance of `process`; map `inputs`; on child complete map `outputs`; parent token waits — unless `independent: true`, in which case the parent continues immediately and the child's whole lifecycle is decoupled (it survives the parent's own completion/abort instead of being cascade-torn-down with it) |
| `forEach` | Multi-instance: start a child per item in `over` (each run to full quiescence); `parallel` → concurrent (`Promise.all`), else sequential (fails fast); collect `itemResult` → `collectInto`. Any item that doesn't complete fails the whole node (`MULTIINSTANCE_ERROR`) instead of silently dropping that item. **Known gap**: since a child is only "done" when `startChild` returns, an item whose own process **waits** (e.g. a per-item human task) is treated as a failure — there's no mechanism yet to park a multi-instance node on N independent per-item resumes |
| `userTask` | Create a **Task**; token **waits** until the task is completed (outputs → variables) or, if the node is `skippable: true`, skipped via `POST /tasks/:id/skip` (no output mapped). `dueDate` populates `Task.dueAt` (queryable via `GET /tasks?overdue=true`) — it's informational only, not itself an escalation trigger; pair a `boundary` timer on the same node for that. `businessAdmin`/`excludedOwners` are enforced on claim/complete/skip (segregation of duties; the business admin always overrides); `priority` only affects `GET /tasks` sort order |
| `send` | Emit a message onto the SignalBus (and/or external). `correlationKey` ($var ref) narrows delivery to the one waiting instance whose own `correlationKey` (set at `start()`) matches, instead of every instance waiting on that message name |
| `receive` | Token **waits** for a matching message |
| `manual` | No work item; auto-complete (tracked only) |
| `gateway` | `exclusive`→first true condition else default; `parallel`→fork/join (join waits for all incoming); `inclusive`→all true + default, join waits for the matching set; `event`→forks a token onto every downstream catch, first one to fire wins the race and cancels the rest (siblings' tokens + any backing TimerJob); `complex`→**not a pluggable rule today**, just falls through to the same first-match-else-default logic as `exclusive` |
| `catch` | Wait for the event (`timer`→TimerJob; `message`/`signal`→SignalBus, correlation-aware — see `send`/`throw`; `condition`→accepted by the schema but **not yet implemented** — no evaluator re-checks it on variable change, so a condition catch/boundary waits forever) |
| `throw` | Raise signal/message/escalation immediately, then continue. `event.correlationKey` — same correlation-scoping as `send` |
| `boundary` | Attached to a host node; interrupting cancels the host token & routes to the boundary flow; non-interrupting spawns a parallel token; timer/error/message/signal/conditional/escalation. A non-interrupting **timer** boundary with a `cycle` recurs (e.g. "ping every hour") instead of firing once, and respects the cycle's ISO-8601 repeat count (`R3/…` = 3 times, `R/…` = unbounded) — repeat counts are honored the same way for start-timers |
| `subprocess` | Embedded: run nested nodes/flows in a child scope (shares vars). Transaction: same + compensation hook. Event: not on the main flow; triggered by its start event (e.g. error) |

Handler contract:
```ts
interface HandlerResult {
  next?: { flowId?: string; nodeId: string }[];   // tokens to create
  wait?: WaitSpec;                                 // this token waits
  vars?: Record<string, unknown>;                  // variable writes
  events?: EngineEvent[];                           // signals/messages/audit
  end?: 'complete' | 'terminate' | 'error';
}
type Handler = (ctx: NodeCtx) => Promise<HandlerResult>;
```

## 3. Wait states & resume

| Wait | Persisted as | Resumed by |
|------|--------------|-----------|
| user task | `Task` + token `waitFor:{kind:'task'}` | `POST /tasks/:id/complete` |
| timer / boundary-timer | `TimerJob` | scheduler when `dueAt` ≤ now |
| catch message / receive | token `waitFor:{kind:'message', ref}` | matching message on SignalBus |
| catch signal | token `waitFor:{kind:'signal', ref}` | matching signal |
| catch conditional | token `waitFor:{kind:'condition'}` | **not yet implemented** — nothing ever resumes this wait |
| call/forEach child | parent token `waitFor:{kind:'child'}` | child instance completes |

Resume = load instance → place event → re-enter the step loop → persist.

## 4. Determinism & persistence

- Injected `clock()` and `newId()`; the step function never calls `Date.now()`/`Math.random()`.
- After each committed step the instance (+ new tasks/timers) are written in one store transaction.
- Crash-safe: on boot, the scheduler re-loads `scheduled` timers and `running` instances with runnable
  tokens and resumes.

## 5. Timers

> Background (async) execution, SLA and user-task deadlines reuse this timer-job machinery: see [18-async-and-node-properties.md](18-async-and-node-properties.md).


- `TimerService` polls `timers` where `status='scheduled' AND dueAt<=now` (or uses a min-heap in
  memory backed by the store). Fires → resume token → for cycles, reschedule next `dueAt`.
- Durations `PTnMnS`/`PnD`, cycles `R/PT1H` / `R5/PT10M`, and absolute dates supported.

## 6. Scripts & expressions (safety)

- `js` scripts and flow conditions run in a **sandbox** (a fresh `isolated-vm` V8 isolate per execution —
  real isolation) with only a `kcontext`/vars shim, no `require`, no globals, a CPU/time budget.
- `java` scripts and flow conditions **also execute** — sent to a persistent JVM sidecar process
  (`jbpm-engine/java-runtime/`) that compiles and runs the exact script text with a real `kcontext`
  binding (real Java, not a JavaScript transpile). A publish-time validator (`java-support` rule)
  runs a fast safety pre-check plus a real dry-compile against the same sidecar, blocking anything
  unsafe or non-compiling with a specific error, rather than letting it fail silently or partway
  through a live instance. See `15-scripting-and-jbpm-export.md` for the full supported /
  unsupported reference.
- Any other dialect (e.g. `mvel`) is **not executed**; the node is recorded `skipped` with a warning
  and the value is preserved for **export**. Authors targeting Node-execution should use `js` or `java`.
- Flow conditions: `js`/`java` → sandbox eval to boolean; unsupported dialects → treated as `false`
  unless a default flow exists (validation warns).

## 7. Errors & compensation

- A handler throwing → nearest **interrupting error boundary** on an enclosing scope catches it; else
  the instance goes `failed` with `error{nodeId,message}`; operator can **retry the node** or abort.
- `end.throw.error` propagates like a thrown error (to boundaries / event subprocess).
- Transaction sub-process: on failure runs registered compensation (v1: hook + manual; auto-comp P2).

## 8. Events & observability

- Emits `instance.started/updated/completed/failed`, `node.entered/exited`, `token.moved`,
  `task.created/completed`, `timer.scheduled/fired`, `signal.sent`, `message.received`.
- Every event → **audit** (redacted) + **WS hub** (live UI). The instance `history` (NodeVisit[]) is
  the backing data for the **per-instance detail** view and the **canvas live-highlight**.

## 9. Testing hooks

- `ExecutionEngine.runToQuiescence(instance)` advances until all tokens wait/finish — deterministic.
- Fake clock + manual `tick(dueAt)` to fire timers in tests.
- Golden traces: assert the ordered `history` for a given input (matches the SDK round-trip tests'
  spirit).
