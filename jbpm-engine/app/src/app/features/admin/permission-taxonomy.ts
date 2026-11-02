// Mirror of server/src/modules/iam/permissions.ts (the server rejects anything outside it, and the Roles page also
// loads the live list from GET /roles/permissions — this copy is only the offline fallback).
import type { PermissionInfo } from '../../core/models';

export const KNOWN_PERMISSIONS: PermissionInfo[] = [
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
export const FULL_ACCESS = '*';
