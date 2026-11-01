# Orkestr 2.0.0 release notes

jBPM-parity release. Plan and results: [20](20-release-2.0.0-jbpm-parity-plan.md); property reference: [21](21-jbpm-properties-reference.md).

## Added
- Timers and events: cron timers, `#{variable}` and short delays, link events, conditional catch/boundary events, signal scope, event sub-processes (signal, message, escalation, timer, condition; interrupting or not), transaction cancel, instantiating event gateway.
- Activities: multi-instance on any task, ad-hoc sub-process, complex gateway activation, multi-owner tasks, assignment strategies, swimlane auto-claim, call failure policy, flow priority, process SLA / description / version / variable tags.
- Scale: indexed lookups, per-instance lock across replicas, bounded ticks, streaming analytics, history cap.
- bpmn-sdk: round-trips all of the above; imports report anything not supported instead of dropping it silently.
- Editor controls for every new property.

## Compatibility
Existing processes, deployments, instances, timers and APIs behave as before (golden fixtures unchanged, 608 server tests green). Changes: declared-but-empty variables are `null` in scripts; the start trigger list no longer offers *condition* (warning on imports that use it).

## Known limits
Postgres push-down and the Redis lease are now verified live with separate replica processes (`npm run test:live`, plan §15); ad-hoc sequential ordering and per-instance variable size cap are not implemented; Java scripts do not see `node.metaData`.
