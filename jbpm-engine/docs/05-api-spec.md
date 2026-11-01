# 05 — API Spec

REST over HTTP (JSON) + a WebSocket channel for realtime. Base: `/api`. All routes are tenant-scoped
via the auth token; all mutating routes enforce RBAC ([Security](./07-security.md)). Validation with
zod; errors use a consistent envelope.

## Conventions
- Auth: `Authorization: Bearer <jwt>`; token carries `tenantId`, `sub`, `roles`.
- Success: `200/201` + resource JSON. List: `{ items, total, cursor? }`.
- Error: `{ error: { code, message, details? } }` with `4xx/5xx`.
- Idempotency: `Idempotency-Key` header honored on `deploy`/`activate`/`start`.
- Time: ISO-8601 UTC.

## Auth
```
POST   /api/auth/login            { email, password } → { token, principal }
POST   /api/auth/refresh
GET    /api/auth/me               → Principal
```

## Workflows
```
GET    /api/workflows                         list (filter: q, archived)
POST   /api/workflows                         { name, key, description }
GET    /api/workflows/:id
PATCH  /api/workflows/:id                      { name?, description?, permissions?, variables? }
DELETE /api/workflows/:id                      (blocked if active deployment; ?force=archive)
GET    /api/workflows/:id/permissions
PUT    /api/workflows/:id/permissions          WorkflowPermission[]
GET    /api/workflows/:id/variables
PUT    /api/workflows/:id/variables            EngineVar[]
```

## Branches & versions
```
GET    /api/workflows/:id/branches
POST   /api/workflows/:id/branches             { name, fromVersionId? }
GET    /api/branches/:id
GET    /api/branches/:id/versions
POST   /api/branches/:id/versions              { engine: EngineProject, message? }  → draft (or updates head draft)
GET    /api/versions/:id
POST   /api/versions/:id/publish               { label? } → freezes; returns new draft head
GET    /api/versions/:a/diff/:b                → structural diff
POST   /api/versions/:id/validate              → SDK validateModel result
```

## Deployments & tags
```
POST   /api/versions/:id/deploy                { environment, tags?, env? } → Deployment(inactive)
GET    /api/workflows/:id/deployments           management list (+ active, counts)
GET    /api/deployments/:id
POST   /api/deployments/:id/tags               { add?: string[], remove?: string[] }
POST   /api/deployments/:id/activate            → activates in its environment (atomic swap)
POST   /api/deployments/:id/rollback           { toDeploymentId } → activate a previous one
POST   /api/deployments/:id/undeploy
POST   /api/deployments/:id/archive
GET    /api/deployments/:id/export              → kjar zip (application/zip)
```

## Instances (runtime)
```
POST   /api/instances                          { workflowId, environment? | deploymentId?, variables?, correlationKey?, async? } → 201 Instance (runs inline to its first wait/end)
                                               async:true or `Prefer: respond-async` → 202 + Location, runs in the background (see 18-async-and-node-properties.md)
GET    /api/instances                          filter: workflowId, status, deploymentId, correlationKey, cursor
GET    /api/instances/:id                       full detail (variables, tokens, history, error)
GET    /api/instances/:id/history               NodeVisit[] (for canvas replay/highlight)
GET    /api/instances/:id/diagram-state         { activeNodeIds, visitedNodeIds, activeEdgeIds } (live highlight)
POST   /api/instances/:id/signal               { name, payload?, correlationKey? }
POST   /api/instances/:id/message              { name, payload? }
POST   /api/instances/:id/retry                { nodeId? }   retry failed node / resume
POST   /api/instances/:id/suspend | /resume | /abort
GET    /api/instances/:id/audit                 AuditEvent[]
```

## Tasks (user tasks)
```
GET    /api/tasks                              filter: assignee=me|group|status
GET    /api/tasks/:id
POST   /api/tasks/:id/claim                    → assignee = me
POST   /api/tasks/:id/release
POST   /api/tasks/:id/complete                 { outputs } → resumes the instance
GET    /api/tasks/:id/form                       resolved form model (SDK) for rendering
```

## Assets
```
GET    /api/workflows/:id/assets                forms, rules, dmn, tables, trees, scorecards, enums
PUT    /api/workflows/:id/assets/:kind/:name    upsert an asset (engine model)
POST   /api/assets/rules/preview               { ruleset, facts } → rule-engine result (design-time test)
POST   /api/assets/dmn/preview                 { decision, inputs } → dmn-engine result
POST   /api/assets/forms/validate              { form, data } → validation result
```

## Import / export
```
POST   /api/import/jbpm                         multipart kjar/zip → { workflowId, versionId }
GET    /api/deployments/:id/export              (see above) kjar zip
GET    /api/versions/:id/export                 kjar zip for a version (not-yet-deployed)
GET    /api/versions/:id/bpmn                    process BPMN XML (text/xml)
```

## Admin
```
GET/POST/PATCH/DELETE /api/tenants
GET/POST/PATCH/DELETE /api/users
GET/POST/DELETE       /api/secrets
GET                   /api/audit                 tenant-wide audit (filter/paginate)
```

## WebSocket
```
WS  /ws?token=<jwt>
→ subscribe: { op:'sub', topics:['instance:<id>','workflow:<id>','tasks:<user>','deployments:<wf>'] }
← event:     { topic, kind, at, data }     // kinds mirror engine events (§08.8)
```
Key kinds: `instance.updated`, `node.entered`, `node.exited`, `token.moved`, `task.created`,
`task.completed`, `timer.fired`, `deployment.activated`.

## Error codes
`AUTH_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_FAILED`, `CONFLICT` (e.g. active-pointer race),
`VERSION_FROZEN`, `DEPLOY_BLOCKED`, `INSTANCE_NOT_RESUMABLE`, `SCRIPT_TIMEOUT`, `INTERNAL`.
