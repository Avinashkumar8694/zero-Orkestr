// Per-node handler contract. Each node type lives in its own folder (handler.ts = backend logic).
// The ExecutionEngine builds a HandlerCtx and dispatches to the registered handler; handlers are pure
// functions that return a HandlerResult (what the step loop should do next).
import type { AppContext } from '../../context.ts';
import type { Deployment, Instance, Token } from '../../domain.ts';
import type { EngineFlow, EngineProcess } from '../../sdk/index.ts';
import type { EngineEvent } from '../execution-engine.ts';

export interface HandlerResult {
  vars?: Record<string, unknown>;
  wait?: Token['waitFor'];
  end?: 'complete' | 'terminate' | 'error';
  next?: string[];        // explicit target node ids (else follow outgoing flows)
  consume?: boolean;      // remove token without spawning (e.g. join not yet satisfied)
  outcome?: string;
  error?: string;
  errorCode?: string;     // BPMN-style error code for error-boundary routing
  errorDetails?: Record<string, unknown>; // enriched error payload (HTTP status, body, headers, stack, etc.)
  rethrow?: boolean;
  signalLocal?: string;   // deliver this signal to waiting tokens of THIS instance only, once the current step has settled (scope: 'instance')
  abort?: boolean;        // abort the whole instance (a call activity configured to abort its parent when the child fails)      // bubble up to outer/global error handler
}

/** Everything a node handler needs — the node + instance state plus engine capabilities. */
export interface HandlerCtx {
  node: any;
  inst: Instance;
  proc: EngineProcess;
  dep: Deployment;
  app: AppContext;
  joins: Record<string, Set<string>>;
  /** the current active token's id — the genuine node-*instance*-level id (as opposed to `node.id`,
   *  the node *definition* id), matching real jBPM's `NodeInstance.getId()` vs `.getNode().getId()`
   *  distinction (see kcontext.getNodeInstance() in script/condition handlers). */
  tokenId: string;
  outgoing(nodeId: string): EngineFlow[];
  incoming(nodeId: string): EngineFlow[];
  emit(e: EngineEvent): void;
  /** `independent`: decouple the child's lifecycle from the parent's — see `Instance.independent`. */
  startChild(dep: Deployment, processId: string, vars: Record<string, unknown>, parentTokenId: string, independent?: boolean): Promise<Instance>;
  /** `correlationValue`, when given, narrows delivery to instances whose OWN correlationKey matches
   *  (see execution-engine.ts's broadcast() doc comment) instead of every instance waiting on `name`. */
  broadcast(name: string, correlationValue?: string): Promise<void>;
  /** Deliver a signal to a SPECIFIC instance by id (matches real jBPM's targeted
   *  kcontext.getKieRuntime().signalEvent(type, event, processInstanceId), as opposed to
   *  broadcast()'s session-wide delivery) — a no-op if the id doesn't resolve to a live instance in
   *  this tenant. */
  signal(targetInstanceId: string, name: string, payload?: unknown): Promise<void>;
  /** Abort a SPECIFIC instance by id (matches real jBPM's kcontext.getKieRuntime().
   *  abortProcessInstance(id)) — a no-op if the id doesn't resolve to a live instance in this tenant. */
  abort(targetInstanceId: string): Promise<void>;
  /** Run compensation handlers for completed activities in reverse order (all, or a single host). */
  compensate(ref?: string): Promise<Record<string, unknown>>;
  resolveCalled?: (processId: string) => Promise<{ dep: Deployment; processId: string } | undefined>;
}

export type NodeHandler = (c: HandlerCtx) => Promise<HandlerResult> | HandlerResult;
