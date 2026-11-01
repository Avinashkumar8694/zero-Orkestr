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

## System administrator controls
- **Script parallelism** (pool size, queue length, overflow mode) now defaults to **1** and is visible and editable by system administrators only. It is gone from the workspace settings screen, the plan usage page, the public plans and the workspace settings API; a workspace admin who tries to set it gets `403`. Plan caps (`concurrentScripts`) still apply and stay editable in the platform screens.
- **Delegating it:** the system administrator can switch *Workspace admins can manage script settings* on globally (Global caps tab) or per workspace (Show and allow / Hide / Inherit in the workspace override). When allowed, that workspace's admins see and change pool size, queue and overflow, always within the global and per-workspace caps; the plan page then shows the plan's script cap too. Public plans never advertise it.
- **Not the same as replicas:** how many replicas serve a workspace is the separate *Serving replicas* limit (plan `maxReplicas` and the global cap, coordinated through Redis). Script parallelism is how many scripts run at once, in total, for the workspace; with several replicas the pool is split between them.
- **Who is a system administrator** is now data, not just the configured e-mail: on Postgres a real `system_admins` table (`email`, boolean `enabled`, `note`); elsewhere the `systemAdmins` collection. Set `enabled = true` for any verified e-mail and they are an administrator within about 5 seconds, no restart; untick to revoke. The configured `PLATFORM_ADMIN_EMAIL` is always one and is seeded into the table at start.
  ```sql
  UPDATE system_admins SET enabled = true WHERE email = 'someone@company.com';   -- or INSERT a row
  ```
- **Serving replicas** (plan `maxReplicas` and the global / per-workspace cap) is visible to system administrators only. It is removed from workspace settings, plan usage and public plans, and unlike the script settings it cannot be delegated.
