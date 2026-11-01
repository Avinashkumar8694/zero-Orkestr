import { type NodeDef, GENERAL } from '../def-types.ts';

export const def: NodeDef = {
  engineType: 'gateway',
  palette: [
    { key: 'gw-exclusive', label: 'Exclusive Gateway', category: 'Gateways', icon: '✕', color: '#f59e0b', engineType: 'gateway', defaults: { type: 'gateway', mode: 'exclusive' } },
    { key: 'gw-parallel', label: 'Parallel Gateway', category: 'Gateways', icon: '＋', color: '#f59e0b', engineType: 'gateway', defaults: { type: 'gateway', mode: 'parallel' } },
    { key: 'gw-inclusive', label: 'Inclusive Gateway', category: 'Gateways', icon: '○', color: '#f59e0b', engineType: 'gateway', defaults: { type: 'gateway', mode: 'inclusive' } },
    { key: 'gw-event', label: 'Event Gateway', category: 'Gateways', icon: '◇', color: '#f59e0b', engineType: 'gateway', defaults: { type: 'gateway', mode: 'event' } },
  ],
  ports: {} /* gateway: unlimited (fan in or out) */,   // diverging → many out; converging → many in
  schema: [GENERAL, { title: 'Gateway', fields: [
    { key: 'mode', label: 'Mode', widget: 'select', options: ['exclusive', 'parallel', 'inclusive', 'event', 'complex'] },
    { key: 'direction', label: 'Direction', widget: 'select', options: ['Diverging', 'Converging'] },
    { key: 'default', label: 'Default flow id', widget: 'text', help: 'Taken when no condition matches (exclusive/inclusive)' },
    { key: 'activationCondition', label: 'Activation condition (complex)', widget: 'textarea', placeholder: 'arrived >= 2', help: 'Complex join: continue as soon as this is true; sees arrived (tokens so far this round), total (incoming flows) and the process variables.' },
    { key: 'instantiate', label: 'Instantiate (event-based)', widget: 'bool', help: 'The process starts when any of the events after this gateway arrives (signal or message).' },
  ] }],
  diagram: { icon: 'branch', color: '#f59e0b', shape: 'diamond' },
  typeLabel: 'Gateway',
  docs: {
    summary: 'Controls execution branching and joining: Exclusive (XOR), Parallel (AND), Inclusive (OR), and Event-based.',
    purpose: 'Routes execution tokens through conditional branching, concurrent parallel execution, or event races.',
    whenToUse: [
      'Use Exclusive Gateway for if/else or switch-case routing where exactly one path should execute.',
      'Use Parallel Gateway to spawn concurrent activities and synchronize them back into a single token.',
      'Use Inclusive Gateway when multiple matching conditions should all execute concurrently.',
      'Use Event Gateway to race between external incoming signals and timeout deadlines.',
    ],
    whenNotToUse: [
      'Do not mix multiple inputs and multiple outputs on the same gateway (split into Join then Fork).',
      'Do not place conditions on flows leaving a Parallel Gateway.',
    ],
    scenarios: [
      {
        title: 'Exclusive Decision Routing (XOR)',
        description: 'Evaluates outgoing conditions in order; takes the first true condition, or the default fallback.',
        whenToUse: 'Mutually exclusive business decision paths.',
        exampleJson: { id: 'gw_decision', name: 'Check Eligibility', type: 'gateway', mode: 'exclusive', default: 'flow_fallback' },
      },
      {
        title: 'Parallel Fork & Join (AND)',
        description: 'Diverging fork splits into N concurrent tokens; converging join waits for all incoming tokens.',
        whenToUse: 'Concurrent background checks or multi-party reviews.',
        exampleJson: { id: 'gw_fork', name: 'Parallel Verification', type: 'gateway', mode: 'parallel' },
      },
      {
        title: 'Event-Based Race',
        description: 'Races between competing events (e.g. Signal Catch vs Timer Catch). The first event to fire wins.',
        whenToUse: 'Waiting for a callback with a maximum timeout SLA.',
        exampleJson: { id: 'gw_event', name: 'Response vs Timeout', type: 'gateway', mode: 'event' },
      },
    ],
    fields: [
      { key: 'name', label: 'Name', type: 'string', default: 'Gateway', required: true, description: 'Display name.' },
      { key: 'mode', label: 'Mode', type: 'select', options: ['exclusive', 'parallel', 'inclusive', 'event'], default: 'exclusive', required: true, description: 'Routing algorithm.' },
      { key: 'direction', label: 'Direction', type: 'select', options: ['Diverging', 'Converging'], default: 'Diverging', required: false, description: 'Flow orientation.' },
      { key: 'default', label: 'Default Flow ID', type: 'string', required: false, description: 'Fallback sequence flow taken when no conditions match.' },
    ],
    gotchas: [
      'An Exclusive Gateway with no matching condition and no default flow will throw a runtime error.',
      'A Parallel Join will wait forever if one of the incoming branches is aborted or never emits a token.',
    ],
  },
};
