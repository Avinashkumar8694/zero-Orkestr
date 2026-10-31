# End Event (`end`)

## 1. Overview & Purpose
The **End Event** marks the termination of an execution path within a process. An end node consumes the incoming execution token. Depending on its configured result mode (`normal` vs `terminate`) and attached throw events (`error`, `signal`, `escalation`), it either completes a single parallel branch or terminates the entire process instance and all associated tokens immediately.

## 2. Supported Scenarios & Behavioral Variants

### Scenario A: Normal End (`result: '(normal)'` or omitted)
- **Behavior**: Consumes the token on this branch. If other parallel branches or tokens are still active, the instance remains `running`. When the last remaining token reaches a normal end, the instance status transitions to `completed`.
- **When to Use**: Standard branch completion in sequential workflows or parallel forks where other parallel paths must be allowed to complete.

### Scenario B: Terminate End (`result: 'terminate'`)
- **Behavior**: Immediately aborts all active tokens in the instance (including waiting user tasks and pending timer jobs) and cancels any non-independent child sub-processes. The entire instance completes immediately.
- **When to Use**: Cancellation flows, immediate rejections, fraud drop-offs, or emergency stops where no remaining branches should continue running.

### Scenario C: Error End (`throw.error: string`)
- **Behavior**: Throws a BPMN error event with a specific error code (e.g. `FRAUD_REJECTED`) and optional message. If an Error Boundary on a parent scope or an Error Event Sub-Process is present, execution routes to that error handler. If unhandled, the instance marks as `failed`.
- **When to Use**: Business fault handling, validation failures, or unrecoverable domain errors that require compensation or recovery flows.

### Scenario D: Signal / Message Throw End (`throw.signal` or `throw.message`)
- **Behavior**: Emits a broadcast or correlated signal before terminating the branch.
- **When to Use**: Notifying external observer processes or triggering sibling workflows upon process completion.

## 3. Property Reference & Possible Values

| Field | JSON Path | Type | Allowed Values | Default | Description |
|---|---|---|---|---|---|
| **Name** | `name` | `string` | Free text | `"End"` | Label displayed on diagram and audit logs. |
| **Result Mode** | `result` | `string` | `'(normal)'`, `'terminate'` | `'(normal)'` | Normal consumes the token; Terminate kills all other tokens and stops the instance. |
| **Throw Type** | `throw` | `string` | `'none'`, `'signal'`, `'error'`, `'escalation'`, `'message'` | `'none'` | Event to fire upon reaching this end node. |
| **Error Code** | `throw.error` | `string` | Alphanumeric error code | `undefined` | Error code thrown to error boundaries or event subprocesses. |
| **Signal Name** | `throw.signal` | `string` | Signal identifier | `undefined` | Signal broadcasted upon completion. |
| **Correlate To** | `throw.correlationKey` | `string` | Variable reference (e.g. `$claimId`) | `undefined` | Correlation key for targeted signal delivery. |

## 4. When to Use & When NOT to Use
- **Do Use**:
  - Use **Normal End** when joining parallel branches with a Parallel Gateway or allowing independent branches to finish naturally.
  - Use **Terminate End** when a fatal rejection occurs (e.g., "Claim Rejected" or "User Ineligible") to prevent orphaned user tasks on parallel branches.
  - Use **Error End** to signal expected business failure codes to parent call activities.
- **Do NOT Use**:
  - Do NOT draw outgoing sequence flows from an End node (`ports.maxOut: 0`).
  - Do NOT use Terminate End if sibling branches still need to perform cleanup or audits.

## 5. Concrete Step-by-Step Examples

### Example 1: Normal Completion End
```json
{
  "id": "end_complete",
  "name": "Application Approved",
  "type": "end"
}
```

### Example 2: Immediate Terminate End (Rejection)
```json
{
  "id": "end_reject",
  "name": "Fraud Rejection - Terminate",
  "type": "end",
  "result": "terminate"
}
```

### Example 3: Error Throw End
```json
{
  "id": "end_error",
  "name": "Throw Ineligible Error",
  "type": "end",
  "throw": {
    "error": "APPLICANT_INELIGIBLE"
  }
}
```

## 6. Testing Scenarios & Verification Guide
1. **Parallel Branch Token Consumption**: Fork into 2 branches; pass branch 1 into a Normal End; verify branch 2 is still active and instance is `running`.
2. **Terminate Cascade**: Fork into 2 branches; branch 1 hits Terminate End; verify branch 2's token is immediately canceled and instance is `completed`.
3. **Error Routing**: Throw error `ERR_LIMIT_EXCEEDED`; verify error boundary on the parent activity catches it.
