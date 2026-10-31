import { type NodeDef, GENERAL } from '../def-types.ts';

export const def: NodeDef = {
  engineType: 'start',
  palette: [
    { key: 'start', label: 'Start', category: 'Events', icon: '▶', color: '#16a34a', engineType: 'start', defaults: { type: 'start', name: 'Start' } },
    { key: 'start-signal', label: 'Start (Signal)', category: 'Events', icon: '📡', color: '#16a34a', engineType: 'start', defaults: { type: 'start', on: { signal: 'Start' } } },
    { key: 'start-timer', label: 'Start (Timer)', category: 'Events', icon: '⏰', color: '#16a34a', engineType: 'start', defaults: { type: 'start', on: { timer: 'R/PT1H' } } },
  ],
  ports: { maxIn: 0, maxOut: 1 },   // start: exactly one outgoing
  schema: [GENERAL, { title: 'Trigger', fields: [
    { key: 'on', label: 'Start trigger', widget: 'event', options: ['none', 'signal', 'message', 'timer', 'condition'], help: 'How instances of this process are started' },
    { key: 'on.timer', label: 'Timer / cron', widget: 'text', help: 'ISO duration (PT1H), date, or recurring cycle (R/PT1H). The active deployment auto-starts instances on schedule.' },
  ] }],
  diagram: { icon: 'play', color: '#16a34a', shape: 'circle' },
  typeLabel: 'Start event',
  docs: {
    summary: 'Begins process execution on manual invocation, scheduled timer, or incoming event signal.',
    purpose: 'Marks the formal entry point of a BPMN process. When an instance is triggered, an execution token is generated and passed down its outgoing sequence flow.',
    whenToUse: [
      'Use None Start for standard user-driven, REST API, or webhook-initiated workflows.',
      'Use Timer / Cron Start for periodic reconciliations, daily sweeps, or batch processing.',
      'Use Signal Start to decouple interdependent workflows via enterprise event broadcasting.',
      'Use Error Start inside Event Sub-Processes to handle global process-wide exceptions.',
    ],
    whenNotToUse: [
      'Do not connect incoming sequence flows into a Start node (maxIn: 0).',
      'Do not place multiple default None Start events in the same process definition.',
      'Do not use Timer Start inside an embedded subprocess.',
    ],
    scenarios: [
      {
        title: 'Manual / REST Start',
        description: 'Standard trigger invoked explicitly via POST /instances with process variables.',
        whenToUse: 'Interactive forms, synchronous API calls, and case initiation.',
        exampleJson: { id: 'start_1', name: 'Start', type: 'start' },
      },
      {
        title: 'Recurring Timer / Cron Start',
        description: 'Durable scheduler spawns an instance periodically (e.g. every hour or daily at midnight).',
        whenToUse: 'Automated background sweeps, SLA checks, and batch jobs.',
        exampleJson: { id: 'start_timer', name: 'Hourly Schedule', type: 'start', on: { timer: 'R/PT1H' } },
      },
      {
        title: 'Broadcast Signal Start',
        description: 'Instantiates a new process when a matching untargeted broadcast signal is emitted.',
        whenToUse: 'Event-driven multi-process choreography.',
        exampleJson: { id: 'start_sig', name: 'Onboarding Event', type: 'start', on: { signal: 'UserRegistered' } },
      },
    ],
    fields: [
      { key: 'name', label: 'Name', type: 'string', default: 'Start', required: true, description: 'Display name rendered on diagrams and execution traces.' },
      { key: 'on', label: 'Start Trigger', type: 'select', options: ['none', 'signal', 'message', 'timer', 'condition'], default: 'none', required: false, description: 'The initiation trigger mechanism.' },
      { key: 'on.timer', label: 'Timer / Cron', type: 'string', required: false, description: 'ISO duration (PT1H), date, or recurring cycle (R/PT1H).' },
      { key: 'on.signal', label: 'Signal Name', type: 'string', required: false, description: 'Name of the broadcast signal that triggers this start.' },
    ],
    gotchas: [
      'Timer and Signal starts only activate when their deployment is marked Active in the environment.',
      'If tenant quotas (maxActiveInstances) are exhausted, timer start occurrences are skipped rather than crashing.',
    ],
  },
};
