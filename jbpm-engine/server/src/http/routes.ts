// All REST routes (see docs/05-api-spec.md). One assembled router to keep the wiring in one place.
// A per-request AppContext + actor are attached by contextMiddleware (see app.ts); requireAuth (also
// app.ts) verifies the caller's JWT before anything here runs. Each route additionally declares the
// permission it needs via requirePermission(action) — see http/auth-middleware.ts and
// modules/iam/service.ts's DEFAULT_ROLES for what grants what.
import { Router } from 'express';
import type { Request } from 'express';
import { asyncHandler } from '../infra/errors.ts';
import type { AppContext } from '../context.ts';
import { WorkflowService } from '../modules/workflows/service.ts';
import { FolderService } from '../modules/folders/service.ts';
import { BranchService } from '../modules/branches/service.ts';
import { VersionService } from '../modules/versions/service.ts';
import { DeploymentService } from '../modules/deployments/service.ts';
import { InstanceService } from '../modules/instances/service.ts';
import { TaskService } from '../modules/tasks/service.ts';
import { ProcessService } from '../modules/processes/service.ts';
import { QueryService } from '../modules/queries/service.ts';
import { AssetsService } from '../modules/assets/service.ts';
import { IamService } from '../modules/iam/service.ts';
import { ErrorService } from '../modules/errors/service.ts';
import { AuditService } from '../modules/audit/service.ts';
import { NotificationService } from '../modules/notifications/service.ts';
import { effectiveLimitsFor } from '../modules/platform/limits.ts';
import { SettingsService } from '../modules/settings/service.ts';
import { planUsageFor } from '../modules/plans/plans.ts';
import { TimerService } from '../modules/timers/service.ts';
import { NODE_DEFS, NODE_DEF_BY_TYPE, CATEGORIES } from '../engine/nodes/index.ts';
import { exportKjar, validateJbpmExport } from '../modules/export/service.ts';
import { ImportService } from '../modules/import/service.ts';
import { ValidationService } from '../modules/validation/service.ts';
import { openapiSpec, swaggerHtml } from './openapi.ts';
import { buildWorkflowInstanceRoutes } from './routes/workflow-instances.ts';
import { buildTeamRoutes } from './team-routes.ts';
import { hub } from '../infra/ws-hub.ts';
import { requirePermission, callerPermissions } from './auth-middleware.ts';
import { PERMISSION_CATALOG } from '../modules/iam/permissions.ts';
import { rateLimit } from './rate-limit.ts';

const ctxOf = (req: Request): AppContext => (req as any).ctx;
const actorOf = (req: Request): string => (req as any).actor;
const emit = hub.engineEmit;
const perm = requirePermission;
/** TaskService for this request; workspace owners/admins and the platform admin may act on tasks held by others. */
const taskSvc = (req: Request, e?: (ev: any) => void) => {
  const svc = new TaskService(ctxOf(req), e);
  const a = (req as any).access as { platformAdmin?: boolean; member?: { role: string } } | undefined;
  svc.adminOverride = !!a && (!!a.platformAdmin || a.member?.role === 'owner' || a.member?.role === 'admin');
  return svc;
};
// per-user (post-auth) limits on the routes most likely to be hammered by a runaway script or abused
// for DoS — starting instances (cheapest to spam, so the tightest per-second ceiling), and the
// heavier deploy/import operations (already permission-gated, but still worth bounding).
const startLimiter = rateLimit({ windowMs: 60_000, max: 120 });
const deployLimiter = rateLimit({ windowMs: 60_000, max: 20 });
const importLimiter = rateLimit({ windowMs: 60_000, max: 20 });

