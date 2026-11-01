import { type NodeDef, GENERAL } from '../def-types.ts';

export const def: NodeDef = {
  engineType: 'end',
  palette: [
    { key: 'end', label: 'End', category: 'Events', icon: '⏹', color: '#dc2626', engineType: 'end', defaults: { type: 'end', name: 'End' } },
    { key: 'end-terminate', label: 'End (Terminate)', category: 'Events', icon: '⛔', color: '#dc2626', engineType: 'end', defaults: { type: 'end', result: 'terminate' } },
  ],
  ports: { maxOut: 0 },   // end: no outgoing; multiple paths may converge into an end (unlimited in)
  schema: [GENERAL, { title: 'End behavior', fields: [
    { key: 'result', label: 'Result', widget: 'select', options: ['(normal)', 'terminate', 'cancel'], help: 'terminate cancels all other tokens and ends the whole instance · cancel (inside a transaction sub-process) compensates what completed, aborts the scope and raises TRANSACTION_CANCELLED in the parent, where an error boundary can catch it' },
    { key: 'throw', label: 'Throw event', widget: 'event', options: ['none', 'signal', 'error', 'escalation', 'message'] },
    { key: 'throw.rethrow', label: 'Rethrow to Global Error Handler', widget: 'bool', help: 'If true, bubbles the error end event up to the project global error handler.' },
    { key: 'throw.correlationKey', label: 'Correlate to', widget: 'varRef', varSource: 'ownRef', placeholder: '$claimId', help: 'Deliver only to the waiting instance whose own correlationKey matches this variable’s value; blank = deliver to every instance waiting on this name' },
  ] }],
  diagram: { icon: 'error', color: '#dc2626', shape: 'circle' },
  typeLabel: 'End event',
  docs: {
    summary: 'Consumes an execution token, completing a branch or terminating the entire process instance.',
    purpose: 'Marks the terminal boundary of an execution path. Normal end completes the token; Terminate end cancels all remaining active tokens and stops the instance immediately.',
    whenToUse: [
      'Use Normal End at the end of valid execution paths or parallel join sequences.',
      'Use Terminate End when a critical path aborts (e.g. Fraud Rejection) to cancel all remaining tasks.',
      'Use Error End to bubble structured BPMN error codes up to parent scopes or error boundaries.',
    ],
    whenNotToUse: [
      'Do not connect outgoing sequence flows from an End event (maxOut: 0).',
      'Do not use Terminate End when other branches are required to complete cleanup actions.',
    ],
    scenarios: [
      {
        title: 'Normal Token Completion',
        description: 'Finishes this execution branch. The instance completes when all active tokens reach an end.',
        whenToUse: 'Standard flow completion and parallel branch endpoints.',
        exampleJson: { id: 'end_1', name: 'End', type: 'end' },
      },
      {
        title: 'Immediate Instance Termination',
        description: 'Immediately terminates the whole instance, cancelling all active sibling tokens and pending timers.',
        whenToUse: 'Immediate rejection paths, fatal exceptions, or user cancellations.',
        exampleJson: { id: 'end_term', name: 'Reject & Terminate', type: 'end', result: 'terminate' },
      },
      {
        title: 'Error Throw End',
        description: 'Throws a BPMN error with a specific error code, caught by error boundaries or event sub-processes.',
        whenToUse: 'Business rule rejections and fault handling.',
        exampleJson: { id: 'end_err', name: 'Throw Error', type: 'end', throw: { error: 'INVALID_CREDIT_SCORE' } },
      },
    ],
    fields: [
      { key: 'name', label: 'Name', type: 'string', default: 'End', required: true, description: 'Display name rendered on diagrams.' },
      { key: 'result', label: 'Result Mode', type: 'select', options: ['(normal)', 'terminate'], default: '(normal)', required: false, description: 'Normal consumes token; terminate cancels all active tokens.' },
      { key: 'throw', label: 'Throw Event', type: 'select', options: ['none', 'signal', 'error', 'escalation', 'message'], default: 'none', required: false, description: 'Optional event thrown on completion.' },
      { key: 'throw.correlationKey', label: 'Correlate To', type: 'string', required: false, description: 'Variable reference ($claimId) for targeted delivery.' },
    ],
    gotchas: [
      'Terminate End cascades to non-independent child instances (call activities), cancelling them as well.',
      'An instance with parallel tokens only transitions to completed when ALL tokens finish or a Terminate End is reached.',
    ],
  },
};
