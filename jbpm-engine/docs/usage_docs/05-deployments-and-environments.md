# Deployments & Environments

## What a deployment is

A **deployment** binds one published Version to one **environment** (a free-text label — `prod`,
`staging`, `qa`, anything your org uses) plus deployment-specific `env` variables (e.g.
`INTEGRATION_LAYER_URL` for that environment's real integration layer — see the
[HTTP / Service Task](nodes/http-service.md) doc). Only one deployment per (workflow, environment) can
be **active** at a time — that's what `Instance.start()` resolves against when you don't pass an
explicit `deploymentId`.

`POST /versions/:id/deploy` (`workflow:deploy`) — requires the version to already be published.

## Activate

A freshly created deployment is not automatically the active one for its environment. **Activate**
(`workflow:deploy`) makes it so — deactivating whatever was previously active for that same
(workflow, environment) pair. Activating also syncs any **timer/cron start events** on this process
(see [Jobs, timers & scheduling](08-jobs-timers-and-scheduling.md)): the previous active deployment's
start-timers are cancelled, and this one's are scheduled.

## Tags

Freeform labels (`POST /deployments/:id/tags`, add/remove) — e.g. `v2.3`, `hotfix`, `approved-by-qa`.
Purely descriptive, no execution effect; useful for finding a specific deployment later or for your own
release process conventions.

## Rollback

`POST /deployments/:id/rollback` with `{ environment, toDeploymentId }` — re-activates an older
deployment for that environment. Running instances already on the deployment you're rolling back
*from* are unaffected; only new starts (and the environment's active-deployment pointer) change.

## Undeploy / Archive

- **Undeploy**: deactivates without deleting the deployment record — instances already running
  continue; no new instance can start against it while inactive (`InstanceService.start` rejects with
  `cannot start on an archived deployment` for archived ones, and simply won't be the resolved
  "active" deployment for undeployed ones).
- **Archive**: a stronger, typically final state — the deployment can no longer be started against at
  all, even by explicit `deploymentId`.

## Project-Level Deployments

Deployments in this system are executed at the **Project level**, rather than process-by-process:
- Triggered directly from the **Project Shell Header** (`Deploy Project` button).
- Packaging bundles the whole project (all processes, sub-processes, DRL rules, DMN models, forms, and variables) into an immutable multi-process snapshot.
- Avoids version drift across interdependent processes (such as parent processes invoking child processes via `call` activities).
- The deployment modal prompts for:
  - **Environment**: e.g. `dev`, `sit`, `uat`, `prod`.
  - **Tags**: Descriptive release labels (e.g. `release-2026.1`, `hotfix-claim-calc`).
  - **Auto-Activate**: Whether to immediately make this deployment the active target for the chosen environment.

## Multiple processes per project

A project (and therefore a Version, and therefore a Deployment) can contain more than one process.
When starting an instance, pass `processId` to pick which one — omitted, the engine picks the version's
first process. Both Process instances and Case instances explicitly track which process within the project is being executed.

## Export

`GET /deployments/:id/export` and `.../definitions` return the deployment's engine JSON — useful for
diffing what's actually running against your source project, or for archival outside this system.
