// Analytics Builder routes — see docs/19-analytics-builder.md. Designing needs `analytics:query`; calling a published API needs
// `query:read`; on top of that every source a query reads has its own permission (enforced inside AnalyticsService, with the
// caller's real permissions in THIS workspace — never a claim from the request body).
import { Router } from 'express';
import type { Request } from 'express';
import { asyncHandler } from '../../infra/errors.ts';
import { ctxOf, actorOf } from '../route-context.ts';
import { requirePermission, callerPermissions } from '../auth-middleware.ts';
import { resolveWorkflowServiceStore } from '../../workflow-service/store/index.ts';
import { AnalyticsService, type Caller } from '../../analytics/service.ts';

const perm = requirePermission;
const svc = (req: Request) => new AnalyticsService(ctxOf(req), resolveWorkflowServiceStore(ctxOf(req).store));
const caller = async (req: Request): Promise<Caller> => ({ actor: actorOf(req), permissions: await callerPermissions(req) });

export function buildAnalyticsBuilderRoutes(): Router {
  const r = Router();
  const B = '/analytics-builder';

  r.get(`${B}/catalog`, perm('analytics:query'), asyncHandler(async (req, res) => res.json(svc(req).catalog(await caller(req)))));
  r.post(`${B}/preview`, perm('analytics:query'), asyncHandler(async (req, res) =>
    res.json(await svc(req).preview(req.body?.query, req.body?.params, await caller(req)))));

  r.get(`${B}/apis`, perm('analytics:query'), asyncHandler(async (req, res) => res.json({ items: await svc(req).list(await caller(req)) })));
  r.post(`${B}/apis`, perm('analytics:query'), asyncHandler(async (req, res) => res.status(201).json(await svc(req).create(req.body, await caller(req)))));
  r.get(`${B}/apis/:id`, perm('analytics:query'), asyncHandler(async (req, res) => res.json(await svc(req).get(req.params.id, await caller(req)))));
  r.put(`${B}/apis/:id`, perm('analytics:query'), asyncHandler(async (req, res) => res.json(await svc(req).update(req.params.id, req.body, await caller(req)))));
  r.delete(`${B}/apis/:id`, perm('analytics:query'), asyncHandler(async (req, res) => { await svc(req).remove(req.params.id, await caller(req)); res.status(204).end(); }));

  // call a published analytics API by its slug: parameters in the query string (GET) or the JSON body (POST)
  const run = asyncHandler(async (req, res) => {
    const given = req.method === 'GET' ? { ...(req.query as Record<string, unknown>) } : { ...(req.body?.params ?? req.body ?? {}) };
    res.json(await svc(req).run(req.params.slug!, given, 'http', await caller(req)));
  });
  r.get('/analytics/run/:slug', perm('query:read'), run);
  r.post('/analytics/run/:slug', perm('query:read'), run);

  return r;
}
