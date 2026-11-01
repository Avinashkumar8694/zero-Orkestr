import { type NodeDef, GENERAL, SLA } from '../def-types.ts';
export const def: NodeDef = {
  engineType: 'receive',
  palette: [{ key: 'receive', label: 'Receive Task', category: 'Tasks', icon: '📥', color: '#16a34a', engineType: 'receive', defaults: { type: 'receive', message: 'Msg' } }],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [GENERAL, { title: 'Message', fields: [
    { key: 'message', label: 'Message name', widget: 'assetRef', assetKind: 'messages' },
    { key: 'implementation', label: 'Implementation', widget: 'select', options: ['##WebService', 'Other'] },
  ] }, SLA],
  diagram: { icon: 'download', color: '#16a34a', shape: 'rectangle' },
  typeLabel: 'Receive task',
};
