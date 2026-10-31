// Workflow Instance Management routes — an additive layer over the existing deployment/instance/task
// APIs (all of which remain fully usable directly). See
// docs/usage_docs/14-workflow-instance-management.md for the full walkthrough.
import { Router } from 'express';
import type { Request } from 'express';
import { asyncHandler } from '../../infra/errors.ts';
import { ctxOf, actorOf } from '../route-context.ts';
import { requirePermission } from '../auth-middleware.ts';
import { hub } from '../../infra/ws-hub.ts';
import { resolveWorkflowServiceStore } from '../../workflow-service/store/index.ts';
import { WorkflowDefinitionService } from '../../workflow-service/services/workflow-definition-service.ts';
import { WorkflowInstanceService } from '../../workflow-service/services/workflow-instance-service.ts';
import { WorkflowAnalyticsService } from '../../workflow-service/services/workflow-analytics-service.ts';
import { QueryEngineService } from '../../workflow-service/services/query-engine-service.ts';

const perm = requirePermission;
const emit = hub.engineEmit;

const wfStore = (req: Request) => resolveWorkflowServiceStore(ctxOf(req).store);
const defs = (req: Request) => new WorkflowDefinitionService(ctxOf(req), wfStore(req));
const insts = (req: Request) => new WorkflowInstanceService(ctxOf(req), wfStore(req), emit);
const analytics = (req: Request) => new WorkflowAnalyticsService(ctxOf(req), wfStore(req));
const qe = (req: Request) => new QueryEngineService(ctxOf(req), wfStore(req));

