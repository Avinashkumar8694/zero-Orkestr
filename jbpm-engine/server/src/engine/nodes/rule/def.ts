import { type NodeDef, MULTI_INSTANCE, GENERAL, EXECUTION, SLA, ADVANCED } from '../def-types.ts';
export const def: NodeDef = {
  engineType: 'rule',
  palette: [{ key: 'rule', label: 'Business Rule', category: 'Tasks', icon: '📐', color: '#ea580c', engineType: 'rule', defaults: { type: 'rule', ruleflowGroup: 'group' } }],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [GENERAL, { title: 'DRL rules', fields: [
    { key: 'ruleflowGroup', label: 'Ruleflow group', widget: 'assetRef', assetKind: 'rulesets', placeholder: 'classify' },
  ] }, { title: 'DMN (alternative)', fields: [
    { key: 'dmn.namespace', label: 'DMN namespace', widget: 'text' },
    { key: 'dmn.model', label: 'DMN model name', widget: 'assetRef', assetKind: 'decisions' },
    { key: 'dmn.decision', label: 'Decision name', widget: 'text' },
  ] }, { title: 'Guided Decision Table (alternative)', fields: [
    { key: 'guidedTable', label: 'Guided table name', widget: 'assetRef', assetKind: 'guidedTables', help: 'Evaluate a guided decision table asset' },
  ] }, { title: 'Decision tree / scorecard (alternative)', fields: [
    { key: 'decisionTree', label: 'Decision tree name', widget: 'assetRef', assetKind: 'decisionTrees', help: 'Evaluate a guided decision tree asset' },
    { key: 'scorecard', label: 'Scorecard name', widget: 'assetRef', assetKind: 'scorecards', help: 'Evaluate a scorecard asset (writes its target score)' },
  ] }, EXECUTION, MULTI_INSTANCE, SLA, ADVANCED],
  diagram: { icon: 'branch', color: '#ea580c', shape: 'rectangle' },
  typeLabel: 'Business rule',
};
