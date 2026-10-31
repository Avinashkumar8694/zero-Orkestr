# 09 — Deployment, Branching & Versioning

Mirrors how jBPM/Business Central manages spaces, project versions, and KIE-server containers with
aliases — expressed in a Node-native model.

## 1. Concepts

| Concept | Meaning | jBPM analog |
|---------|---------|-------------|
| **Branch** | A named line of development on a workflow | BC space branch (Git) |
| **Version** | An immutable snapshot of the engine JSON on a branch | BC project version / commit |
| **Deployment** | A frozen, runnable copy of a published version + env | KIE-server container (kjar) |
| **Tag** | A label on a deployment (`dev`, `prod`, `v1.2.0`) | Container alias / label |
| **Environment** | A tag namespace with exactly one **active** deployment | KIE alias resolving to one container |
| **Active pointer** | Which deployment serves a given environment now | The alias's current target |

## 2. Branching

```
main:      v1 ── v2 ── v3 ─────────── v4
                   \
feature/sms:        f1 ── f2
```
- Every workflow starts with a `main` branch and `v1` (draft).
- `POST /branches` forks a **new branch** from a chosen `fromVersionId` (records `forkedFromVersionId`).
- A branch's `headVersionId` tracks its latest version.
- **Protected branches** (e.g. `main`) can require the version be published via review (policy hook).
- **Merge (v1)** = *copy-forward*: create a new version on the target branch whose engine JSON equals
  the source version (optionally after a manual diff resolve). No automatic 3-way merge in v1; the
  diff view (below) makes conflicts explicit.

## 3. Versioning

- Versions are numbered **monotonically per branch** (1,2,3,…) with an optional human `label`.
- A **draft** version is mutable (each editor save overwrites the draft's engine JSON).
- **Publishing** (`POST /versions/:id/publish`) freezes it (`state:'published'`) and opens a new draft
  as the branch head (so authors always edit a draft, never a published version).
- **Diff** (`GET /versions/:a/diff/:b`) computes a structural delta: added/removed/changed nodes,
  edges, variables, and per-node property changes. Used for review and for merge decisions.
- **Lineage** via `parentVersionId` enables "history" and rollback of authoring.

## 4. Deployment lifecycle

```
Version(published) ──deploy──▶ Deployment(inactive)
                                   │  attach tags: ["staging"]
                                   ▼
                              activate(environment="staging")
                                   │  (atomically deactivates the previous active in "staging")
                                   ▼
                              Deployment(active)  ◀── instances start here
                                   │
              promote to "prod" ───┤  (deploy same version to prod OR retag + activate)
                                   ▼
                              rollback ── activate an earlier deployment in the environment
                                   │
                              undeploy / archive
```

### Rules
- **Project-Level Deployments**: Deployments operate strictly at the **Project level**, never per individual process. When a deployment is created, the entire `EngineProject` snapshot — containing all constituent processes, call activities, shared variables, DRL rulesets, DMN decision models, and forms — is packaged and tagged together under a unified project version. This prevents version skew and broken cross-process dependencies.
- A deployment is an **immutable snapshot**: it copies the version's engine JSON + resolved env, so it
  keeps running even if the source version/branch is later changed or deleted.
- **Exactly one active** deployment per `(workflowId, environment)`. Activating B deactivates A in the
  same environment — done in a single transaction; emits `deployment.activated`.
- **Starting an instance** resolves the target: `POST /instances { workflowId, environment, processId? }` →
  the active deployment for that environment; or `{ deploymentId, processId? }` to pin a specific one.
- **Running instances are not migrated** on activation — they finish on the deployment they started on
  (like KIE containers). New instances use the new active deployment.
- **Undeploy** sets `inactive` (cannot start new instances; existing continue). **Archive** hides it.

### Tags
- Free-form; two conventional uses: **environment tags** (`dev`/`staging`/`prod` — drive the active
  pointer) and **release tags** (`v1.2.0` — human identification).
- The **deployment management view** lists every deployment with: version/branch, tags, environment,
  active badge, deployedAt/By, instance counts, and actions (activate, promote, rollback, undeploy,
  export).

## 5. State machine (deployment.status)

```
        deploy                 activate(env)                deactivate/undeploy
  ●──────────────▶ inactive ───────────────▶ active ───────────────▶ inactive
                      │                                                  │
                      └──────────────────── archive ────────────────────┘──▶ archived
```

## 6. API surface (see [05](./05-api-spec.md) for full shapes)

```
POST   /workflows/:id/branches                 create branch (from a version)
GET    /workflows/:id/branches
POST   /branches/:id/versions                  save/create a draft version
POST   /versions/:id/publish                   freeze; open new draft
GET    /versions/:a/diff/:b                     structural diff
POST   /versions/:id/deploy                    → Deployment (inactive), body: {tags, env, environment}
POST   /deployments/:id/tags                    add/remove tags
POST   /deployments/:id/activate                activate in its environment (deactivates previous)
POST   /deployments/:id/rollback               activate a previous deployment in the environment
POST   /deployments/:id/undeploy | /archive
GET    /workflows/:id/deployments               management list (+ active flags, counts)
GET    /deployments/:id/export                  download kjar zip
```

## 7. Concurrency & integrity

- Version publish and deployment activate use an optimistic-lock (`updatedAt` check) or a store-level
  transaction (Postgres) to prevent split-brain active pointers.
- Deleting a workflow/branch/version is blocked while an **active** deployment references it (or
  cascades to archive with an explicit `force`).
