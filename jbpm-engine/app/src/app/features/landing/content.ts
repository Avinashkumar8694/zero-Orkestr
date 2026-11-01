// Landing page content for Orkestr
export interface PublicPlan {
  key: string;
  name: string;
  description: string;
  isDefault: boolean;
  isCustom: boolean;
  trialDays: number | null;
  contactConfig: { type: 'email' | 'url'; value: string; label?: string } | null;
  limits: Record<string, unknown>;
  features: string[];
  status?: 'active' | 'disabled' | 'upcoming';
}

export const FALLBACK_PLANS: PublicPlan[] = [
  {
    key: 'trial',
    name: 'Free trial',
    description: 'Explore the visual workflow designer, process engine, and execution runtime for 7 days.',
    isDefault: true,
    isCustom: false,
    trialDays: 7,
    contactConfig: null,
    limits: { concurrentRequests: 50, requestsPerMinute: 600, instancesPerDay: 200, instancesPerWeek: 1000, instancesPerMonth: 3000, maxActiveInstances: 50, maxActiveTimers: 100, maxWorkflows: 10, maxTeamMembers: 5, maxDeployments: 20 },
    features: ['Visual Workflow Designer', 'Process Execution', 'Task Inbox', 'Decision Tables', 'Versioned Deployments'],
  },
  {
    key: 'custom',
    name: 'Custom plan',
    description: 'Volume, custom integrations, dedicated execution sidecars, and limits agreed with us. Contact us to configure your workspace.',
    isDefault: false,
    isCustom: true,
    trialDays: null,
    contactConfig: { type: 'email', value: 'sales@orkestr.io', label: 'Contact us' },
    limits: { maxWorkflows: -1, maxTeamMembers: -1 },
    features: ['Unlimited Workflows & Instances', 'Dedicated Execution Sidecar', 'Custom hitPolicies & Rules', 'High-availability clustering', 'Dedicated 24/7 SLA Support'],
  },
];

export const STANDARDS = ['BPMN 2.0', 'DMN 1.3 Rules', 'Case Management', 'Token Runtime', 'jBPM kjar', 'Enterprise Multi-tenant'];

export const ICON: Record<string, string> = {
  designer: 'M12 19l7-7 3 3-7 7-3-3zM18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z',
  route: 'M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2v7a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-7zM2 12l3.5-7h13L22 12',
  rules: 'M4 4h16v16H4V4zm4 4h8v2H8V8zm0 4h8v2H8v-2zm0 4h5v2H8v-2z',
  deploy: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  radar: 'M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2zm0 18a8 8 0 1 1 8-8 8 8 0 0 1-8 8zm0-14a6 6 0 1 0 6 6 6 6 0 0 0-6-6zm0 10a4 4 0 1 1 4-4 4 4 0 0 1-4 4z',
  schema: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 2l5 5h-5V4zM8 12h8v2H8v-2zm0 4h8v2H8v-2z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4',
  bolt: 'M13 2 3 14h9l-1 8 10-12h-9l1-8z',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  chart: 'M18 20V10M12 20V4M6 20v-6',
  login: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  play: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zM10 8l6 4-6 4V8z',
  calendar: 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM16 2v4M8 2v4M3 10h18',
  check: 'M20 6 9 17l-5-5',
  moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
};

export const CHIPS = [
  { icon: 'calendar', text: '7-day free trial' },
  { icon: 'bolt', text: 'Sub-millisecond dispatch' },
  { icon: 'shield', text: 'Isolated multi-tenant' },
  { icon: 'check', text: 'jBPM kjar compatible' },
];

