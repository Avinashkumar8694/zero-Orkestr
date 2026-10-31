import { type NodeDef, GENERAL } from '../def-types.ts';

export const def: NodeDef = {
  engineType: 'userTask',
  palette: [{ key: 'userTask', label: 'User Task', category: 'Tasks', icon: '👤', color: '#2563eb', engineType: 'userTask', defaults: { type: 'userTask', name: 'User Task', group: 'user' } }],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [GENERAL, { title: 'Assignment', fields: [
    { key: 'group', label: 'Group / role', widget: 'text', placeholder: 'examiners' },
    { key: 'assignee', label: 'Assignee (specific user)', widget: 'text' },
    { key: 'businessAdmin', label: 'Business administrator', widget: 'text' },
    { key: 'excludedOwners', label: 'Excluded owners', widget: 'stringlist' },
  ] }, { title: 'Form & behavior', fields: [
    { key: 'form', label: 'Form name', widget: 'assetRef', assetKind: 'forms' },
    { key: 'priority', label: 'Priority', widget: 'number' },
    { key: 'dueDate', label: 'Due date / SLA', widget: 'text', placeholder: 'PT8H or 2026-01-01' },
    { key: 'skippable', label: 'Skippable', widget: 'bool' },
    { key: 'description', label: 'Task description', widget: 'textarea' },
  ] }, { title: 'Data', fields: [
    { key: 'inputs', label: 'Task inputs (taskVar ← processVar)', widget: 'keyval', valueSource: 'ownRef', help: 'Left = the field name the form/UI sees on this task. Right = "$name" to copy one of this process\'s own variables in, or a literal value.' },
    { key: 'outputs', label: 'Task outputs (processVar ← taskVar)', widget: 'keyval', keySource: 'own', help: 'Left = the process variable to write (pick an existing one to overwrite it, or type a new name). Right = the field name submitted on this task.' },
  ] }],
  diagram: { icon: 'user', color: '#2563eb', shape: 'rectangle' },
  typeLabel: 'User task',
  docs: {
    summary: 'Assigns manual work to a human user or group pool with interactive forms and SLA tracking.',
    purpose: 'Halts process execution to wait for a human user to complete an assignment via the task inbox or API. Supports candidate group claiming, delegation, form binding, and segregation of duties.',
    whenToUse: [
      'Use for manual reviews, approvals, signatures, underwriting inspections, or audits.',
      'Use candidate groups for pooled team queues where any available examiner can claim a task.',
      'Use excludedOwners to enforce dual control / four-eyes compliance policies.',
    ],
    whenNotToUse: [
      'Do not use a User Task for automated decisions or API lookups (use Business Rule Task or Service Task).',
      'Do not hardcode specific individual usernames in Assignee when a group pool is more resilient.',
    ],
    scenarios: [
      {
        title: 'Candidate Group Pool Claim',
        description: 'Publishes task to a shared team queue (e.g. underwriters). Any member can claim and complete.',
        whenToUse: 'Operational queues distributed across multiple staff.',
        exampleJson: { id: 'task_claim', name: 'Review Claim', type: 'userTask', group: 'underwriters', form: 'claim_form', dueDate: 'PT24H' },
      },
      {
        title: 'Direct Assignment with Priority',
        description: 'Assigns directly to a specific user with elevated priority for urgent review.',
        whenToUse: 'Supervisor escalation or account-specific assignments.',
        exampleJson: { id: 'task_direct', name: 'Escalated Review', type: 'userTask', assignee: 'lead_adjuster', priority: 100 },
      },
      {
        title: 'Segregation of Duties (Dual Control)',
        description: 'Prevents the creator or initiator from claiming or completing the approval step.',
        whenToUse: 'Financial approvals and fraud prevention.',
        exampleJson: { id: 'task_audit', name: 'Approve Payout', type: 'userTask', group: 'finance', excludedOwners: ['$creatorUser'] },
      },
    ],
    fields: [
      { key: 'name', label: 'Name', type: 'string', default: 'User Task', required: true, description: 'Display name rendered in inboxes and diagrams.' },
      { key: 'group', label: 'Group / Role', type: 'string', default: 'user', required: false, description: 'Candidate group eligible to claim this task from the pool.' },
      { key: 'assignee', label: 'Assignee', type: 'string', required: false, description: 'Specific user directly assigned this task.' },
      { key: 'excludedOwners', label: 'Excluded Owners', type: 'string[]', required: false, description: 'Usernames forbidden from claiming this task.' },
      { key: 'businessAdmin', label: 'Business Administrator', type: 'string', required: false, description: 'Manager with reassignment and escalation rights.' },
      { key: 'form', label: 'Form Name', type: 'string', required: false, description: 'Project Form asset rendered for interactive completion.' },
      { key: 'priority', label: 'Priority', type: 'number', default: 0, required: false, description: 'Relative priority (higher numbers appear first in the inbox).' },
      { key: 'dueDate', label: 'Due Date / SLA', type: 'string', required: false, description: 'ISO duration (PT8H) or date. Falls back to system setting defaultTaskSlaHours.' },
      { key: 'inputs', label: 'Task Inputs', type: 'keyval', required: false, description: 'Input variable mapping: taskVar ← $processVar.' },
      { key: 'outputs', label: 'Task Outputs', type: 'keyval', required: false, description: 'Output variable mapping: processVar ← taskVar.' },
    ],
    gotchas: [
      'If dueDate is omitted, the engine automatically calculates dueAt using the system defaultTaskSlaHours.',
      'Idle tasks left claimed can be automatically released back to the group pool if autoReleaseClaimedTaskHours is enabled.',
    ],
  },
};
