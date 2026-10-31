// OpenAPI 3.0 specification for the engine's REST API, served at GET /api/openapi.json and rendered
// by Swagger UI at GET /api/docs. Hand-authored to mirror the jBPM KIE-Server Swagger surface: authoring,
// versioning, deployment lifecycle, runtime instances, human tasks, and the query/analytics module.

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const listOf = (name: string) => ({ type: 'object', properties: { items: { type: 'array', items: ref(name) } } });
const ok = (schema: any) => ({ '200': { description: 'OK', content: { 'application/json': { schema } } } });
const created = (schema: any) => ({ '201': { description: 'Created', content: { 'application/json': { schema } } } });
const idParam = (name = 'id', desc = 'Resource id') => ({ name, in: 'path', required: true, schema: { type: 'string' }, description: desc });
const q = (name: string, desc: string) => ({ name, in: 'query', required: false, schema: { type: 'string' }, description: desc });
const jsonBody = (schema: any, required = true) => ({ required, content: { 'application/json': { schema } } });

// ---- reusable component schemas (core entities) ----
const schemas = {
  Error: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } } } },
  Problem: { type: 'object', properties: { rule: { type: 'string' }, severity: { type: 'string', enum: ['error', 'warning'] }, message: { type: 'string' }, nodeId: { type: 'string' } } },
  ValidationResult: { type: 'object', properties: { ok: { type: 'boolean' }, errors: { type: 'array', items: ref('Problem') }, warnings: { type: 'array', items: ref('Problem') } } },
  Workflow: { type: 'object', properties: { id: { type: 'string' }, key: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, defaultBranchId: { type: 'string' }, folderId: { type: 'string', nullable: true }, variables: { type: 'array', items: {} }, createdAt: { type: 'string', format: 'date-time' } } },
  Folder: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, parentId: { type: 'string', nullable: true }, createdAt: { type: 'string', format: 'date-time' } } },
  Branch: { type: 'object', properties: { id: { type: 'string' }, workflowId: { type: 'string' }, name: { type: 'string' }, headVersionId: { type: 'string' } } },
  Version: { type: 'object', properties: { id: { type: 'string' }, branchId: { type: 'string' }, workflowId: { type: 'string' }, number: { type: 'integer' }, label: { type: 'string' }, state: { type: 'string', enum: ['draft', 'published'] }, engine: { type: 'object' } } },
  Deployment: { type: 'object', properties: { id: { type: 'string' }, workflowId: { type: 'string' }, versionId: { type: 'string' }, environment: { type: 'string' }, status: { type: 'string', enum: ['active', 'inactive', 'archived'] }, tags: { type: 'array', items: { type: 'string' } }, versionNumber: { type: 'integer' }, versionLabel: { type: 'string' }, env: { type: 'object', additionalProperties: { type: 'string' } }, deployedAt: { type: 'string', format: 'date-time' } } },
  NodeVisit: { type: 'object', properties: { tokenId: { type: 'string' }, nodeId: { type: 'string' }, type: { type: 'string' }, enteredAt: { type: 'string' }, exitedAt: { type: 'string' }, outcome: { type: 'string' } } },
  Token: { type: 'object', properties: { id: { type: 'string' }, nodeId: { type: 'string' }, state: { type: 'string', enum: ['active', 'waiting'] }, waitFor: { type: 'object' } } },
  Instance: { type: 'object', properties: { id: { type: 'string' }, workflowId: { type: 'string' }, deploymentId: { type: 'string' }, processId: { type: 'string' }, correlationKey: { type: 'string' }, status: { type: 'string', enum: ['running', 'waiting', 'completed', 'aborted', 'failed', 'suspended'] }, variables: { type: 'object' }, tokens: { type: 'array', items: ref('Token') }, history: { type: 'array', items: ref('NodeVisit') }, parentInstanceId: { type: 'string' }, startedAt: { type: 'string' }, startedBy: { type: 'string' }, endedAt: { type: 'string' } } },
  InstanceGraph: { type: 'object', properties: { nodes: { type: 'array', items: {} }, flows: { type: 'array', items: {} }, diagram: { type: 'object', properties: { activeNodeIds: { type: 'array', items: { type: 'string' } }, visitedNodeIds: { type: 'array', items: { type: 'string' } }, status: { type: 'string' } } }, counts: { type: 'object', additionalProperties: { type: 'integer' }, description: 'per-node execution count (jBPM instance badges)' }, status: { type: 'string' } } },
  Task: { type: 'object', properties: { id: { type: 'string' }, instanceId: { type: 'string' }, nodeId: { type: 'string' }, name: { type: 'string' }, group: { type: 'string' }, assignee: { type: 'string' }, status: { type: 'string', enum: ['created', 'reserved', 'inprogress', 'completed', 'skipped', 'error'] }, inputs: { type: 'object' }, outputs: { type: 'object' }, createdAt: { type: 'string' }, dueAt: { type: 'string' }, completedAt: { type: 'string' }, completedBy: { type: 'string' } } },
  TimerJob: { type: 'object', properties: { id: { type: 'string' }, instanceId: { type: 'string' }, nodeId: { type: 'string' }, kind: { type: 'string', enum: ['duration', 'cycle', 'date', 'start'] }, dueAt: { type: 'string' }, cycle: { type: 'string' }, status: { type: 'string', enum: ['scheduled', 'fired', 'cancelled'] }, deploymentId: { type: 'string' }, processId: { type: 'string' } } },
  UserRow: { type: 'object', properties: { user: { type: 'string' }, groups: { type: 'array', items: { type: 'string' } }, startedInstances: { type: 'integer' }, openTasks: { type: 'integer' }, completedTasks: { type: 'integer' } } },
  ProcessDef: { type: 'object', properties: { processId: { type: 'string' }, name: { type: 'string' }, package: { type: 'string' }, deploymentId: { type: 'string' }, environment: { type: 'string' }, version: { type: 'string' }, nodes: { type: 'integer' }, instances: { type: 'object', properties: { total: { type: 'integer' }, active: { type: 'integer' } } } } },
  DurStats: { type: 'object', properties: { count: { type: 'integer' }, avgMs: { type: 'integer' }, minMs: { type: 'integer' }, maxMs: { type: 'integer' } } },
  Summary: { type: 'object', properties: { instances: { type: 'object' }, tasks: { type: 'object' }, deployments: { type: 'object' }, jobs: { type: 'object' } } },
  User: { type: 'object', properties: { id: { type: 'string' }, username: { type: 'string' }, roles: { type: 'array', items: { type: 'string' } }, groups: { type: 'array', items: { type: 'string' } }, active: { type: 'boolean' }, createdAt: { type: 'string' } } },
  ExecutionError: { type: 'object', properties: { id: { type: 'string' }, type: { type: 'string', enum: ['process', 'task', 'job', 'integration'] }, instanceId: { type: 'string' }, taskId: { type: 'string' }, jobId: { type: 'string' }, workflowId: { type: 'string' }, deploymentId: { type: 'string' }, processId: { type: 'string' }, nodeId: { type: 'string' }, nodeName: { type: 'string' }, nodeType: { type: 'string' }, message: { type: 'string' }, stack: { type: 'string' }, at: { type: 'string' }, occurrences: { type: 'integer' }, acknowledged: { type: 'boolean' }, acknowledgedBy: { type: 'string' }, acknowledgedAt: { type: 'string' } } },
  AuditEvent: { type: 'object', properties: { id: { type: 'string' }, at: { type: 'string' }, actor: { type: 'string' }, kind: { type: 'string' }, workflowId: { type: 'string' }, deploymentId: { type: 'string' }, instanceId: { type: 'string' }, taskId: { type: 'string' }, nodeId: { type: 'string' }, data: { type: 'object' } } },
  Notification: { type: 'object', properties: { id: { type: 'string' }, userId: { type: 'string' }, kind: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, link: { type: 'string' }, instanceId: { type: 'string' }, taskId: { type: 'string' }, deploymentId: { type: 'string' }, read: { type: 'boolean' }, at: { type: 'string' } } },
  TaskComment: { type: 'object', properties: { id: { type: 'string' }, taskId: { type: 'string' }, author: { type: 'string' }, body: { type: 'string' }, at: { type: 'string' } } },
  SystemSettings: { type: 'object', properties: { defaultPageSize: { type: 'integer', enum: [10, 20, 50, 100] }, instanceRetentionDays: { type: 'integer' }, auditRetentionDays: { type: 'integer' }, allowRunningVariableEdits: { type: 'boolean' }, executorIntervalSeconds: { type: 'integer' }, defaultJobRetries: { type: 'integer' }, slaWarnThresholdPct: { type: 'integer' }, sessionTimeoutHours: { type: 'integer' }, emailEnabled: { type: 'boolean' }, emailFrom: { type: 'string' }, smtpHost: { type: 'string' }, smtpPort: { type: 'integer' }, updatedAt: { type: 'string' }, updatedBy: { type: 'string' } } },
  VariableChange: { type: 'object', properties: { name: { type: 'string' }, from: {}, to: {}, at: { type: 'string' }, actor: { type: 'string' } } },
  Group: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' } } },
  Role: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } } } },
};

