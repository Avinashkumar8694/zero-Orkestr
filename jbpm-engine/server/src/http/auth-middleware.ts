// Express auth middleware: verifies the bearer token (requireAuth — a local HS256 token OR an Identity
// Server OIDC token), resolves the caller's workspace (requireWorkspaceAccess) and checks the permission a
// route needs (requirePermission). Wired in app.ts / routes.ts. Mirrors zero-payment-ms's
// jwtAuth → tenant membership → requirePermission chain.
import type { Request, Response, NextFunction } from 'express';
import { verifyBearer, permissionGrants, type JwtClaims } from '../infra/auth.ts';
import { authRequired, forbidden } from '../infra/errors.ts';
import { Collections, type ApiKey, type Role, type Tenant, type TenantMember, type User } from '../domain.ts';
import { apiKeyFromRequest, authenticateApiKey } from '../modules/apikeys/service.ts';
import { makeContext, type AppContext } from '../context.ts';
import { DEFAULT_ROLES } from '../modules/iam/service.ts';
import { claimMemberships, isPlatformAdmin, memberMatches, membershipsOf } from '../modules/tenants/identity.ts';

/** Resolved by requireWorkspaceAccess for the request's workspace; requirePermission reads it. */
interface Access { platformAdmin: boolean; member?: TenantMember; apiKey?: ApiKey }

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('authorization') || '';
  // A bearer header is the only credential the REST API accepts. The one exception is the API documentation pages
  // (/api/docs, /api/openapi*.json): a browser cannot send headers when navigating, so `?token=` is honoured THERE ONLY —
  // elsewhere a token in a URL would end up in logs, history and referrers.
  const docsPath = /^\/api\/(docs|openapi[\w.-]*)\/?$/.test((req.originalUrl || '').split('?')[0]);
  // an API key is accepted next to an access token (X-API-Key, Authorization: ApiKey …, or a Bearer value that starts with ork_)
  const rawKey = apiKeyFromRequest(req);
  if (rawKey) {
    try {
      const ctx = (req as any).ctx as AppContext;
      const key = await authenticateApiKey(ctx.store, rawKey, new Date().toISOString());
      (req as any).apiKey = key;
      (req as any).user = { sub: `apikey:${key.id}`, username: `apikey:${key.name}`, roles: [], groups: [], source: 'apikey' } satisfies JwtClaims;
      (req as any).actor = `apikey:${key.name}`;
      return next();
    } catch (e) { return next(e); }
  }
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : (docsPath && typeof req.query?.token === 'string' ? req.query.token : undefined);
  if (!token) return next(authRequired());
  try {
    const claims = await verifyBearer(token);
    // A local token outlives the account state it was minted from: honour deactivation and password changes
    // immediately instead of at token expiry. (Fabricated test principals without a row are not affected.)
    if (claims.source === 'local') {
      const row = await ((req as any).ctx as AppContext).store.repo<User>(Collections.users).get(claims.sub);
      const iat = (claims as any).iat as number | undefined;
      if (row && (!row.active || (row.passwordChangedAt && iat !== undefined && iat * 1000 < Date.parse(row.passwordChangedAt) - 1000))) throw new Error('session revoked');
    }
    (req as any).user = claims;
    (req as any).actor = claims.email || claims.username;   // routes.ts's actorOf(req) keeps working unchanged
    next();
  } catch {
    next(authRequired('invalid or expired token'));
  }
}

/** Permissions a workspace role grants: the workspace's own Role row if it has one (admin-editable),
 *  else the built-in default — new workspaces have no Role rows until someone customises them. */
async function permissionsForMemberRole(ctx: AppContext, tenantId: string, role: string): Promise<string[]> {
  if (role === 'owner' || role === 'admin' || role === 'system_admin') return ['*'];
  const rows = await ctx.store.repo<Role>(Collections.roles).query((r) => r.tenantId === tenantId && r.name === role);
  if (rows.length) return rows.flatMap((r) => r.permissions);
  return DEFAULT_ROLES[role] ?? [];
}

/** Must run after requireAuth (needs req.user) and the ctx-attaching middleware (needs req.ctx).
 *  Grants when the caller is a platform administrator, or holds ANY of the listed permissions through their membership of
 *  THIS workspace (explicit member.permissions, else the permissions of member.role), or — local IAM users —
 *  through the Role rows named in their token. */
export function requirePermission(...actions: string[]) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = (req as any).user as JwtClaims | undefined;
      if (!user) throw authRequired();
      const ctx = (req as any).ctx as AppContext;

      let access = (req as any).access as Access | undefined;
      if (!access) {
        await claimMemberships(ctx.store, user);
        const members = await ctx.store.repo<TenantMember>(Collections.tenantMembers).query((m) => m.tenantId === ctx.tenantId && m.status === 'active' && memberMatches(m, user));
        access = { platformAdmin: await isPlatformAdmin(ctx.store, user), member: members[0] };
      }
      if (access.platformAdmin) return next();
      if (access.apiKey) {                          // exactly the permissions listed on the key
        if (actions.some((a) => permissionGrants(access!.apiKey!.permissions, a))) return next();
        throw forbidden(`this API key does not allow: ${actions.join(' or ')}`);
      }

      const member = access.member;
      if (member) {
        const granted = member.permissions ?? await permissionsForMemberRole(ctx, ctx.tenantId, member.role);
        if (actions.some((action) => permissionGrants(granted, action))) return next();
      }

      const roles = await ctx.store.repo<Role>(Collections.roles).query((r) => r.tenantId === ctx.tenantId && (user.roles || []).includes(r.name));
      const perms = roles.flatMap((r) => r.permissions);
      if (!actions.some((action) => permissionGrants(perms, action))) throw forbidden(`missing permission: ${actions.join(' or ')}`);
      next();
    } catch (e) { next(e); }
  };
}

