import { type NodeDef, GENERAL, EXECUTION, SLA, ADVANCED } from '../def-types.ts';
export const def: NodeDef = {
  engineType: 'subprocess',
  palette: [{ key: 'subprocess', label: 'Sub-process', category: 'Sub-process', icon: '▭', color: '#4f46e5', engineType: 'subprocess', defaults: { type: 'subprocess', nodes: [], flows: [] } }],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [GENERAL, { title: 'Sub-process', fields: [
    { key: 'transaction', label: 'Transaction', widget: 'bool' },
    { key: 'on.error', label: 'Event sub-process on error', widget: 'text', help: 'Error code that triggers this as an event sub-process' },
  ] }, EXECUTION, SLA, ADVANCED],
  diagram: { icon: 'projects', color: '#4f46e5', shape: 'rectangle' },
  typeLabel: 'Sub-process',
};