export const FEATURES = [
  {
    icon: 'designer',
    title: 'Visual Workflow Designer',
    text: 'Model sequence flows, exclusive and parallel gateways, timers, and service tasks with an intuitive visual canvas and real-time validation.',
  },
  {
    icon: 'route',
    title: 'Subprocesses & Call Activities',
    text: 'Compose modular enterprise process hierarchies with multi-instance loops, parallel iterations, and boundary error catches.',
  },
  {
    icon: 'inbox',
    title: 'Dynamic Task Inbox',
    text: 'Human workflow management with role assignment, team claims, SLA tracking, form schemas, and automatic escalation timers.',
  },
  {
    icon: 'rules',
    title: 'Guided Decision Tables (DMN)',
    text: 'Define business logic tables with FIRST and UNIQUE hit policies, condition expressions, and instant roundtrip evaluation.',
  },
  {
    icon: 'deploy',
    title: 'Deployments & Branching',
    text: 'Git-like branching, immutable version snapshots, and zero-downtime active pointers. Roll back or canary test with one click.',
  },
  {
    icon: 'radar',
    title: 'Real-time Execution Tracking',
    text: 'Watch tokens advance along process paths, inspect variables at each step, and debug failures with comprehensive execution traces.',
  },
  {
    icon: 'schema',
    title: 'Case Management & Schemas',
    text: 'Dynamic JSON schemas, field validation rules, ad-hoc milestone triggers, and case file repositories for flexible business cases.',
  },
  {
    icon: 'shield',
    title: 'Enterprise Multi-tenancy & IAM',
    text: 'Strict per-workspace data isolation, granular role permissions, append-only audit trail, and automated rate limiting.',
  },
];

export const TOUR = [
  {
    key: 'designer',
    label: 'Workflow Designer',
    title: 'Visual Workflow & Process Canvas',
    text: 'Author processes in our engine-native model or standard BPMN. Drag-and-drop palette tools for service tasks, scripts, timers, and gateway routing with live validation.',
    img: 'feature_bpmn_designer.png',
  },
  {
    key: 'deployments',
    label: 'Deployments',
    title: 'Immutable Releases & Environment Pointers',
    text: 'Snapshot workflow versions, tag releases with environment labels, and switch the active deployment safely without terminating in-flight instances.',
    img: 'feature_deployments.png',
  },
  {
    key: 'instances',
    label: 'Instances & Diagnostics',
    title: 'Real-time Execution & Token State Tracking',
    text: 'Inspect active token positions, audit logs, variables state, and error stacks. Retry failed activities or abort runaway processes from a single pane.',
    img: 'feature_instances.png',
  },
  {
    key: 'cases',
    label: 'Human Task Inbox',
    title: 'Collaborative Workflows & Human Approvals',
    text: 'Human workflow management with role assignment, team claims, SLA tracking, dynamic form schemas, and automatic escalation timers.',
    img: 'feature_tasks_inbox.png',
  },
  {
    key: 'governance',
    label: 'Governance & Audit',
    title: 'Immutable Audit Trail & Enterprise IAM',
    text: 'Track who edited, deployed, or ran every workflow. Define custom roles, manage groups, and inspect audit logs down to the exact millisecond.',
    img: 'feature_audit_log.png',
  },
];

export interface Demo {
  key: string;
  title: string;
  text: string;
  steps: string[];
  img: string;
}

export interface DemoGroup {
  name: string;
  items: Demo[];
}

export const DEMOS: DemoGroup[] = [
  {
    name: 'Authoring & Modeling',
    items: [
      {
        key: 'model',
        title: 'Author a Visual Workflow',
        text: 'Create a multi-step approval process with exclusive gateways, timers, and service tasks.',
        steps: [
          'Create a project and open the process canvas',
          'Drag nodes from the palette: Start -> Service Task -> Gateway -> User Task -> End',
          'Configure variable input/output mappings and script conditions',
          'Validate with the problems panel before publishing',
        ],
        img: 'feature_bpmn_designer.png',
      },
      {
        key: 'decisions',
        title: 'Define Decision Tables (DMN)',
        text: 'Add DMN guided decision tables for automated pricing, risk scores, or routing rules.',
        steps: [
          'Add a new Guided Table asset to the project',
          'Configure conditions (e.g. amount > 10000, risk == "high")',
          'Set output values and choose FIRST or UNIQUE hit policy',
          'Link the decision table directly to a Business Rule Task',
        ],
        img: 'feature_decision_tables.png',
      },
    ],
  },
  {
    name: 'Execution & Operations',
    items: [
      {
        key: 'execution',
        title: 'Deploy and Start Instances',
        text: 'Deploy an immutable version and run processes via API or web console.',
        steps: [
          'Publish a version and click Deploy to production environment',
          'Start a new instance passing JSON process variables',
          'Watch tokens advance across nodes in the visual diagram',
          'Inspect completed node visits and variable transformations',
        ],
        img: 'feature_instances.png',
      },
      {
        key: 'tasks',
        title: 'Task Inbox & Human Approvals',
        text: 'Assign human tasks to user groups, claim, and submit form variables.',
        steps: [
          'Navigate to Tasks Inbox to view pending human work items',
          'Claim task for the logged-in user or delegate to a team member',
          'Fill in form fields and complete task to resume process token',
        ],
        img: 'feature_tasks_inbox.png',
      },
    ],
  },
];

