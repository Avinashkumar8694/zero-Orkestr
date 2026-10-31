# Start Event (`start`)

## 1. Overview & Purpose
The **Start Event** marks the initiation point of a process flow. Every process definition requires at least one reachable start event per entry path. When an instance is created, execution begins by spawning an active token at the start node, which immediately transitions down its outgoing sequence flow to the first activity.

## 2. Supported Scenarios & Behavioral Variants

### Scenario A: Manual / REST Start (`on: undefined` or `'none'`)
- **Behavior**: An instance is manually started via the REST API (`POST /instances` with `{ processId, variables }`). The start node itself performs no waiting or evaluation; it simply marks the visual and logical entry point.
- **When to Use**: Synchronous, user-driven, or webhook-initiated workflows (e.g. submitting a claim from a frontend portal).

### Scenario B: Signal Start (`on: { signal: string }`)
- **Behavior**: The engine listens for an untargeted broadcast signal (emitted by another process's intermediate Signal Throw node or via `POST /instances/signal`). When the broadcast matches `signal`, a fresh process instance is instantiated automatically.
- **When to Use**: Event-driven architectures where an event in one process triggers a decoupled new case or workflow (e.g. "CustomerRegistered" triggers "WelcomeOnboardingProcess").

### Scenario C: Message Start (`on: { message: string }`)
- **Behavior**: An instance begins when an inbound enterprise message with a matching message reference is received via an integration endpoint.
- **When to Use**: Asynchronous integration queues, Kafka event consumption, or partner webhook intake.

### Scenario D: Timer / Cron Start (`on: { timer: string }`)
- **Behavior**: A durable `TimerJob` of kind `'start'` is scheduled automatically whenever the process's deployment becomes **active**. The background worker scheduler polls due timers and starts a new instance at each scheduled interval.
- **Supported Formats**:
  - Cycle (Recurring): `R/PT1H` (every hour indefinitely), `R5/P1D` (repeat 5 times, every day).
  - Duration: `PT10M` (once, 10 minutes after deployment activation).
  - Fixed Date: `2026-12-31T23:59:59Z`.
- **When to Use**: Periodic batch jobs, daily reconciliation sweeps, SLA monitoring jobs, and automated report generation.

### Scenario E: Error Start (`on: { error: string }`)
- **Behavior**: Used exclusively inside an **Event Sub-Process**. When an uncaught error is thrown anywhere in the parent process matching `error` (or `*` for catch-all), this start event activates the event sub-process error handler.
- **When to Use**: Process-wide exception handling, rollback pipelines, and automated administrative alert flows.

## 3. Property Reference & Possible Values

| Field | JSON Path | Type | Allowed Values | Default | Required? | Description |
|---|---|---|---|---|---|---|
| **Name** | `name` | `string` | Free text | `"Start"` | Yes | Display label on diagrams and execution traces. |
| **Trigger Type** | `on` / `on.kind` | `string` | `'none'`, `'signal'`, `'message'`, `'timer'`, `'condition'`, `'error'` | `'none'` | No | Mechanism that triggers process instantiation. |
| **Signal Name** | `on.signal` | `string` | Alphanumeric string | `undefined` | Required if trigger is signal | The broadcast signal name to listen for. |
| **Message Ref** | `on.message` | `string` | Message asset name | `undefined` | Required if trigger is message | The message contract identifier. |
| **Timer Spec** | `on.timer` | `string` | ISO-8601 Duration, Cycle, or Date | `undefined` | Required if trigger is timer | Cycle (`R/PT1H`), Duration (`PT5M`), or ISO Date. |
| **Error Code** | `on.error` | `string` | Error code or `*` | `undefined` | Required if event sub-process | BPMN error code or wildcard `*`. |
| **Documentation** | `documentation` | `string` | Text notes | `""` | No | Author notes explaining intent. |

## 4. When to Use & When NOT to Use

- **Do Use**:
  - Always have exactly one start event per standard linear or branching process.
  - Use Timer Start for batch jobs instead of external cron triggers.
  - Use Signal Start to decouple interdependent workflows.
- **Do NOT Use**:
  - Do NOT connect incoming sequence flows into a start event (`ports.maxIn: 0`).
  - Do NOT use multiple plain start events in the same process (only one default entry point is allowed).
  - Do NOT use Timer Start inside an embedded sub-process.

## 5. Concrete Step-by-Step Examples

### Example 1: Standard Manual Start
```json
{
  "id": "start_1",
  "name": "Claim Intake Start",
  "type": "start"
}
```

### Example 2: Hourly Batch Reconciliation (Timer Start)
```json
{
  "id": "start_cron",
  "name": "Hourly Reconciliation Schedule",
  "type": "start",
  "on": {
    "timer": "R/PT1H"
  }
}
```

### Example 3: Signal-Triggered Escalation Flow
```json
{
  "id": "start_sig",
  "name": "High Risk Claim Signal Start",
  "type": "start",
  "on": {
    "signal": "HighRiskFraudDetected"
  }
}
```

## 6. Testing Scenarios & Verification Guide
1. **Manual Start Test**: Call `engine.start(deployment, processId, { amount: 500 })` and verify `tokens` includes outgoing node.
2. **Signal Start Test**: Emit `engine.broadcast("HighRiskFraudDetected")` with no waiting tokens; verify a new instance is spawned.
3. **Timer Start Test**: Fast-forward fake clock past the cycle interval and execute `timerService.tick(now)`; verify a new instance starts and the timer reschedules for the next cycle.

## 7. Operational Gotchas & Edge Cases
- **Active Deployment Requirement**: A Timer or Signal start will **only fire on the active deployment** of a workflow. If a deployment is in `draft` or `inactive` state, timers are paused.
- **Quota Protection**: If `maxActiveInstances` quota is reached, timer-triggered starts will skip that tick rather than crashing, and will attempt again on the next cycle.
