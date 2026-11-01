# jBPM Engine (Node.js) — Documentation

A **fully-featured, Node.js-native BPM engine with a visual workflow builder UI**, built on top of
[`@fabrixly/bpmn-sdk`](../../bpmn-sdk). It authors processes in the SDK's clean *engine (nodejs)*
JSON model, executes them in a Node token-based interpreter, manages **deployments with branching +
per-branch versioning + deployment tags**, exposes **per-instance execution details with the live
executing flow**, and can **export any workflow as a deployable jBPM (Business Central) kjar**.

> This `docs/` folder is written **before** implementation and gates it. Read it in order; the
> [checklist](./10-checklist.md) and [roadmap](./11-roadmap.md) drive the build.

## Vision

Give business users the jBPM/Business Central authoring & operations experience — palette, canvas,
properties panel, deployments, running instances, execution audit — but running entirely on Node.js,
with zero Java/KIE server required, and a one-click escape hatch to export to real jBPM when needed.

## Documents

| # | Doc | What it covers |
|---|-----|----------------|
| — | [README](./README.md) | This index + vision + stack |
| 01 | [Requirements](./01-requirements.md) | Functional + non-functional requirements, personas, scope |
| 02 | [Features](./02-features.md) | Feature catalog mapped to jBPM capabilities |
| 03 | [Architecture](./03-architecture.md) | Technical design, modules, layering, data flow |
| 04 | [Data Model](./04-data-model.md) | Entities: workflow, branch, version, deployment, tag, instance, task |
| 05 | [API Spec](./05-api-spec.md) | REST + WebSocket contract |
| 06 | [UI Spec](./06-ui-spec.md) | Header / footer / sidenav / canvas / palette / properties panel |
| 07 | [Security](./07-security.md) | AuthN/Z, tenancy, secrets, sandboxing, threat model |
| 08 | [Execution Engine](./08-execution-engine.md) | Token semantics, node handlers, timers, persistence |
| 09 | [Deployment, Branching & Versioning](./09-deployment-branching-versioning.md) | Branch/version/tag model + lifecycle |
| 10 | [Checklist](./10-checklist.md) | Implementation checklist (tracked) |
| 11 | [Roadmap](./11-roadmap.md) | Phased delivery plan |
| 12 | [Validation Rules](./12-validation-rules.md) | Process validation rules (jBPM-equivalent) + enforcement |
| 13 | [Projects & Operations](./13-projects-and-operations.md) | Project→processes model, assets, per-version deploy, cron, instances |
| 14 | [Error Handling](./14-error-handling.md) | Error Catch node (boundary + global), taxonomy, runtime, export |
| 15 | [Scripting & jBPM export](./15-scripting-and-jbpm-export.md) | How JavaScript scripts/conditions map to exported jBPM |
| 16 | [jBPM Parity & Capability](./16-jbpm-parity.md) | Feature-by-feature comparison to jBPM + test evidence (28 unit + 12 live) |
| 18 | [Async execution & node properties](./18-async-and-node-properties.md) | Background starts, Is Async nodes, SLA, user-task deadlines, jBPM property gap analysis |

## Tech stack (decided)

| Layer | Choice | Why |
|-------|--------|-----|
| Backend | **Node 20 + TypeScript + Express** | Small, ubiquitous, matches SDK toolchain |
| Authoring model | **`@fabrixly/bpmn-sdk` engine JSON** | Already the project's source of truth; converts to/from BPMN |
| Execution | **Custom Node token interpreter** | Runs in Node; reuses SDK rule/DMN/tree/scorecard evaluators |
| Persistence | **File store now, Postgres later** (repository interface) | Zero-setup dev; swappable in prod |
| Realtime | **WebSocket (ws)** | Live instance/flow updates to the UI |
| Frontend | **Angular 18 (standalone) + TypeScript** | Requested; enterprise-grade, batteries-included |
| Canvas | **@foblex/flow** (Angular flow/diagram lib) | Purpose-built node/edge editor matching the reference UI; fallback: custom SVG + Angular CDK drag-drop |
| UI state | **Angular signals + injectable stores** (NgRx optional) | Native, minimal ceremony |
| UI kit | **Angular CDK** (overlay, drag-drop, a11y) + hand-rolled components | Matches the exact reference look without a heavy theme |
| Export | **SDK `fromEngineProject` + `writeProject`** | One-click kjar export |

## Repository layout

```
jbpm-engine/
  docs/            ← you are here
  server/          ← backend (Express API + execution engine + stores)
  app/             ← frontend (Angular workflow builder + operations console)
  package.json     ← npm workspaces root (server, app)
```

## Quick start (once implemented)

```bash
cd jbpm-engine
npm install                 # installs server + app workspaces
npm run dev                 # server on :4000, app (Angular) on :4200
```