// ---- paths (grouped by tag) ----
const paths: Record<string, any> = {
  '/catalog/nodes': { get: { tags: ['Catalog'], summary: 'Node palette, property schemas and connection ports', responses: ok({ type: 'object' }) } },
  '/catalog/nodes/{engineType}': { get: { tags: ['Catalog'], summary: 'One node type definition', parameters: [idParam('engineType', 'Engine node type')], responses: { ...ok({ type: 'object' }), '404': { description: 'Not found', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/catalog/processes': { get: { tags: ['Catalog'], summary: 'Every process behind a currently-active deployment, tenant-wide — what a call activity / multi-instance node can resolve', responses: ok({ type: 'object' }) } },
  '/validate': { post: { tags: ['Authoring'], summary: 'Validate an in-progress process (no save)', requestBody: jsonBody({ type: 'object' }), responses: ok(ref('ValidationResult')) } },
  '/import/jbpm': { post: { tags: ['Import/Export'], summary: 'Import a jBPM kjar (file map) as a new project', requestBody: jsonBody({ type: 'object', properties: { files: { type: 'object', additionalProperties: { type: 'string' } }, name: { type: 'string' } } }), responses: created({ type: 'object', properties: { workflowId: { type: 'string' }, processes: { type: 'integer' } } }) } },
  '/import/jbpm/deploy': { post: { tags: ['Import/Export'], summary: 'Import a jBPM kjar and deploy it immediately, in one step', requestBody: jsonBody({ type: 'object', properties: { files: { type: 'object', additionalProperties: { type: 'string' } }, name: { type: 'string' }, environment: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, env: { type: 'object', additionalProperties: { type: 'string' } } } }), responses: created({ type: 'object', properties: { workflowId: { type: 'string' }, processes: { type: 'integer' }, deploymentId: { type: 'string' } } }) } },

  '/folders': {
    get: { tags: ['Projects'], summary: 'List folders (Projects-page tree)', responses: ok(listOf('Folder')) },
    post: { tags: ['Projects'], summary: 'Create a folder', requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, parentId: { type: 'string', nullable: true } } }), responses: created(ref('Folder')) },
  },
  '/folders/{id}': {
    get: { tags: ['Projects'], summary: 'Get a folder', parameters: [idParam()], responses: ok(ref('Folder')) },
    patch: { tags: ['Projects'], summary: 'Rename or move a folder', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, parentId: { type: 'string', nullable: true } } }), responses: ok(ref('Folder')) },
    delete: { tags: ['Projects'], summary: 'Delete an empty folder', parameters: [idParam()], responses: { '204': { description: 'Deleted' }, '409': { description: 'Folder is not empty', content: { 'application/json': { schema: ref('Error') } } } } },
  },
  '/workflows': {
    get: { tags: ['Projects'], summary: 'List projects', responses: ok(listOf('Workflow')) },
    post: { tags: ['Projects'], summary: 'Create a project', requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } } }), responses: created(ref('Workflow')) },
  },
  '/workflows/{id}': {
    get: { tags: ['Projects'], summary: 'Get a project', parameters: [idParam()], responses: ok(ref('Workflow')) },
    patch: { tags: ['Projects'], summary: 'Update a project', parameters: [idParam()], requestBody: jsonBody({ type: 'object' }), responses: ok(ref('Workflow')) },
    delete: { tags: ['Projects'], summary: 'Archive a project', parameters: [idParam()], responses: { '204': { description: 'Archived' } } },
  },
  '/workflows/{id}/permissions': { put: { tags: ['Projects'], summary: 'Set project permissions', parameters: [idParam()], requestBody: jsonBody({ type: 'array', items: {} }), responses: ok(ref('Workflow')) } },
  '/workflows/{id}/variables': { put: { tags: ['Projects'], summary: 'Set project variables', parameters: [idParam()], requestBody: jsonBody({ type: 'array', items: {} }), responses: ok(ref('Workflow')) } },
  '/workflows/{id}/processes': {
    get: { tags: ['Processes'], summary: 'List processes in a project', parameters: [idParam()], responses: ok(listOf('ProcessDef')) },
    post: { tags: ['Processes'], summary: 'Add a process', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' } } }), responses: created({ type: 'object' }) },
  },
  '/workflows/{id}/processes/{pid}': {
    get: { tags: ['Processes'], summary: 'Get a process definition', parameters: [idParam(), idParam('pid', 'Process id')], responses: ok({ type: 'object' }) },
    put: { tags: ['Processes'], summary: 'Save a process definition', parameters: [idParam(), idParam('pid', 'Process id')], requestBody: jsonBody({ type: 'object' }), responses: ok({ type: 'object' }) },
    patch: { tags: ['Processes'], summary: 'Rename a process', parameters: [idParam(), idParam('pid', 'Process id')], requestBody: jsonBody({ type: 'object' }), responses: ok({ type: 'object' }) },
    delete: { tags: ['Processes'], summary: 'Remove a process', parameters: [idParam(), idParam('pid', 'Process id')], responses: { '204': { description: 'Removed' } } },
  },
  '/workflows/{id}/engine': { get: { tags: ['Projects'], summary: 'Assembled engine model (all processes + assets) for a project', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/workflows/{id}/export-engine': { get: { tags: ['Projects'], summary: 'Export project engine JSON for Node engine runner', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/workflows/{id}/jbpm-compatibility': { get: { tags: ['Projects'], summary: 'Inspect project compatibility with jBPM KIE runtime', parameters: [idParam()], responses: ok({ type: 'object', properties: { compatible: { type: 'boolean' }, errors: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } } } }) } },
  '/workflows/{id}/assets': {
    get: { tags: ['Assets'], summary: 'List project assets by kind', parameters: [idParam()], responses: ok({ type: 'object' }) },
    post: { tags: ['Assets'], summary: 'Add an asset', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { kind: { type: 'string' }, name: { type: 'string' }, fields: { type: 'object', description: 'Kind-specific fields beyond the name, e.g. { fact, baseline, target } for a scorecard — see GET /workflows/{id}/assets for each kind\'s nameField.' } } }), responses: created({ type: 'object' }) },
  },
  '/workflows/{id}/assets/{kind}/{name}': {
    get: { tags: ['Assets'], summary: 'Get one asset, with the process nodes that reference it', parameters: [idParam(), idParam('kind', 'Asset kind key, e.g. forms/rulesets/decisions'), idParam('name', "The asset's name (or nameField value, e.g. a ruleset's group)")], responses: ok({ type: 'object', properties: { kind: { type: 'string' }, asset: { type: 'object' }, usedBy: { type: 'array', items: { type: 'object' } } } }) },
    patch: { tags: ['Assets'], summary: 'Update an asset (rename and/or edit its fields); renaming re-points every process reference', parameters: [idParam(), idParam('kind', 'Asset kind key'), idParam('name', 'Current asset name')], requestBody: jsonBody({ type: 'object' }), responses: ok({ type: 'object', properties: { kind: { type: 'string' }, name: { type: 'string' } } }) },
    delete: { tags: ['Assets'], summary: 'Delete an asset — blocked (409) while any process node still references it', parameters: [idParam(), idParam('kind', 'Asset kind key'), idParam('name', 'Asset name')], responses: { '204': { description: 'Deleted' }, '409': { description: 'Still referenced', content: { 'application/json': { schema: ref('Error') } } } } },
  },
  '/workflows/{id}/assets/{kind}/{name}/test': {
    post: { tags: ['Assets'], summary: 'Execute, simulate, or test an asset according to its jBPM purpose', parameters: [idParam(), idParam('kind', 'Asset kind key'), idParam('name', 'Asset name')], requestBody: jsonBody({ type: 'object' }, false), responses: ok({ type: 'object' }) },
  },
  '/workflows/{id}/branches': {
    get: { tags: ['Versioning'], summary: 'List branches', parameters: [idParam()], responses: ok(listOf('Branch')) },
    post: { tags: ['Versioning'], summary: 'Create a branch', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, fromVersionId: { type: 'string' } } }), responses: created(ref('Branch')) },
  },
  '/branches/{id}': { get: { tags: ['Versioning'], summary: 'Get a branch', parameters: [idParam()], responses: ok(ref('Branch')) } },
  '/branches/{id}/versions': {
    get: { tags: ['Versioning'], summary: 'List versions on a branch', parameters: [idParam()], responses: ok(listOf('Version')) },
    post: { tags: ['Versioning'], summary: 'Save a draft version', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { engine: { type: 'object' }, message: { type: 'string' } } }), responses: created(ref('Version')) },
  },
  '/versions/{id}': { get: { tags: ['Versioning'], summary: 'Get a version', parameters: [idParam()], responses: ok(ref('Version')) } },
  '/versions/{id}/publish': { post: { tags: ['Versioning'], summary: 'Publish a draft (immutable) version', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { label: { type: 'string' } } }, false), responses: ok({ type: 'object' }) } },
  '/versions/{id}/validate': { post: { tags: ['Versioning'], summary: 'Validate a version', parameters: [idParam()], responses: ok(ref('ValidationResult')) } },
  '/versions/{a}/diff/{b}': { get: { tags: ['Versioning'], summary: 'Diff two versions', parameters: [idParam('a', 'Version A'), idParam('b', 'Version B')], responses: ok({ type: 'object' }) } },
  '/versions/{id}/deploy': { post: { tags: ['Deployments'], summary: 'Deploy a published version', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { environment: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, env: { type: 'object' }, activate: { type: 'boolean' } } }), responses: created(ref('Deployment')) } },
  '/versions/{id}/export': { get: { tags: ['Import/Export'], summary: 'Export a version as a jBPM kjar (file map)', parameters: [idParam()], responses: ok({ type: 'object', properties: { files: { type: 'object', additionalProperties: { type: 'string' } } } }) } },
  '/versions/{id}/export-engine': { get: { tags: ['Import/Export'], summary: 'Export version engine JSON for Node engine runner', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/versions/{id}/jbpm-compatibility': { get: { tags: ['Import/Export'], summary: 'Inspect version compatibility with jBPM KIE runtime', parameters: [idParam()], responses: ok({ type: 'object', properties: { compatible: { type: 'boolean' }, errors: { type: 'array', items: { type: 'string' } }, warnings: { type: 'array', items: { type: 'string' } } } }) } },

  '/deployments': { get: { tags: ['Deployments'], summary: 'List deployments across all projects', parameters: [q('workflowId', 'Filter by project'), q('environment', 'Filter by environment'), q('status', 'Filter by status')], responses: ok(listOf('Deployment')) } },
  '/workflows/{id}/deployments': { get: { tags: ['Deployments'], summary: 'List deployments for a project', parameters: [idParam()], responses: ok(listOf('Deployment')) } },
  '/deployments/{id}': { get: { tags: ['Deployments'], summary: 'Get a deployment', parameters: [idParam()], responses: ok(ref('Deployment')) } },
  '/deployments/{id}/tags': { post: { tags: ['Deployments'], summary: 'Add/remove deployment tags', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } } }), responses: ok(ref('Deployment')) } },
  '/deployments/{id}/activate': { post: { tags: ['Deployments'], summary: 'Activate (swaps the active one in the environment)', parameters: [idParam()], responses: ok(ref('Deployment')) } },
  '/deployments/{id}/rollback': { post: { tags: ['Deployments'], summary: 'Roll back to this deployment', parameters: [idParam()], responses: ok(ref('Deployment')) } },
  '/deployments/{id}/undeploy': { post: { tags: ['Deployments'], summary: 'Undeploy (deactivate)', parameters: [idParam()], responses: ok(ref('Deployment')) } },
  '/deployments/{id}/archive': { post: { tags: ['Deployments'], summary: 'Archive a deployment', parameters: [idParam()], responses: ok(ref('Deployment')) } },
  '/deployments/{id}/export': { get: { tags: ['Import/Export'], summary: 'Export a deployment as a jBPM kjar', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/deployments/{id}/definitions': { get: { tags: ['Processes'], summary: 'Process definitions in a deployment', parameters: [idParam()], responses: ok(listOf('ProcessDef')) } },

  '/instances': {
    get: { tags: ['Instances'], summary: 'List process instances', parameters: [q('workflowId', 'Filter by project'), q('status', 'Filter by status'), q('deploymentId', 'Filter by deployment'), q('correlationKey', 'Filter by correlation key')], responses: ok(listOf('Instance')) },
    post: { tags: ['Instances'], summary: 'Start a process instance', requestBody: jsonBody({ type: 'object', properties: { workflowId: { type: 'string' }, processId: { type: 'string' }, environment: { type: 'string' }, deploymentId: { type: 'string' }, variables: { type: 'object' }, correlationKey: { type: 'string' } } }), responses: created(ref('Instance')) },
  },
  '/instances/{id}': { get: { tags: ['Instances'], summary: 'Get an instance', parameters: [idParam()], responses: ok(ref('Instance')) } },
  '/instances/{id}/history': { get: { tags: ['Instances'], summary: 'Node-visit history', parameters: [idParam()], responses: ok({ type: 'array', items: ref('NodeVisit') }) } },
  '/instances/{id}/graph': { get: { tags: ['Instances'], summary: 'Diagram + per-node execution counts (instance badges)', parameters: [idParam()], responses: ok(ref('InstanceGraph')) } },
  '/instances/{id}/diagram-state': { get: { tags: ['Instances'], summary: 'Active/visited node ids', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/instances/{id}/related': { get: { tags: ['Instances'], summary: 'Parent + child (sub-process) instances', parameters: [idParam()], responses: ok({ type: 'object' }) } },
  '/instances/{id}/signal': { post: { tags: ['Instances'], summary: 'Send a signal/message to the instance', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, payload: {} } }), responses: ok(ref('Instance')) } },
  '/instances/{id}/retry': { post: { tags: ['Instances'], summary: 'Re-trigger a node (retry / replay)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { nodeId: { type: 'string' } } }), responses: ok(ref('Instance')) } },
  '/instances/{id}/suspend': { post: { tags: ['Instances'], summary: 'Suspend (cascades to the whole subtree)', parameters: [idParam()], responses: ok(ref('Instance')) } },
  '/instances/{id}/resume': { post: { tags: ['Instances'], summary: 'Resume the subtree', parameters: [idParam()], responses: ok(ref('Instance')) } },
  '/instances/{id}/abort': { post: { tags: ['Instances'], summary: 'Abort (cascades to active children)', parameters: [idParam()], responses: ok(ref('Instance')) } },

  '/tasks': { get: { tags: ['Human Tasks'], summary: 'List tasks', parameters: [q('assignee', 'Owned by user'), q('group', 'Group queue'), q('status', 'Task status'), q('overdue', 'true = only tasks past their dueAt and not yet completed/skipped')], responses: ok(listOf('Task')) } },
  '/tasks/{id}': {
    get: { tags: ['Human Tasks'], summary: 'Get a task', parameters: [idParam()], responses: ok(ref('Task')) },
    patch: { tags: ['Human Tasks'], summary: 'Admin edits: priority / due date (null dueAt clears it)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { priority: { type: 'integer' }, dueAt: { type: 'string', format: 'date-time', nullable: true } } }), responses: ok(ref('Task')) },
  },
  '/tasks/{id}/claim': { post: { tags: ['Human Tasks'], summary: 'Claim a task', parameters: [idParam()], responses: ok(ref('Task')) } },
  '/tasks/{id}/release': { post: { tags: ['Human Tasks'], summary: 'Release a task', parameters: [idParam()], responses: ok(ref('Task')) } },
  '/tasks/{id}/complete': { post: { tags: ['Human Tasks'], summary: 'Complete a task (resumes the instance)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { outputs: { type: 'object' } } }), responses: ok(ref('Task')) } },
  '/tasks/{id}/skip': { post: { tags: ['Human Tasks'], summary: 'Skip a task without completing it (only if the node is declared skippable)', parameters: [idParam()], responses: ok(ref('Task')) } },
  '/tasks/{id}/start': { post: { tags: ['Human Tasks'], summary: 'Start working (reserved → inprogress; starting from Ready implicitly claims)', parameters: [idParam()], responses: ok(ref('Task')) } },
  '/tasks/{id}/stop': { post: { tags: ['Human Tasks'], summary: 'Stop working (inprogress → reserved, ownership kept)', parameters: [idParam()], responses: ok(ref('Task')) } },
  '/tasks/{id}/save': { post: { tags: ['Human Tasks'], summary: 'Save partial outputs without completing', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { outputs: { type: 'object' } } }), responses: ok(ref('Task')) } },
  '/tasks/{id}/delegate': { post: { tags: ['Human Tasks'], summary: 'Delegate to a user (lands reserved in their inbox)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { to: { type: 'string' } } }), responses: ok(ref('Task')) } },
  '/tasks/{id}/forward': { post: { tags: ['Human Tasks'], summary: 'Forward to a user or group queue (back to Ready; target must claim)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { user: { type: 'string' }, group: { type: 'string' } } }), responses: ok(ref('Task')) } },
  '/tasks/{id}/remind': { post: { tags: ['Human Tasks'], summary: 'Send the current owner a reminder notification', parameters: [idParam()], responses: ok({ type: 'object', properties: { notified: { type: 'string' } } }) } },
  '/tasks/{id}/comments': {
    get: { tags: ['Human Tasks'], summary: 'List comments', parameters: [idParam()], responses: ok(listOf('TaskComment')) },
    post: { tags: ['Human Tasks'], summary: 'Add a comment', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { body: { type: 'string' } } }), responses: created(ref('TaskComment')) },
  },
  '/tasks/{id}/comments/{cid}': { delete: { tags: ['Human Tasks'], summary: 'Delete a comment (author or business admin)', parameters: [idParam(), idParam('cid', 'Comment id')], responses: { '204': { description: 'Deleted' } } } },
  '/tasks/{id}/events': { get: { tags: ['Human Tasks'], summary: 'Task audit trail (the Logs tab)', parameters: [idParam()], responses: ok(listOf('AuditEvent')) } },
  '/instances/{id}/variables': { put: { tags: ['Instances'], summary: 'Edit instance variables inline (audited; refused once the instance has ended)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', additionalProperties: {} }), responses: ok(ref('Instance')) } },
  '/instances/{id}/variable-history': { get: { tags: ['Instances'], summary: 'Per-variable change history (from the audit trail)', parameters: [idParam(), q('name', 'Only this variable')], responses: ok(listOf('VariableChange')) } },

  '/errors': { get: { tags: ['Execution Errors'], summary: 'List execution errors (the operational failure queue)', parameters: [q('type', 'Comma-separated: process,task,job,integration'), q('instanceId', 'Filter by instance'), q('taskId', 'Filter by task'), q('jobId', 'Filter by job'), q('workflowId', 'Filter by project'), q('processId', 'Filter by process'), q('acknowledged', 'true / false'), q('from', 'ISO lower bound'), q('to', 'ISO upper bound'), q('limit', 'Page size'), q('offset', 'Page offset')], responses: ok({ type: 'object', properties: { items: { type: 'array', items: ref('ExecutionError') }, total: { type: 'integer' } } }) } },
  '/errors/summary': { get: { tags: ['Execution Errors'], summary: 'Counts for the nav badge / Home KPI', responses: ok({ type: 'object', properties: { total: { type: 'integer' }, unacknowledged: { type: 'integer' }, last24h: { type: 'integer' } } }) } },
  '/errors/{id}': { get: { tags: ['Execution Errors'], summary: 'Get one error', parameters: [idParam()], responses: ok(ref('ExecutionError')) } },
  '/errors/{id}/ack': { post: { tags: ['Execution Errors'], summary: 'Acknowledge (take ownership; idempotent)', parameters: [idParam()], responses: ok(ref('ExecutionError')) } },
  '/errors/ack': { post: { tags: ['Execution Errors'], summary: 'Bulk acknowledge', requestBody: jsonBody({ type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } } } }), responses: ok({ type: 'object', properties: { results: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, ok: { type: 'boolean' }, reason: { type: 'string' } } } } } }) } },

  '/jobs': { get: { tags: ['Jobs & Timers'], summary: 'List timer jobs', parameters: [q('status', 'scheduled|fired|cancelled'), q('instanceId', 'Filter by instance'), q('kind', 'duration|cycle|date|start')], responses: ok(listOf('TimerJob')) } },
  '/jobs/{id}': { get: { tags: ['Jobs & Timers'], summary: 'Get a job', parameters: [idParam()], responses: ok(ref('TimerJob')) } },
  '/jobs/{id}/cancel': { post: { tags: ['Jobs & Timers'], summary: 'Cancel a scheduled job', parameters: [idParam()], responses: ok(ref('TimerJob')) } },
  '/jobs/{id}/trigger': { post: { tags: ['Jobs & Timers'], summary: 'Fire a scheduled job now', parameters: [idParam()], responses: ok(ref('TimerJob')) } },
  '/jobs/{id}/reschedule': { post: { tags: ['Jobs & Timers'], summary: 'Move the fire time (also revives a cancelled job)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { dueAt: { type: 'string', format: 'date-time' } } }), responses: ok(ref('TimerJob')) } },

  '/audit': { get: { tags: ['Governance'], summary: 'Audit log (admin)', parameters: [q('actor', 'Filter by actor'), q('kind', "Exact kind or prefix ending in '.' (e.g. 'task.')"), q('workflowId', 'Filter by project'), q('deploymentId', 'Filter by deployment'), q('instanceId', 'Filter by instance'), q('taskId', 'Filter by task'), q('from', 'ISO lower bound'), q('to', 'ISO upper bound'), q('limit', 'Page size'), q('offset', 'Page offset')], responses: ok({ type: 'object', properties: { items: { type: 'array', items: ref('AuditEvent') }, total: { type: 'integer' } } }) } },
  '/audit/facets': { get: { tags: ['Governance'], summary: 'Distinct kinds + actors for the filter dropdowns (admin)', responses: ok({ type: 'object', properties: { kinds: { type: 'array', items: { type: 'string' } }, actors: { type: 'array', items: { type: 'string' } } } }) } },

  '/notifications': { get: { tags: ['Notifications'], summary: "The caller's notifications (bell panel)", parameters: [q('unread', 'true = unread only'), q('limit', 'Max rows (default 50)')], responses: ok({ type: 'object', properties: { items: { type: 'array', items: ref('Notification') }, unread: { type: 'integer' } } }) } },
  '/notifications/read-all': { post: { tags: ['Notifications'], summary: 'Mark all read', responses: ok({ type: 'object', properties: { marked: { type: 'integer' } } }) } },
  '/notifications/{id}/read': { post: { tags: ['Notifications'], summary: 'Mark one read', parameters: [idParam()], responses: ok(ref('Notification')) } },

  '/settings/system': {
    get: { tags: ['Governance'], summary: 'Global system settings (singleton; defaults if never saved)', responses: ok(ref('SystemSettings')) },
    put: { tags: ['Governance'], summary: 'Update system settings (admin)', requestBody: jsonBody(ref('SystemSettings')), responses: ok(ref('SystemSettings')) },
  },

  '/query/process-definitions': { get: { tags: ['Query & Analytics'], summary: 'All active process definitions with live stats', responses: ok(listOf('ProcessDef')) } },
  '/query/process-definitions/{processId}/instances': { get: { tags: ['Query & Analytics'], summary: 'Instances of a process definition', parameters: [idParam('processId', 'Process id'), q('status', 'Filter by status')], responses: ok(listOf('Instance')) } },
  '/query/process-definitions/{processId}/signals': { get: { tags: ['Query & Analytics'], summary: 'Signals a process listens-for / throws', parameters: [idParam('processId', 'Process id')], responses: ok({ type: 'object', properties: { processId: { type: 'string' }, listensFor: { type: 'array', items: { type: 'string' } }, throws: { type: 'array', items: { type: 'string' } } } }) } },
  '/query/users': { get: { tags: ['Query & Analytics'], summary: 'Derived user directory with work counts', responses: ok(listOf('UserRow')) } },
  '/query/users/{user}/tasks': { get: { tags: ['Query & Analytics'], summary: 'Tasks owned by a user (inbox)', parameters: [idParam('user', 'User'), q('status', 'Task status')], responses: ok(listOf('Task')) } },
  '/query/users/{user}/tasks/completed': { get: { tags: ['Query & Analytics'], summary: 'Tasks completed by a user', parameters: [idParam('user', 'User')], responses: ok(listOf('Task')) } },
  '/query/groups/{group}/tasks': { get: { tags: ['Query & Analytics'], summary: 'Tasks for a group (queue)', parameters: [idParam('group', 'Group'), q('status', 'Task status')], responses: ok(listOf('Task')) } },
  '/query/instances/{id}/tasks': { get: { tags: ['Query & Analytics'], summary: 'Tasks of a process instance', parameters: [idParam()], responses: ok(listOf('Task')) } },
  '/query/analytics/tasks': { get: { tags: ['Query & Analytics'], summary: 'Task turn-around-time (by task, by assignee)', responses: ok({ type: 'object' }) } },
  '/query/analytics/processes': { get: { tags: ['Query & Analytics'], summary: 'Process turn-around-time + status mix', responses: ok({ type: 'object' }) } },
  '/query/analytics/summary': { get: { tags: ['Query & Analytics'], summary: 'Dashboard summary counts', responses: ok(ref('Summary')) } },
  '/query/jobs': { get: { tags: ['Query & Analytics'], summary: 'Timer jobs', parameters: [q('status', 'scheduled|fired|cancelled')], responses: ok(listOf('TimerJob')) } },

  '/auth/login': { post: { tags: ['IAM'], security: [], summary: 'Log in — issues a JWT (Bearer token) for every other endpoint', requestBody: jsonBody({ type: 'object', properties: { username: { type: 'string' }, password: { type: 'string' } } }), responses: { ...ok({ type: 'object', properties: { token: { type: 'string' }, user: ref('User') } }), '401': { description: 'Invalid credentials', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/plan/usage': { get: { tags: ['IAM'], summary: 'The workspace plan, its limits and current usage (process starts per day / week / month, workflows, team members, deployments, active instances and timers) with the reset times', responses: ok({ type: 'object', properties: { plan: { type: 'object' }, trialEndsAt: { type: 'string', nullable: true }, expired: { type: 'boolean' }, limits: { type: 'object' }, usage: { type: 'object' }, resources: { type: 'object' } } }) } },
  '/auth/config': { get: { tags: ['IAM'], security: [], summary: 'Configuration-driven sign-in surface: which of SSO / local login / registration / forgot-password / email-verification are on, plus the password policy', responses: ok({ type: 'object', properties: { appName: { type: 'string' }, sso: { type: 'boolean' }, localLogin: { type: 'boolean' }, registration: { type: 'boolean' }, forgotPassword: { type: 'boolean' }, emailVerification: { type: 'boolean' }, registrationMethod: { type: 'string', enum: ['temp_password', 'password'] }, tempPasswordHours: { type: 'integer' }, otpLogin: { type: 'boolean' }, tosUrl: { type: 'string', nullable: true }, passwordMinLength: { type: 'integer' }, ssoLoginUrl: { type: 'string', nullable: true } } }) } },
  '/auth/oidc/login': { get: { tags: ['IAM'], security: [], summary: 'Start single sign-on — redirects the browser to the identity server (authorization code + PKCE)', parameters: [{ in: 'query', name: 'redirect', schema: { type: 'string' }, description: 'Same-origin path to return to after sign-in' }], responses: { '302': { description: 'Redirect to the identity server; sets the signed HttpOnly oidc_tx login-transaction cookie' }, '404': { description: 'Single sign-on is not configured', content: { 'application/json': { schema: ref('Error') } } }, '503': { description: 'Identity server unreachable', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/oidc/callback': { get: { tags: ['IAM'], security: [], summary: 'OIDC redirect URI — exchanges the code and sends the browser to the app with the tokens in the URL fragment (never the query string)', parameters: [{ in: 'query', name: 'code', schema: { type: 'string' } }, { in: 'query', name: 'state', schema: { type: 'string' } }, { in: 'query', name: 'error', schema: { type: 'string' } }], responses: { '302': { description: 'Redirect to <app>/auth/callback#access_token=…&id_token=…&expires_in=… (or #error=…)' } } } },
  '/auth/oidc/logout': { get: { tags: ['IAM'], security: [], summary: 'Sign out — ends the identity-server session and returns to the app', parameters: [{ in: 'query', name: 'id_token_hint', schema: { type: 'string' } }], responses: { '302': { description: 'Redirect to the identity server’s end-session endpoint, or the app when it has none' } } } },
  '/auth/register': { post: { tags: ['IAM'], security: [], summary: 'Self-register (AUTH_REGISTRATION + local login). Default method temp_password: no password is collected — a temporary password is emailed and the account is created when it is used to sign in (always 202, whether or not the address is new). Method password: the caller chooses a password (201)', requestBody: jsonBody({ type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' } } }), responses: { '201': { description: 'Created (method password); verificationRequired tells the UI whether to ask the user to confirm their email' }, '202': { description: 'Temporary password emailed (method temp_password)' }, '404': { description: 'Registration is disabled', content: { 'application/json': { schema: ref('Error') } } }, '409': { description: 'Email already registered', content: { 'application/json': { schema: ref('Error') } } }, '422': { description: 'Invalid email or weak password', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/set-password': { post: { tags: ['IAM'], security: [], summary: 'Temp-password onboarding step 2: replace the emailed temporary password with your own (needs the short-lived setupToken returned by sign-in); returns the first session', requestBody: jsonBody({ type: 'object', properties: { setupToken: { type: 'string' }, password: { type: 'string' } } }), responses: { ...ok({ type: 'object', properties: { token: { type: 'string' }, user: ref('User') } }), '401': { description: 'Setup step expired — sign in again', content: { 'application/json': { schema: ref('Error') } } }, '422': { description: 'Weak password, or same as the temporary one', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/otp/request': { post: { tags: ['IAM'], security: [], summary: 'Email a 6-digit sign-in code (AUTH_OTP_LOGIN; always 202, never reveals whether the address exists)', requestBody: jsonBody({ type: 'object', properties: { email: { type: 'string' } } }), responses: { '202': { description: 'Accepted' }, '404': { description: 'OTP sign-in is disabled', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/otp/verify': { post: { tags: ['IAM'], security: [], summary: 'Sign in with the emailed code (10 min, 5 attempts, single use)', requestBody: jsonBody({ type: 'object', properties: { email: { type: 'string' }, code: { type: 'string' } } }), responses: { ...ok({ type: 'object', properties: { token: { type: 'string' }, user: ref('User') } }), '401': { description: 'Invalid or expired code', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/verify-email': { post: { tags: ['IAM'], security: [], summary: 'Confirm an email address with the emailed single-use token', requestBody: jsonBody({ type: 'object', properties: { token: { type: 'string' } } }), responses: { '204': { description: 'Verified' }, '404': { description: 'Unknown or expired link', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/resend-verification': { post: { tags: ['IAM'], security: [], summary: 'Re-send the verification email (always 202 — never reveals whether the address exists)', requestBody: jsonBody({ type: 'object', properties: { email: { type: 'string' } } }), responses: { '202': { description: 'Accepted' } } } },
  '/auth/forgot-password': { post: { tags: ['IAM'], security: [], summary: 'Request a password-reset email (always 202 — never reveals whether the address exists)', requestBody: jsonBody({ type: 'object', properties: { email: { type: 'string' } } }), responses: { '202': { description: 'Accepted' }, '404': { description: 'Disabled', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/reset-password/check': { post: { tags: ['IAM'], security: [], summary: 'Is this reset link still valid?', requestBody: jsonBody({ type: 'object', properties: { token: { type: 'string' } } }), responses: ok({ type: 'object', properties: { valid: { type: 'boolean' } } }) } },
  '/auth/reset-password': { post: { tags: ['IAM'], security: [], summary: 'Set a new password with the emailed single-use token (1 h, one use); also unlocks the account', requestBody: jsonBody({ type: 'object', properties: { token: { type: 'string' }, password: { type: 'string' } } }), responses: { '204': { description: 'Password changed; existing sessions are revoked' }, '404': { description: 'Unknown or expired link', content: { 'application/json': { schema: ref('Error') } } }, '422': { description: 'Weak or reused password', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/auth/me': { get: { tags: ['IAM'], summary: 'The caller’s own identity + resolved permissions (from their current roles)', responses: ok({ type: 'object', properties: { user: { type: 'object', properties: { id: { type: 'string' }, username: { type: 'string' }, roles: { type: 'array', items: { type: 'string' } }, groups: { type: 'array', items: { type: 'string' } } } }, permissions: { type: 'array', items: { type: 'string' } } } }) } },
  '/auth/me/password': { post: { tags: ['IAM'], summary: 'Change your own password (requires the current one)', requestBody: jsonBody({ type: 'object', properties: { currentPassword: { type: 'string' }, newPassword: { type: 'string' } } }), responses: { '204': { description: 'Changed' }, '403': { description: 'Current password incorrect', content: { 'application/json': { schema: ref('Error') } } } } } },
  '/users': {
    get: { tags: ['IAM'], summary: 'List users (admin)', responses: ok(listOf('User')) },
    post: { tags: ['IAM'], summary: 'Create a user (admin)', requestBody: jsonBody({ type: 'object', properties: { username: { type: 'string' }, password: { type: 'string' }, roles: { type: 'array', items: { type: 'string' } }, groups: { type: 'array', items: { type: 'string' } } } }), responses: created(ref('User')) },
  },
  '/users/{id}': {
    get: { tags: ['IAM'], summary: 'Get a user (admin)', parameters: [idParam()], responses: ok(ref('User')) },
    patch: { tags: ['IAM'], summary: 'Update a user’s roles/groups/active flag (admin)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { roles: { type: 'array', items: { type: 'string' } }, groups: { type: 'array', items: { type: 'string' } }, active: { type: 'boolean' } } }), responses: ok(ref('User')) },
  },
  '/users/{id}/password': { post: { tags: ['IAM'], summary: 'Set a user’s password (admin)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { password: { type: 'string' } } }), responses: { '204': { description: 'Changed' } } } },
  '/groups': {
    get: { tags: ['IAM'], summary: 'List groups (admin)', responses: ok(listOf('Group')) },
    post: { tags: ['IAM'], summary: 'Create a group (admin)', requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } } }), responses: created(ref('Group')) },
  },
  '/groups/{id}': {
    patch: { tags: ['IAM'], summary: 'Rename / re-describe a group; a rename carries every member along (admin)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } } }), responses: ok(ref('Group')) },
    delete: { tags: ['IAM'], summary: 'Delete a group and detach it from its members (admin)', parameters: [idParam()], responses: { '204': { description: 'Deleted' } } },
  },
  '/groups/{id}/members': { put: { tags: ['IAM'], summary: 'Replace a group’s membership with exactly these users (admin)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { userIds: { type: 'array', items: { type: 'string' } } } }), responses: { '200': { description: 'Updated' } } } },
  '/roles': {
    get: { tags: ['IAM'], summary: 'List roles (admin)', responses: ok(listOf('Role')) },
    post: { tags: ['IAM'], summary: 'Create a role (admin)', requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } } } }), responses: created(ref('Role')) },
  },
  '/roles/permissions': { get: { tags: ['IAM'], summary: 'The permission strings roles may carry, grouped for display (admin)', responses: { '200': { description: 'Permission catalogue' } } } },
  '/roles/{id}': {
    patch: { tags: ['IAM'], summary: 'Replace a role’s permissions (admin; the built-in "admin" role is immutable)', parameters: [idParam()], requestBody: jsonBody({ type: 'object', properties: { permissions: { type: 'array', items: { type: 'string' } } } }), responses: ok(ref('Role')) },
    delete: { tags: ['IAM'], summary: 'Delete a custom role (409 while assigned), or reset a customised built-in role to its defaults (200 { reset: true }); "admin" cannot be deleted (admin)', parameters: [idParam()], responses: { '204': { description: 'Deleted' }, '200': { description: 'Built-in role reset to defaults' } } },
  },
};

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'jBPM-style BPM Engine API',
    version: '0.1.0',
    description: 'Node-native BPM engine REST API — authoring, versioning, deployment lifecycle, runtime process instances, human tasks, KIE-Server-style query & analytics, and IAM (users/groups/roles). Sign in with single sign-on (`GET /auth/oidc/login`, Identity Server, authorization code + PKCE) or, where enabled, `POST /auth/login`; send the resulting token as `Authorization: Bearer <token>` on every other request, plus `x-tenant-id` to pick the workspace (membership is enforced). Each route requires a permission granted by one of the caller’s roles — see `DEFAULT_ROLES` in modules/iam/service.ts.',
  },
  servers: [{ url: '/api', description: 'This server' }],
  tags: [
    { name: 'Catalog' }, { name: 'Authoring' }, { name: 'Projects' }, { name: 'Processes' }, { name: 'Assets' },
    { name: 'Versioning' }, { name: 'Deployments' }, { name: 'Instances' }, { name: 'Human Tasks' },
    { name: 'Execution Errors' }, { name: 'Jobs & Timers' }, { name: 'Notifications' }, { name: 'Governance' },
    { name: 'Query & Analytics' }, { name: 'Import/Export' }, { name: 'IAM' },
  ],
  components: {
    schemas,
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
  },
  security: [{ bearerAuth: [] }],
  paths,
};

/** Minimal self-contained Swagger UI page (loads the swagger-ui assets from a CDN). */
export const swaggerHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BPM Engine API — Swagger UI</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui.css" />
  <style> body { margin: 0; } .topbar { display: none; } </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
  <script>
    window.ui = SwaggerUIBundle({ url: 'openapi.json', dom_id: '#swagger-ui', deepLinking: true, docExpansion: 'none', filter: true });
  </script>
</body>
</html>`;
