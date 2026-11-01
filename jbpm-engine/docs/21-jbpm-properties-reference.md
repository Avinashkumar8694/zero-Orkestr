# 21 — jBPM property reference (what the engine supports)

One table per node family: the property, what it does, its default, and the test that proves it. Properties are optional everywhere: leave
one unset and the node behaves as it always did. Maintained per phase of release 2.0.0 (plan: [20](20-release-2.0.0-jbpm-parity-plan.md)).

## Every node
| Property | Does | Default |
|---|---|---|
| `metaData` (key → value) | Free labels; scripts read `node.metaData` / `node.getMetaData(key)`. Never affects routing. | none |

## Every activity (script, http, workItem, rule, send, receive, manual, call, forEach, subprocess, userTask)
| Property | Does | Default |
|---|---|---|
| `autoStart` | In an ad-hoc process, starts with the instance when nothing flows into the node. | off |
| `isForCompensation` | Marks a compensation handler; not reported as unreachable. | off |
| `slaDueDate` | Node SLA (met / violated). | none |
| `async`, `asyncRetries`, `asyncRetryDelay`, `asyncDelay` | Background run, its retries, and a start delay. | inline |
| `onEntry`, `onExit` | Scripts. | none |

## Process
| Property | Does | Default |
|---|---|---|
| `slaDueDate` | Instance SLA: pending → met when it completes in time, violated when the job fires first. Audit + notification; the process carries on. | none |
| `description` | Title template, `#{var}` filled at start (`#{customer.name}` works). Stored on the instance. | none |
| `adHoc` | Makes `autoStart` nodes live. | false |
| `version` | Label stored with the definition. | none |
| variable `tags` | `required`: the instance cannot start without a value. `readonly`: set once, then refused (scripts and API; a script's change is undone and the node fails with `VARIABLE_READONLY`). | none |

## User task
| Property | Does | Default |
|---|---|---|
| `group`, `assignee` | The original single group / user. | as before |
| `actors[]`, `groups[]` | Several users and groups. Any listed actor, or a registered member of any listed group, may claim. With `actors` set, an unregistered caller who is not listed is refused. | none |
| `businessAdminGroups[]` | Members may reassign and manage the task. | none |
| `stakeholders[]` | Follow the task; no right to claim or complete. | none |
| `comment`, `content`, `locale`, `createdBy` | First comment; extra form data (input `Content`); notification language; creator (defaults to whoever started the instance). | none |
| `notStartedReassign`, `notCompletedReassign`, `notStartedNotify`, `notCompletedNotify` | jBPM deadline syntax. | none |

## Call activity
| Property | Does | Default |
|---|---|---|
| `process` | A process **id or name**. | — |
| `waitForCompletion`, `independent` | Wait for the child / let it outlive the parent. | wait |
| `onChildFailure` | `fail` raises `CALL_ERROR` (catchable); `continue` carries on and stores `{childInstanceId, childStatus, childError}` in `errorVar` (default `callError`); `abort` aborts the parent at once. | `fail` |

## For-each
| Property | Does | Default |
|---|---|---|
| `completionCondition` | JavaScript condition over `completed`, `total`, `results`, variables. When true the rest are aborted and the node completes with the results so far. | wait for all |

## Gateways and flows
| Property | Does | Default |
|---|---|---|
| flow `priority` | Lower number is tried first at an exclusive / inclusive gateway; flows without one keep drawn order, after prioritised ones. Equal numbers keep drawn order. | drawn order |

## HTTP / REST
| Property | Does | Default |
|---|---|---|
| `contentType` | The content-type header; `application/x-www-form-urlencoded` sends the body as a form. | `application/json` |
| `authType` (`basic`, `bearer`), `username`, `password`, `token` | Builds the Authorization header. Values may be literals, `$variable` (process variable, then deployment env) or `${ENV}`. | none |
| `headers` | Explicit headers; they override the generated ones whatever their case. | none |
| `timeoutSeconds` | Per-node timeout. | workspace setting |

## Timers (start, catch and boundary events)
| Form | Meaning |
|---|---|
| `PT30M`, `1h 30m`, `90m`, `2d` | delay from now |
| `{ date: "2030-01-01T00:00:00Z" }` or an ISO date string | once, at that instant |
| `{ cycle: "R3/PT1H" }` | repeat (existing behaviour) |
| `{ cron: "0 9 * * MON-FRI" }`, `"cron:0 9 * * *"`, `{ cycle: "…", language: "cron" }` | schedule, UTC. 5 fields (minute hour day month weekday) or Quartz (seconds first, `?`, year) |
| `#{variable}` in any of the above | filled from the process variables when the timer is set; a missing variable is an error |

A recurring timer is one durable row; after downtime it fires once and reschedules from the current time.

## Events
| Property | Does |
|---|---|
| catch `event.condition` (+ `lang`) | waits until the condition is true; re-checked only when this instance's variables change |
| boundary `event.condition` | same, attached to an activity; interrupting or not |
| throw / catch `event.link` | "go to": the throw jumps to the catch with the same name in the same process |
| throw / end `scope: "instance"` | signal, message or escalation delivered only inside this instance |
| user task `suspendUntil` | the task is created suspended and becomes available at that time (duration, date or `#{var}`) |

Conditional **start** events are not supported (see plan §11, G23).

## Sub-processes and structure
| Property | Does |
|---|---|
| sub-process `on: { signal | message | escalation | timer | condition }` | An **event sub-process**: an unconnected sub-process that starts when its trigger fires during the instance's life. `interrupting` (default true) stops the rest of the process; `false` runs beside it. Its body shares the process variables. |
| sub-process `adHoc`, `completionCondition` | Ad-hoc scope: `autoStart` steps begin, others start on demand; ends when the condition (over `completed`, `active`, variables) is true, or when nothing is left running. |
| sub-process `transaction` + end `result: "cancel"` | Cancel: compensate, abort the scope, raise `TRANSACTION_CANCELLED` in the parent. |
| any activity `multiInstance` | `{ over, as, parallel, collectInto, itemResult, completionCondition }`: run once per item. Valid on userTask, script, http, workItem, rule, send, manual, subprocess. |
| gateway (event) `instantiate` | The process starts when any event after the gateway arrives (signal / message). |
| gateway (complex) `activationCondition` | Join fires when the condition holds (`arrived`, `total`, variables); once per round. |

## User task (assignment)
| Property | Does |
|---|---|
| `assignmentStrategy` | `leastLoaded` (fewest open tasks) or `roundRobin` (longest since this step gave that person a task) among actors and group members; none = queue. |
| `swimlane`, `autoClaim` | With `autoClaim`, the task goes to whoever completed the previous task of the same swimlane in the instance (unless excluded). |
