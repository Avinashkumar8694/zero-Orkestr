// Process validation rules — the engine-native equivalent of jBPM/BPMN diagram validation, adapted to
// the nodejs engine model. Each rule inspects the EngineProcess graph and returns typed Problems.
// Errors block publish/deploy; warnings are advisory. See docs/08 + docs/09.
import type { EngineFlow, EngineNode, EngineProcess } from '../../sdk/index.ts';
import { NODE_DEF_BY_TYPE } from '../../engine/nodes/index.ts';
import { ASYNC_CAPABLE } from '../../engine/async-kick.ts';
import { parseDuration } from '../../engine/duration.ts';
import { validateJavaSupport } from '../../engine/java-compat.ts';
import { validateJava } from '../../engine/java-sidecar.ts';

export type Severity = 'error' | 'warning';
export interface Problem {
  rule: string;
  severity: Severity;
  message: string;
  nodeId?: string;
  nodeName?: string;
  flowId?: string;
  processId?: string;
  processName?: string;
  remedy?: string;
}

export const REMEDIES: Record<string, string> = {
  'start-exists': 'Add a Start Event to the process diagram from the palette.',
  'end-exists': 'Add at least one End Event to the process diagram.',
  'single-start': 'Merge multiple starts or use gateway branching after a single Start event.',
  'unique-ids': 'Assign a unique ID to every node in its properties panel.',
  'flow-endpoints': 'Re-connect or delete sequence flows that point to deleted nodes.',
  'flow-direction': 'Verify that End events have no outgoing flows and Start events have no incoming flows.',
  'connection-cardinality': 'Use diverging Gateways (Exclusive/Parallel) to branch into multiple sequence flows.',
  'start-connections': 'Draw an outgoing sequence flow from the Start event to the first activity.',
  'end-connections': 'Draw an incoming sequence flow from the preceding activity to the End event.',
  'node-connected': 'Connect this floating activity with incoming and outgoing sequence flows, or delete it.',
  'reachable': 'Connect a sequence flow path from a Start event to reach this activity.',
  'ends-at-end': 'Ensure all branches and paths from this node terminate at an End event.',
  'boundary-host': 'Attach this boundary catch event to an existing activity or set it to "*" for process-wide.',
  'node-config': 'Fill in the required configuration fields (e.g. Script code, HTTP URL, Rule reference) in the node properties.',
  'event-trigger': 'Define a signal, message, error, or timer trigger definition in the event properties.',
  'gateway-branching': 'Define explicit condition expressions or designate a default outgoing flow for the gateway.',
  'usertask-assignment': 'Assign a candidate group or actor to this user task in properties.',
  'condition-lang': 'Set flow condition language to "js" or "java".',
  'node-name': 'Provide a descriptive name for this activity in properties.',
  'java-support': 'Review and fix Java syntax errors. Recommendation: Replace this node with a fresh node from the palette if internal code cannot be resolved.',
  'async-config': 'Async applies to script, service/HTTP, work-item, rule, send, call, for-each and sub-process nodes. Retries are 0–20; the delay is an ISO-8601 duration such as PT30S.',
  'unsupported-construct': 'Recommendation: Replace this unsupported construct with a standard BPMN 2.0 Task, Gateway, or Sub-process from the palette.',
};

export interface GraphCtx {
  process: EngineProcess;
  nodes: EngineNode[];
  flows: EngineFlow[];
  byId: Map<string, EngineNode>;
  outgoing: Map<string, EngineFlow[]>;
  incoming: Map<string, EngineFlow[]>;
  starts: EngineNode[];
  ends: EngineNode[];
  reachable: Set<string>;
  boundaryByHost: Map<string, EngineNode[]>;
}

