import { type NodeDef, GENERAL, ADVANCED } from '../def-types.ts';
export const def: NodeDef = {
  engineType: 'manual',
  palette: [{ key: 'manual', label: 'Manual Task', category: 'Tasks', icon: '✋', color: '#64748b', engineType: 'manual', defaults: { type: 'manual', name: 'Manual Task' } }],
  ports: { maxIn: 1, maxOut: 1 },
  schema: [GENERAL, ADVANCED],
  diagram: { icon: 'tasks', color: '#64748b', shape: 'rectangle' },
  typeLabel: 'Manual task',
};
