// IAM: users, groups, roles/permissions, login. Single-tenant (this project intentionally doesn't do
// JWT-bound multi-tenancy — see docs/07-security.md) but otherwise implements the RBAC model that doc
// describes: named roles carrying permission strings, users carrying role + group names, group names
// matching the same plain strings userTask.group/Task.group already use.
import { AllocationService } from '../allocation/service.ts';
import type { AppContext } from '../../context.ts';
import { Collections, type Group, type Role, type TenantMember, type User } from '../../domain.ts';
import { hashPassword, verifyPassword, signToken, permissionGrants } from '../../infra/auth.ts';
import { notFound, validation, conflict, forbidden, authRequired, rateLimited } from '../../infra/errors.ts';
import { config } from '../../infra/config.ts';
import { sendMail } from '../../infra/mailer.ts';
import { templates } from '../../infra/mail-templates.ts';
import { passwordProblem } from '../../infra/passwords.ts';
import { AccountService } from './accounts.ts';
import { permissionProblem } from './permissions.ts';

export { sanitize, type PublicUser, type LoginResult } from './session.ts';
import { sanitize, finishSignIn, type PublicUser, type LoginResult } from './session.ts';

/** name -> default permission set, seeded once (see ensureSeeded) if the roles collection is empty.
 *  Matches docs/07-security.md's role list exactly. */
export const DEFAULT_ROLES: Record<string, string[]> = {
  admin: ['*'],
  developer: ['workflow:view', 'workflow:edit', 'workflow:run', 'query:read', 'task:manage', 'task:viewAll', 'team:read'],
  author: ['workflow:view', 'workflow:edit', 'team:read'],
  release: ['workflow:view', 'workflow:deploy', 'workflowInstance:admin', 'team:read'],
  operator: ['workflow:view', 'workflow:run', 'query:read', 'workflowInstance:manage', 'analytics:query', 'team:read'],
  worker: ['task:manage', 'workflowInstance:manage', 'team:read'],
  viewer: ['workflow:view', 'query:read', 'team:read'],
};

let _dummy: Promise<string> | undefined;
const dummyHash = () => (_dummy ??= hashPassword('not-a-real-password-0'));

export class IamService {
  constructor(private ctx: AppContext) {}
  private users() { return this.ctx.store.repo<User>(Collections.users); }
  private groups() { return this.ctx.store.repo<Group>(Collections.groups); }
  private roles() { return this.ctx.store.repo<Role>(Collections.roles); }

  /** Bootstraps a fresh deployment: default roles (if none exist) + one admin user (if no users exist
   *  at all) so there's always a way in. Call once at server startup — safe to call repeatedly
   *  (no-ops once seeded). */
  async ensureSeeded(defaultAdminPassword: string): Promise<{ seededAdmin: boolean }> {
    const existingRoles = await this.roles().query((r) => r.tenantId === this.ctx.tenantId);
    if (existingRoles.length === 0) {
      for (const [name, permissions] of Object.entries(DEFAULT_ROLES)) {
        await this.roles().put({ id: this.ctx.newId(), tenantId: this.ctx.tenantId, name, permissions });
      }
    }
    const existingUsers = await this.users().query((u) => u.tenantId === this.ctx.tenantId);
    if (existingUsers.length === 0) {
      await this.createUser({ username: 'admin', password: defaultAdminPassword, roles: ['admin'], groups: [] }, 'system');
      return { seededAdmin: true };
    }
    return { seededAdmin: false };
  }

