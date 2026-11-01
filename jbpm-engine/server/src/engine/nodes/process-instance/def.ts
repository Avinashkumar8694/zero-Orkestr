import { type NodeDef, GENERAL } from '../def-types.ts';
import { buildSchema } from '../instance-ops/ops.ts';

const { operations, fields } = buildSchema('process');

export const def: NodeDef = {
  engineType: 'processInstance',
  palette: [{ key: 'processInstance', label: 'Process instance', category: 'Instances', icon: '🧭', color: '#0d9488', engineType: 'processInstance', defaults: { type: 'processInstance', operation: 'process.get' } }],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [
    GENERAL,
    { title: 'Operation', fields: [
      { key: 'operation', label: 'Operation', widget: 'select', options: operations.map((o) => o.key), help: 'Pick what this node does. Only that operation’s parameters are shown below.' },
    ] },
    { title: 'Parameters', fields },
    { title: 'Result', fields: [
      { key: 'resultTo', label: 'Store result in variable', widget: 'varRef', varSource: 'own', placeholder: 'result' },
      { key: 'resultPath', label: 'Result path', widget: 'text', placeholder: 'empty = whole result', help: 'Keep only part of the answer, e.g. data.claimAmount or tasks.0.assignee.' },
      { key: 'onError', label: 'If it fails', widget: 'select', options: ['fail', 'store'], help: '"fail" stops the node with error INSTANCE_OP_ERROR (an error boundary can catch it); "store" writes { error, code } into the result variable and carries on.' },
    ] },
  ],
  diagram: { icon: 'file', color: '#0d9488', shape: 'rectangle' },
  typeLabel: 'Process instance',
  docs: {
    summary: 'Read or control any process instance — its variables, history, tasks and children — from inside a flow.',
    purpose: 'One node, many operations: choose the operation, fill its parameters (literals or $variables), and keep the answer in a variable for later nodes and conditions.',
    whenToUse: ['Look up a case or instance at any moment of a flow (status, data, tasks, variables).', 'Update the case record as the flow progresses (status, data, comments, milestones).', 'Start or control other instances from a flow.', 'Pull published analytics into the flow ("analytics.run").'],
    whenNotToUse: ['Changing the instance that is running this node (refused with SELF_TARGET): use a script node.', 'Large result sets: narrow them with a Result path or an analytics query; a variable holds at most 1 MB.'],
    scenarios: [{ title: 'Read one value', description: 'Run the default operation and keep only one field of the answer.', whenToUse: 'Branch on the business status of the case or instance.', exampleJson: { id: 'n1', type: 'processInstance', operation: 'process.get', resultTo: 'info', resultPath: 'status' } }],
    fields: [
      { key: 'operation', label: 'Operation', type: 'select', required: true, description: 'One of the operations listed in the properties panel.' },
      { key: 'resultTo', label: 'Result variable', type: 'string', required: false, description: 'Variable that receives the result.' },
      { key: 'resultPath', label: 'Result path', type: 'string', required: false, description: 'Dotted path into the result.' },
      { key: 'onError', label: 'If it fails', type: 'select', options: ['fail', 'store'], default: 'fail', required: false, description: 'Fail the node, or store the error and continue.' },
    ],
    gotchas: ['Operations act with the engine’s own authority inside this workspace (another workspace’s ids are "not found"); who may DESIGN such a flow is governed by workflow:edit.', 'Writes to the running instance itself are refused (SELF_TARGET); reads of it are served from its live state.'],
  },
};
