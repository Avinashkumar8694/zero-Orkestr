# Intermediate Catch Event (`catch`)

## 1. Overview & Purpose
An **Intermediate Catch Event** pauses the execution of a token along an inline sequence flow until a specific trigger occurs. It is an inline pause step used to introduce intentional delays, wait for external signals, or wait for specific enterprise messages before continuing down the flow.

## 2. Supported Scenarios & Behavioral Variants

### Scenario A: Intermediate Timer Delay (`event: { timer: { duration: 'PT15M' } }`)
- **Behavior**: Creates a durable `TimerJob` in the database with `dueAt = now + duration`. The token transitions to status `waiting`. When the background scheduler reaches `dueAt`, it resumes the token and moves to the next node.
- **When to Use**: Delaying execution (e.g., "Wait 2 hours before sending follow-up email", "Pause 3 days to allow bank clearing").

### Scenario B: Intermediate Signal Catch (`event: { signal: 'PaymentConfirmed' }`)
- **Behavior**: Pauses the token until an external API call (`POST /instances/{id}/signal`) or another process's Signal Throw node broadcasts a signal matching this name.
- **When to Use**: Inter-process synchronization and external webhook callbacks.

### Scenario C: Intermediate Message Catch (`event: { message: 'DocReceived' }`)
- **Behavior**: Pauses the token until a correlated message event arrives for this instance.
- **When to Use**: Asynchronous message intake from Kafka, RabbitMQ, or document scanner queues.

## 3. Property Reference & Possible Values

| Field | JSON Path | Type | Allowed Values | Default | Description |
|---|---|---|---|---|---|
| **Name** | `name` | `string` | Free text | `"Catch event"` | Display label. |
| **Event Type** | `event.kind` | `string` | `'timer'`, `'signal'`, `'message'`, `'condition'` | `'timer'` | Event type to wait for. |
| **Duration** | `event.timer.duration` | `string` | ISO duration (e.g. `PT5M`, `P1D`) | `undefined` | Delay period. |
| **Date** | `event.timer.date` | `string` | ISO-8601 Date string | `undefined` | Exact date/time to resume. |
| **Signal Name** | `event.signal` | `string` | Alphanumeric string | `undefined` | Name of the signal to wait for. |
| **Message Name** | `event.message` | `string` | Message contract name | `undefined` | Name of the message to wait for. |

## 4. When to Use & When NOT to Use
- **Do Use**:
  - To introduce durable, crash-resilient delays without keeping threads or connections open in memory.
  - In combination with an **Event-Based Gateway** to race between two incoming signals or a signal vs a timeout.
- **Do NOT Use**:
  - Do NOT use in-code `setTimeout` or sleep loops inside Script Tasks. Always use Intermediate Timer Catch.
  - Do NOT use for catching exceptions on an activity (use Boundary Event).

## 5. Concrete Step-by-Step Examples

### Example 1: 30-Minute Durable Delay
```json
{
  "id": "catch_delay",
  "name": "Wait 30 Minutes",
  "type": "catch",
  "event": {
    "timer": {
      "duration": "PT30M"
    }
  }
}
```

### Example 2: Wait for External Payment Webhook Signal
```json
{
  "id": "catch_payment_signal",
  "name": "Wait for Payment Confirmation",
  "type": "catch",
  "event": {
    "signal": "PaymentAuthorized"
  }
}
```

## 6. Testing Scenarios & Verification Guide
1. **Timer Persistence**: Token enters node; verify `tokens[0].status === 'waiting'` and a `TimerJob` row exists with `status === 'scheduled'`.
2. **Scheduler Resumption**: Run `timerService.tick(dueAt)`; verify timer status transitions to `fired` and instance resumes to the next node.
3. **Signal Delivery**: Call `instances.signal(instanceId, 'PaymentAuthorized', { txnId: '123' })`; verify waiting token resumes immediately.
