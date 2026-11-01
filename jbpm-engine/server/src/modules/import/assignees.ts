// Users and groups a jBPM project assigns its tasks to. On import the ones this workspace lacks are created with the least permission:
// groups as plain groups, users as DISABLED accounts with the read-only viewer role (an administrator sets a password and enables them).
import { randomBytes } from 'node:crypto';
import type { AppContext } from '../../context.ts';
import type { EngineProject } from '../../sdk/index.ts';
import { Collections } from '../../domain.ts';
import { IamService } from '../iam/service.ts';

const split = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : []).map((x) => String(x).trim()).filter(Boolean);
const dynamic = (x: string) => /^[$#]\{|^\$/.test(x);          // #{var} / ${var} / $var are resolved per instance, not names to create
export interface Assignees { users: string[]; groups: string[] }

/** Every user and group named by a user task (also inside sub-processes). A name in `actors` may be either, as in jBPM: it counts as a group when the
 *  project also uses it as a group (GroupId), otherwise as a user. */
export function collectAssignees(engine: EngineProject): Assignees {
  const users = new Set<string>(), groups = new Set<string>(), ambiguous = new Set<string>();
  const walk = (nodes: any[]) => {
    for (const n of nodes || []) {
      if (n.type === 'userTask') {
        for (const g of [...split(n.group), ...split(n.groups), ...split(n.businessAdminGroups)]) if (!dynamic(g)) groups.add(g);
        for (const u of [...split(n.assignee), ...split(n.businessAdmin), ...split(n.excludedOwners), ...split(n.stakeholders)]) if (!dynamic(u)) users.add(u);
        for (const a of [...split(n.actors), ...split(n.taskInputs?.ActorId)]) if (!dynamic(a)) ambiguous.add(a);
      }
      if (Array.isArray(n.nodes)) walk(n.nodes);
    }
  };
  for (const p of engine.processes || []) walk(p.nodes as any[]);
  for (const a of ambiguous) (groups.has(a) ? groups : users).add(a);
  for (const g of groups) users.delete(g);
  return { users: [...users].sort(), groups: [...groups].sort() };
}

export interface Provisioned { createdGroups: string[]; createdUsers: string[]; failed: Array<{ name: string; kind: 'user' | 'group'; reason: string }> }

/** Creates what is missing (case-insensitively); never touches an existing user or group. */
export async function provisionAssignees(ctx: AppContext, engine: EngineProject, actor: string): Promise<Provisioned> {
  const out: Provisioned = { createdGroups: [], createdUsers: [], failed: [] };
  const want = collectAssignees(engine);
  const iam = new IamService(ctx);
  const t = ctx.tenantId;
  const haveGroups = new Set((await ctx.store.repo<any>(Collections.groups).query((g) => g.tenantId === t)).map((g) => String(g.name).toLowerCase()));
  const existingUsers = await ctx.store.repo<any>(Collections.users).query((u) => u.tenantId === t);
  const haveUsers = new Set(existingUsers.flatMap((u) => [String(u.username).toLowerCase(), String(u.email || '').toLowerCase()]).filter(Boolean));
  const haveRoles = new Set((await ctx.store.repo<any>(Collections.roles).query((r) => r.tenantId === t)).map((r) => String(r.name)));
  for (const name of want.groups) {
    if (haveGroups.has(name.toLowerCase())) continue;
    try { await iam.createGroup({ name, description: 'Created by project import (task assignment)' }, actor); out.createdGroups.push(name); haveGroups.add(name.toLowerCase()); }
    catch (e) { out.failed.push({ name, kind: 'group', reason: (e as Error).message }); }
  }
  for (const username of want.users) {
    if (haveUsers.has(username.toLowerCase()) || haveGroups.has(username.toLowerCase())) continue;
    try {
      // an unguessable password nobody is told: the account cannot be used until an administrator resets it and enables it
      const u = await iam.createUser({ username, password: `Aa1!${randomBytes(18).toString('base64url')}`, roles: haveRoles.has('viewer') ? ['viewer'] : [], groups: [] }, actor);
      await iam.updateUser(u.id, { active: false }, actor);
      out.createdUsers.push(username); haveUsers.add(username.toLowerCase());
    } catch (e) { out.failed.push({ name: username, kind: 'user', reason: (e as Error).message }); }
  }
  return out;
}
