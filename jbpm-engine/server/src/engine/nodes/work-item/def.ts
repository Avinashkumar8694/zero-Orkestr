import { type NodeDef, GENERAL, EXECUTION, SLA } from '../def-types.ts';
// Operation tasks backed by work-item handlers. Each palette tile presets the handler; the property
// panel lets you pick the handler, supply params ($var), and map results back to variables.
export const def: NodeDef = {
  engineType: 'workItem',
  palette: [
    { key: 'email', label: 'Email', category: 'Tasks', icon: '✉', color: '#16a34a', engineType: 'workItem', defaults: { type: 'workItem', name: 'Send email', handler: 'Email', params: { to: '', subject: '', body: '' } } },
    { key: 'sms', label: 'SMS', category: 'Tasks', icon: '💬', color: '#16a34a', engineType: 'workItem', defaults: { type: 'workItem', name: 'Send SMS', handler: 'SMS', params: { to: '', text: '' } } },
    { key: 'db', label: 'DB Task', category: 'Tasks', icon: '🗄', color: '#2563eb', engineType: 'workItem', defaults: { type: 'workItem', name: 'DB query', handler: 'DBQuery', params: { query: '' } } },
    { key: 'compute', label: 'Compute', category: 'Tasks', icon: '∑', color: '#0891b2', engineType: 'workItem', defaults: { type: 'workItem', name: 'Compute', handler: 'Compute', params: { expression: '' }, resultTo: { result: 'result' } } },
    { key: 'log', label: 'Log', category: 'Tasks', icon: '📝', color: '#64748b', engineType: 'workItem', defaults: { type: 'workItem', name: 'Log', handler: 'Log', params: { message: '' } } },
  ],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [GENERAL, { title: 'Work item', fields: [
    { key: 'handler', label: 'Handler', widget: 'select', options: ['Email', 'SMS', 'DBQuery', 'Compute', 'Log'], help: 'Email/SMS/DB call the configured service URL (deployment env), else simulate. Compute evaluates a JS expression.' },
    { key: 'params', label: 'Parameters (value or $var)', widget: 'keyval', valueSource: 'ownRef', help: 'Right side: "$name" to pass one of this process\'s own variables, or a literal value.' },
    { key: 'resultTo', label: 'Map result → variable', widget: 'keyval', keySource: 'own', help: 'Left = this process\'s variable to write (pick an existing one to overwrite it, or type a new name), e.g. result ← result, sent ← sent, rows ← rows.' },
  ] }, EXECUTION, SLA],
  diagram: { icon: 'admin', color: '#0891b2', shape: 'rectangle' },
  typeLabel: 'Work item',
};
