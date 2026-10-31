import { type NodeDef, GENERAL } from '../def-types.ts';

export const def: NodeDef = {
  engineType: 'boundary',
  palette: [
    { key: 'error-catch', label: 'Error Catch', category: 'Events', icon: '⚠', color: '#dc2626', engineType: 'boundary', defaults: { type: 'boundary', name: 'Error catch', on: [], event: { error: '*' }, interrupting: true } },
    { key: 'boundary-timer', label: 'Timer Catch', category: 'Events', icon: '⏰', color: '#7c3aed', engineType: 'boundary', defaults: { type: 'boundary', name: 'Timer', on: [], event: { timer: { duration: 'P1D' } }, interrupting: false } },
    { key: 'boundary-compensation', label: 'Compensation', category: 'Events', icon: '↩', color: '#0d9488', engineType: 'boundary', defaults: { type: 'boundary', name: 'Compensation', on: [], event: { compensation: true }, interrupting: false } },
  ],
  ports: { maxIn: 0, maxOut: 1 },   // boundary: no incoming; one recovery outgoing
  schema: [GENERAL, { title: 'Error / boundary catch', fields: [
    { key: 'on', label: 'Catch from', widget: 'nodes', help: 'Pick node(s) to catch (boundary), or “All nodes” for a process-wide handler. Connect this node’s outgoing flow to the recovery path.' },
    { key: 'event', label: 'Trigger', widget: 'event', options: ['error', 'timer', 'message', 'signal', 'escalation', 'condition'] },
    { key: 'interrupting', label: 'Interrupting (cancel the caught activity)', widget: 'bool' },
    { key: 'rethrow', label: 'Rethrow to Global Error Handler', widget: 'bool', help: 'If enabled, unhandled errors bubble up to the project global error handler.' },
  ] }],
  diagram: { icon: 'warning', color: '#7c3aed', shape: 'circle' },
  typeLabel: 'Boundary event',
  docs: {
    summary: 'Catches errors, SLA timeouts, signals, or compensation on host activities and routes down recovery flows.',
    purpose: 'Provides exceptional path handling on activities. An interrupting boundary cancels the host task; a non-interrupting boundary fires concurrent reminder flows.',
    whenToUse: [
      'Use Error Catch on Service/REST Tasks to gracefully handle API downtime or 5xx responses.',
      'Use Interrupting Timer Catch on User Tasks to escalate overdue tasks to a supervisor.',
      'Use Non-Interrupting Timer Catch with a cycle (R/P1D) to send periodic email reminders.',
      'Use Compensation Boundary to register rollback actions if a saga fails downstream.',
    ],
    whenNotToUse: [
      'Do not connect incoming sequence flows into a Boundary Event (maxIn: 0).',
      'Do not make a timer interrupting if you intend to send a reminder without aborting the task.',
    ],
    scenarios: [
      {
        title: 'Error Catch Recovery Path',
        description: 'Catches a specific runtime error code (or * for all) and routes to an alternate flow.',
        whenToUse: 'Recovering from external REST failures, script syntax errors, or business faults.',
        exampleJson: { id: 'b_err', name: 'Catch API Error', type: 'boundary', on: ['http_task_1'], interrupting: true, event: { error: 'SERVICE_ERROR' } },
      },
      {
        title: 'Interrupting SLA Escalation Timer',
        description: 'Cancels the waiting task once the duration elapses and diverts execution to an escalation branch.',
        whenToUse: 'Hard SLAs where overdue work must be reallocated.',
        exampleJson: { id: 'b_timer_esc', name: '48h SLA Escalation', type: 'boundary', on: ['user_task_1'], interrupting: true, event: { timer: { duration: 'PT48H' } } },
      },
      {
        title: 'Non-Interrupting SLA Reminder',
        description: 'Fires periodically while keeping the host task alive and open in the user inbox.',
        whenToUse: 'Periodic reminder emails or warning notifications.',
        exampleJson: { id: 'b_timer_remind', name: 'Daily Reminder', type: 'boundary', on: ['user_task_1'], interrupting: false, event: { timer: { cycle: 'R3/P1D' } } },
      },
    ],
    fields: [
      { key: 'name', label: 'Name', type: 'string', default: 'Boundary event', required: true, description: 'Display name.' },
      { key: 'on', label: 'Catch From (Nodes)', type: 'nodes', required: false, description: 'Specific nodes to attach to, or empty for process-wide catch.' },
      { key: 'event', label: 'Event Trigger', type: 'event', required: true, description: 'Event trigger configuration (error, timer, signal, compensation).' },
      { key: 'interrupting', label: 'Interrupting', type: 'bool', default: true, required: false, description: 'True aborts host activity; false spawns concurrent reminder branch.' },
    ],
    gotchas: [
      'When an error is caught, the error code, node ID, and message are automatically saved into the process variable errorInfo.',
      'Completing a user task before its boundary timer fires will automatically cancel the scheduled timer job.',
    ],
  },
};