export const STEPS = [
  {
    title: '1. Model your workflow',
    text: 'Use the visual canvas or import existing BPMN 2.0 XML / jBPM kjar archives. Define data variables and business rules.',
  },
  {
    title: '2. Snapshot & Deploy',
    text: 'Publish immutable versions with version numbers and environment tags. Activate with zero downtime across multiple instances.',
  },
  {
    title: '3. Orchestrate & Automate',
    text: 'Trigger instances via REST APIs or webhooks. Let the token engine handle timers, retries, and human approvals seamlessly.',
  },
];

export const TRUST = [
  'Strict per-workspace data isolation with zero data leakage',
  '100% compliant with standard workflow specification and jBPM export',
  'Append-only immutable audit trail recording every state change',
  'Sub-millisecond node transition throughput with sandbox protection',
];

export const FAQ = [
  {
    q: 'Can I import existing jBPM or BPMN 2.0 processes?',
    a: 'Yes! Orkestr provides lossless round-trip importing of standard BPMN 2.0 XML files and jBPM kjar project archives with full node and variable mapping preservation.',
  },
  {
    q: 'How does multi-tenancy work across workspaces?',
    a: 'Every project, process definition, deployment, running instance, task, and audit event carries a tenantId. All queries, caching, and execution threads are strictly isolated by workspace.',
  },
  {
    q: 'Can I run custom JavaScript or Java scripts?',
    a: 'JavaScript logic executes inside an isolated VM sandbox with a strict CPU and memory budget. For Java projects, a dedicated JVM sidecar compiles and runs Java expressions without downtime.',
  },
  {
    q: 'How are human user tasks assigned and completed?',
    a: 'User tasks support assignees, groups, business administrators, and excluded owners (for segregation of duties). Users claim and complete tasks through the Inbox UI or REST API.',
  },
];

export function trialFaq(plan: PublicPlan | undefined): { q: string; a: string } {
  if (!plan || !plan.trialDays) {
    return {
      q: 'What is included in the free trial?',
      a: 'Workspaces can get started immediately with full access to our visual workflow designer, token execution engine, decision tables, and task inbox. Choose a plan or contact enterprise sales to begin.',
    };
  }

  const featuresText = plan.features?.length
    ? ` Full access is included for: ${plan.features.join(', ')}.`
    : '';

  const limits = plan.limits as Record<string, unknown> | undefined;
  const n = (k: string) => (typeof limits?.[k] === 'number' && (limits[k] as number) >= 0 ? (limits[k] as number) : undefined);
  const parts = [
    n('maxWorkflows') !== undefined ? `${n('maxWorkflows')} workflows` : '',
    n('instancesPerDay') !== undefined ? `${n('instancesPerDay')} process runs per day (${n('instancesPerWeek') ?? '—'} per week, ${n('instancesPerMonth') ?? '—'} per month)` : '',
    n('concurrentRequests') !== undefined ? `${n('concurrentRequests')} concurrent API requests` : '',
    n('maxTeamMembers') !== undefined ? `${n('maxTeamMembers')} team members` : '',
  ].filter(Boolean);
  const limitsText = parts.length ? ` Trial allowances: ${parts.join(', ')}.` : '';

  return {
    q: 'What is included in the free trial?',
    a: `Your ${plan.trialDays}-day free trial gives you full access with no credit card required.${featuresText}${limitsText} When your trial ends, all your workflows and history remain intact while you select a plan or contact us.`,
  };
}
