import { type NodeDef, GENERAL, EXECUTION, SLA, ADVANCED } from '../def-types.ts';
export const def: NodeDef = {
  engineType: 'subprocess',
  palette: [{ key: 'subprocess', label: 'Sub-process', category: 'Sub-process', icon: '▭', color: '#4f46e5', engineType: 'subprocess', defaults: { type: 'subprocess', nodes: [], flows: [] } }],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [GENERAL, { title: 'Sub-process', fields: [
    { key: 'transaction', label: 'Transaction', widget: 'bool', help: 'A cancel end inside it compensates the completed activities and raises TRANSACTION_CANCELLED in the parent.' },
    { key: 'adHoc', label: 'Ad-hoc', widget: 'bool', help: 'Its activities are not wired together: those marked autoStart begin, any other can be started on demand ("re-trigger a node"). Ends when the completion condition is true (or, without one, when nothing is left running).' },
    { key: 'completionCondition', label: 'Completion condition (ad-hoc)', widget: 'textarea', placeholder: 'completed >= 3', help: 'Sees completed (finished steps), active (running steps) and the process variables.' },
    { key: 'interrupting', label: 'Interrupting (event sub-process)', widget: 'bool', help: 'For an event sub-process: when it fires, stop everything else in the process (default). Untick to run beside the main flow.' },
    { key: 'on.error', label: 'Event sub-process on error', widget: 'text', help: 'Error code that triggers this as an event sub-process' },
  ] }, EXECUTION, SLA, ADVANCED],
  diagram: { icon: 'projects', color: '#4f46e5', shape: 'rectangle' },
  typeLabel: 'Sub-process',
};
