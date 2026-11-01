// Process instance node — runs the operation chosen in its properties (see instance-ops/ops.ts) and stores the result in a variable.
import type { NodeHandler } from '../types.ts';
import { runOperation } from '../instance-ops/ops.ts';

export const handler: NodeHandler = (c) => runOperation(c, 'process');
