# Boundary Event (`boundary`)

## 1. Overview & Purpose
A **Boundary Event** catches an event (such as a timeout, business error, signal, or compensation request) that occurs while a host activity is executing. It provides exceptional routing, SLA escalation, and failure recovery. A boundary event has **no incoming flows** (`maxIn: 0`) and exactly **one outgoing flow** (`maxOut: 1`) that connects to the recovery or escalation path.

## 2. Supported Scenarios & Behavioral Variants

### Scenario A: Interrupting Timer Boundary (`interrupting: true`)
- **Behavior**: When the configured duration (`duration: 'PT2H'`) or date elapses while the host task is still waiting, the engine **cancels the host activity** (e.g. aborts the user task) and diverts the execution token down the boundary event's outgoing sequence flow.
- **When to Use**: Strict SLA escalation (e.g. if an underwriter has not reviewed a claim within 48 hours, cancel the task and automatically reassign to a senior manager).

### Scenario B: Non-Interrupting Timer Boundary (`interrupting: false`)
- **Behavior**: When the timer fires (e.g. `cycle: 'R3/P1D'`), the host activity **remains active and waiting**. A new concurrent token is spawned down the outgoing flow (e.g. to send an email reminder). If configured with a cycle repeat count, it fires repeatedly until the host activity completes or the count is exhausted.
- **When to Use**: Periodic notifications, SLA warnings, and reminder emails while keeping the task open for completion.

### Scenario C: Error Boundary Catch (`event: { error: 'SERVICE_ERROR' }` or `'*'`)
- **Behavior**: Catches an error thrown by the host node (such as HTTP 5xx, script syntax error, or explicit BPMN Error Throw end).
  - Can catch a specific code: `SERVICE_ERROR`, `SCRIPT_ERROR`, `RULE_ERROR`, `CALL_ERROR`, or user codes like `INSUFFICIENT_FUNDS`.
  - Wildcard `*` catches any error.
  - Automatically binds error metadata (`code`, `node`, `message`) to the process variable `errorInfo`.
- **When to Use**: Circuit breakers, graceful fallbacks, and error recovery pipelines.

### Scenario D: Compensation Boundary (`event: { compensation: true }`)
- **Behavior**: Attached to an activity to record a rollback action. Does not execute immediately; instead, when a downstream Compensate Throw event is triggered, this boundary's outgoing path executes to undo the completed activity.
- **When to Use**: Saga pattern / distributed transactions (e.g. cancelling a hotel reservation if flight booking fails).

## 3. Property Reference & Possible Values

| Field | JSON Path | Type | Allowed Values | Default | Description |
|---|---|---|---|---|---|
| **Name** | `name` | `string` | Free text | `"Boundary event"` | Display label. |
| **Attached To** | `on` | `string[]` | Array of Node IDs, or `[]` (All nodes) | `[]` | Node(s) this boundary monitors. Empty = process-wide handler. |
| **Event Type** | `event` / `event.kind` | `string` | `'error'`, `'timer'`, `'signal'`, `'compensation'` | `'error'` | Type of event to intercept. |
| **Interrupting** | `interrupting` | `boolean` | `true`, `false` | `true` | If true, aborts host task when fired. If false, spawns concurrent branch. |
| **Timer Spec** | `event.timer` | `object` | `{ duration, cycle, date }` | `undefined` | Duration (`PT1H`), recurring cycle (`R/PT15M`), or fixed date. |
| **Error Code** | `event.error` | `string` | Error code string or `*` | `"*"` | Error code to match. |

## 4. When to Use & When NOT to Use
- **Do Use**:
  - Always attach an Error Boundary to Service/REST tasks to prevent network outages from failing the entire process instance.
  - Use Non-Interrupting Timers for automated reminders (e.g. "Reminder: Claim review pending for 3 days").
  - Use Interrupting Timers for hard escalations and automatic rerouting.
- **Do NOT Use**:
  - Do NOT connect incoming sequence flows into a Boundary Event (`maxIn: 0`).
  - Do NOT attach an interrupting boundary if the main task must still be able to complete normally.

## 5. Concrete Step-by-Step Examples

### Example 1: 48-Hour Hard SLA Escalation (Interrupting)
```json
{
  "id": "boundary_escalate",
  "name": "48h SLA Escalation",
  "type": "boundary",
  "on": ["task_underwriter_review"],
  "interrupting": true,
  "event": {
    "timer": {
      "duration": "PT48H"
    }
  }
}
```

### Example 2: Service Error Fallback (Catches SERVICE_ERROR)
```json
{
  "id": "boundary_err",
  "name": "Catch API Failure",
  "type": "boundary",
  "on": ["http_policy_lookup"],
  "interrupting": true,
  "event": {
    "error": "SERVICE_ERROR"
  }
}
```

### Example 3: Daily Reminder Email (Non-Interrupting)
```json
{
  "id": "boundary_reminder",
  "name": "Daily Reminder",
  "type": "boundary",
  "on": ["task_gather_docs"],
  "interrupting": false,
  "event": {
    "timer": {
      "cycle": "R5/P1D"
    }
  }
}
```

## 6. Testing Scenarios & Verification Guide
1. **Interrupting Timer Cancellation**: Fast-forward fake clock; tick timer; verify boundary flow is entered and host task is aborted.
2. **Non-Interrupting Recurring Cycle**: Fast-forward clock; verify reminder branch executes while host task remains waiting; complete task; verify future timers cancelled.
3. **Error Catch & `errorInfo` Binding**: Trigger 500 error in service task; verify error boundary catches and `inst.variables.errorInfo` contains `{ code: 'SERVICE_ERROR', node, message }`.
