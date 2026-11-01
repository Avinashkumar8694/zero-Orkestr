// Boundary/error-catch matching logic — previously implemented as private ExecutionEngine methods
// (a real self-containment violation: every other node type's logic lives in its own folder, but
// 'boundary' had none at all beyond def.ts's UI config). Pure, stateless functions only: deciding
// WHICH node matches a given host/error/timer situation. The actual state mutation that ACTS on that
// decision (pushing tokens, cancelling timers, running compensations) stays in execution-engine.ts's
// raiseError/fireBoundary/fireTimerJob, since those need engine capabilities (this.ctx, this.
// removeToken, this.runToQuiescence, the timer repo) a plain function can't get without a much larger
// context-threading exercise — fireTimerJob in particular is called externally from
// modules/instances/service.ts's timer-poll path, so it can't become a free function at all.
//
// Note this file's logic isn't PURELY about 'boundary' nodes: isErrorCatch/catchErrorName/
// isGlobalCatch also recognize an event sub-process with an error start (n.type === 'subprocess',
// on.error set) as an error-catch — jBPM's other common "global error handler" idiom. This is the
// natural home for that matching logic regardless (boundary is the dominant case), but it's "error-
// catch-capable node matching," not boundary-exclusive.
import type { EngineNode } from '../../../sdk/index.ts';

export const ENGINE_ERRORS = [
  'SCRIPT_ERROR', 'SERVICE_ERROR', 'RULE_ERROR', 'RUNTIME_ERROR',
  'CALL_ERROR', 'CALL_ABORTED', 'SUBPROCESS_ERROR', 'SUBPROCESS_ABORTED', 'MULTIINSTANCE_ERROR', 'TRANSACTION_CANCELLED',
] as const;

/** on: string | string[]; '*' = all nodes (process-global). Normalize to a list. (boundary only — an
 *  event sub-process error-catch has no host list; see isGlobalCatch.) */
export function onList(n: EngineNode): string[] {
  const on = (n as any).on;
  return Array.isArray(on) ? on : (typeof on === 'string' ? [on] : []);
}

/** the declared error name/id, regardless of which catch construct carries it */
export function catchErrorName(n: EngineNode): string | undefined {
  if (n.type === 'boundary') return (n as any).event?.error;
  if (n.type === 'subprocess') return (n as any).on?.error;
  return undefined;
}

export function isErrorCatch(n: EngineNode): boolean {
  if (n.type === 'boundary') { const e = (n as any).event; return !!e && Object.prototype.hasOwnProperty.call(e, 'error'); }
  if (n.type === 'subprocess') return !!(n as any).on && Object.prototype.hasOwnProperty.call((n as any).on, 'error');
  return false;
}

export function isCatchAll(n: EngineNode): boolean {
  const e = catchErrorName(n);
  return e === '' || e === '*' || e == null || String(e).toUpperCase() === 'ANY';
}

/** an event sub-process error-catch is always process-wide; a boundary is global only via on: '*' */
export function isGlobalCatch(n: EngineNode): boolean {
  return n.type === 'subprocess' || onList(n).includes('*');
}

// jBPM/BPMN error declarations are named for human/XML readability (e.g. "REST_API_FAILURE" with
// errorCode "org.jbpm.bpmn2.handler.WorkItemHandlerRuntimeException"); the Node runtime only ever
// raises one of the fixed ENGINE_ERRORS codes, since that's determined entirely by which node TYPE
// failed (an http node can only ever produce SERVICE_ERROR, a script node only SCRIPT_ERROR, etc).
// A catch attached to one specific host can therefore only ever see one possible code anyway, so it
// matches on ANY error from that host regardless of what name the author (or the mechanical jBPM
// conversion) gave it — no author or converted process needs to know this runtime's internal
// vocabulary. A GLOBAL catch (on: '*', or any event sub-process error-start, which is always
// process-wide) still needs the code to disambiguate if there's more than one global handler; a
// declared name that isn't itself one of ENGINE_ERRORS defaults to SERVICE_ERROR, since "catch
// failures anywhere" overwhelmingly means "catch service/work-item failures" in real jBPM projects
// (this project's own pru-sample-global-error/pru-api-error-handler are exactly that pattern). Use
// an explicit ENGINE_ERRORS name, or '*'/'ANY'/empty, to mean something else or to catch everything.
/** A global, named catch matches a raised code if: the names match exactly (covers an explicit
 *  author error-throw end paired with an author-named catch — both sides pick the same custom
 *  name, e.g. "VALIDATION", and mean exactly that); OR the raised code came from an actual node
 *  execution failure (i.e. IS one of ENGINE_ERRORS — never true for an author's own error-throw
 *  end, which raises its literal custom name) and this catch's name is itself NOT a recognized
 *  ENGINE_ERRORS name, in which case it's treated as meaning SERVICE_ERROR (see block comment
 *  above) — a non-standard-named catch is never assumed to mean SCRIPT_ERROR/RULE_ERROR/etc. */
