import { type NodeDef, GENERAL, EXECUTION, SLA } from '../def-types.ts';
export const def: NodeDef = {
  engineType: 'send',
  palette: [{ key: 'send', label: 'Send Task', category: 'Tasks', icon: '📤', color: '#16a34a', engineType: 'send', defaults: { type: 'send', message: 'Msg' } }],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [GENERAL, { title: 'Message', fields: [
    { key: 'message', label: 'Message name', widget: 'assetRef', assetKind: 'messages' },
    { key: 'implementation', label: 'Implementation', widget: 'select', options: ['##WebService', 'Other'] },
    { key: 'correlationKey', label: 'Correlate to', widget: 'varRef', varSource: 'ownRef', placeholder: '$claimId', help: 'Deliver only to the waiting instance whose own correlationKey matches this variable’s value; blank = deliver to every instance waiting on this name' },
  ] }, EXECUTION, SLA],
  diagram: { icon: 'upload', color: '#16a34a', shape: 'rectangle' },
  typeLabel: 'Send task',
};