const isStart = (n: EngineNode) => n.type === 'start';
const isEnd = (n: EngineNode) => n.type === 'end';
const isBoundary = (n: EngineNode) => n.type === 'boundary';
// Presence check, not truthy: a catch-all event sub-process is declared with `on: { error: '' }` (the
// same convention already fixed for boundary/end/throw catches elsewhere in this file — see the
// node-config rule below) — a truthy check here treats that legitimate catch-all as "not an event
// sub-process at all", wrongly subjecting it to the ordinary connectivity/reachability rules an event
// sub-process is specifically exempt from (it has no incoming/outgoing flow by design; see boundary/
// handler.ts's own isErrorCatch, which already gets this right via hasOwnProperty).
const isEventSub = (n: EngineNode) => n.type === 'subprocess' && !!(n as any).on && Object.prototype.hasOwnProperty.call((n as any).on, 'error');
const label = (n: EngineNode) => n.name || n.id || n.type;

function buildCtx(process: EngineProcess): GraphCtx {
  const nodes = process.nodes || [];
  const flows = process.flows || [];
  const byId = new Map(nodes.map((n) => [n.id!, n]));
  const outgoing = new Map<string, EngineFlow[]>();
  const incoming = new Map<string, EngineFlow[]>();
  for (const f of flows) {
    (outgoing.get(f.from) || outgoing.set(f.from, []).get(f.from)!).push(f);
    (incoming.get(f.to) || incoming.set(f.to, []).get(f.to)!).push(f);
  }
  const onList = (n: EngineNode): string[] => { const on = (n as any).on; return Array.isArray(on) ? on : (on ? [on] : []); };
  const boundaryByHost = new Map<string, EngineNode[]>();
  for (const n of nodes) if (isBoundary(n)) {
    for (const host of onList(n)) (boundaryByHost.get(host) || boundaryByHost.set(host, []).get(host)!).push(n);
  }
  const starts = nodes.filter(isStart);
  const ends = nodes.filter(isEnd);

  // reachability from starts (event-subprocesses + process-global error catches are always reachable;
  // node-attached boundaries are reachable when their host is)
  const reachable = new Set<string>();
  const globalCatches = nodes.filter((n) => isBoundary(n) && onList(n).includes('*'));
  const queue: string[] = [...starts.map((n) => n.id!), ...nodes.filter(isEventSub).map((n) => n.id!), ...globalCatches.map((n) => n.id!)];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id) || !byId.has(id)) continue;
    reachable.add(id);
    for (const f of outgoing.get(id) || []) queue.push(f.to);
    for (const b of boundaryByHost.get(id) || []) queue.push(b.id!);
  }
  return { process, nodes, flows, byId, outgoing, incoming, starts, ends, reachable, boundaryByHost };
}

export interface Rule { id: string; description: string; run(ctx: GraphCtx): Problem[] | Promise<Problem[]>; }
const P = (rule: string, severity: Severity, message: string, extra: Partial<Problem> = {}): Problem => ({ rule, severity, message, ...extra });
const deg = (ctx: GraphCtx, id: string) => ({ in: (ctx.incoming.get(id) || []).length, out: (ctx.outgoing.get(id) || []).length });