export function globalNameMatches(n: EngineNode, code: string): boolean {
  const declared = catchErrorName(n);
  if (declared === code) return true;
  const ERR = ENGINE_ERRORS as readonly string[];
  return ERR.includes(code) && declared !== undefined && !ERR.includes(declared) && code === 'SERVICE_ERROR';
}

/** Find the best error-catch for (failing node, code): host-specific (any code) → global+named →
 *  global+catch-all. */
export function findErrorHandler(nodes: EngineNode[], failingNodeId: string, code: string): EngineNode | undefined {
  const catches = nodes.filter((n) => isErrorCatch(n));
  const onNode = (n: EngineNode) => !isGlobalCatch(n) && onList(n).includes(failingNodeId);
  const onNodeSpecific = (n: EngineNode) => onNode(n) && !isCatchAll(n) && catchErrorName(n) === code;
  const onNodeCatchAll = (n: EngineNode) => onNode(n) && isCatchAll(n);
  const onNodeAny = (n: EngineNode) => onNode(n);
  const globalNamed = (n: EngineNode) => isGlobalCatch(n) && !isCatchAll(n) && globalNameMatches(n, code);
  const globalCatchAll = (n: EngineNode) => isGlobalCatch(n) && isCatchAll(n);
  return catches.find(onNodeSpecific) || catches.find(onNodeCatchAll) || catches.find(onNodeAny) || catches.find(globalNamed) || catches.find(globalCatchAll);
}

/** Boundary nodes with a timer trigger attached to `hostNodeId` — scheduled when that host starts
 *  waiting (a host can have more than one boundary attached, e.g. a timer AND an error catch). */
export function boundaryTimerHosts(nodes: EngineNode[], hostNodeId: string): EngineNode[] {
  return nodes.filter((b) => b.type === 'boundary' && (b as any).event?.timer && onList(b).includes(hostNodeId));
}

/** Boundary nodes with a message/signal/escalation trigger attached to `hostNodeId` — given a
 *  WAITING token of their own (mirroring boundaryTimerHosts' TimerJob) the moment that host starts
 *  waiting, so broadcast()/signalInstance() can find and resume them exactly like any other catch.
 *  Escalation has no dedicated WaitSpec kind (see domain.ts) and buckets into 'signal' — consistent
 *  with throw/handler.ts's own broadcast(name), which never distinguished escalation from signal on
 *  the SENDING side either. */
export function messageBoundaryHosts(nodes: EngineNode[], hostNodeId: string): { node: EngineNode; kind: 'message' | 'signal' | 'condition'; name: string }[] {
  return nodes
    .filter((b) => b.type === 'boundary' && onList(b).includes(hostNodeId))
    .flatMap((b): { node: EngineNode; kind: 'message' | 'signal' | 'condition'; name: string }[] => {
      const ev = (b as any).event || {};
      // a conditional boundary waits as a 'condition' token the engine re-checks when variables change
      if (ev.condition && !ev.message && !ev.signal && !ev.escalation) return [{ node: b, kind: 'condition' as const, name: b.id! }];
      const name = ev.message || ev.signal || ev.escalation;
      if (!name) return [];
      return [{ node: b, kind: (ev.message ? 'message' : 'signal') as 'message' | 'signal', name }];
    });
}

/** Boundary nodes with a compensation trigger attached to `hostNodeId` — recorded when that host
 *  completes normally, so a LATER compensation throw can find and run them (LIFO). Returns the
 *  matching boundary NODES (same shape as {@link boundaryTimerHosts}), not pre-resolved compensation
 *  entries — resolving a boundary's outgoing flow to find its actual handler node needs the process's
 *  flow list, which this module (deliberately node-list-only, no flow awareness) doesn't have; the
 *  caller already does that resolution today via its own `outgoing(id)` helper. */
export function compensationBoundaries(nodes: EngineNode[], hostNodeId: string): EngineNode[] {
  return nodes.filter((b) => b.type === 'boundary' && (b as any).event?.compensation && onList(b).includes(hostNodeId));
}
