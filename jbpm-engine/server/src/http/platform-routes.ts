// Platform administration: governs the limits every workspace lives under. EVERY route here is reachable only by
// the fixed platform administrator (config.platformAdminEmail, verified SSO identity) — workspace owners/admins of
// any workspace, local IAM admins and everyone else get 403. See modules/platform/limits.ts for the model.
import { Router, type Request, type Response, type NextFunction } from 'express';
import { asyncHandler, forbidden } from '../infra/errors.ts';
import type { JwtClaims } from '../infra/auth.ts';
import { isPlatformAdmin } from '../modules/tenants/identity.ts';
import { PlatformLimitsService, maxReplicasFor } from '../modules/platform/limits.ts';
import { coordinator } from '../infra/coordinator.ts';
import { Collections } from '../domain.ts';
import type { AppContext } from '../context.ts';
import { makeContext } from '../context.ts';
import { PlanService } from '../modules/plans/plans.ts';
import { LIMIT_CATALOG } from '../modules/plans/plan-limits.ts';

export async function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = (req as any).user as JwtClaims;
    const ctx = (req as any).ctx as AppContext;
    if (!user || !(await isPlatformAdmin(ctx.store, user))) throw forbidden('Platform system administrator access required');
    next();
  } catch (e) { next(e); }
}

export function buildPlatformRoutes(): Router {
  const r = Router();
  const svc = (req: Request) => new PlatformLimitsService(((req as any).ctx as AppContext).store);
  const actor = (req: Request) => ((req as any).user as JwtClaims).email || ((req as any).user as JwtClaims).sub;

  r.get('/limits', asyncHandler(async (req, res) => res.json({ success: true, data: await svc(req).getGlobal() })));
  r.put('/limits', asyncHandler(async (req, res) => res.json({ success: true, data: await svc(req).putGlobal(req.body || {}, actor(req)) })));
  r.get('/limits/usage', asyncHandler(async (req, res) => res.json({ success: true, data: await svc(req).usage() })));
  r.get('/workspaces/:id/limits', asyncHandler(async (req, res) => res.json({ success: true, data: await svc(req).getWorkspace(req.params.id) })));
  r.put('/workspaces/:id/limits', asyncHandler(async (req, res) => res.json({ success: true, data: await svc(req).putWorkspace(req.params.id, req.body || {}, actor(req)) })));

  // ---- cluster: which replicas are alive and which of them serve each workspace right now ----
  r.get('/cluster', asyncHandler(async (req, res) => {
    const co = coordinator();
    const store = ((req as any).ctx as AppContext).store;
    const tenants = await store.repo<{ id: string; name?: string; slug?: string }>(Collections.tenants).list();
    const workspaces = [];
    for (const t of tenants) {
      const holders = await co.holders(t.id);
      const max = await maxReplicasFor(store, t.id);
      if (holders.length || max) workspaces.push({ workspaceId: t.id, name: t.name, maxReplicas: max || null, holders, requestsInFlight: await co.inUse('req', t.id) });
    }
    res.json({ success: true, data: { backend: co.kind, shared: co.shared, thisReplica: co.replicaId, replicas: await co.replicas(), workspaces } });
  }));

  // ---- plans: the commercial layer. Every limit is enforced; -1 = unlimited. ----
  const plans = (req: Request) => new PlanService(((req as any).ctx as AppContext).store);
  r.get('/plans', asyncHandler(async (req, res) => res.json({ success: true, data: { plans: await plans(req).list(), catalog: LIMIT_CATALOG } })));
  r.post('/plans', asyncHandler(async (req, res) => {
    const out = await plans(req).create(req.body || {}, actor(req));
    await ((req as any).ctx as AppContext).audit({ actor: actor(req), kind: 'platform.plan.created', data: { plan: out.key, status: out.status } });
    res.status(201).json({ success: true, data: out });
  }));
  r.put('/plans/:key', asyncHandler(async (req, res) => {
    const out = await plans(req).update(req.params.key, req.body || {}, actor(req));
    await ((req as any).ctx as AppContext).audit({ actor: actor(req), kind: 'platform.plan.updated', data: { plan: req.params.key, changed: Object.keys(req.body || {}) } });
    res.json({ success: true, data: out });
  }));
  r.delete('/plans/:key', asyncHandler(async (req, res) => {
    await plans(req).remove(req.params.key, actor(req));
    await ((req as any).ctx as AppContext).audit({ actor: actor(req), kind: 'platform.plan.deleted', data: { plan: req.params.key } });
    res.status(204).end();
  }));
  // put a workspace on a plan / extend a trial: { plan, planExpiresAt? | extendDays? }
  r.put('/workspaces/:id/plan', asyncHandler(async (req, res) => {
    const t = await plans(req).assign(req.params.id, String(req.body?.plan || ''), { planExpiresAt: req.body?.planExpiresAt, extendDays: req.body?.extendDays });
    await makeContext({ store: ((req as any).ctx as AppContext).store, tenantId: t.id }).audit({ actor: actor(req), kind: 'platform.workspace-plan.updated', data: { plan: t.plan, planExpiresAt: t.planExpiresAt } });
    res.json({ success: true, data: { id: t.id, plan: t.plan, planExpiresAt: t.planExpiresAt } });
  }));
  return r;
}