export const RULES: Rule[] = [
  { id: 'async-config', description: 'Async (background) execution settings must be valid and on a node that can run in the background', run: (c) => {
    const out: Problem[] = [];
    for (const n of c.nodes) {
      const a = n as any;
      if (a.async === undefined && a.asyncRetries === undefined && a.asyncRetryDelay === undefined) continue;
      if (a.async === true && !ASYNC_CAPABLE.has(n.type)) out.push(P('async-config', 'warning', `"${label(n)}" (${n.type}) cannot run in the background — async is ignored`, { nodeId: n.id }));
      if (a.asyncRetries !== undefined && !(Number.isInteger(a.asyncRetries) && a.asyncRetries >= 0 && a.asyncRetries <= 20)) out.push(P('async-config', 'error', `"${label(n)}": async retries must be a whole number from 0 to 20`, { nodeId: n.id }));
      if (a.asyncRetryDelay !== undefined && a.asyncRetryDelay !== '' && !parseDuration(String(a.asyncRetryDelay))) out.push(P('async-config', 'error', `"${label(n)}": async retry delay must be an ISO-8601 duration such as PT30S`, { nodeId: n.id }));
    }
    return out;
  } },

  { id: 'start-exists', description: 'Process must have at least one start node', run: (c) => c.starts.length ? [] : [P('start-exists', 'error', 'Process has no start node')] },
  { id: 'end-exists', description: 'Process must have at least one end node', run: (c) => c.ends.length ? [] : [P('end-exists', 'error', 'Process has no end node')] },
  { id: 'single-start', description: 'Prefer a single start node', run: (c) => c.starts.length > 1 ? [P('single-start', 'warning', `Process has ${c.starts.length} start nodes`)] : [] },

  { id: 'unique-ids', description: 'Node ids must be unique', run: (c) => {
    const seen = new Set<string>(), dupes = new Set<string>();
    for (const n of c.nodes) { if (seen.has(n.id!)) dupes.add(n.id!); seen.add(n.id!); }
    return [...dupes].map((id) => P('unique-ids', 'error', `Duplicate node id "${id}"`, { nodeId: id }));
  } },

  { id: 'flow-endpoints', description: 'Every connection must link two existing nodes', run: (c) => {
    const out: Problem[] = [];
    for (const f of c.flows) {
      if (!c.byId.has(f.from)) out.push(P('flow-endpoints', 'error', `Connection source "${f.from}" does not exist`, { flowId: f.id }));
      if (!c.byId.has(f.to)) out.push(P('flow-endpoints', 'error', `Connection target "${f.to}" does not exist`, { flowId: f.id }));
      if (f.from === f.to) out.push(P('flow-endpoints', 'warning', `Connection loops a node onto itself (${f.from})`, { flowId: f.id }));
    }
    return out;
  } },

  { id: 'flow-direction', description: 'Connections must respect each node type\'s declared ports (in/out)', run: (c) => {
    const out: Problem[] = [];
    for (const f of c.flows) {
      const from = c.byId.get(f.from); const to = c.byId.get(f.to);
      const fromDef = from && NODE_DEF_BY_TYPE[from.type]; const toDef = to && NODE_DEF_BY_TYPE[to.type];
      if (fromDef && fromDef.ports.maxOut === 0) out.push(P('flow-direction', 'error', `"${label(from!)}" (${from!.type}) has no outgoing connection point`, { flowId: f.id, nodeId: from!.id }));
      if (toDef && toDef.ports.maxIn === 0) out.push(P('flow-direction', 'error', `"${label(to!)}" (${to!.type}) has no incoming connection point`, { flowId: f.id, nodeId: to!.id }));
    }
    return out;
  } },

  { id: 'connection-cardinality', description: 'Nodes must respect max in/out; only gateways branch/merge', run: (c) => {
    const out: Problem[] = [];
    for (const n of c.nodes) {
      const def = NODE_DEF_BY_TYPE[n.type]; if (!def) continue;
      const din = (c.incoming.get(n.id!) || []).length, dout = (c.outgoing.get(n.id!) || []).length;
      const { maxIn, maxOut } = def.ports;
      if (maxOut != null && dout > maxOut) out.push(P('connection-cardinality', 'error', `"${label(n)}" (${n.type}) allows at most ${maxOut} outgoing connection${maxOut === 1 ? '' : 's'} (has ${dout})`, { nodeId: n.id }));
      if (maxIn != null && din > maxIn) out.push(P('connection-cardinality', 'error', `"${label(n)}" (${n.type}) allows at most ${maxIn} incoming connection${maxIn === 1 ? '' : 's'} (has ${din})`, { nodeId: n.id }));
      if (n.type === 'gateway' && (n as any).mode !== 'exclusive' && din > 1 && dout > 1) out.push(P('connection-cardinality', 'error', `Gateway "${label(n)}" must be diverging (1→many) or converging (many→1), not both`, { nodeId: n.id }));
    }
    return out;
  } },

  { id: 'start-connections', description: 'Start has one+ outgoing and no incoming', run: (c) => {
    const out: Problem[] = [];
    for (const n of c.starts) { const d = deg(c, n.id!);
      if (d.out === 0) out.push(P('start-connections', 'error', `Start "${label(n)}" has no outgoing connection`, { nodeId: n.id }));
      if (d.in > 0) out.push(P('start-connections', 'error', `Start "${label(n)}" must not have incoming connections`, { nodeId: n.id }));
    }
    return out;
  } },

  { id: 'end-connections', description: 'End has one+ incoming and no outgoing', run: (c) => {
    const out: Problem[] = [];
    for (const n of c.ends) { const d = deg(c, n.id!);
      if (d.in === 0) out.push(P('end-connections', 'error', `End "${label(n)}" has no incoming connection`, { nodeId: n.id }));
      if (d.out > 0) out.push(P('end-connections', 'error', `End "${label(n)}" must not have outgoing connections`, { nodeId: n.id }));
    }
    return out;
  } },

  // A node type absent from NODE_DEF_BY_TYPE (chiefly 'raw' — the SDK's escape hatch for a BPMN
  // construct it doesn't structurally understand, e.g. an ad-hoc sub-process or an unrecognized service
  // task implementation) is invisible to every other structural rule here: connection-cardinality and
  // flow-direction both guard on `NODE_DEF_BY_TYPE[n.type]` and silently skip it, and it renders on the
  // canvas with no real configuration surface. Without this rule, importing a real jBPM project with one
  // of these constructs reports "no problems" while actually having silently dropped part of the
  // process's logic — caught by testing real jbpm-playground/businessautomation-cop examples, where an
  // ad-hoc sub-process's entire nested task list disappears into one opaque raw blob with zero warning.
  { id: 'unsupported-construct', description: 'Every node type must be understood by this engine (not the raw/opaque fallback)', run: (c) => {
    const out: Problem[] = [];
    for (const n of c.nodes) {
      if (!NODE_DEF_BY_TYPE[n.type]) {
        out.push(P('unsupported-construct', 'error', `"${label(n)}" (${n.type}) is a construct this engine doesn't structurally support — imported as opaque data; it will not execute as intended and needs manual reconstruction`, { nodeId: n.id }));
      }
    }
    return out;
  } },

  { id: 'node-connected', description: 'Activities/gateways/events must be connected (no floating nodes)', run: (c) => {
    const out: Problem[] = [];
    for (const n of c.nodes) {
      if (isStart(n) || isEnd(n) || isEventSub(n)) continue;
      const d = deg(c, n.id!);
      if (isBoundary(n)) { if (d.out === 0) out.push(P('node-connected', 'error', `Boundary "${label(n)}" has no outgoing (handler) connection`, { nodeId: n.id })); continue; }
      if (d.in === 0 && d.out === 0) out.push(P('node-connected', 'error', `Node "${label(n)}" is not connected`, { nodeId: n.id }));
      else if (d.in === 0) out.push(P('node-connected', 'error', `Node "${label(n)}" has no incoming connection`, { nodeId: n.id }));
      else if (d.out === 0) out.push(P('node-connected', 'error', `Node "${label(n)}" has no outgoing connection`, { nodeId: n.id }));
    }
    return out;
  } },

  { id: 'reachable', description: 'Every node must be reachable from a start', run: (c) => {
    const out: Problem[] = [];
    for (const n of c.nodes) {
      if (isStart(n) || isEventSub(n)) continue;
      const d = deg(c, n.id!);
      if ((d.in > 0 || d.out > 0) && !c.reachable.has(n.id!)) out.push(P('reachable', 'error', `Node "${label(n)}" is not reachable from a start`, { nodeId: n.id }));
    }
    return out;
  } },

  { id: 'ends-at-end', description: 'Every path must terminate at an end event (no dead-ends / endless loops)', run: (c) => {
    if (!c.ends.length) return [];   // 'end-exists' already reports the missing end
    // reverse-reachability: which nodes can reach an end? (walk backwards over incoming flows from ends)
    const reachesEnd = new Set<string>();
    const q = c.ends.map((n) => n.id!);
    while (q.length) { const id = q.shift()!; if (reachesEnd.has(id) || !c.byId.has(id)) continue; reachesEnd.add(id); for (const f of c.incoming.get(id) || []) q.push(f.from); }
    const out: Problem[] = [];
    for (const n of c.nodes) {
      if (isEnd(n) || isEventSub(n)) continue;
      if (c.reachable.has(n.id!) && !reachesEnd.has(n.id!)) out.push(P('ends-at-end', 'error', `"${label(n)}" does not lead to an end event — every process path must finish at an End`, { nodeId: n.id }));
    }
    return out;
  } },

  { id: 'boundary-host', description: 'Error/boundary catch must attach to existing node(s) or all (*)', run: (c) => {
    const out: Problem[] = [];
    for (const n of c.nodes) if (isBoundary(n)) {
      const hosts = (() => { const on = (n as any).on; return Array.isArray(on) ? on : (on ? [on] : []); })();
      if (hosts.length === 0) { out.push(P('boundary-host', 'error', `Catch "${label(n)}" is not attached to any node (pick nodes or "all")`, { nodeId: n.id })); continue; }
      for (const h of hosts) if (h !== '*' && !c.byId.has(h)) out.push(P('boundary-host', 'error', `Catch "${label(n)}" attaches to missing node "${h}"`, { nodeId: n.id }));
    }
    return out;
  } },

  { id: 'node-config', description: 'Per-type required configuration', run: (c) => {
    const out: Problem[] = [];
    for (const n of c.nodes) {
      const a = n as any;
      switch (n.type) {
        case 'script': if (!a.code || !String(a.code).trim()) out.push(P('node-config', 'error', `Script "${label(n)}" has no code`, { nodeId: n.id })); break;
        case 'http': if (!a.url) out.push(P('node-config', 'error', `Service task "${label(n)}" has no URL`, { nodeId: n.id })); break;
        case 'call': if (!a.process) out.push(P('node-config', 'error', `Call activity "${label(n)}" has no called process`, { nodeId: n.id })); break;
        case 'forEach': if (!a.process) out.push(P('node-config', 'error', `Multi-instance "${label(n)}" has no process`, { nodeId: n.id }));
          if (!a.over) out.push(P('node-config', 'error', `Multi-instance "${label(n)}" has no collection`, { nodeId: n.id })); break;
        case 'rule': if (!a.ruleflowGroup && !a.dmn && !a.decisionTree && !a.scorecard && !a.guidedTable) out.push(P('node-config', 'error', `Business rule "${label(n)}" references no ruleflow group, DMN decision, guided table, decision tree, or scorecard`, { nodeId: n.id })); break;
        case 'send': if (!a.message) out.push(P('node-config', 'error', `Send task "${label(n)}" has no message`, { nodeId: n.id })); break;
        case 'receive': if (!a.message) out.push(P('node-config', 'error', `Receive task "${label(n)}" has no message`, { nodeId: n.id })); break;
        case 'gateway': if (!a.mode) out.push(P('node-config', 'error', `Gateway "${label(n)}" has no mode`, { nodeId: n.id })); break;
        // A throw kind (error/signal/message/escalation) is "selected" the moment its key exists on
        // throw/event — the properties panel writes e.g. `{ signal: '' }` the instant you pick Signal
        // from the dropdown, before you've typed a name. Both end/handler.ts and throw/handler.ts
        // check the NAME truthily (`throw?.signal`, `ev.signal`, etc.), so a blank one is silently a
        // no-op at runtime (an "error end" that just completes normally, a "throw signal" that throws
        // nothing) — the process still runs, just not as configured, with no error anywhere. Catching
        // it here at publish time, the same way the DRL/DMN check above already does, is far safer
        // than a live instance silently completing when the author expects it to fail or broadcast.
        case 'end': case 'throw': {
          const o = (n.type === 'end' ? a.throw : a.event) || {};
          const label2 = n.type === 'end' ? 'End' : 'Throw';
          for (const k of ['error', 'signal', 'message', 'escalation']) {
            if (k in o && !String(o[k] ?? '').trim()) out.push(P('node-config', 'error', `${label2} "${label(n)}" is set to throw ${k === 'error' ? 'an error' : k} but has no ${k === 'error' ? 'code' : 'name'}`, { nodeId: n.id }));
          }
          break;
        }
        // A blank message/signal on a catch falls through catch/handler.ts's if-chain to a
        // condition-wait instead — silently waiting on the wrong thing, forever, rather than the
        // message/signal the author actually picked.
        case 'catch': {
          const o = a.event || {};
          for (const k of ['message', 'signal']) {
            if (k in o && !String(o[k] ?? '').trim()) out.push(P('node-config', 'error', `Catch "${label(n)}" is set to wait on a ${k} but has no name`, { nodeId: n.id }));
          }
          break;
        }
      }
    }
    return out;
  } },

  { id: 'event-trigger', description: 'Catch/throw/boundary events must define a trigger', run: (c) => {
    const out: Problem[] = [];
    const hasTrigger = (e: any) => e && (e.signal != null || e.message != null || e.error != null || e.escalation != null || e.condition != null || e.timer != null || e.compensation != null || e.compensate != null);
    for (const n of c.nodes) {
      const a = n as any;
      if ((n.type === 'catch' || n.type === 'throw' || n.type === 'boundary') && !hasTrigger(a.event))
        out.push(P('event-trigger', 'error', `${n.type} event "${label(n)}" has no trigger defined`, { nodeId: n.id }));
      // timer completeness
      const timer = a.event?.timer || (n.type === 'start' && a.on?.timer);
      if (timer && typeof timer === 'object' && !timer.duration && !timer.cycle && !timer.date)
        out.push(P('event-trigger', 'error', `Timer on "${label(n)}" has no duration/cycle/date`, { nodeId: n.id }));
    }
    return out;
  } },

  { id: 'gateway-branching', description: 'Diverging exclusive/inclusive gateways should resolve deterministically', run: (c) => {
    const out: Problem[] = [];
    for (const n of c.nodes) {
      const a = n as any;
      if (n.type !== 'gateway' || (a.mode !== 'exclusive' && a.mode !== 'inclusive')) continue;
      const outs = c.outgoing.get(n.id!) || [];
      if (outs.length <= 1) continue;
      const hasDefault = outs.some((f) => f.id && f.id === a.default);
      const uncond = outs.filter((f) => !f.when);
      // In jBPM / BPMN 2.0: having conditional branches without an explicit default flow is standard
      // practice when conditions are mutually exhaustive. Only multiple unconditional branches without
      // a default flow create runtime non-determinism.
      if (!hasDefault && uncond.length > 1) out.push(P('gateway-branching', 'warning', `Gateway "${label(n)}" has multiple unconditional branches`, { nodeId: n.id }));
    }
    return out;
  } },

  { id: 'usertask-assignment', description: 'User task should have an actor or group', run: (c) => {
    const out: Problem[] = [];
    for (const n of c.nodes) if (n.type === 'userTask' && !(n as any).group && !(n as any).assignee)
      out.push(P('usertask-assignment', 'warning', `User task "${label(n)}" has no group or assignee`, { nodeId: n.id }));
    return out;
  } },

  { id: 'condition-lang', description: 'Flow conditions must be js or java to execute in the Node runtime', run: (c) => {
    const out: Problem[] = [];
    for (const f of c.flows) if (f.when && f.lang && f.lang !== 'js' && f.lang !== 'java')
      out.push(P('condition-lang', 'warning', `Connection condition is "${f.lang}" and will not evaluate at runtime (use js or java)`, { flowId: f.id }));
    return out;
  } },

  // In BPMN 2.0 and jBPM, Events (start, end, catch, throw, boundary) and Gateways are graphic shapes
  // that are standardly unnamed; only activities, tasks, and sub-processes require meaningful names for clarity.
  { id: 'node-name', description: 'Nodes should be named', run: (c) => c.nodes.filter((n) => n.type !== 'start' && n.type !== 'end' && n.type !== 'gateway' && n.type !== 'catch' && n.type !== 'throw' && n.type !== 'boundary' && (!n.name || !n.name.trim())).map((n) => P('node-name', 'warning', `${n.type} "${n.id}" has no name`, { nodeId: n.id })) },

  // Recurses into subprocess/event-subprocess children itself (unlike the other rules above, which
  // only see the top-level process.nodes/flows) so a Java script buried inside an embedded or event
  // subprocess is checked too, not silently skipped. Two layers, cheapest first: (1) the sync
  // denylist (java-compat.ts) — fast, no network, catches operationally-unsafe constructs; (2) for
  // anything that passes, a real dry compile against the JVM sidecar (java-sidecar.ts) — ground
  // truth for whether the exact script text actually compiles, using the identical wrapper shape
  // execution uses, so this can never drift out of sync with what running the script actually does.
  {
    id: 'java-support',
    description: 'lang:"java" scripts and conditions must actually compile and stay inside the supported subset (see docs/bpm-nodes/_scripting-java.md)',
    run: async (c) => {
      const out: Problem[] = [];
      const pending: Promise<void>[] = [];
      // real jBPM's Java dialect binds every DECLARED process variable as a bare, typed local
      // identifier for BOTH scripts/onEntry/onExit and conditions (confirmed against jBPM's own
      // JavaActionBuilder codegen — not condition-specific) — subprocess-nested code shares the
      // top-level process's variable scope (embedded subprocesses have no vars of their own),
      // matching how gateway/handler.ts and script/handler.ts resolve this same map at runtime.
      //
      // Passing the SAME varTypes here for scripts too (not just conditions) isn't just about
      // correctness of the bare-name binding itself — the JVM sidecar's compiled-class cache keys on
      // (code, varTypes shape) together (see ScriptRunner.classNameFor), so this dry-compile at
      // publish time ACTUALLY pre-warms the exact cache entry real execution will look up. Passing a
      // different varTypes shape here (e.g. omitting it for scripts, as an earlier version of this
      // code did) computes a DIFFERENT cache key — meaning the dry-compile still validates the script
      // compiles, but doesn't save the first real instance from a fresh compile-on-cache-miss, quietly
      // defeating the "compile once at deploy time" intent JVM sidecar dry-compilation exists for.
      const varTypes: Record<string, string> = {};
      for (const v of c.process.vars || []) if (v.name) varTypes[v.name] = v.type;
      // http/handler.ts's exitScript execution always adds a synthesized `resPayload: 'String'` entry
      // on top of the declared vars (see its own comment: real exit scripts constantly reference
      // resPayload, e.g. `resPayload.isEmpty()`) — the dry-compile here must use the IDENTICAL shape,
      // or it computes a different cache key than real execution and (same reasoning as above) fails
      // to actually pre-warm the cache for this node.
      const httpVarTypes: Record<string, string> = { resPayload: 'String', ...varTypes };
      const check = (code: string, asCondition: boolean, types: Record<string, string>, describe: (msg: string) => Problem) => {
        const denylist = validateJavaSupport(code);
        for (const msg of denylist.errors) out.push(describe(msg));
        if (denylist.errors.length) return; // don't also dry-compile something already rejected
        pending.push(validateJava(code, asCondition, types).then((res) => {
          if (!res.ok) out.push(describe(res.error));
        }));
      };
      const walk = (nodes: EngineNode[], flows: EngineFlow[]) => {
        for (const n of nodes) {
          const a = n as any;
          if (n.type === 'script' && a.lang === 'java' && a.code) {
            check(String(a.code), false, varTypes, (msg) => {
              const remedy = msg.includes('cannot find symbol') || msg.includes('does not exist') || msg.includes('package')
                ? 'The script references external Java classes or symbols not available in this environment. Recommendation: Replace this node with a fresh node from the palette, or rewrite the script in JavaScript.'
                : 'Review and fix Java syntax errors. Recommendation: Replace this node with a fresh node from the palette if internal code cannot be resolved.';
              return P('java-support', 'error', `Script "${label(n)}": ${msg}`, { nodeId: n.id, remedy });
            });
          }
          if (n.type === 'http' && a.lang === 'java' && a.exitScript) {
            check(String(a.exitScript), false, httpVarTypes, (msg) => P('java-support', 'error', `Exit script "${label(n)}": ${msg}`, {
              nodeId: n.id,
              remedy: 'Review exit script Java syntax or replace this service task with a fresh node from the palette.'
            }));
          }
          // onEntry/onExit — real jBPM's generic action-hook mechanism, attachable to any activity
          // (userTask/businessRuleTask/sendTask/receiveTask/manualTask/subProcess/call/forEach/
          // workItem — see execution-engine.ts's runLifecycle). Skipped for 'http', whose onEntry/
          // onExit is the separate, already-checked exitScript mechanism above.
          if (n.type !== 'http') {
            if (a.onEntry && a.onEntryLang === 'java') {
              check(String(a.onEntry), false, varTypes, (msg) => P('java-support', 'error', `onEntry "${label(n)}": ${msg}`, {
                nodeId: n.id,
                remedy: 'This node contains internal onEntry Java actions from an imported model that failed compilation. Recommendation: Replace this node with a fresh node from the palette, or clear its internal actions in properties.'
              }));
            }
            if (a.onExit && a.onExitLang === 'java') {
              check(String(a.onExit), false, varTypes, (msg) => P('java-support', 'error', `onExit "${label(n)}": ${msg}`, {
                nodeId: n.id,
                remedy: 'This node contains internal onExit Java actions from an imported model that failed compilation. Recommendation: Replace this node with a fresh node from the palette, or clear its internal actions in properties.'
              }));
            }
          }
          if (Array.isArray(a.nodes)) walk(a.nodes, a.flows || []);
        }
        for (const f of flows) {
          if (f.when && f.lang === 'java') {
            check(f.when, true, varTypes, (msg) => P('java-support', 'error', `Connection condition "${f.id}": ${msg}`, { flowId: f.id }));
          }
        }
      };
      walk(c.process.nodes || [], c.process.flows || []);
      await Promise.all(pending);
      return out;
    },
  },
];

export interface ValidationResult { ok: boolean; errors: Problem[]; warnings: Problem[]; problems: Problem[]; }

export async function validateProcess(process: EngineProcess): Promise<ValidationResult> {
  const ctx = buildCtx(process);
  const perRule = await Promise.all(RULES.map((r) => r.run(ctx)));
  const problems = perRule.flat().map((p) => {
    let nodeName = p.nodeName;
    if (!nodeName && p.nodeId && ctx.byId.has(p.nodeId)) {
      const n = ctx.byId.get(p.nodeId)!;
      nodeName = n.name || n.id || n.type;
    }
    const remedy = p.remedy || REMEDIES[p.rule] || 'Review and adjust the process model or node configuration.';
    return {
      ...p,
      processId: process.id,
      processName: process.name || process.id,
      ...(nodeName ? { nodeName } : {}),
      remedy,
    };
  });
  const errors = problems.filter((p) => p.severity === 'error');
  const warnings = problems.filter((p) => p.severity === 'warning');
  return { ok: errors.length === 0, errors, warnings, problems };
}
