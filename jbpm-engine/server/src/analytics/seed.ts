// Built-in analytics APIs, shipped as MIGRATIONS: each migration has a version and is applied to a workspace exactly once (tracked by
// a per-workspace marker), at startup for every existing workspace and when a workspace is created. A later release adds a new
// migration (version 2, 3 …) and only that one is applied; a restart with nothing new does nothing, and an API a workspace deleted
// stays deleted. A slug the workspace already uses is left alone.
import type { AnalyticsQuery, Cond, Value } from './engine.ts';
import type { ParamSpec } from './service.ts';

export interface SeedApi { slug: string; name: string; description: string; query: AnalyticsQuery; params?: ParamSpec[]; cacheSeconds?: number }
export interface SeedMigration { version: number; description: string; apis: SeedApi[] }

const eq = (field: string, value: Value): Cond => ({ field, op: 'eq', value });

export const SEED_MIGRATIONS: SeedMigration[] = [
  {
    version: 1,
    description: 'Core operational analytics: instances, failures, tasks, cases, errors, deployments',
    apis: [
      {
        slug: 'instances-by-status', name: 'Process instances by status',
        description: 'How many process instances are running, waiting, completed, failed, aborted or suspended.',
        query: { from: 'process', groupBy: [{ field: 'process.status', as: 'status' }], metrics: [{ fn: 'count', as: 'instances' }], sort: [{ field: 'instances', dir: 'desc' }] },
      },
      {
        slug: 'instances-started-per-day', name: 'Process instances started per day (last 30 days)',
        description: 'Daily volume of started instances for the last 30 days, with how many ended and the average duration.',
        query: {
          from: 'process', where: { op: 'and', items: [{ field: 'process.startedAt', op: 'gte', value: { now: '-30d' } }] },
          groupBy: [{ field: 'process.startedAt', bucket: 'day', as: 'day' }],
          metrics: [{ fn: 'count', as: 'started' }, { fn: 'count', field: 'process.endedAt', as: 'ended' }, { fn: 'avg', field: 'process.durationMs', as: 'avgDurationMs' }],
          sort: [{ field: 'day', dir: 'asc' }], limit: 60,
        },
      },
      {
        slug: 'failed-instances', name: 'Failed process instances',
        description: 'The most recent failed instances with the node and message they failed on.',
        query: {
          from: 'process', where: { op: 'and', items: [eq('process.status', 'failed')] },
          select: [{ field: 'process.id', as: 'instanceId' }, { field: 'process.processId', as: 'processId' }, { field: 'process.errorNodeId', as: 'node' }, { field: 'process.errorMessage', as: 'error' }, { field: 'process.startedBy', as: 'startedBy' }, { field: 'process.startedAt', as: 'startedAt' }],
          sort: [{ field: 'startedAt', dir: 'desc' }], limit: 100,
        },
      },
      {
        slug: 'process-duration-by-project', name: 'Process duration by project',
        description: 'Average and 95th-percentile duration of completed instances per project.',
        query: {
          from: 'process', joins: [{ rel: 'process.project' }], where: { op: 'and', items: [eq('process.status', 'completed')] },
          groupBy: [{ field: 'project.name', as: 'project' }],
          metrics: [{ fn: 'count', as: 'completed' }, { fn: 'avg', field: 'process.durationMs', as: 'avgMs' }, { fn: 'p95', field: 'process.durationMs', as: 'p95Ms' }],
          sort: [{ field: 'completed', dir: 'desc' }],
        },
      },
      {
        slug: 'open-tasks-by-assignee', name: 'Open tasks by assignee',
        description: 'Workload: tasks not yet completed, per assignee (blank = unclaimed, still in a group queue).',
        query: {
          from: 'task', where: { op: 'and', items: [{ field: 'task.status', op: 'in', value: ['created', 'reserved', 'inprogress'] }] },
          groupBy: [{ field: 'task.assignee', as: 'assignee' }, { field: 'task.group', as: 'group' }],
          metrics: [{ fn: 'count', as: 'openTasks' }, { fn: 'min', field: 'task.createdAt', as: 'oldestCreated' }],
          sort: [{ field: 'openTasks', dir: 'desc' }],
        },
      },
      {
        slug: 'task-turnaround-by-assignee', name: 'Task turnaround by assignee',
        description: 'For completed tasks: count, average and 90th-percentile total time, and average time waiting to be claimed.',
        query: {
          from: 'task', where: { op: 'and', items: [{ field: 'task.completedAt', op: 'notNull' }] },
          groupBy: [{ field: 'task.completedBy', as: 'completedBy' }],
          metrics: [{ fn: 'count', as: 'tasks' }, { fn: 'avg', field: 'task.totalMs', as: 'avgTotalMs' }, { fn: 'p90', field: 'task.totalMs', as: 'p90TotalMs' }, { fn: 'avg', field: 'task.waitMs', as: 'avgWaitMs' }],
          sort: [{ field: 'tasks', dir: 'desc' }],
        },
      },
      {
        slug: 'overdue-tasks', name: 'Overdue tasks',
        description: 'Tasks past their due time (open ones, or completed late).',
        query: {
          from: 'task', where: { op: 'and', items: [eq('task.overdue', true)] },
          select: [{ field: 'task.id', as: 'taskId' }, { field: 'task.name', as: 'name' }, { field: 'task.status', as: 'status' }, { field: 'task.assignee', as: 'assignee' }, { field: 'task.group', as: 'group' }, { field: 'task.dueAt', as: 'dueAt' }, { field: 'task.instanceId', as: 'instanceId' }],
          sort: [{ field: 'dueAt', dir: 'asc' }], limit: 200,
        },
      },
      {
        slug: 'cases-by-status', name: 'Cases by status',
        description: 'Case count per business status, per workflow.',
        query: { from: 'case', groupBy: [{ field: 'case.workflowName', as: 'workflow' }, { field: 'case.status', as: 'status' }], metrics: [{ fn: 'count', as: 'cases' }], sort: [{ field: 'cases', dir: 'desc' }] },
      },
      {
        slug: 'case-tasks', name: 'Tasks of a case',
        description: 'Every task under a case (including those in its sub-processes), with owner and timings. Parameter: caseId.',
        params: [{ name: 'caseId', type: 'string', required: true, label: 'Case id' }],
        query: {
          from: 'case', joins: [{ rel: 'case.tasks' }], where: { op: 'and', items: [eq('case.id', { param: 'caseId' })] },
          select: [{ field: 'case.id', as: 'caseId' }, { field: 'case.status', as: 'caseStatus' }, { field: 'task.id', as: 'taskId' }, { field: 'task.name', as: 'task' }, { field: 'task.status', as: 'taskStatus' }, { field: 'task.assignee', as: 'assignee' }, { field: 'task.createdAt', as: 'createdAt' }, { field: 'task.completedAt', as: 'completedAt' }, { field: 'task.totalMs', as: 'totalMs' }],
          sort: [{ field: 'createdAt', dir: 'asc' }], limit: 500,
        }, cacheSeconds: 0,
      },
      {
        slug: 'process-call-tree', name: 'Call tree of a process instance',
        description: 'Every sub-process / called instance beneath a process instance, with depth, status and duration. Parameter: instanceId.',
        params: [{ name: 'instanceId', type: 'string', required: true, label: 'Process instance id' }],
        query: {
          from: 'process', joins: [{ rel: 'process.descendants', as: 'sub', type: 'inner' }], where: { op: 'and', items: [eq('process.id', { param: 'instanceId' })] },
          select: [{ field: 'sub.depth', as: 'depth' }, { field: 'sub.id', as: 'instanceId' }, { field: 'sub.processId', as: 'processId' }, { field: 'sub.status', as: 'status' }, { field: 'sub.durationMs', as: 'durationMs' }, { field: 'sub.errorMessage', as: 'error' }],
          sort: [{ field: 'depth', dir: 'asc' }], limit: 500,
        }, cacheSeconds: 0,
      },
      {
        slug: 'errors-by-node', name: 'Unacknowledged errors by node',
        description: 'Where execution errors cluster: per node, how many errors and how many repeats, newest first.',
        query: {
          from: 'error', where: { op: 'and', items: [eq('error.acknowledged', false)] },
          groupBy: [{ field: 'error.nodeId', as: 'node' }, { field: 'error.nodeType', as: 'nodeType' }],
          metrics: [{ fn: 'count', as: 'errors' }, { fn: 'sum', field: 'error.occurrences', as: 'occurrences' }, { fn: 'max', field: 'error.at', as: 'lastAt' }],
          sort: [{ field: 'occurrences', dir: 'desc' }], limit: 100,
        },
      },
      {
        slug: 'deployments-overview', name: 'Deployments overview',
        description: 'Every deployment with its project, environment, version and status.',
        query: {
          from: 'deployment', joins: [{ rel: 'deployment.project' }],
          select: [{ field: 'project.name', as: 'project' }, { field: 'deployment.environment', as: 'environment' }, { field: 'deployment.status', as: 'status' }, { field: 'deployment.versionNumber', as: 'version' }, { field: 'deployment.deployedAt', as: 'deployedAt' }, { field: 'deployment.deployedBy', as: 'deployedBy' }],
          sort: [{ field: 'deployedAt', dir: 'desc' }], limit: 200,
        },
      },
    ],
  },
];

export const LATEST_SEED_VERSION = SEED_MIGRATIONS[SEED_MIGRATIONS.length - 1]!.version;
