// Tenant Service: multi-tenancy, workspaces, memberships, self-serve signup, and plans
import type { AppContext } from '../../context.ts';
import {
  Collections,
  type Tenant,
  type TenantMember,
  type Plan,
  type Role,
  type User,
} from '../../domain.ts';
import { conflict, forbidden, notFound, validation } from '../../infra/errors.ts';
import { config } from '../../infra/config.ts';
import { DEFAULT_PLAN_LIMITS, TRIAL_DAYS } from '../plans/plan-limits.ts';
import { PlanService, statusOf } from '../plans/plans.ts';
import { DEFAULT_ROLES } from '../iam/service.ts';
import { sendMail } from '../../infra/mailer.ts';
import { templates } from '../../infra/mail-templates.ts';
import { ensurePlatformAdmin, isPlatformAdmin, membershipsOf, type Identity } from './identity.ts';

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SLUGS = new Set([
  'api', 'app', 'auth', 'admin', 'system', 'public', 'dashboard', 'settings',
  'null', 'undefined', 'root', 'support', 'workspace', 'tenants', 'billing',
  'login', 'logout', 'help', 'docs', 'home', 'status'
]);

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
  isCurrent?: boolean;
  support?: boolean;
}

export interface InactiveMembership {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  role: string;
  memberStatus: string;
}

export interface MyProfileResult {
  /** the server's own verdict: may this caller manage the platform (plans, limits, every workspace)? */
  platformAdmin: boolean;
  userId: string;
  email: string;
  member?: {
    id: string;
    tenantId: string;
    role: string;
    status: string;
    displayName: string | null;
    permissions?: string[];
    joinedAt?: string | null;
  };
  tenant: { id: string; name: string; slug: string } | null;
}

export class TenantService {
  constructor(private ctx: AppContext) {}

  private tenantRepo() {
    return this.ctx.store.repo<Tenant>(Collections.tenants);
  }

  private memberRepo() {
    return this.ctx.store.repo<TenantMember>(Collections.tenantMembers);
  }

  private planRepo() {
    return this.ctx.store.repo<Plan>(Collections.plans);
  }

  private userRepo() {
    return this.ctx.store.repo<User>(Collections.users);
  }

  private roleRepo() {
    return this.ctx.store.repo<Role>(Collections.roles);
  }

