// The permission strings the API actually checks (one entry per `perm('…')` in the routes), grouped for the UI.
// Roles may only carry these (or `*`, or a namespace wildcard like `workflow:*`): a typo would otherwise silently
// grant nothing, which is the worst kind of IAM bug.
export interface PermissionInfo { key: string; label: string; group: string }

export const PERMISSION_CATALOG: PermissionInfo[] = [
  { key: 'workflow:view', label: 'View workflows, folders and processes', group: 'Workflows' },
  { key: 'workflow:edit', label: 'Create and edit workflows', group: 'Workflows' },
  { key: 'workflow:deploy', label: 'Deploy workflows', group: 'Workflows' },
  { key: 'workflow:run', label: 'Start and operate process instances', group: 'Workflows' },
  { key: 'workflowInstance:manage', label: 'Work on cases (workflow instances)', group: 'Cases' },
  { key: 'workflowInstance:admin', label: 'Manage case definitions (name → deployment mapping)', group: 'Cases' },
  { key: 'task:manage', label: 'Claim and complete tasks of your own groups', group: 'Tasks' },
  { key: 'task:viewAll', label: 'See every task in the workspace, not only your own and your groups\'', group: 'Tasks' },
  { key: 'task:reassign', label: 'Hand a task to someone outside its group, or to another group', group: 'Tasks' },
  { key: 'query:read', label: 'Read instances, tasks and reports', group: 'Insight' },
  { key: 'analytics:query', label: 'Run and save ad-hoc analytics queries', group: 'Insight' },
  { key: 'team:read', label: 'See the workspace team', group: 'Team' },
  { key: 'team:invite', label: 'Invite people to the workspace', group: 'Team' },
  { key: 'team:manage', label: 'Change or remove team members', group: 'Team' },
  { key: 'admin:iam', label: 'Manage users, roles and groups', group: 'Administration' },
];

export const KNOWN_PERMISSION_KEYS = new Set(PERMISSION_CATALOG.map((p) => p.key));
const NAMESPACES = new Set(PERMISSION_CATALOG.map((p) => p.key.split(':')[0]!));

/** null when `p` is a grantable permission string, otherwise why it is not */
export function permissionProblem(p: unknown): string | null {
  if (typeof p !== 'string' || !p) return 'permissions must be non-empty strings';
  if (p === '*' || KNOWN_PERMISSION_KEYS.has(p)) return null;
  if (p.endsWith(':*') && NAMESPACES.has(p.slice(0, -2))) return null;
  return `unknown permission "${p}"`;
}