export function buildRoutes(): Router {
  const r = Router();

  // --- API docs: OpenAPI spec + Swagger UI (jBPM-style) — any authenticated caller ---
  r.get('/openapi.json', (_req, res) => res.json(openapiSpec));
  r.get('/docs', (_req, res) => res.type('html').send(swaggerHtml));

  // --- catalog: the UI gets the node list + per-node config (palette, ports, property schema) here ---
  r.get('/catalog/nodes', (_req, res) => res.json({
    categories: CATEGORIES,
    nodes: NODE_DEFS.flatMap((d) => d.palette),                                  // palette tiles
    schemas: Object.fromEntries(NODE_DEFS.map((d) => [d.engineType, d.schema])), // engineType → property form
    ports: Object.fromEntries(NODE_DEFS.map((d) => [d.engineType, d.ports])),    // engineType → { in, out }
    diagram: Object.fromEntries(NODE_DEFS.map((d) => [d.engineType, d.diagram])),       // engineType → { icon, color, shape } for diagram rendering
    typeLabels: Object.fromEntries(NODE_DEFS.map((d) => [d.engineType, d.typeLabel])),   // engineType → neutral display name
  }));
  r.get('/catalog/nodes/:engineType', (req, res) => {
    const def = NODE_DEF_BY_TYPE[req.params.engineType];
    if (!def) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'node type not found' } });
    res.json(def);
  });
  // Every process a 'call'/'forEach' node can actually resolve at runtime: any process on any
  // currently-active deployment, tenant-wide (same project or a different one) — exactly matching
  // instances/service.ts's own resolveCalled, so nothing shows up here that would fail at run time.
  // Backs the 'processRef' widget's picker and the 'called' variable-mapping source.
  r.get('/catalog/processes', perm('workflow:view'), asyncHandler(async (req, res) => {
    const ctx = ctxOf(req);
    const deployments = await new DeploymentService(ctx).list({ status: 'active' });
    const wfNames = new Map<string, string>();
    const wfSvc = new WorkflowService(ctx);
    const items: { id: string; name: string; workflowId: string; workflowName: string; environment: string; vars: { name: string; type?: string }[] }[] = [];
    for (const dep of deployments) {
      if (!wfNames.has(dep.workflowId)) {
        const wf = await wfSvc.get(dep.workflowId).catch(() => null);
        wfNames.set(dep.workflowId, wf?.name || dep.workflowId);
      }
      for (const p of dep.engine?.processes || []) {
        items.push({ id: p.id!, name: p.name || p.id!, workflowId: dep.workflowId, workflowName: wfNames.get(dep.workflowId)!, environment: dep.environment, vars: (p as any).vars || [] });
      }
    }
    res.json({ items });
  }));

  // --- validation (validate an in-progress engine process, no save) — any authenticated caller ---
  r.post('/validate', asyncHandler(async (req, res) => res.json(await new ValidationService().validate((req.body?.engine?.processes?.[0]) || req.body?.process || req.body))));

  // --- import a jBPM kjar (file map) as a new project ---
  r.post('/import/jbpm', perm('workflow:edit'), importLimiter, asyncHandler(async (req, res) => res.status(201).json(await new ImportService(ctxOf(req)).importKjar(req.body?.files, req.body?.name, actorOf(req)))));
  // Import straight to a running deployment, no manual Publish/Deploy detour — jBPM's own
  // "deploy this artifact" ops flow. Requires deploy permission (a superset of the plain import above).
  r.post('/import/jbpm/deploy', perm('workflow:deploy'), importLimiter, asyncHandler(async (req, res) => res.status(201).json(await new ImportService(ctxOf(req)).importAndDeploy(
    req.body?.files, req.body?.name, actorOf(req),
    { environment: req.body?.environment || 'prod', tags: req.body?.tags, env: req.body?.env },
  ))));

  // --- folders (organize the Projects page into a tree; purely presentational) ---
  r.get('/folders', perm('workflow:view'), asyncHandler(async (req, res) => res.json({ items: await new FolderService(ctxOf(req)).list() })));
  r.post('/folders', perm('workflow:edit'), asyncHandler(async (req, res) => res.status(201).json(await new FolderService(ctxOf(req)).create(req.body, actorOf(req)))));
  r.get('/folders/:id', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new FolderService(ctxOf(req)).get(req.params.id))));
  r.patch('/folders/:id', perm('workflow:edit'), asyncHandler(async (req, res) => res.json(await new FolderService(ctxOf(req)).update(req.params.id, req.body, actorOf(req)))));
  r.delete('/folders/:id', perm('workflow:edit'), asyncHandler(async (req, res) => { await new FolderService(ctxOf(req)).delete(req.params.id); res.status(204).end(); }));

  // --- workflows ---
  r.get('/workflows', perm('workflow:view'), asyncHandler(async (req, res) => res.json({ items: await new WorkflowService(ctxOf(req)).list() })));
  r.post('/workflows', perm('workflow:edit'), asyncHandler(async (req, res) => res.status(201).json(await new WorkflowService(ctxOf(req)).create(req.body, actorOf(req)))));
  r.get('/workflows/:id', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new WorkflowService(ctxOf(req)).get(req.params.id))));
  r.patch('/workflows/:id', perm('workflow:edit'), asyncHandler(async (req, res) => res.json(await new WorkflowService(ctxOf(req)).update(req.params.id, req.body, actorOf(req)))));
  r.delete('/workflows/:id', perm('workflow:edit'), asyncHandler(async (req, res) => { await new WorkflowService(ctxOf(req)).archive(req.params.id, actorOf(req)); res.status(204).end(); }));
  r.put('/workflows/:id/permissions', perm('workflow:edit'), asyncHandler(async (req, res) => res.json(await new WorkflowService(ctxOf(req)).setPermissions(req.params.id, req.body, actorOf(req)))));
  r.put('/workflows/:id/variables', perm('workflow:edit'), asyncHandler(async (req, res) => res.json(await new WorkflowService(ctxOf(req)).setVariables(req.params.id, req.body, actorOf(req)))));

  // --- processes within a project ---
  r.get('/workflows/:id/processes', perm('workflow:view'), asyncHandler(async (req, res) => res.json({ items: await new ProcessService(ctxOf(req)).list(req.params.id) })));
  r.post('/workflows/:id/processes', perm('workflow:edit'), asyncHandler(async (req, res) => res.status(201).json(await new ProcessService(ctxOf(req)).add(req.params.id, req.body?.name, actorOf(req)))));
  r.get('/workflows/:id/processes/:pid', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new ProcessService(ctxOf(req)).getProcess(req.params.id, req.params.pid))));
  r.put('/workflows/:id/processes/:pid', perm('workflow:edit'), asyncHandler(async (req, res) => { await new ProcessService(ctxOf(req)).saveProcess(req.params.id, req.params.pid, req.body?.process || req.body, actorOf(req)); res.json({ ok: true }); }));
  r.patch('/workflows/:id/processes/:pid', perm('workflow:edit'), asyncHandler(async (req, res) => { await new ProcessService(ctxOf(req)).rename(req.params.id, req.params.pid, req.body?.name, actorOf(req)); res.json({ ok: true }); }));
  r.delete('/workflows/:id/processes/:pid', perm('workflow:edit'), asyncHandler(async (req, res) => { await new ProcessService(ctxOf(req)).remove(req.params.id, req.params.pid, actorOf(req)); res.status(204).end(); }));

  // --- project engine + assets ---
  r.get('/workflows/:id/engine', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new ProcessService(ctxOf(req)).getEngine(req.params.id))));
  r.get('/workflows/:id/export-engine', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new ProcessService(ctxOf(req)).getEngine(req.params.id))));
  r.get('/workflows/:id/jbpm-compatibility', perm('workflow:view'), asyncHandler(async (req, res) => {
    const engine = await new ProcessService(ctxOf(req)).getEngine(req.params.id);
    res.json(validateJbpmExport(engine));
  }));
  r.get('/workflows/:id/assets', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new AssetsService(ctxOf(req)).list(req.params.id))));
  r.post('/workflows/:id/assets', perm('workflow:edit'), asyncHandler(async (req, res) => res.status(201).json(await new AssetsService(ctxOf(req)).add(req.params.id, req.body?.kind, req.body?.name, actorOf(req), req.body?.fields))));
  r.get('/workflows/:id/assets/:kind/:name', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new AssetsService(ctxOf(req)).get(req.params.id, req.params.kind, req.params.name))));
  r.patch('/workflows/:id/assets/:kind/:name', perm('workflow:edit'), asyncHandler(async (req, res) => res.json(await new AssetsService(ctxOf(req)).update(req.params.id, req.params.kind, req.params.name, req.body || {}, actorOf(req)))));
  r.post('/workflows/:id/assets/:kind/:name/test', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new AssetsService(ctxOf(req)).testAsset(req.params.id, req.params.kind, req.params.name, req.body || {}))));
  r.delete('/workflows/:id/assets/:kind/:name', perm('workflow:edit'), asyncHandler(async (req, res) => { await new AssetsService(ctxOf(req)).remove(req.params.id, req.params.kind, req.params.name, actorOf(req)); res.status(204).end(); }));

  // --- branches ---
  r.get('/workflows/:id/branches', perm('workflow:view'), asyncHandler(async (req, res) => res.json({ items: await new BranchService(ctxOf(req)).listByWorkflow(req.params.id) })));
  r.post('/workflows/:id/branches', perm('workflow:edit'), asyncHandler(async (req, res) => res.status(201).json(await new BranchService(ctxOf(req)).create(req.params.id, req.body, actorOf(req)))));
  r.get('/branches/:id', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new BranchService(ctxOf(req)).get(req.params.id))));
  r.get('/branches/:id/versions', perm('workflow:view'), asyncHandler(async (req, res) => res.json({ items: await new VersionService(ctxOf(req)).listByBranch(req.params.id) })));
  r.post('/branches/:id/versions', perm('workflow:edit'), asyncHandler(async (req, res) => res.status(201).json(await new VersionService(ctxOf(req)).saveDraft(req.params.id, req.body.engine, actorOf(req), req.body.message))));

  // --- versions ---
  r.get('/versions/:id', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new VersionService(ctxOf(req)).get(req.params.id))));
  r.post('/versions/:id/publish', perm('workflow:edit'), asyncHandler(async (req, res) => res.json(await new VersionService(ctxOf(req)).publish(req.params.id, actorOf(req), req.body?.label))));
  r.post('/versions/:id/validate', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new VersionService(ctxOf(req)).validate(req.params.id))));
  r.get('/versions/:a/diff/:b', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new VersionService(ctxOf(req)).diff(req.params.a, req.params.b))));
  r.post('/versions/:id/deploy', perm('workflow:deploy'), deployLimiter, asyncHandler(async (req, res) => res.status(201).json(await new DeploymentService(ctxOf(req)).deploy(req.params.id, req.body, actorOf(req)))));
  r.get('/versions/:id/export', perm('workflow:view'), asyncHandler(async (req, res) => {
    const v = await new VersionService(ctxOf(req)).get(req.params.id);
    res.json(exportKjar(v.engine));
  }));
  r.get('/versions/:id/export-engine', perm('workflow:view'), asyncHandler(async (req, res) => {
    const v = await new VersionService(ctxOf(req)).get(req.params.id);
    res.json(v.engine);
  }));
  r.get('/versions/:id/jbpm-compatibility', perm('workflow:view'), asyncHandler(async (req, res) => {
    const v = await new VersionService(ctxOf(req)).get(req.params.id);
    res.json(validateJbpmExport(v.engine));
  }));

  // --- deployments ---
  // cross-project listing (Deployments is a top-level page, same shape as GET /instances) —
  // workflows/:id/deployments below stays as the per-project convenience alias.
  r.get('/deployments', perm('workflow:view'), asyncHandler(async (req, res) => res.json({ items: await new DeploymentService(ctxOf(req)).list(req.query as any) })));
  r.get('/workflows/:id/deployments', perm('workflow:view'), asyncHandler(async (req, res) => res.json({ items: await new DeploymentService(ctxOf(req)).listByWorkflow(req.params.id) })));
  r.get('/deployments/:id', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new DeploymentService(ctxOf(req)).get(req.params.id))));
  r.post('/deployments/:id/tags', perm('workflow:deploy'), asyncHandler(async (req, res) => res.json(await new DeploymentService(ctxOf(req)).setTags(req.params.id, req.body, actorOf(req)))));
  r.post('/deployments/:id/activate', perm('workflow:deploy'), asyncHandler(async (req, res) => res.json(await new DeploymentService(ctxOf(req)).activate(req.params.id, actorOf(req)))));
  r.post('/deployments/:id/rollback', perm('workflow:deploy'), asyncHandler(async (req, res) => res.json(await new DeploymentService(ctxOf(req)).rollback(req.body.environment, req.body.toDeploymentId, actorOf(req)))));
  r.post('/deployments/:id/undeploy', perm('workflow:deploy'), asyncHandler(async (req, res) => res.json(await new DeploymentService(ctxOf(req)).undeploy(req.params.id, actorOf(req)))));
  r.post('/deployments/:id/archive', perm('workflow:deploy'), asyncHandler(async (req, res) => res.json(await new DeploymentService(ctxOf(req)).archive(req.params.id, actorOf(req)))));
  r.get('/deployments/:id/export', perm('workflow:view'), asyncHandler(async (req, res) => {
    const d = await new DeploymentService(ctxOf(req)).get(req.params.id);
    res.json(exportKjar(d.engine));
  }));
  r.get('/deployments/:id/definitions', perm('workflow:view'), asyncHandler(async (req, res) => {
    const d = await new DeploymentService(ctxOf(req)).get(req.params.id);
    res.json({ items: (d.engine.processes || []).map((p) => ({ id: p.id, name: p.name || p.id, nodes: (p.nodes || []).length, startable: (p.nodes || []).some((n) => n.type === 'start') })) });
  }));

  // --- instances (runtime) ---
  r.post('/instances', perm('workflow:run'), startLimiter, asyncHandler(async (req, res) => res.status(201).json(await new InstanceService(ctxOf(req), emit).start(req.body, actorOf(req)))));
  r.get('/instances', perm('workflow:view'), asyncHandler(async (req, res) => res.json({ items: await new InstanceService(ctxOf(req)).list(req.query as any) })));
  r.get('/instances/:id', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new InstanceService(ctxOf(req)).get(req.params.id))));
  r.get('/instances/:id/history', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new InstanceService(ctxOf(req)).history(req.params.id))));
  r.get('/instances/:id/diagram-state', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new InstanceService(ctxOf(req)).diagramState(req.params.id))));
  r.get('/instances/:id/graph', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new InstanceService(ctxOf(req)).graph(req.params.id))));
  r.get('/instances/:id/related', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await new InstanceService(ctxOf(req)).related(req.params.id))));
  r.post('/instances/:id/signal', perm('workflow:run'), asyncHandler(async (req, res) => res.json(await new InstanceService(ctxOf(req), emit).signal(req.params.id, req.body?.name, req.body?.payload, actorOf(req)))));
  r.post('/instances/:id/retry', perm('workflow:run'), asyncHandler(async (req, res) => res.json(await new InstanceService(ctxOf(req), emit).retry(req.params.id, req.body?.nodeId, actorOf(req)))));
  r.post('/instances/:id/suspend', perm('workflow:run'), asyncHandler(async (req, res) => res.json(await new InstanceService(ctxOf(req)).suspend(req.params.id, actorOf(req)))));
  r.post('/instances/:id/resume', perm('workflow:run'), asyncHandler(async (req, res) => res.json(await new InstanceService(ctxOf(req)).resumeInstance(req.params.id, actorOf(req)))));
  r.post('/instances/:id/abort', perm('workflow:run'), asyncHandler(async (req, res) => res.json(await new InstanceService(ctxOf(req)).abort(req.params.id, actorOf(req)))));
  r.put('/instances/:id/variables', perm('workflow:run'), asyncHandler(async (req, res) => res.json(await new InstanceService(ctxOf(req)).updateVariables(req.params.id, req.body || {}, actorOf(req)))));
  r.get('/instances/:id/variable-history', perm('workflow:view'), asyncHandler(async (req, res) => res.json({ items: await new InstanceService(ctxOf(req)).variableHistory(req.params.id, req.query.name as string | undefined) })));

  // --- tasks (task-level group/assignee/excludedOwners/businessAdmin checks happen inside TaskService
  // itself — see modules/tasks/service.ts — on top of the role-level task:manage gate here) ---
  r.get('/tasks', perm('task:manage'), asyncHandler(async (req, res) => res.json({ items: await taskSvc(req).list({ ...req.query as any, overdue: req.query.overdue === 'true' }) })));
  r.get('/tasks/:id', perm('task:manage'), asyncHandler(async (req, res) => res.json(await taskSvc(req).get(req.params.id))));
  r.post('/tasks/:id/claim', perm('task:manage'), asyncHandler(async (req, res) => res.json(await taskSvc(req).claim(req.params.id, actorOf(req)))));
  r.post('/tasks/:id/release', perm('task:manage'), asyncHandler(async (req, res) => res.json(await taskSvc(req).release(req.params.id, actorOf(req)))));
  r.post('/tasks/:id/complete', perm('task:manage'), asyncHandler(async (req, res) => res.json(await taskSvc(req, emit).complete(req.params.id, req.body?.outputs || {}, actorOf(req)))));
  r.post('/tasks/:id/skip', perm('task:manage'), asyncHandler(async (req, res) => res.json(await taskSvc(req, emit).skip(req.params.id, actorOf(req)))));
  r.post('/tasks/:id/start', perm('task:manage'), asyncHandler(async (req, res) => res.json(await taskSvc(req).start(req.params.id, actorOf(req)))));
  r.post('/tasks/:id/stop', perm('task:manage'), asyncHandler(async (req, res) => res.json(await taskSvc(req).stop(req.params.id, actorOf(req)))));
  r.post('/tasks/:id/save', perm('task:manage'), asyncHandler(async (req, res) => res.json(await taskSvc(req).saveOutputs(req.params.id, req.body?.outputs || {}, actorOf(req)))));
  r.post('/tasks/:id/delegate', perm('task:manage'), asyncHandler(async (req, res) => res.json(await taskSvc(req).delegate(req.params.id, req.body?.to, actorOf(req)))));
  r.post('/tasks/:id/forward', perm('task:manage'), asyncHandler(async (req, res) => res.json(await taskSvc(req).forward(req.params.id, { user: req.body?.user, group: req.body?.group }, actorOf(req)))));
  r.post('/tasks/:id/remind', perm('task:manage'), asyncHandler(async (req, res) => res.json(await taskSvc(req).remind(req.params.id, actorOf(req)))));
  r.patch('/tasks/:id', perm('task:manage'), asyncHandler(async (req, res) => res.json(await taskSvc(req).update(req.params.id, { priority: req.body?.priority, dueAt: req.body?.dueAt }, actorOf(req)))));
  r.get('/tasks/:id/comments', perm('task:manage'), asyncHandler(async (req, res) => res.json({ items: await taskSvc(req).listComments(req.params.id) })));
  r.post('/tasks/:id/comments', perm('task:manage'), asyncHandler(async (req, res) => res.status(201).json(await taskSvc(req).addComment(req.params.id, req.body?.body, actorOf(req)))));
  r.delete('/tasks/:id/comments/:cid', perm('task:manage'), asyncHandler(async (req, res) => { await taskSvc(req).deleteComment(req.params.id, req.params.cid, actorOf(req)); res.status(204).end(); }));
  r.get('/tasks/:id/events', perm('task:manage'), asyncHandler(async (req, res) => res.json({ items: await taskSvc(req).events(req.params.id) })));

  // --- execution errors (the operational failure queue — see modules/errors/service.ts) ---
  const errs = (req: Request) => new ErrorService(ctxOf(req));
  r.get('/errors', perm('workflow:view'), asyncHandler(async (req, res) => {
    const { type, acknowledged, limit, offset, ...rest } = req.query as Record<string, string>;
    res.json(await errs(req).list({
      ...rest,
      type: type ? (type.split(',') as any) : undefined,
      acknowledged: acknowledged === undefined ? undefined : acknowledged === 'true',
      limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined,
    }));
  }));
  r.get('/errors/summary', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await errs(req).summary())));
  r.get('/errors/:id', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await errs(req).get(req.params.id))));
  r.post('/errors/:id/ack', perm('workflow:run'), asyncHandler(async (req, res) => res.json(await errs(req).acknowledge(req.params.id, actorOf(req)))));
  r.post('/errors/ack', perm('workflow:run'), asyncHandler(async (req, res) => res.json({ results: await errs(req).acknowledgeMany(req.body?.ids || [], actorOf(req)) })));

  // --- jobs & timers (list/cancel/trigger/reschedule the durable TimerJobs) ---
  const timers = (req: Request) => new TimerService(ctxOf(req), emit);
  r.get('/jobs', perm('workflow:view'), asyncHandler(async (req, res) => res.json({ items: await timers(req).list(req.query as any) })));
  r.get('/jobs/:id', perm('workflow:view'), asyncHandler(async (req, res) => res.json(await timers(req).getJob(req.params.id))));
  r.post('/jobs/:id/cancel', perm('workflow:run'), asyncHandler(async (req, res) => res.json(await timers(req).cancel(req.params.id, actorOf(req)))));
  r.post('/jobs/:id/trigger', perm('workflow:run'), asyncHandler(async (req, res) => res.json(await timers(req).trigger(req.params.id, actorOf(req)))));
  r.post('/jobs/:id/reschedule', perm('workflow:run'), asyncHandler(async (req, res) => res.json(await timers(req).rescheduleJob(req.params.id, req.body?.dueAt, actorOf(req)))));

  // --- audit log (reads the trail every service writes via ctx.audit) ---
  r.get('/audit', perm('admin:iam'), asyncHandler(async (req, res) => {
    const { limit, offset, ...rest } = req.query as Record<string, string>;
    res.json(await new AuditService(ctxOf(req)).list({ ...rest, limit: limit ? Number(limit) : undefined, offset: offset ? Number(offset) : undefined }));
  }));
  r.get('/audit/facets', perm('admin:iam'), asyncHandler(async (req, res) => res.json(await new AuditService(ctxOf(req)).facets())));

  // --- notifications (always scoped to the caller — no cross-user reads) ---
  r.get('/notifications', asyncHandler(async (req, res) => res.json(await new NotificationService(ctxOf(req)).listFor(actorOf(req), { unread: req.query.unread === 'true', limit: req.query.limit ? Number(req.query.limit) : undefined }))));
  r.post('/notifications/read-all', asyncHandler(async (req, res) => res.json(await new NotificationService(ctxOf(req)).markAllRead(actorOf(req)))));
  r.post('/notifications/:id/read', asyncHandler(async (req, res) => res.json(await new NotificationService(ctxOf(req)).markRead(req.params.id, actorOf(req)))));

  // --- system settings (singleton; readable by anyone signed in, writable by admins) ---
  // `effective*` = what the script pool actually applies (quota/default clamped by SCRIPT_POOL_MAX_SIZE; workspace
  // mode vs the SCRIPT_OVERFLOW_MODE env default) — so operators can see the real limit, not just the setting.
  // the workspace's plan, its limits and what it has used (every member may look; the platform admin edits plans)
  r.get('/plan/usage', perm('team:read'), asyncHandler(async (req, res) => res.json(await planUsageFor(ctxOf(req)))));
  r.get('/settings/system', asyncHandler(async (req, res) => {
    const s = await new SettingsService(ctxOf(req)).get();
    const { effective, caps } = await effectiveLimitsFor(ctxOf(req));
    res.json({
      ...s,
      effectiveScriptConcurrency: effective.scriptPoolSize, effectiveScriptOverflowMode: effective.scriptOverflowMode,
      effectiveLimits: effective,   // what is really applied (read-only)
      limitCaps: caps,              // what this workspace may not exceed (set by the platform administrator)
    });
  }));
  r.put('/settings/system', perm('admin:iam'), asyncHandler(async (req, res) => res.json(await new SettingsService(ctxOf(req)).update(req.body || {}, actorOf(req)))));

  // --- query / task-admin / analytics (jBPM KIE-Server-style; see docs/17) ---
  const q = (req: Request) => new QueryService(ctxOf(req));
  const s = (req: Request) => (req.query.status as string | undefined);
  r.get('/query/process-definitions', perm('query:read'), asyncHandler(async (req, res) => res.json({ items: await q(req).processDefinitions() })));
  r.get('/query/process-definitions/:processId/instances', perm('query:read'), asyncHandler(async (req, res) => res.json({ items: await q(req).processInstances(req.params.processId, s(req)) })));
  r.get('/query/process-definitions/:processId/signals', perm('query:read'), asyncHandler(async (req, res) => res.json(await q(req).processSignals(req.params.processId))));
  r.get('/query/users', perm('query:read'), asyncHandler(async (req, res) => res.json({ items: await q(req).users() })));
  r.get('/query/users/:user/tasks', perm('query:read'), asyncHandler(async (req, res) => res.json({ items: await q(req).tasksForUser(req.params.user, s(req)) })));
  r.get('/query/users/:user/tasks/completed', perm('query:read'), asyncHandler(async (req, res) => res.json({ items: await q(req).tasksCompletedByUser(req.params.user) })));
  r.get('/query/groups/:group/tasks', perm('query:read'), asyncHandler(async (req, res) => res.json({ items: await q(req).tasksForGroup(req.params.group, s(req)) })));
  r.get('/query/instances/:id/tasks', perm('query:read'), asyncHandler(async (req, res) => res.json({ items: await q(req).instanceTasks(req.params.id) })));
  r.get('/query/analytics/tasks', perm('query:read'), asyncHandler(async (req, res) => res.json(await q(req).taskAnalytics())));
  r.get('/query/analytics/processes', perm('query:read'), asyncHandler(async (req, res) => res.json(await q(req).processAnalytics())));
  r.get('/query/analytics/summary', perm('query:read'), asyncHandler(async (req, res) => res.json(await q(req).summary())));
  r.get('/query/jobs', perm('query:read'), asyncHandler(async (req, res) => res.json({ items: await q(req).jobs(s(req)) })));

  // --- IAM: users, groups, roles (admin-only) ---
  const iam = (req: Request) => new IamService(ctxOf(req));
  r.get('/users', perm('admin:iam'), asyncHandler(async (req, res) => res.json({ items: await iam(req).listUsers() })));
  r.post('/users', perm('admin:iam'), asyncHandler(async (req, res) => res.status(201).json(await iam(req).createUser(req.body || {}, actorOf(req), await callerPermissions(req)))));
  r.get('/users/:id', perm('admin:iam'), asyncHandler(async (req, res) => res.json(await iam(req).getUser(req.params.id))));
  r.patch('/users/:id', perm('admin:iam'), asyncHandler(async (req, res) => res.json(await iam(req).updateUser(req.params.id, req.body || {}, actorOf(req), await callerPermissions(req)))));
  r.post('/users/:id/password', perm('admin:iam'), asyncHandler(async (req, res) => { await iam(req).setPassword(req.params.id, req.body?.password, actorOf(req)); res.status(204).end(); }));
  r.get('/groups', perm('admin:iam'), asyncHandler(async (req, res) => res.json({ items: await iam(req).listGroups() })));
  r.post('/groups', perm('admin:iam'), asyncHandler(async (req, res) => res.status(201).json(await iam(req).createGroup(req.body || {}, actorOf(req)))));
  r.patch('/groups/:id', perm('admin:iam'), asyncHandler(async (req, res) => res.json(await iam(req).updateGroup(req.params.id, req.body || {}, actorOf(req)))));
  r.put('/groups/:id/members', perm('admin:iam'), asyncHandler(async (req, res) => res.json(await iam(req).setGroupMembers(req.params.id, req.body?.userIds, actorOf(req)))));
  r.delete('/groups/:id', perm('admin:iam'), asyncHandler(async (req, res) => { await iam(req).deleteGroup(req.params.id, actorOf(req)); res.status(204).end(); }));
  r.get('/roles', perm('admin:iam'), asyncHandler(async (req, res) => res.json({ items: await iam(req).listRoles() })));
  r.get('/roles/permissions', perm('admin:iam'), asyncHandler(async (_req, res) => res.json({ items: PERMISSION_CATALOG })));
  r.post('/roles', perm('admin:iam'), asyncHandler(async (req, res) => res.status(201).json(await iam(req).createRole(req.body || {}, actorOf(req), await callerPermissions(req)))));
  r.patch('/roles/:id', perm('admin:iam'), asyncHandler(async (req, res) => res.json(await iam(req).updateRole(req.params.id, req.body?.permissions, actorOf(req), await callerPermissions(req)))));
  r.delete('/roles/:id', perm('admin:iam'), asyncHandler(async (req, res) => { const out = await iam(req).deleteRole(req.params.id, actorOf(req)); out.reset ? res.json(out) : res.status(204).end(); }));

  // --- Workflow Instance Management (Case Management) ---
  r.use(buildWorkflowInstanceRoutes());
  r.use(buildTeamRoutes());   // workspace members, invitations, ownership

  return r;
}