  async checkSlug(slug: string): Promise<{ available: boolean }> {
    const s = slug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(s) || s.length < 2 || s.length > 50 || RESERVED_SLUGS.has(s)) {
      return { available: false };
    }
    const all = await this.tenantRepo().query(() => true);
    const existing = all.find((t) => t.slug.toLowerCase() === s);
    return { available: !existing };
  }

  /** `caller` is the verified SSO identity when sign-in is via the Identity Server: the owner is then the caller
   *  themselves (bound to their `sub`, email from the VERIFIED token) — never a free-text email, which anyone could
   *  type to squat a workspace for somebody else. Without SSO (local dev) the body's ownerEmail is used. */
  async signup(data: { name: string; slug: string; ownerEmail: string; ownerName?: string }, caller?: Identity & { name?: string }): Promise<Tenant> {
    if (caller?.source === 'oidc') {
      if (!caller.email || caller.emailVerified !== true) throw forbidden('A verified email address is required to create a workspace');
      data = { ...data, ownerEmail: caller.email, ownerName: data.ownerName || caller.name };
    }
    const str = (v: unknown) => (typeof v === 'string' ? v : '');   // untrusted body: non-strings count as missing
    const name = str(data.name).trim();
    const slug = str(data.slug).trim().toLowerCase();
    const ownerEmail = str(data.ownerEmail).trim().toLowerCase();
    const ownerName = str(data.ownerName).trim() || ownerEmail.split('@')[0];

    if (!name || name.length < 2 || name.length > 100) {
      throw validation('Workspace name must be between 2 and 100 characters');
    }
    if (!SLUG_PATTERN.test(slug) || slug.length < 2 || slug.length > 50) {
      throw validation('Workspace address must use lowercase letters, numbers, and single hyphens (2-50 characters)');
    }
    if (RESERVED_SLUGS.has(slug)) {
      throw validation(`Workspace address "${slug}" is reserved and cannot be used`);
    }
    if (!ownerEmail || !ownerEmail.includes('@')) {
      throw validation('A valid owner email address is required');
    }

    const check = await this.checkSlug(slug);
    if (!check.available) {
      throw conflict(`Workspace address "${slug}" is already taken`);
    }

    const tenantId = `org_${this.ctx.newId().replace(/[^a-zA-Z0-9]/g, '').slice(0, 24)}`;
    const now = this.ctx.clock();

    const tenant: Tenant = {
      id: tenantId,
      tenantId,
      name,
      slug,
      status: 'active',
      ...(await new PlanService(this.ctx.store).startingPlan(Date.parse(now))),
      settings: {
        timezone: 'UTC',
        dateFormat: 'YYYY-MM-DD',
        brandName: name,
      },
      ownerEmail,
      ownerName,
      createdAt: now,
      updatedAt: now,
    };

    await this.tenantRepo().put(tenant);
    // a new workspace starts with the built-in analytics APIs (seed migrations; a failure here never blocks the signup)
    await (await import('../../analytics/migrate.ts')).migrateAnalyticsFor(this.ctx.store, tenantId);

    // Find or link user by email/username
    const allUsers = await this.userRepo().query(() => true);
    const matchedUser = allUsers.find((u) => u.username.toLowerCase() === ownerEmail.toLowerCase() || u.id === ownerEmail);
    const userId = caller?.source === 'oidc' ? caller.sub : matchedUser ? matchedUser.id : ownerEmail;

    const membership: TenantMember = {
      id: this.ctx.newId(),
      tenantId,
      userId,
      email: ownerEmail,
      role: 'owner',
      status: 'active',
      displayName: ownerName,
      permissions: ['*'],
      joinedAt: now,
      lastActiveAt: now,
    };

    await this.memberRepo().put(membership);
    void sendMail(templates.workspaceCreated(ownerEmail, name, TRIAL_DAYS));

    return tenant;
  }

  async listMyTenants(id: Identity, search?: string, limit = 10, requestedTenantId?: string): Promise<{ tenants: TenantSummary[]; currentTenantId: string | null }> {
    const allTenants = await this.tenantRepo().query(() => true);
    const userMemberships = (await membershipsOf(this.ctx.store, id)).filter((m) => m.status === 'active');
    const isSystemAdmin = await isPlatformAdmin(this.ctx.store, id, userMemberships);

    const activeMap = new Map<string, Tenant>();
    for (const t of allTenants) {
      if (t.status === 'active') activeMap.set(t.id, t);
    }

    let rows: TenantSummary[] = [];

    for (const m of userMemberships) {
      const t = activeMap.get(m.tenantId);
      if (t) {
        rows.push({
          id: t.id,
          name: t.name,
          slug: t.slug,
          role: m.role,
          isCurrent: false,
        });
      }
    }

    // Platform administrator support access: can switch to platform view or search across any workspace
    if (isSystemAdmin) {
      rows.unshift({
        id: 'all',
        name: 'All Workspaces (Platform View)',
        slug: 'platform-wide',
        role: 'system_admin',
        isCurrent: requestedTenantId === 'all',
        support: true,
      });
      const have = new Set(rows.map((r) => r.id));
      if (requestedTenantId && !have.has(requestedTenantId)) {
        const named = activeMap.get(requestedTenantId);
        if (named) {
          rows.push({
            id: named.id,
            name: named.name,
            slug: named.slug,
            role: 'system_admin',
            isCurrent: true,
            support: true,
          });
          have.add(named.id);
        }
      }

      if (search && search.trim()) {
        const q = search.trim().toLowerCase();
        for (const t of activeMap.values()) {
          if (!have.has(t.id) && (t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q))) {
            rows.push({
              id: t.id,
              name: t.name,
              slug: t.slug,
              role: 'system_admin',
              isCurrent: false,
              support: true,
            });
            have.add(t.id);
          }
        }
      }
    }

    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter((r) => r.name.toLowerCase().includes(q) || r.slug.toLowerCase().includes(q));
      if (limit > 0) {
        rows = rows.slice(0, limit);
      }
    }

    const currentTenantId = rows.find((r) => r.id === requestedTenantId)?.id ?? rows[0]?.id ?? null;
    rows.forEach((r) => {
      r.isCurrent = r.id === currentTenantId;
    });

    return { tenants: rows, currentTenantId };
  }

  async getMyProfile(id: Identity, tenantId: string): Promise<MyProfileResult> {
    const userId = id.sub;
    const memberships = await membershipsOf(this.ctx.store, id);
    const isSystemAdmin = await isPlatformAdmin(this.ctx.store, id, memberships);
    const email = id.email || (id.username?.includes('@') ? id.username : undefined);

    if (tenantId === 'all' && isSystemAdmin) {
      return {
        platformAdmin: isSystemAdmin,
        userId,
        email: email || `${id.username || userId}@platform.local`,
        member: {
          id: `mem_${userId}_platform`,
          tenantId: 'all',
          role: 'system_admin',
          status: 'active',
          displayName: 'Platform Administrator',
          permissions: ['*'],
          joinedAt: this.ctx.clock(),
        },
        tenant: { id: 'all', name: 'All Workspaces (Platform View)', slug: 'platform-wide' },
      };
    }

    const membership = memberships.find((m) => m.tenantId === tenantId && m.status === 'active');
    const tenant = (await this.tenantRepo().query((t) => t.id === tenantId))[0];
    // Not a member (and not a platform admin): there is no profile to show — never invent a "viewer" seat.
    if (!membership && !isSystemAdmin) throw forbidden('You are not a member of the requested workspace.');
    if (!tenant) throw notFound(`Workspace "${tenantId}" not found`);

    const role = membership?.role ?? 'system_admin';
    const permissions = membership?.permissions ?? await this.permissionsForRole(tenantId, role);

    return {
      platformAdmin: isSystemAdmin,
      userId,
      email: membership?.email || email || `${id.username || userId}@local`,
      member: {
        id: membership?.id || `mem_${userId}_${tenantId}`,
        tenantId,
        role,
        status: membership?.status || 'active',
        displayName: membership?.displayName || id.username || userId,
        permissions,
        joinedAt: membership?.joinedAt || this.ctx.clock(),
      },
      tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug },
    };
  }

  /** What a workspace role grants: the workspace's own Role row, else the built-in default (same rule as requirePermission). */
  private async permissionsForRole(tenantId: string, role: string): Promise<string[]> {
    if (role === 'owner' || role === 'admin' || role === 'system_admin') return ['*'];
    const rows = await this.roleRepo().query((r) => r.tenantId === tenantId && r.name === role);
    return rows.length ? rows.flatMap((r) => r.permissions) : DEFAULT_ROLES[role] ?? [];
  }

  async getCurrentTenant(tenantId: string, id: Identity): Promise<Tenant> {
    const memberships = await membershipsOf(this.ctx.store, id);
    if (tenantId === 'all' ? !(await isPlatformAdmin(this.ctx.store, id, memberships)) : !(memberships.some((m) => m.tenantId === tenantId && m.status === 'active') || await isPlatformAdmin(this.ctx.store, id, memberships))) {
      throw forbidden('You are not a member of the requested workspace.');
    }
    if (tenantId === 'all') {
      const now = this.ctx.clock();
      return {
        id: 'all',
        tenantId: 'all',
        name: 'All Workspaces (Platform View)',
        slug: 'platform-wide',
        status: 'active',
        plan: 'enterprise',
        createdAt: now,
        updatedAt: now,
      };
    }
    const all = await this.tenantRepo().query(() => true);
    const tenant = all.find((t) => t.id === tenantId);
    if (!tenant) throw notFound(`Workspace "${tenantId}" not found`);
    return tenant;
  }

  async listMemberships(id: Identity): Promise<InactiveMembership[]> {
    const allTenants = await this.tenantRepo().query(() => true);
    const tenantMap = new Map(allTenants.map((t) => [t.id, t]));
    const userMembers = await membershipsOf(this.ctx.store, id);
    return userMembers.map((m) => {
      const t = tenantMap.get(m.tenantId);
      return {
        id: t?.id || m.tenantId,
        name: t?.name || 'Workspace',
        slug: t?.slug || m.tenantId,
        status: t?.status || 'active',
        plan: t?.plan || 'trial',
        role: m.role,
        memberStatus: m.status,
      };
    });
  }

  async listPublicPlans(): Promise<Plan[]> {
    const plans = (await this.planRepo().query(() => true))
      .filter((p) => !(p as unknown as { deleted?: boolean }).deleted && statusOf(p) !== 'hidden')        // hidden plans are never listed
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
    const hide = (p: Plan): Plan => { const limits = { ...(p.limits ?? {}) } as Record<string, unknown>; delete limits.concurrentScripts; return { ...p, limits } as Plan; };   // script parallelism is not advertised
    if (plans.length > 0) return plans.map((p) => hide({ ...p, status: statusOf(p) }));
    return this.builtinPlans().map(hide);
  }

  /** The plans every deployment starts with: a 7-day trial (the default) and a contact-us custom plan. */
  builtinPlans(): Plan[] {
    return [
      {
        id: 'plan_trial',
        tenantId: 'system',
        key: 'trial',
        name: 'Free trial',
        description: 'Explore the visual workflow designer, process engine, and execution runtime for 7 days.',
        isDefault: true,
        isCustom: false,
        trialDays: TRIAL_DAYS,
        contactConfig: null,
        limits: { ...DEFAULT_PLAN_LIMITS.trial },
        features: ['Visual Workflow Designer', 'Process Execution', 'Task Inbox', 'Decision Tables', 'Versioned Deployments'],
        status: 'active', sortOrder: 0,
      },
      {
        id: 'plan_custom',
        tenantId: 'system',
        key: 'custom',
        name: 'Custom plan',
        description: 'Volume, custom integrations, dedicated execution sidecars, and limits agreed with us. Contact us to configure your workspace.',
        isDefault: false,
        isCustom: true,
        trialDays: null,
        contactConfig: { type: 'email', value: `sales@${config.domain}`, label: 'Contact us' },
        limits: { ...DEFAULT_PLAN_LIMITS.custom },
        features: ['Unlimited Workflows & Instances', 'Dedicated Execution Sidecar', 'Custom hitPolicies & Rules', 'High-availability clustering', 'Dedicated 24/7 SLA Support'],
        status: 'active', sortOrder: 10,
      },
    ];
  }

  async seedDefaultsIfEmpty(): Promise<void> {
    const tenants = await this.tenantRepo().query(() => true);
    const defaultTenantId = 'default';
    let defaultTenant = tenants.find((t) => t.id === defaultTenantId || t.slug === 'default');

    if (!defaultTenant) {
      defaultTenant = {
        id: defaultTenantId,
        tenantId: defaultTenantId,
        name: 'Default Workspace',
        slug: 'default',
        status: 'active',
        plan: 'enterprise',        // the system workspace is not a commercial trial: unlimited, never expires
        planExpiresAt: null,
        settings: { timezone: 'UTC', dateFormat: 'YYYY-MM-DD', brandName: config.appName },
        ownerEmail: `admin@${config.domain}`,
        ownerName: 'System Administrator',
        createdAt: this.ctx.clock(),
        updatedAt: this.ctx.clock(),
      };
      await this.tenantRepo().put(defaultTenant);
    }

    // Seed admin membership
    const members = await this.memberRepo().query(() => true);
    const hasAdminMember = members.some((m) => m.userId === 'admin' && m.tenantId === defaultTenantId);
    if (!hasAdminMember) {
      await this.memberRepo().put({
        id: 'mem_admin_default',
        tenantId: defaultTenantId,
        userId: 'admin',
        email: 'admin@local',
        role: 'owner',
        status: 'active',
        displayName: 'System Admin',
        permissions: ['*'],
        joinedAt: this.ctx.clock(),
        lastActiveAt: this.ctx.clock(),
      });
    }

    // The one platform administrator (config.platformAdminEmail) is always seeded as system_admin
    await ensurePlatformAdmin(this.ctx.store, this.ctx.clock(), () => this.ctx.newId());

    // Seed the built-in plans by key: a fresh deployment gets the 7-day trial (default) and the custom plan; an existing one
    // only gets what is missing, and a plan an administrator deleted (its marker row has the same id) is never brought back.
    const stored = await this.planRepo().query(() => true);
    for (const p of this.builtinPlans()) {
      if (!stored.some((x) => x.id === p.id || x.key === p.key)) await this.planRepo().put(p);
    }
    // every other built-in plan is seeded Hidden: never listed or selectable, only an administrator can assign it (or publish it)
    for (const [i, key] of ['starter', 'pro', 'enterprise'].entries()) {
      if (stored.some((x) => x.id === `plan_${key}` || x.key === key)) continue;
      await this.planRepo().put({
        id: `plan_${key}`, tenantId: 'system', key, name: key[0]!.toUpperCase() + key.slice(1), description: '', isDefault: false, isCustom: false,
        trialDays: null, contactConfig: null, limits: { ...DEFAULT_PLAN_LIMITS[key] }, features: [], status: 'hidden', sortOrder: 20 + i,
      } as Plan);
    }
    if (!(await this.planRepo().query((x) => !!x.isDefault && !(x as { deleted?: boolean }).deleted)).length) {
      const t = await this.planRepo().get('plan_trial');       // never leave the platform without a default plan
      if (t && !(t as { deleted?: boolean }).deleted) await this.planRepo().put({ ...t, isDefault: true, status: 'active' });
    }
    // bring plans stored by an older version up to date: add the limit keys they lack, move the old 14-day trial to 7
    await new PlanService(this.ctx.store).ensureDefaults();
    // built-in analytics APIs (a versioned seed migration: applied once per workspace)
    await (await import('../../analytics/migrate.ts')).migrateAnalyticsFor(this.ctx.store, defaultTenantId);
  }
}
