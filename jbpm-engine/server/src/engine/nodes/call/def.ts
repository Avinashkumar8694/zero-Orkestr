import { type NodeDef, GENERAL, EXECUTION } from '../def-types.ts';
export const def: NodeDef = {
  engineType: 'call',
  palette: [{ key: 'call', label: 'Call Activity', category: 'Sub-process', icon: '⇥', color: '#4f46e5', engineType: 'call', defaults: { type: 'call', process: '' } }],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [GENERAL, { title: 'Called process', fields: [
    { key: 'process', label: 'Process', widget: 'processRef', placeholder: 'child-workflow.process', help: 'Any process behind a currently active deployment — in this project or another. Not deployed yet? Deploy it first, or type the id/key now and deploy before running.' },
    { key: 'inputs', label: 'Inputs (childVar ← parentVar)', widget: 'keyval', keySource: 'called', valueSource: 'ownRef', help: 'Left = a variable declared on the called process. Right = "$name" to copy one of this process\'s own variables in, or a literal value.' },
    { key: 'outputs', label: 'Outputs (parentVar ← childVar)', widget: 'keyval', keySource: 'own', valueSource: 'called', help: 'Left = the variable to write on THIS process (pick an existing one to overwrite it, or type a new name). Right = the variable to read from the called process once it completes.' },
    { key: 'independent', label: 'Independent (don’t wait)', widget: 'bool', help: 'Fire-and-forget: the parent continues immediately and the child keeps running standalone even after the parent completes or aborts' },
  ] }, EXECUTION],
  diagram: { icon: 'arrowRight', color: '#4f46e5', shape: 'rectangle' },
  typeLabel: 'Call activity',
};
