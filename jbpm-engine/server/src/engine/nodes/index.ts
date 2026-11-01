// Node handler registry — maps an engine node type to its backend handler. Each node lives in its own
// folder (nodes/<type>/handler.ts) with all of its run-time logic. Add a node = add a folder + entry.
import type { NodeHandler } from './types.ts';
import type { EngineNode } from '../../sdk/index.ts';
import type { Instance } from '../../domain.ts';
import { handler as start } from './start/handler.ts';
import { handler as end } from './end/handler.ts';
import { handler as manual } from './manual/handler.ts';
import { handler as script } from './script/handler.ts';
import { handler as http } from './http/handler.ts';
import { handler as rule } from './rule/handler.ts';
import { handler as gateway } from './gateway/handler.ts';
import { handler as userTask } from './user-task/handler.ts';
import { handler as receive } from './receive/handler.ts';
import { handler as catchEvent } from './catch/handler.ts';
import { handler as throwEvent } from './throw/handler.ts';
import { handler as send } from './send/handler.ts';
import { handler as call, mapChildOutputs as mapCallOutputs } from './call/handler.ts';
import { handler as forEach, buildMultiInstanceResult } from './for-each/handler.ts';
import { handler as subprocess, mapChildOutputs as mapSubprocessOutputs } from './subprocess/handler.ts';
import { handler as workItem } from './work-item/handler.ts';
import { handler as caseInstance } from './case-instance/handler.ts';
import { handler as processInstance } from './process-instance/handler.ts';

export const NODE_HANDLERS: Record<string, NodeHandler> = {
  start, end, manual, script, http, rule, gateway, userTask, receive,
  catch: catchEvent, throw: throwEvent, send, call, forEach, subprocess, workItem, caseInstance, processInstance,
  // 'boundary' has no active handler — it is spawned by the error router and follows its outgoing flow.
};

/** Node types whose child-completion output-mapping logic execution-engine.ts's tryResumeParent needs
 *  to reuse for the ASYNC path (child instead waited, completing later) — a deliberately sparse
 *  capability map, not a mirror of NODE_HANDLERS. Only call/subprocess ever produce a
 *  `wait:{kind:'child'}` today. */
export const CHILD_OUTPUT_MAPPERS: Partial<Record<string, (n: EngineNode, child: Instance) => Record<string, unknown>>> = {
  call: mapCallOutputs, subprocess: mapSubprocessOutputs,
};

// forEach's own child-settlement logic (parallel/sequential fan-out, MULTIINSTANCE_ERROR on any
// failed sibling, wait-for-the-rest otherwise) — reused by execution-engine.ts's tryResumeParent/
// tryFailParent for the ASYNC path, same reasoning as CHILD_OUTPUT_MAPPERS above but for a node type
// that waits on N children instead of one.
export { buildMultiInstanceResult };

// per-node UI config (palette + ports + property schema), co-located with each handler
import { def as startDef } from './start/def.ts';
import { def as endDef } from './end/def.ts';
import { def as manualDef } from './manual/def.ts';
import { def as scriptDef } from './script/def.ts';
import { def as httpDef } from './http/def.ts';
import { def as ruleDef } from './rule/def.ts';
import { def as gatewayDef } from './gateway/def.ts';
import { def as userTaskDef } from './user-task/def.ts';
import { def as receiveDef } from './receive/def.ts';
import { def as catchDef } from './catch/def.ts';
import { def as throwDef } from './throw/def.ts';
import { def as sendDef } from './send/def.ts';
import { def as callDef } from './call/def.ts';
import { def as forEachDef } from './for-each/def.ts';
import { def as subprocessDef } from './subprocess/def.ts';
import { def as boundaryDef } from './boundary/def.ts';
import { def as workItemDef } from './work-item/def.ts';
import { def as caseInstanceDef } from './case-instance/def.ts';
import { def as processInstanceDef } from './process-instance/def.ts';
import type { NodeDef } from './def-types.ts';

export const NODE_DEFS: NodeDef[] = [
  startDef, endDef, catchDef, throwDef, boundaryDef,        // Events
  userTaskDef, scriptDef, httpDef, ruleDef, sendDef, receiveDef, manualDef, workItemDef,  // Tasks (+ work items)
  gatewayDef,                                                // Gateways
  callDef, forEachDef, subprocessDef,                        // Sub-process
  caseInstanceDef, processInstanceDef,                       // Instances (case / process operations)
];
/** engineType → def (ports/schema lookup for validation + UI). */
export const NODE_DEF_BY_TYPE: Record<string, NodeDef> = Object.fromEntries(NODE_DEFS.map((d) => [d.engineType, d]));

export { CATEGORIES } from './def-types.ts';
export type { HandlerCtx, HandlerResult, NodeHandler } from './types.ts';
export type { NodeDef, Ports, UiSection, UiField, PaletteEntry } from './def-types.ts';
