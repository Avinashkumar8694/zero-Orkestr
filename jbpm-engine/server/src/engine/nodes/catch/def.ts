import { type NodeDef, GENERAL } from '../def-types.ts';

export const def: NodeDef = {
  engineType: 'catch',
  palette: [
    { key: 'catch-timer', label: 'Timer', category: 'Events', icon: '⏱', color: '#7c3aed', engineType: 'catch', defaults: { type: 'catch', event: { timer: { duration: 'PT5M' } } } },
    { key: 'catch-message', label: 'Catch Message', category: 'Events', icon: '✉', color: '#7c3aed', engineType: 'catch', defaults: { type: 'catch', event: { message: 'Msg' } } },
  ],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [GENERAL, { title: 'Event', fields: [
    { key: 'event', label: 'Catch', widget: 'event', options: ['timer', 'message', 'signal', 'condition'] },
  ] }],
  diagram: { icon: 'clock', color: '#7c3aed', shape: 'circle' },
  typeLabel: 'Catch event',
  docs: {
    summary: 'Inline pause event that waits for an elapsed duration, specific date, or external signal/message.',
    purpose: 'Suspends the execution token in a durable state until the specified timer expires or an incoming signal matches.',
    whenToUse: [
      'Use Intermediate Timer to introduce durable delays (e.g. wait 24 hours before sending follow-up).',
      'Use Intermediate Signal to pause until an external event or webhook arrives.',
      'Use with Event-Based Gateways to race competing event paths.',
    ],
    whenNotToUse: [
      'Do not use to handle errors thrown by preceding tasks (use Boundary Error instead).',
      'Do not use shell sleep or in-memory setTimeout in scripts when an Intermediate Catch Timer is available.',
    ],
    scenarios: [
      {
        title: 'Durable Timer Delay',
        description: 'Schedules a persistent background TimerJob and pauses execution for a defined duration.',
        whenToUse: 'Cool-down periods, delayed notifications, and business waiting periods.',
        exampleJson: { id: 'catch_delay', name: 'Wait 1 Hour', type: 'catch', event: { timer: { duration: 'PT1H' } } },
      },
      {
        title: 'Wait for Inbound Signal',
        description: 'Pauses execution until a matching signal name is broadcast or sent directly to this instance.',
        whenToUse: 'Webhook callbacks, partner confirmations, and inter-process signals.',
        exampleJson: { id: 'catch_sig', name: 'Wait for Callback', type: 'catch', event: { signal: 'PartnerKycVerified' } },
      },
    ],
    fields: [
      { key: 'name', label: 'Name', type: 'string', default: 'Catch event', required: true, description: 'Display name.' },
      { key: 'event', label: 'Event Trigger', type: 'event', required: true, description: 'Trigger type: timer, signal, message, condition.' },
    ],
    gotchas: [
      'Timers are crash-resilient; if the engine restarts, pending timer jobs remain stored in the database.',
      'Suspending an instance will prevent its scheduled catch timers from firing until the instance is resumed.',
    ],
  },
};
