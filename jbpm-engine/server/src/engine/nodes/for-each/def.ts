import { type NodeDef, GENERAL, EXECUTION } from '../def-types.ts';
export const def: NodeDef = {
  engineType: 'forEach',
  palette: [{ key: 'forEach', label: 'Multi-Instance', category: 'Sub-process', icon: '⇶', color: '#4f46e5', engineType: 'forEach', defaults: { type: 'forEach', process: '', over: 'items' } }],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [GENERAL, { title: 'Multi-instance', fields: [
    { key: 'process', label: 'Process', widget: 'processRef', help: 'Run once per item, on any process behind a currently active deployment.' },
    { key: 'over', label: 'Collection variable', widget: 'varRef', varSource: 'own', placeholder: 'applicablePolicies', help: 'One of this process\'s own variables, holding the array to iterate.' },
    { key: 'as', label: 'Item variable', widget: 'text', placeholder: 'currentPolicy', help: 'New variable name on the CHILD process, set to the current item on each run.' },
    { key: 'collectInto', label: 'Collect results into', widget: 'varRef', varSource: 'own', help: 'This process\'s variable to collect every child\'s item result into, as an array. Pick an existing one to overwrite, or type a new name.' },
    { key: 'itemResult', label: 'Item result variable', widget: 'varRef', varSource: 'called', help: 'Which variable on the CHILD process holds its one result — read back into "Collect results into" above.' },
    { key: 'parallel', label: 'Run in parallel', widget: 'bool' },
    { key: 'pass', label: 'Pass-through variables', widget: 'stringlist', varSource: 'own', help: 'This process\'s own variables to copy into every child run unchanged.' },
  ] }, EXECUTION],
  diagram: { icon: 'projects', color: '#4f46e5', shape: 'rectangle' },
  typeLabel: 'Multi-instance',
};
