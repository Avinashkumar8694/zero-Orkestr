# Gateway (`gateway`)

## 1. Overview & Purpose
The **Gateway** controls the divergence (forking) and convergence (joining) of sequence flows in a process. It directs tokens down conditional paths, forks execution into concurrent parallel threads, synchronizes multiple branches, or races between competing external events.

## 2. Supported Scenarios & Behavioral Variants

### Scenario A: Exclusive Gateway (XOR) (`mode: 'exclusive'`)
- **Diverging Fork**: Evaluates the conditions on outgoing sequence flows in order. The **first condition that evaluates to `true` is taken**, and no other branches are explored. If no conditions match, the sequence flow configured as `default` is taken as a fallback. If nothing matches and no default flow exists, the engine fails the step.
- **Converging Join**: Multiple paths merge into a single outgoing flow without synchronization. Each arriving token passes through immediately.
- **When to Use**: Mutually exclusive decisions (e.g. `amount > 50000` vs `amount <= 50000`).

### Scenario B: Parallel Gateway (AND) (`mode: 'parallel'`)
- **Diverging Fork**: Splits the execution token into $N$ parallel tokens—one for **every outgoing sequence flow unconditionally**.
- **Converging Join**: Synchronizes parallel execution. It waits until **all incoming sequence flows** have delivered a token before emitting a single combined token to continue.
- **When to Use**: Concurrent operations (e.g., ordering medical exam AND ordering background check simultaneously).

### Scenario C: Inclusive Gateway (OR) (`mode: 'inclusive'`)
- **Diverging Fork**: Evaluates conditions on all outgoing flows. **Every branch whose condition evaluates to `true` is taken concurrently**. If none match, the `default` flow is taken as fallback.
- **Converging Join**: Synchronizes all currently active branches that were spawned by the matching inclusive fork before proceeding.
- **When to Use**: Multi-condition routing where zero, one, or multiple branches can apply (e.g. sending SMS, Email, and Push notification based on user preferences).

### Scenario D: Event-Based Gateway (`mode: 'event'`)
- **Diverging Fork**: Spawns waiting tokens at multiple intermediate catch events (e.g. Signal Catch vs Timer Catch). The **first event to fire wins the race**; all other competing events are immediately cancelled, and execution continues down the winning branch.
- **When to Use**: Timeout vs Callback races (e.g. wait for customer response for 7 days OR continue on timeout).

## 3. Property Reference & Possible Values

| Field | JSON Path | Type | Allowed Values | Default | Description |
|---|---|---|---|---|---|
| **Name** | `name` | `string` | Free text | `"Gateway"` | Display label. |
| **Mode** | `mode` | `string` | `'exclusive'`, `'parallel'`, `'inclusive'`, `'event'` | `'exclusive'` | Gateway behavioral mode. |
| **Direction** | `direction` | `string` | `'Diverging'`, `'Converging'` | `'Diverging'` | Visual classification of fork vs join. |
| **Default Flow** | `default` | `string` | Sequence Flow ID | `undefined` | Fallback flow taken when no conditions match. |

## 4. When to Use & When NOT to Use
- **Do Use**:
  - Always provide a `default` flow on Exclusive Gateways to prevent runtime deadlocks if unexpected data arrives.
  - Pair every Parallel Fork with a corresponding Parallel Join to keep token counts balanced.
  - Use Event-Based Gateway when racing asynchronous callbacks against SLAs.
- **Do NOT Use**:
  - Do NOT create a mixed gateway (multiple in AND multiple out on the same node). Split into a Join Gateway followed by a Fork Gateway.
  - Do NOT place conditions on sequence flows leaving a Parallel Gateway (they are unconditional).

## 5. Concrete Step-by-Step Examples

### Example 1: Exclusive Gateway with Default Fallback
```json
{
  "id": "gw_approval",
  "name": "Check Claim Amount",
  "type": "gateway",
  "mode": "exclusive",
  "default": "flow_auto_approve"
}
```

### Example 2: Parallel Fork for Concurrent Checks
```json
{
  "id": "gw_fork_checks",
  "name": "Fork Medical & Identity Checks",
  "type": "gateway",
  "mode": "parallel"
}
```

### Example 3: Event-Based Gateway (Customer Response vs 7-Day Timeout)
```json
{
  "id": "gw_event_wait",
  "name": "Wait for Docs or Timeout",
  "type": "gateway",
  "mode": "event"
}
```

### Sequence Flow Condition Expressions (Modern vs Compatibility Dialect)
When configuring conditional sequence flows exiting an Exclusive or Inclusive Gateway:
- **Modern Node.js (Recommended)**: Use plain JavaScript expressions referencing process variables directly:
  - `amount > 5000`
  - `riskTier === 'HIGH' && priority === 'CRITICAL'`
  - `vars.claim.payout > 1000`
- **Compatibility Dialect**: Expressions using `kcontext.getVariable("key")` or Java sidecar conditions are fully supported.

> [!TIP]
> **Condition Syntax & Recipes**: See the [JavaScript & Flow Variables Cheat Sheet](../../../../docs/usage_docs/15-javascript-and-flow-variables-cheatsheet.md) for full condition recipes including string pattern matching, array methods, and multi-line condition blocks.

## 6. Testing Scenarios & Verification Guide
1. **Exclusive Ordering**: Configure flows `[x > 10, x > 5]`; pass `x = 15`; verify only flow 1 (`x > 10`) is taken.
2. **Parallel Synchronization**: Fork 2 tasks; complete task 1; verify join gateway waits; complete task 2; verify join resumes.
3. **Event Gateway Race**: Attach Signal Catch and Timer Catch; fire Signal; verify Signal branch resumes and Timer job is cancelled.