/**
 * Verifies that the authenticated caller has access to the workspace targeted by x-tenant-id (or default).
 * Validates:
 * 1. Target workspace exists and is active (not suspended / pending / deleted).
 * 2. Caller is an ACTIVE member of that workspace, OR is a platform system admin.
 * Platform administrators may use the 'all' (platform-wide) scope. Anything else is 403 — an explicitly
 * requested workspace the caller does not belong to is never silently swapped for another one.
 * If authorized, updates req.ctx with the validated workspace context and records req.access.
 */
export function requireWorkspaceAccess(req: Request, _res: Response, next: NextFunction) {
  (async () => {
    try {
      const user = (req as any).user as JwtClaims | undefined;
      if (!user) throw authRequired();

      const ctx = (req as any).ctx as AppContext;
      const key = (req as any).apiKey as ApiKey | undefined;
      if (key) {                                    // a key works in ONE workspace; naming another is refused, never swapped
        const asked = (req.headers['x-tenant-id'] as string | undefined)?.trim();
        if (asked && asked !== key.tenantId) throw forbidden('This API key belongs to another workspace.');
        const tenant = (await ctx.store.repo<Tenant>(Collections.tenants).query((t) => t.id === key.tenantId))[0];
        if (!tenant || tenant.status !== 'active') throw forbidden('The workspace of this API key is not active.');
        (req as any).ctx = makeContext({ store: ctx.store, tenantId: key.tenantId });
        (req as any).ctx.planExempt = false;
        (req as any).access = { platformAdmin: false, apiKey: key } satisfies Access;
        return next();
      }
      const requestedTenantId = ((req.headers['x-tenant-id'] as string | undefined)?.trim()) || ctx?.tenantId || 'default';

      const memberships = (await membershipsOf(ctx.store, user)).filter((m) => m.status === 'active');
      const platformAdmin = await isPlatformAdmin(ctx.store, user, memberships);

      // Platform-wide scope: strictly for platform administrators
      if (requestedTenantId === 'all' || requestedTenantId === '*') {
        if (!platformAdmin) throw forbidden('Platform system administrator access required for platform-wide scope.');
        (req as any).ctx = makeContext({ store: ctx.store, tenantId: 'all' });
        (req as any).ctx.planExempt = true;
        (req as any).access = { platformAdmin } satisfies Access;
        return next();
      }

      const tenant = (await ctx.store.repo<Tenant>(Collections.tenants).query((t) => t.id === requestedTenantId))[0];
      if (!tenant || tenant.status === 'deleted') throw forbidden(`Workspace "${requestedTenantId}" not found or access denied`);
      if (tenant.status === 'suspended') throw forbidden('This workspace has been suspended. Contact support.');
      if (tenant.status === 'pending_verification') throw forbidden('This workspace is pending activation.');

      const member = memberships.find((m) => m.tenantId === requestedTenantId);
      if (!platformAdmin && !member) {
        // local IAM users whose user row lives in this workspace
        // (only admin-provisioned users that hold roles; a self-registered account has none and must belong via a seat)
        const u = user.source !== 'oidc' && user.sub ? await ctx.store.repo<User>(Collections.users).get(user.sub) : undefined;
        if (!(u && u.tenantId === requestedTenantId && u.active && u.roles.length > 0)) throw forbidden('You are not a member of the requested workspace.');
      }

      if (ctx.tenantId !== requestedTenantId) (req as any).ctx = makeContext({ store: ctx.store, tenantId: requestedTenantId });
      // the platform administrator is not subject to plan limits or trial expiry in any workspace
      (req as any).ctx.planExempt = platformAdmin;
      (req as any).access = { platformAdmin, member } satisfies Access;
      next();
    } catch (err) {
      next(err);
    }
  })();
}

/** What the caller may hand out to others: everything for the platform administrator, else what their own seat in the
 *  request's workspace (or, for local IAM users, their Role rows) grants. Used to stop role/permission escalation. */
export async function callerPermissions(req: Request): Promise<string[]> {
  const access = (req as any).access as Access | undefined;
  if (access?.platformAdmin) return ['*'];
  if (access?.apiKey) return access.apiKey.permissions;
  const ctx = (req as any).ctx as AppContext;
  const user = (req as any).user as JwtClaims;
  if (access?.member) return access.member.permissions ?? await permissionsForMemberRole(ctx, ctx.tenantId, access.member.role);
  const roles = await ctx.store.repo<Role>(Collections.roles).query((r) => r.tenantId === ctx.tenantId && (user?.roles || []).includes(r.name));
  return roles.flatMap((r) => r.permissions);
}