  /** Sign in by username OR email. Wrong password / unknown account answer identically (and spend the same
   *  hashing time), repeated failures lock the account for a while, and an account whose mailbox is not yet
   *  verified cannot sign in when verification is required. */
  async login(identifier: string, password: string): Promise<LoginResult> {
    if (typeof identifier !== 'string' || typeof password !== 'string') throw authRequired('invalid username or password');
    const id = identifier.trim();
    const low = id.toLowerCase();
    let u = id ? (await this.users().query((x) => x.tenantId === this.ctx.tenantId && (x.username === id || x.username.toLowerCase() === low || (x.email || '').toLowerCase() === low)))[0] : undefined;
    // not an account yet: maybe a self-registration waiting for its emailed temporary password (confirms → creates the account)
    if (!u && id) u = await new AccountService(this.ctx).confirmPendingRegistration(low, password);
    if (!u) { await verifyPassword(password || '', await dummyHash()); throw authRequired('invalid username or password'); }

    const now = this.ctx.clock();
    if (u.lockedUntil && u.lockedUntil > now) {
      const mins = Math.max(1, Math.ceil((Date.parse(u.lockedUntil) - Date.parse(now)) / 60000));
      throw rateLimited(`Too many failed sign-in attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
    }
    const ok = u.active && await verifyPassword(password || '', u.passwordHash);
    if (!ok) {
      if (u.active) {
        u.failedLogins = (u.failedLogins ?? 0) + 1;
        if (u.failedLogins >= config.auth.maxFailedLogins) {
          u.lockedUntil = new Date(Date.parse(now) + config.auth.lockoutMinutes * 60000).toISOString();
          u.failedLogins = 0;
          await this.ctx.audit({ actor: u.username, kind: 'user.locked', data: { userId: u.id } });
          if (u.email) void sendMail(templates.accountLocked(u.email, config.auth.lockoutMinutes));
        }
        await this.users().put(u);
      }
      throw authRequired('invalid username or password');
    }
    const result = finishSignIn(u, now);
    if (u.failedLogins || u.lockedUntil) { u.failedLogins = 0; u.lockedUntil = null; await this.users().put(u); }
    return result;
  }

  /** Resolves a role-name list to its union of granted permission strings (missing/unknown role names
   *  simply contribute nothing — a deleted role silently drops from anyone still holding it). */
  async permissionsFor(roleNames: string[]): Promise<string[]> {
    if (!roleNames.length) return [];
    const rows = await this.roles().query((r) => r.tenantId === this.ctx.tenantId && roleNames.includes(r.name));
    return rows.flatMap((r) => r.permissions);
  }
  async authorize(roleNames: string[], action: string): Promise<boolean> {
    return permissionGrants(await this.permissionsFor(roleNames), action);
  }

  // ---- users ----
  async listUsers(): Promise<PublicUser[]> {
    return (await this.users().query((u) => u.tenantId === this.ctx.tenantId)).sort((a, b) => a.username.localeCompare(b.username)).map(sanitize);
  }
  async getUser(id: string): Promise<PublicUser> {
    const u = await this.users().get(id);
    if (!u || u.tenantId !== this.ctx.tenantId) throw notFound('User');
    return sanitize(u);
  }
  async createUser(input: { username: string; password: string; roles?: string[]; groups?: string[] }, actor: string, grantable?: string[]): Promise<PublicUser> {
    this.needWorkspace();
    const username = (input.username || '').trim();
    if (!username) throw validation('username is required');
    if (username.length > 100) throw validation('username is too long (max 100 characters)');
    { const pp = passwordProblem(input.password, config.auth.passwordMinLength, username, false); if (pp) throw validation(pp); }
    const dupe = await this.users().query((u) => u.tenantId === this.ctx.tenantId && u.username.toLowerCase() === username.toLowerCase());
    if (dupe.length) throw conflict(`username "${username}" already exists`);
    const roles = await this.checkRoleNames(input.roles, grantable);
    const groups = await this.checkGroupNames(input.groups);
    const u: User = {
      id: this.ctx.newId(), tenantId: this.ctx.tenantId, username,
      passwordHash: await hashPassword(input.password),
      roles, groups, active: true, createdAt: this.ctx.clock(),
    };
    await this.users().put(u);
    await this.ctx.audit({ actor, kind: 'user.created', data: { username, roles, groups } });
    return sanitize(u);
  }
  async updateUser(id: string, patch: Partial<Pick<User, 'roles' | 'groups' | 'active' | 'skills' | 'maxOpenTasks' | 'maxTasksPerDay' | 'available' | 'awayUntil'>>, actor: string, grantable?: string[]): Promise<PublicUser> {
    this.needWorkspace();
    const u = await this.users().get(id);
    if (!u || u.tenantId !== this.ctx.tenantId) throw notFound('User');
    if (patch.active !== undefined && typeof patch.active !== 'boolean') throw validation('active must be true or false');
    if (patch.active === false && u.active && [u.id, u.username, u.email].some((x) => x && x.toLowerCase() === (actor || '').toLowerCase())) throw validation('You cannot deactivate your own account');
    if (patch.roles !== undefined) u.roles = await this.checkRoleNames(patch.roles, grantable, u.roles);
    if (patch.groups !== undefined) u.groups = await this.checkGroupNames(patch.groups);
    const wasActive = u.active;
    if (patch.active !== undefined) u.active = patch.active;
    // automatic task assignment: what this person can do and how much they may be given
    if (patch.skills !== undefined) {
      if (!Array.isArray(patch.skills) || patch.skills.some((x) => typeof x !== 'string')) throw validation('skills must be a list of names');
      u.skills = [...new Set(patch.skills.map((x) => x.trim()).filter(Boolean))].slice(0, 50);
    }
    for (const k of ['maxOpenTasks', 'maxTasksPerDay'] as const) {
      const v = (patch as any)[k];
      if (v === undefined) continue;
      if (v === null || v === 0 || v === '') delete u[k];
      else if (!Number.isInteger(v) || v < 1 || v > 100000) throw validation(`${k} must be a whole number of at least 1 (empty = no limit)`);
      else u[k] = v;
    }
    if (patch.awayUntil !== undefined) { if (patch.awayUntil === null || (patch.awayUntil as any) === '') delete u.awayUntil; else if (Number.isNaN(Date.parse(String(patch.awayUntil)))) throw validation('awayUntil must be a date and time'); else u.awayUntil = new Date(String(patch.awayUntil)).toISOString(); }
    if (patch.available !== undefined) { if (typeof patch.available !== 'boolean') throw validation('available must be true or false'); u.available = patch.available; }
    await this.users().put(u);
    if (wasActive && !u.active) await new AllocationService(this.ctx).releaseUnstarted(u.username, 'account disabled');   // a disabled person cannot work what was queued for them
    await this.ctx.audit({ actor, kind: 'user.updated', data: { userId: id, roles: u.roles, groups: u.groups, active: u.active } });
    return sanitize(u);
  }

  // ---- scope + validation helpers ----
  /** Roles, groups and users belong to ONE workspace; the platform-wide view ('all') is read-only for them. */
  private needWorkspace() {
    if (!this.ctx.tenantId || this.ctx.tenantId === 'all') throw validation('Select a workspace first: users, roles and groups belong to a single workspace');
  }
  private async roleNames(): Promise<Set<string>> {
    return new Set((await this.listRoles()).map((r) => r.name));
  }
  /** unique, trimmed, existing in THIS workspace (built-in or custom); `keep` = names already held, which are never refused */
  private async checkRoleNames(input: unknown, grantable?: string[], keep: string[] = []): Promise<string[]> {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input) || input.some((x) => typeof x !== 'string')) throw validation('roles must be a list of role names');
    const names = [...new Set((input as string[]).map((x) => x.trim()).filter(Boolean))];
    const known = await this.listRoles();
    const byName = new Map(known.map((r) => [r.name, r]));
    for (const n of names) {
      const role = byName.get(n);
      if (!role) throw validation(`unknown role "${n}" in this workspace`);
      if (grantable && !keep.includes(n) && !role.permissions.every((p) => permissionGrants(grantable, p))) throw forbidden(`You cannot assign the role "${n}": it carries permissions you do not hold yourself`);
    }
    return names;
  }
  private async checkGroupNames(input: unknown): Promise<string[]> {
    if (input === undefined || input === null) return [];
    if (!Array.isArray(input) || input.some((x) => typeof x !== 'string')) throw validation('groups must be a list of group names');
    const names = [...new Set((input as string[]).map((x) => x.trim()).filter(Boolean))];
    const known = new Set((await this.listGroups()).map((g) => g.name));
    for (const n of names) if (!known.has(n)) throw validation(`unknown group "${n}" in this workspace`);
    return names;
  }
  async setPassword(id: string, newPassword: string, actor: string): Promise<void> {
    const u = await this.users().get(id);
    if (!u || u.tenantId !== this.ctx.tenantId) throw notFound('User');
    { const pp = passwordProblem(newPassword, config.auth.passwordMinLength, u.username, false); if (pp) throw validation(pp); }
    u.passwordHash = await hashPassword(newPassword);
    u.passwordChangedAt = this.ctx.clock();
    await this.users().put(u);
    await this.ctx.audit({ actor, kind: 'user.password_changed', data: { userId: id } });
    if (u.email) void sendMail(templates.passwordChanged(u.email, 'admin'));
  }

  /** Self-service variant of setPassword — for a user changing their OWN password (no admin:iam
   *  needed), gated by knowing the current password rather than by permission. */
  async changeOwnPassword(id: string, currentPassword: string, newPassword: string): Promise<void> {
    const u = await this.users().get(id);
    if (!u || u.tenantId !== this.ctx.tenantId) throw notFound('User');
    if (!(await verifyPassword(currentPassword || '', u.passwordHash))) throw forbidden('current password is incorrect');
    { const pp = passwordProblem(newPassword, config.auth.passwordMinLength, u.username); if (pp) throw validation(pp); }
    u.passwordHash = await hashPassword(newPassword);
    u.passwordChangedAt = this.ctx.clock();
    await this.users().put(u);
    await this.ctx.audit({ actor: u.username, kind: 'user.password_changed', data: { userId: id, self: true } });
    if (u.email) void sendMail(templates.passwordChanged(u.email, 'changed'));
  }

  // ---- groups ----
  async listGroups(): Promise<Array<Group & { memberCount: number }>> {
    const users = await this.users().query((u) => u.tenantId === this.ctx.tenantId);
    return (await this.groups().query((g) => g.tenantId === this.ctx.tenantId)).sort((a, b) => a.name.localeCompare(b.name))
      .map((g) => ({ ...g, memberCount: users.filter((u) => u.groups.includes(g.name)).length }));
  }
  private groupName(raw: unknown): string {
    const name = typeof raw === 'string' ? raw.trim() : '';
    if (!name) throw validation('name is required');
    if (!GROUP_NAME.test(name)) throw validation('group name must be 1–60 characters: letters, digits, space, dot, dash, underscore or @');
    return name;
  }
  async createGroup(input: { name: string; description?: string }, actor: string): Promise<Group> {
    this.needWorkspace();
    const name = this.groupName(input?.name);
    const description = this.description(input?.description);
    if ((await this.groups().query((g) => g.tenantId === this.ctx.tenantId && g.name.toLowerCase() === name.toLowerCase())).length) throw conflict(`group "${name}" already exists`);
    const g: Group = { id: this.ctx.newId(), tenantId: this.ctx.tenantId, name, ...(description ? { description } : {}) };
    await this.groups().put(g);
    await this.ctx.audit({ actor, kind: 'group.created', data: { name } });
    return g;
  }
  private description(raw: unknown): string | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    if (typeof raw !== 'string') throw validation('description must be text');
    if (raw.length > 300) throw validation('description is too long (max 300 characters)');
    return raw.trim() || undefined;
  }
  /** Rename and/or re-describe a group. A rename carries every member along (users hold groups by name). */
  async updateGroup(id: string, patch: { name?: string; description?: string }, actor: string): Promise<Group> {
    this.needWorkspace();
    const g = await this.groups().get(id);
    if (!g || g.tenantId !== this.ctx.tenantId) throw notFound('Group');
    const before = g.name;
    if (patch.name !== undefined) {
      const name = this.groupName(patch.name);
      if (name !== before) {
        if ((await this.groups().query((x) => x.tenantId === this.ctx.tenantId && x.id !== id && x.name.toLowerCase() === name.toLowerCase())).length) throw conflict(`group "${name}" already exists`);
        g.name = name;
        for (const u of await this.users().query((x) => x.tenantId === this.ctx.tenantId && x.groups.includes(before))) { u.groups = u.groups.map((n) => (n === before ? name : n)); await this.users().put(u); }
      }
    }
    if (patch.description !== undefined) { const d = this.description(patch.description); if (d) g.description = d; else delete g.description; }
    await this.groups().put(g);
    await this.ctx.audit({ actor, kind: 'group.updated', data: { id, from: before, name: g.name } });
    return g;
  }
  /** Replace a group's membership with exactly these users (ids). */
  async setGroupMembers(id: string, userIds: unknown, actor: string): Promise<{ group: Group; members: string[] }> {
    this.needWorkspace();
    const g = await this.groups().get(id);
    if (!g || g.tenantId !== this.ctx.tenantId) throw notFound('Group');
    if (!Array.isArray(userIds) || userIds.some((x) => typeof x !== 'string')) throw validation('userIds must be a list of user ids');
    const want = new Set(userIds as string[]);
    const users = await this.users().query((u) => u.tenantId === this.ctx.tenantId);
    const known = new Set(users.map((u) => u.id));
    for (const x of want) if (!known.has(x)) throw validation(`unknown user "${x}" in this workspace`);
    for (const u of users) {
      const has = u.groups.includes(g.name);
      if (want.has(u.id) && !has) { u.groups = [...u.groups, g.name]; await this.users().put(u); }
      else if (!want.has(u.id) && has) { u.groups = u.groups.filter((n) => n !== g.name); await this.users().put(u); }
    }
    await this.ctx.audit({ actor, kind: 'group.members', data: { name: g.name, count: want.size } });
    return { group: g, members: [...want] };
  }
  async deleteGroup(id: string, actor: string): Promise<void> {
    this.needWorkspace();
    const g = await this.groups().get(id);
    if (!g || g.tenantId !== this.ctx.tenantId) throw notFound('Group');
    // a deleted group must not linger on its members: they would silently keep matching group-scoped tasks
    const holders = await this.users().query((u) => u.tenantId === this.ctx.tenantId && u.groups.includes(g.name));
    for (const u of holders) { u.groups = u.groups.filter((n) => n !== g.name); await this.users().put(u); }
    await this.groups().delete(id);
    await this.ctx.audit({ actor, kind: 'group.deleted', data: { name: g.name, removedFrom: holders.length } });
  }

  // ---- roles ----
  /** This workspace's roles: its own Role rows plus every built-in role it has not customised yet (those are
   *  virtual, id `builtin:<name>`, until someone edits them). `userCount` = local users, `memberCount` = team seats. */
  async listRoles(): Promise<RoleInfo[]> {
    const rows = await this.roles().query((r) => r.tenantId === this.ctx.tenantId);
    const users = await this.users().query((u) => u.tenantId === this.ctx.tenantId);
    const seats = await this.ctx.store.repo<TenantMember>(Collections.tenantMembers).query((m) => m.tenantId === this.ctx.tenantId && (m.status === 'active' || m.status === 'invited'));
    const info = (r: Role, virtual: boolean): RoleInfo => ({
      ...r, builtIn: r.name in DEFAULT_ROLES, overridden: r.name in DEFAULT_ROLES && !virtual && [...r.permissions].sort().join() !== [...DEFAULT_ROLES[r.name]!].sort().join(), protected: r.name === 'admin',
      userCount: users.filter((u) => u.roles.includes(r.name)).length, memberCount: seats.filter((m) => m.role === r.name).length,
    });
    const have = new Set(rows.map((r) => r.name));
    const virtuals = this.ctx.tenantId === 'all' ? [] : Object.entries(DEFAULT_ROLES).filter(([n]) => !have.has(n)).map(([name, permissions]): Role => ({ id: `builtin:${name}`, tenantId: this.ctx.tenantId, name, permissions: [...permissions] }));
    return [...rows.map((r) => info(r, false)), ...virtuals.map((r) => info(r, true))].sort((a, b) => a.name.localeCompare(b.name));
  }
  private checkPermissions(input: unknown, grantable?: string[]): string[] {
    if (!Array.isArray(input)) throw validation('permissions must be a list');
    const perms = [...new Set(input as unknown[])] as string[];
    for (const p of perms) {
      const bad = permissionProblem(p);
      if (bad) throw validation(bad);
      if (grantable && !permissionGrants(grantable, p)) throw forbidden(`You cannot grant "${p}": you do not hold it yourself`);
    }
    if (perms.includes('*') && perms.length > 1) return ['*'];
    return perms.sort();
  }
  async createRole(input: { name: string; permissions: string[] }, actor: string, grantable?: string[]): Promise<Role> {
    this.needWorkspace();
    const name = (typeof input?.name === 'string' ? input.name : '').trim();
    if (!name) throw validation('name is required');
    if (!ROLE_NAME.test(name)) throw validation('role name must be 2–40 characters: start with a letter, then letters, digits, space, dot, dash or underscore');
    if (RESERVED_ROLES.includes(name.toLowerCase())) throw validation(`"${name}" is reserved`);
    const permissions = this.checkPermissions(input.permissions ?? [], grantable);
    if ([...await this.roleNames()].some((n) => n.toLowerCase() === name.toLowerCase())) throw conflict(`role "${name}" already exists`);
    const r: Role = { id: this.ctx.newId(), tenantId: this.ctx.tenantId, name, permissions };
    await this.roles().put(r);
    await this.ctx.audit({ actor, kind: 'role.created', data: { name, permissions } });
    return r;
  }
  /** Replace a role's permissions. Editing a built-in role the first time stores this workspace's own copy of it. */
  async updateRole(id: string, permissions: string[], actor: string, grantable?: string[]): Promise<Role> {
    this.needWorkspace();
    let r: Role | undefined;
    if (id.startsWith('builtin:')) {
      const name = id.slice('builtin:'.length);
      if (!(name in DEFAULT_ROLES)) throw notFound('Role');
      r = (await this.roles().query((x) => x.tenantId === this.ctx.tenantId && x.name === name))[0]
        ?? { id: this.ctx.newId(), tenantId: this.ctx.tenantId, name, permissions: [...DEFAULT_ROLES[name]!] };
    } else {
      r = await this.roles().get(id);
      if (!r || r.tenantId !== this.ctx.tenantId) throw notFound('Role');
    }
    if (r.name === 'admin') throw forbidden('the admin role\'s permissions cannot be changed');
    r.permissions = this.checkPermissions(permissions, grantable);
    await this.roles().put(r);
    await this.ctx.audit({ actor, kind: 'role.updated', data: { roleId: r.id, name: r.name, permissions: r.permissions } });
    return r;
  }
  /** Delete a custom role, or reset a customised built-in one to its default permissions. */
  async deleteRole(id: string, actor: string): Promise<{ reset?: boolean }> {
    this.needWorkspace();
    if (id.startsWith('builtin:')) throw validation('Built-in roles cannot be deleted — they are already at their defaults');
    const r = await this.roles().get(id);
    if (!r || r.tenantId !== this.ctx.tenantId) throw notFound('Role');
    if (r.name === 'admin') throw forbidden('the admin role cannot be deleted');
    const builtIn = r.name in DEFAULT_ROLES;
    if (!builtIn) {
      const info = (await this.listRoles()).find((x) => x.id === id);
      if (info && (info.userCount || info.memberCount)) throw conflict(`role "${r.name}" is still assigned to ${info.userCount} user(s) and ${info.memberCount} team member(s) — reassign them first`);
    }
    await this.roles().delete(id);
    await this.ctx.audit({ actor, kind: builtIn ? 'role.reset' : 'role.deleted', data: { name: r.name } });
    return builtIn ? { reset: true } : {};
  }
}

export type RoleInfo = Role & { builtIn: boolean; overridden: boolean; protected: boolean; userCount: number; memberCount: number };
const ROLE_NAME = /^[A-Za-z][A-Za-z0-9 _.-]{1,39}$/;
const GROUP_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.@-]{0,59}$/;
const RESERVED_ROLES = ['owner', 'system_admin'];
