import { type NodeDef, GENERAL } from '../def-types.ts';
export const def: NodeDef = {
  engineType: 'throw',
  palette: [
    { key: 'throw-signal', label: 'Throw Signal', category: 'Events', icon: '📣', color: '#7c3aed', engineType: 'throw', defaults: { type: 'throw', event: { signal: 'Go' } } },
    { key: 'throw-compensation', label: 'Compensate', category: 'Events', icon: '↩', color: '#0d9488', engineType: 'throw', defaults: { type: 'throw', event: { compensation: true } } },
  ],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [GENERAL, { title: 'Event', fields: [
    { key: 'event', label: 'Throw', widget: 'event', options: ['signal', 'message', 'escalation', 'link', 'compensation'] },
    { key: 'event.ref', label: 'Compensate activity (optional)', widget: 'text', help: 'Host node id to compensate; blank = compensate all completed activities' },
    { key: 'event.correlationKey', label: 'Correlate to', widget: 'varRef', varSource: 'ownRef', placeholder: '$claimId', help: 'Deliver only to the waiting instance whose own correlationKey matches this variable’s value; blank = deliver to every instance waiting on this name' },
  ] }],
  diagram: { icon: 'mail', color: '#7c3aed', shape: 'circle' },
  typeLabel: 'Throw event',
};
