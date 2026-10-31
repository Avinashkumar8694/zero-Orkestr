# Workflow Engine — Usage Documentation

This folder is the **user/operator-facing** documentation set: how to install, configure, and use the
engine and its Angular builder. It is separate from `../` (the numbered `01-`…`17-` documents), which
are the internal architecture/design specs written during the build — read those if you're modifying
the engine itself; read this folder if you're *running* or *using* it.

## Guides

| # | Document | Covers |
|---|---|---|
| 1 | [Getting started](01-getting-started.md) | Prerequisites, install, first run (file store and Postgres), first login |
| 2 | [Configuration reference](02-configuration.md) | Every environment variable, and every System Settings field (incl. quotas) |
| 3 | [Authentication & authorization](03-authentication-and-authorization.md) | Login, JWT, roles, permissions, groups, task-level segregation of duties |
| 4 | [Projects & processes](04-projects-and-processes.md) | Folders, projects, branches, versions/drafts, publish, the process canvas |
| 5 | [Deployments & environments](05-deployments-and-environments.md) | Deploy, activate, tag, rollback, undeploy, archive |
| 6 | [Running & monitoring instances](06-running-and-monitoring-instances.md) | Start, signal, suspend/resume/abort, retry, variables, diagram, history |
| 7 | [Human tasks](07-human-tasks.md) | Task inbox, claim/complete/skip, forms, comments, SLA |
| 8 | [Jobs, timers & scheduling](08-jobs-timers-and-scheduling.md) | Durable timers, cron/cycle starts, the Jobs & Timers screen |
| 9 | [Execution errors, audit & notifications](09-execution-errors-audit-and-notifications.md) | The Execution Errors queue, the Audit Log, in-app notifications |
| 10 | [Security & quotas](10-security-and-quotas.md) | Rate limits, per-tenant quotas, the script sandbox, SSRF protection, secrets |
| 11 | [Importing & exporting real jBPM](11-importing-and-exporting-jbpm.md) | kjar import, Java-dialect scripts, DMN/DRL recovery, export back to a `.bpmn2` project |
| 12 | [Reports & analytics](12-reports-and-analytics.md) | The Reports page: process, task, and SLA views |
| 13 | [Multi-version deploy sequence](13-multi-version-deploy-sequence.md) | Full request/response trace: deploying the same project twice, one instance per version, then fetching tasks and signals — plus exactly when each identifier (`workflowId`, `versionId`, `deploymentId`, `instanceId`) is generated |
| 14 | [Workflow instance management](14-workflow-instance-management.md) | Dynamic instance management, variable mutation policies, retry behaviors, and state transitions |
| 15 | [JavaScript & Flow Variables Cheat Sheet](15-javascript-and-flow-variables-cheatsheet.md) | Complete reference: sandbox globals, bare variables, `vars`, `instance` API, condition expressions, HTTP exit scripts, and data mappings |
| 16 | [Java & Imported Script Reference Manual](16-java-and-imported-script-reference.md) | JVM sidecar execution, `kcontext` API, Jackson JSON parsing, collections, and Java condition expressions for imported jBPM projects |
| 17 | [Hierarchical Error Handling & Environment Variables Guide](17-error-handling-and-environment-guide.md) | 4-tier error resolution hierarchy, local boundary vs. project global error handler, repair-and-resume strategies, circuit breakers, and project environment variables (`env`) |
| 18 | [Nodes & Assets Production Verification Checklist](18-nodes-and-assets-production-verification-checklist.md) | Exhaustive verification checklist for all 16 BPMN node types and 10 asset kinds, edge-case coverage, and high-concurrency stress performance report |

## Reference

- **[Node reference](nodes/README.md)** — one document per node type (17 total): what it does, its
  fields, its runtime behavior, and a worked example. Use this when building or debugging a process.
- **[Asset reference](assets/README.md)** — one document per asset kind (10 total): forms, DRL
  rulesets, DMN decisions, guided tables, decision trees, scorecards, enumerations, data types,
  messages, and test scenarios.

## How to use this set

If you're new, read documents 1–3 in order, then skim the node reference once while building your
first process. Everything else is a lookup reference — come back to it when you hit that feature.
