# User Task (`userTask`)

## 1. Overview & Purpose
The **User Task** represents a human activity requiring manual interaction or approval by an operator, underwriter, or examiner. When an execution token enters a User Task, the engine generates a durable `Task` entity in the inbox, suspends the token in a waiting state, and pauses until a human user claims and completes (or skips) the task via the UI or REST API.

## 2. Supported Scenarios & Behavioral Variants

### Scenario A: Group / Role Pool Claiming (`group: 'underwriters'`)
- **Behavior**: The task is published to a candidate group pool with status `created`. Any registered user who is a member of that group can see the task in their group inbox and **claim** it. Once claimed, status transitions to `reserved` and the claiming user becomes the `assignee`.
- **When to Use**: Work queues distributed across teams (e.g. Underwriting Queue, Claims Adjusters).

### Scenario B: Direct Assignment (`assignee: 'john_doe'`)
- **Behavior**: The task is assigned directly to a specific user upon creation. It appears in that user's personal inbox immediately.
- **When to Use**: Targeted reviews where a specific supervisor, account owner, or initiator must complete the work.

### Scenario C: Segregation of Duties (`excludedOwners: ['initiator_user']`)
- **Behavior**: Real IAM enforcement prevents specified users from viewing, claiming, or completing this task, even if they belong to the candidate group.
- **When to Use**: Four-eyes principle / dual control (e.g., the user who submitted an invoice cannot approve that same invoice).

### Scenario D: Dynamic UI Form Binding (`form: 'claim_approval_form'`)
- **Behavior**: Binds to a Form asset designed in the project. The task inbox renders this custom interactive form populated with the task's input variables.
- **When to Use**: Structured data entry, questionnaires, and approval checklists.

### Scenario E: SLA Deadlines & Automatic Fallback (`dueDate: 'PT24H'`)
- **Behavior**: Calculates the task deadline (`dueAt`). If not explicitly defined on the node, the engine automatically calculates `dueAt` using the tenant's `defaultTaskSlaHours` (configured in System Settings). If attached to a Boundary Timer, breaching this SLA triggers automatic escalation.
- **When to Use**: Time-sensitive customer operations and compliance SLAs.

### Scenario F: Input / Output Variable Mapping (`inputs`, `outputs`)
- **Behavior**:
  - `inputs`: Maps process variables into task inputs (`taskVar ← $processVar`).
  - `outputs`: Maps form submission keys back into process variables (`processVar ← taskVar`).
- **When to Use**: Scoping task data so the user form only receives relevant variables and names outputs cleanly.

## 3. Property Reference & Possible Values

| Field | JSON Path | Type | Allowed Values | Default | Description |
|---|---|---|---|---|---|
| **Name** | `name` | `string` | Free text | `"User Task"` | Title shown in user inbox and diagrams. |
| **Group** | `group` | `string` | Group name | `"user"` | Candidate group eligible to claim this task. |
| **Assignee** | `assignee` | `string` | Username | `undefined` | Specific user directly assigned this task. |
| **Business Admin** | `businessAdmin` | `string` | Username | `undefined` | Manager allowed to reassign, delegate, or forward. |
| **Excluded Owners** | `excludedOwners` | `string[]` | Array of usernames | `[]` | Users strictly forbidden from claiming (dual control). |
| **Form Name** | `form` | `string` | Form asset identifier | `undefined` | Interactive UI form rendered for this task. |
| **Priority** | `priority` | `number` | Integer $\ge 0$ (higher = more urgent) | `0` | Determines ordering in the task inbox list. |
| **Due Date** | `dueDate` | `string` | ISO duration (`PT8H`), date | Fallback to `defaultTaskSlaHours` | Task completion deadline. |
| **Skippable** | `skippable` | `boolean` | `true`, `false` | `false` | Whether an authorized user can skip this task without submitting data. |
| **Inputs** | `inputs` | `Record<string, unknown>` | Key-value pairs (`$varName` or literal) | `{}` | Variable mapping: `taskVar ← $processVar`. |
| **Outputs** | `outputs` | `Record<string, unknown>` | Key-value pairs (`processVar ← taskVar`) | `{}` | Variable mapping: `processVar ← taskVar`. |

## 4. When to Use & When NOT to Use
- **Do Use**:
  - Whenever a human decision, signature, document review, or manual data entry is needed.
  - Pair with **Boundary Timers** to automatically escalate or send reminders when SLAs approach breach.
  - Use **`excludedOwners`** to enforce compliance and audit segregation of duties.
- **Do NOT Use**:
  - Do NOT use a User Task for automated decisions or API lookups (use Service Task or Business Rule Task).
  - Do NOT hardcode individual usernames in `assignee` unless strictly necessary; prefer `group` for resilient team operations.

## 5. Concrete Step-by-Step Examples

### Example 1: Underwriter Approval with SLA and Form Binding
```json
{
  "id": "task_underwriter",
  "name": "Underwriter Review",
  "type": "userTask",
  "group": "underwriters",
  "form": "claim_review_form",
  "priority": 10,
  "dueDate": "PT24H",
  "inputs": {
    "applicantName": "$customerName",
    "requestedAmount": "$claimAmount"
  },
  "outputs": {
    "underwriterApproval": "approvalDecision",
    "notes": "reviewNotes"
  }
}
```

### Example 2: Dual Control Task with Excluded Owners
```json
{
  "id": "task_payout_approval",
  "name": "Approve High-Value Payout",
  "type": "userTask",
  "group": "finance_managers",
  "excludedOwners": ["$initiatorUser"],
  "priority": 50,
  "dueDate": "PT4H"
}
```

## 6. Testing Scenarios & Verification Guide
1. **Creation & Inbox Listing**: Token enters node; verify `task.created` event emitted and task exists in `GET /tasks?group=underwriters`.
2. **Claim & Reservation**: Call `POST /tasks/{id}/claim`; verify status changes to `reserved` and `assignee` is set.
3. **Completion & Resume**: Call `POST /tasks/{id}/complete` with `{ outputs }`; verify token resumes, variables are merged, and next node is entered.
4. **Dual Control Exclusion**: Attempt claim as an excluded user; verify engine returns `403 Forbidden`.

## 7. Operational Gotchas & Edge Cases
- **Auto-Release Idle Claims**: If `autoReleaseClaimedTaskHours` is enabled in System Settings, tasks left in `reserved` state without completion past the threshold are returned to `created` pool.
- **Task on Dead Instance**: If an instance is aborted or completed by another branch, attempts to complete tasks on it are rejected with `409 Conflict`.