export function buildWorkflowInstanceRoutes(): Router {
  const r = Router();

  // ---- workflow definitions: the stable name -> deployment mapping ----
  r.post('/workflow-definitions', perm('workflowInstance:admin'), asyncHandler(async (req, res) =>
    res.status(201).json(await defs(req).create(req.body || {}, actorOf(req)))));
  r.get('/workflow-definitions', perm('workflowInstance:admin'), asyncHandler(async (req, res) =>
    res.json({ items: await defs(req).list() })));
  r.get('/workflow-definitions/:id', perm('workflowInstance:admin'), asyncHandler(async (req, res) =>
    res.json(await defs(req).get(req.params.id))));
  r.patch('/workflow-definitions/:id', perm('workflowInstance:admin'), asyncHandler(async (req, res) =>
    res.json(await defs(req).update(req.params.id, req.body || {}, actorOf(req)))));

  // ---- workflow instances (cases) ----
  r.post('/workflow-instances', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.status(201).json(await insts(req).create(req.body || {}, actorOf(req)))));
  r.get('/workflow-instances', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json({ items: await insts(req).list(req.query as any) })));
  r.post('/workflow-instances/search', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json({ items: await insts(req).search(req.body || {}) })));
  r.post('/workflow-instances/signal/:signalName', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json(await insts(req).broadcastSignal(req.params.signalName, req.body?.payload, actorOf(req)))));
  r.get('/workflow-instances/:id', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json(await insts(req).aggregate(req.params.id))));
  r.post('/workflow-instances/:id/close', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json(await insts(req).close(req.params.id, req.body?.resolution, actorOf(req)))));
  r.post('/workflow-instances/:id/reopen', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json(await insts(req).reopen(req.params.id, req.body?.reason, actorOf(req)))));
  r.patch('/workflow-instances/:id/status', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json(await insts(req).updateStatus(req.params.id, req.body?.status, actorOf(req)))));
  r.get('/workflow-instances/:id/data', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json(await insts(req).getData(req.params.id))));
  r.put('/workflow-instances/:id/data', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json(await insts(req).updateData(req.params.id, req.body || {}, actorOf(req)))));
  r.delete('/workflow-instances/:id/data/:key', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json(await insts(req).deleteDataKey(req.params.id, req.params.key, actorOf(req)))));
  r.get('/workflow-instances/:id/roles', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json({ roles: await insts(req).getRoles(req.params.id) })));
  r.put('/workflow-instances/:id/roles/:roleName', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json({ roles: await insts(req).setRole(req.params.id, req.params.roleName, req.body?.members || req.body?.users || [], actorOf(req)) })));
  r.delete('/workflow-instances/:id/roles/:roleName', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json({ roles: await insts(req).deleteRole(req.params.id, req.params.roleName, actorOf(req)) })));
  r.get('/workflow-instances/:id/milestones', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json({ milestones: await insts(req).getMilestones(req.params.id) })));
  r.post('/workflow-instances/:id/milestones', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.status(201).json({ milestones: await insts(req).achieveMilestone(req.params.id, req.body?.name || req.body?.milestone, actorOf(req)) })));
  r.get('/workflow-instances/:id/flags', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json(await insts(req).getFlags(req.params.id))));
  r.post('/workflow-instances/:id/flags', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.status(201).json(await insts(req).addFlag(req.params.id, req.body || {}, actorOf(req)))));
  r.delete('/workflow-instances/:id/flags/:flagId', perm('workflowInstance:manage'), asyncHandler(async (req, res) => {
    await insts(req).deleteFlag(req.params.id, req.params.flagId, actorOf(req)); res.status(204).end();
  }));
  r.get('/workflow-instances/:id/documents', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json({ documents: await insts(req).getDocuments(req.params.id) })));
  r.post('/workflow-instances/:id/documents', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.status(201).json(await insts(req).addDocument(req.params.id, req.body || {}, actorOf(req)))));
  r.delete('/workflow-instances/:id/documents/:docId', perm('workflowInstance:manage'), asyncHandler(async (req, res) => {
    await insts(req).deleteDocument(req.params.id, req.params.docId, actorOf(req)); res.status(204).end();
  }));
  r.post('/workflow-instances/:id/dynamic-tasks', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.status(201).json(await insts(req).createDynamicTask(req.params.id, req.body || {}, actorOf(req)))));
  r.post('/workflow-instances/:id/signal', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json(await insts(req).signal(req.params.id, req.body?.name, req.body?.payload, actorOf(req)))));
  r.post('/workflow-instances/:id/tasks/:taskId/decision', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json(await insts(req).decision(req.params.id, req.params.taskId, req.body?.outputs || {}, actorOf(req)))));
  r.post('/workflow-instances/:id/delegate', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json(await insts(req).delegate(req.params.id, req.body?.to, actorOf(req), req.body?.taskId))));
  r.get('/workflow-instances/:id/tasks', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json({ items: await insts(req).tasks(req.params.id) })));
  r.get('/workflow-instances/:id/signals', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json(await insts(req).signals(req.params.id))));

  // comments (dedicated table)
  r.get('/workflow-instances/:id/comments', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json({ items: await insts(req).listComments(req.params.id) })));
  r.post('/workflow-instances/:id/comments', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.status(201).json(await insts(req).addComment(req.params.id, req.body?.body, actorOf(req)))));
  r.delete('/workflow-instances/:id/comments/:commentId', perm('workflowInstance:manage'), asyncHandler(async (req, res) => {
    await insts(req).deleteComment(req.params.id, req.params.commentId, actorOf(req)); res.status(204).end();
  }));

  // audits (dedicated table) — user-addable for a custom/out-of-band entry, not only system-generated
  r.get('/workflow-instances/:id/audits', perm('workflowInstance:manage'), asyncHandler(async (req, res) =>
    res.json({ items: await insts(req).listAudits(req.params.id) })));
  r.post('/workflow-instances/:id/audits', perm('workflowInstance:manage'), asyncHandler(async (req, res) => {
    await insts(req).get(req.params.id);   // must be an instance of THIS workspace
    res.status(201).json(await insts(req).addAudit(req.params.id, actorOf(req), req.body?.kind || 'workflowInstance.note', req.body?.data));
  }));
  r.delete('/workflow-instances/:id/audits/:auditId', perm('workflowInstance:manage'), asyncHandler(async (req, res) => {
    await insts(req).deleteAudit(req.params.id, req.params.auditId, actorOf(req)); res.status(204).end();
  }));

  // ---- analytics ----
  r.get('/workflow-analytics/summary', perm('query:read'), asyncHandler(async (req, res) =>
    res.json(await analytics(req).summary(req.query as any))));
  r.get('/workflow-analytics/tat', perm('query:read'), asyncHandler(async (req, res) =>
    res.json(await analytics(req).tat(req.query as any))));
  r.get('/workflow-instances/:id/tasks/:taskId/ownership-timeline', perm('query:read'), asyncHandler(async (req, res) =>
    res.json(await analytics(req).ownershipTimeline(req.params.taskId))));
  r.get('/analytics/tasks-and-processes/:piid', perm('query:read'), asyncHandler(async (req, res) =>
    res.json(await analytics(req).tasksAndProcesses(req.params.piid))));

  // generic ad-hoc query engine + saved queries — see query-engine-service.ts's own doc comment for
  // the tenant-isolation guarantee this depends on.
  r.post('/analytics/query/run', perm('analytics:query'), asyncHandler(async (req, res) =>
    res.json(await qe(req).run(req.body || {}))));
  r.get('/analytics/queries', perm('analytics:query'), asyncHandler(async (req, res) =>
    res.json({ items: await qe(req).list(actorOf(req)) })));
  r.post('/analytics/queries', perm('analytics:query'), asyncHandler(async (req, res) =>
    res.status(201).json(await qe(req).save(req.body || {}, actorOf(req)))));
  r.post('/analytics/queries/:id/run', perm('analytics:query'), asyncHandler(async (req, res) =>
    res.json(await qe(req).runSaved(req.params.id, actorOf(req)))));
  r.delete('/analytics/queries/:id', perm('analytics:query'), asyncHandler(async (req, res) => {
    await qe(req).delete(req.params.id, actorOf(req)); res.status(204).end();
  }));

  return r;
}
