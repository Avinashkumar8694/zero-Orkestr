// Parse a jBPM BPMN 2.0 XML string -> ProcessModel(s).
import { parseXml, local, kids, kid, descendants, cdataText, stringifyNode } from './xml.js';
import type { ElementNode } from './xml.js';
import type {
  ProcessModel, Node, Flow, Variable, SignalDecl, ErrorDecl, MessageDecl, EscalationDecl,
  Position, Waypoint, DataObject, DataStoreRef, Lane,
} from './types.js';

const RAW_SKIP = new Set([
  'property', 'sequenceFlow', 'laneSet', 'extensionElements', 'ioSpecification',
  'documentation', 'dataObject', 'dataObjectReference', 'dataStore', 'dataStoreReference',
  'textAnnotation', 'association', 'group',
  // structural children of an activity/container that are not flow nodes:
  'incoming', 'outgoing', 'multiInstanceLoopCharacteristics', 'dataInputAssociation',
  'dataOutputAssociation', 'dataInput', 'dataOutput', 'inputSet', 'outputSet', 'conditionExpression',
]);
const GATEWAYS: Record<string, Node['type']> = {
  exclusiveGateway: 'exclusiveGateway', parallelGateway: 'parallelGateway',
  inclusiveGateway: 'inclusiveGateway', eventBasedGateway: 'eventBasedGateway', complexGateway: 'complexGateway',
};

function attr(el: ElementNode, name: string): string | undefined {
  return el.attrs[name] !== undefined ? el.attrs[name] : el.attrs[name.split(':').pop() as string];
}

/** Parse ALL processes in a BPMN file (a file may contain more than one <process>). */
export function parseBpmnAll(xml: string): ProcessModel[] {
  const defs = parseXml(xml);
  const itemTypes: Record<string, string> = {};
  kids(defs, 'itemDefinition').forEach((it) => { itemTypes[it.attrs.id] = it.attrs.structureRef || ''; });
  const signals: SignalDecl[] = kids(defs, 'signal').map((s) => ({ id: s.attrs.id, name: s.attrs.name }));
  const errors: ErrorDecl[] = kids(defs, 'error').map((e) => ({ id: e.attrs.id, errorCode: e.attrs.errorCode }));
  const messages: MessageDecl[] = kids(defs, 'message').map((m) => ({ id: m.attrs.id, name: m.attrs.name, itemRef: m.attrs.itemRef }));
  const escalations: EscalationDecl[] = kids(defs, 'escalation').map((e) => ({ id: e.attrs.id, escalationCode: e.attrs.escalationCode, name: e.attrs.name }));
  const sigName = (ref?: string) => (signals.find((s) => s.id === ref) || ({} as SignalDecl)).name || ref;

  let gc = 0;
  const genId = (p: string) => `_${p}${++gc}`; // for id-less elements (some jBPM files omit ids)

  // definitions-scope diagram info (shared across processes)
  const pos: Record<string, Position> = {};
  const wps: Record<string, Waypoint[]> = {};
  descendants(defs, 'BPMNShape').forEach((sh) => {
    const b = kid(sh, 'Bounds');
    if (b) pos[sh.attrs.bpmnElement] = { x: +b.attrs.x, y: +b.attrs.y, width: +b.attrs.width, height: +b.attrs.height, expanded: sh.attrs.isExpanded === 'true' };
  });
  descendants(defs, 'BPMNEdge').forEach((e) => { wps[e.attrs.bpmnElement] = kids(e, 'waypoint').map((w) => ({ x: +w.attrs.x, y: +w.attrs.y })); });

  const io = (el: ElementNode) => ({
    incoming: kids(el, 'incoming').map((c) => cdataText(c) || c.text),
    outgoing: kids(el, 'outgoing').map((c) => cdataText(c) || c.text),
  });
  const elementName = (el: ElementNode): string | undefined => {
    const ext = kid(el, 'extensionElements');
    if (ext) { const md = kids(ext, 'metaData').find((m) => m.attrs.name === 'elementname'); if (md) return cdataText(kid(md, 'metaValue')); }
    return el.attrs.name;
  };
  const targetText = (a: ElementNode) => { const t = kid(a, 'targetRef'); return t ? (cdataText(t) || t.text) : ''; };
  const sourceText = (a: ElementNode) => { const s = kid(a, 'sourceRef'); return s ? (cdataText(s) || s.text) : ''; };
  const assignTo = (el: ElementNode, suffix: string): string | undefined => {
    const a = kids(el, 'dataInputAssociation').find((x) => targetText(x).endsWith(suffix));
    if (!a) return undefined;
    const asg = kid(a, 'assignment'); if (!asg) return undefined;
    return cdataText(kid(asg, 'from'));
  };
  /** onEntry-script/onExit-script extensionElements — real jBPM's generic action-hook mechanism,
   *  attachable to any activity (not just the REST call-activity wrapper this engine used to special-
   *  case). Shared so every activity case below parses it identically. */
  function applyOnEntryExit(el: ElementNode, nd: Node): void {
    const ext = kid(el, 'extensionElements');
    if (!ext) return;
    const onE = kids(ext, 'onEntry-script')[0]; const onX = kids(ext, 'onExit-script')[0];
    if (onE) { nd.onEntry = cdataText(kid(onE, 'script')); const f = attr(onE, 'scriptFormat'); if (f) nd.onEntryFormat = f; }
    if (onX) { nd.onExit = cdataText(kid(onX, 'script')); const f = attr(onX, 'scriptFormat'); if (f) nd.onExitFormat = f; }
    // jBPM's designer extras live in <drools:metaData name="customXxx"> — keep every one (elementname is the node's name, handled elsewhere)
    for (const md of kids(ext, 'metaData')) {
      const name = md.attrs.name; if (!name || name === 'elementname') continue;
      const v = cdataText(kid(md, 'metaValue')) ?? '';
      if (name === 'customAsync') nd.async = v.trim() === 'true';
      else if (name === 'customSLADueDate') nd.slaDueDate = v;
      else if (name === 'customAutoStart') nd.autoStart = v.trim() === 'true';
      else (nd.metaData ||= {})[name] = v;
    }
  }
  function applyEventDef(nd: Node, el: ElementNode) {
    const sg = kid(el, 'signalEventDefinition'); if (sg) { nd.eventType = 'signal'; nd.signalName = sigName(sg.attrs.signalRef); return; }
    const er = kid(el, 'errorEventDefinition'); if (er) { nd.eventType = 'error'; nd.errorRef = er.attrs.errorRef; return; }
    const ms = kid(el, 'messageEventDefinition'); if (ms) { nd.eventType = 'message'; nd.messageRef = ms.attrs.messageRef; return; }
    const es = kid(el, 'escalationEventDefinition'); if (es) { nd.eventType = 'escalation'; nd.escalationRef = es.attrs.escalationRef; return; }
    const cd = kid(el, 'conditionalEventDefinition'); if (cd) { nd.eventType = 'conditional'; const c = kid(cd, 'condition'); nd.conditionExpr = cdataText(c); if (c && c.attrs.language) nd.conditionExprLanguage = c.attrs.language; return; }
    const tm = kid(el, 'timerEventDefinition'); if (tm) { nd.eventType = 'timer'; const dur = kid(tm, 'timeDuration'), cyc = kid(tm, 'timeCycle'), dat = kid(tm, 'timeDate'); if (cyc) nd.timeCycle = cdataText(cyc); else if (dat) nd.timeDate = cdataText(dat); else nd.timeDuration = cdataText(dur); return; }
    const tr = kid(el, 'terminateEventDefinition'); if (tr) { nd.eventType = 'terminate'; return; }
    nd.eventType = 'none';
  }

  function parseContainer(container: ElementNode): { nodes: Node[]; flows: Flow[] } {
    const nodes: Node[] = [];
    const flows: Flow[] = [];
    for (const el of container.children) {
      const tag = local(el.name);
      if (tag === 'sequenceFlow') {
        const f: Flow = { id: el.attrs.id || genId('flow'), sourceRef: el.attrs.sourceRef, targetRef: el.attrs.targetRef };
        if (el.attrs.name) f.name = el.attrs.name;
        const c = kid(el, 'conditionExpression'); if (c) { f.condition = cdataText(c); if (c.attrs.language) f.conditionLanguage = c.attrs.language; }
        if (wps[el.attrs.id]) f.waypoints = wps[el.attrs.id];
        flows.push(f);
        continue;
      }
      const base: Node = { id: el.attrs.id || genId('node'), name: elementName(el), type: 'raw', position: pos[el.attrs.id], ...io(el) };
      if (GATEWAYS[tag]) {
        const nd: Node = { ...base, type: GATEWAYS[tag], gatewayDirection: (el.attrs.gatewayDirection as Node['gatewayDirection']) || 'Unspecified' };
        if (el.attrs.default) nd.default = el.attrs.default;
        if (tag === 'eventBasedGateway') { if (el.attrs.eventGatewayType) nd.eventGatewayType = el.attrs.eventGatewayType; if (el.attrs.instantiate) nd.instantiate = el.attrs.instantiate === 'true'; }
        nodes.push(nd); continue;
      }
      switch (tag) {
        case 'startEvent': { const nd: Node = { ...base, type: 'startEvent' }; if (el.attrs.isInterrupting) nd.isInterrupting = el.attrs.isInterrupting === 'true'; applyEventDef(nd, el); nd.subtype = nd.eventType; nodes.push(nd); break; }
        case 'endEvent': { const nd: Node = { ...base, type: 'endEvent' }; applyEventDef(nd, el); nd.subtype = nd.eventType === 'terminate' ? 'terminate' : nd.eventType; nodes.push(nd); break; }
        case 'intermediateCatchEvent': { const nd: Node = { ...base, type: 'intermediateCatchEvent' }; applyEventDef(nd, el); nodes.push(nd); break; }
        case 'intermediateThrowEvent': { const nd: Node = { ...base, type: 'intermediateThrowEvent' }; applyEventDef(nd, el); nodes.push(nd); break; }
        case 'boundaryEvent': { const nd: Node = { ...base, type: 'boundaryEvent', attachedTo: el.attrs.attachedToRef, cancelActivity: el.attrs.cancelActivity !== 'false' }; applyEventDef(nd, el); nodes.push(nd); break; }
        case 'scriptTask': nodes.push({ ...base, type: 'scriptTask', script: cdataText(kid(el, 'script')), scriptFormat: el.attrs.scriptFormat }); break;
        case 'userTask': { const nd: Node = { ...base, type: 'userTask', taskName: assignTo(el, '_TaskNameInputX'), skippable: assignTo(el, '_SkippableInputX') !== 'false', group: assignTo(el, '_GroupIdInputX') }; applyOnEntryExit(el, nd); nodes.push(nd); break; }
        case 'businessRuleTask': {
          const nd: Node = { ...base, type: 'businessRuleTask', ruleFlowGroup: attr(el, 'drools:ruleFlowGroup'), implementation: el.attrs.implementation };
          if (el.attrs.implementation === 'http://www.jboss.org/drools/dmn') {
            nd.dmnNamespace = assignTo(el, '_namespaceInputX'); nd.dmnModel = assignTo(el, '_modelInputX');
          }
          applyOnEntryExit(el, nd); nodes.push(nd); break;
        }
        case 'sendTask': { const nd: Node = { ...base, type: 'sendTask', messageRef: el.attrs.messageRef, operationRef: el.attrs.operationRef, implementation: el.attrs.implementation }; applyOnEntryExit(el, nd); nodes.push(nd); break; }
        case 'receiveTask': { const nd: Node = { ...base, type: 'receiveTask', messageRef: el.attrs.messageRef, implementation: el.attrs.implementation }; applyOnEntryExit(el, nd); nodes.push(nd); break; }
        case 'manualTask': { const nd: Node = { ...base, type: 'manualTask' }; applyOnEntryExit(el, nd); nodes.push(nd); break; }
        case 'subProcess': case 'transaction': {
          const nd: Node = { ...base, type: 'subProcess', subtype: tag === 'transaction' ? 'transaction' : (el.attrs.triggeredByEvent === 'true' ? 'event' : 'embedded') };
          applyOnEntryExit(el, nd);
          const inner = parseContainer(el);
          nd.nodes = inner.nodes; nd.flows = inner.flows;
          nodes.push(nd); break;
        }
        case 'callActivity': {
          const nd: Node = { ...base, type: 'callActivity', calledElement: el.attrs.calledElement };
          const mi = kid(el, 'multiInstanceLoopCharacteristics');
          if (mi) {
            nd.subtype = 'multiInstance';
            const idi = kid(mi, 'inputDataItem'); const odi = kid(mi, 'outputDataItem');
            const firstIn = kids(el, 'dataInputAssociation')[0]; const firstOut = kids(el, 'dataOutputAssociation')[0];
            nd.multiInstance = {
              isSequential: mi.attrs.isSequential === 'true',
              itemVar: (idi && idi.attrs.name) || 'item', itemOutVar: (odi && odi.attrs.name) || 'result',
              collectionIn: firstIn ? sourceText(firstIn) : '', collectionOut: firstOut ? targetText(firstOut) : '',
            };
          } else if ((el.attrs.calledElement || '').endsWith('pru-rest-executor')) {
            nd.subtype = 'rest';
            const url = assignTo(el, '_UrlInputX'); nd.url = url ? url.replace('#{baseUrl}', '') : undefined;
            nd.method = assignTo(el, '_MethodInputX') || 'POST';
          } else { nd.subtype = 'reusable'; }
          const portName = (ref: string, suffix: string) => ref.startsWith(`${el.attrs.id}_`) && ref.endsWith(suffix) ? ref.slice(el.attrs.id.length + 1, -suffix.length) : ref;
          const inputs: Record<string, string> = {};
          for (const a of kids(el, 'dataInputAssociation')) {
            const port = portName(targetText(a), 'InputX');
            const asg = kid(a, 'assignment');
            const value = asg ? cdataText(kid(asg, 'from')) : sourceText(a);
            if (port && value !== undefined) inputs[port] = asg ? (value || '') : `$${value}`;
          }
          const outputs: Record<string, string> = {};
          for (const a of kids(el, 'dataOutputAssociation')) {
            const port = portName(sourceText(a), 'OutputX');
            const target = targetText(a);
            if (port && target) outputs[target] = port;
          }
          if (Object.keys(inputs).length) (nd as any).inputs = inputs;
          if (Object.keys(outputs).length) (nd as any).outputs = outputs;
          applyOnEntryExit(el, nd);
          nodes.push(nd); break;
        }
        case 'task': {
          // generic custom WorkItemHandler task: <bpmn2:task drools:taskName="X"> — e.g. jBPM's
          // built-in "Rest" REST work item, or any customer WorkItemHandler bound by name.
          const handlerName = attr(el, 'drools:taskName');
          if (!handlerName) { if (!RAW_SKIP.has(tag)) nodes.push({ ...base, type: 'raw', bpmnLocal: tag, raw: stringifyNode(el) }); break; }
          const portName = (ref: string, suffix: string) => ref.startsWith(`${el.attrs.id}_`) && ref.endsWith(suffix) ? ref.slice(el.attrs.id.length + 1, -suffix.length) : ref;
          const workParams: Record<string, string> = {};
          for (const a of kids(el, 'dataInputAssociation')) {
            const port = portName(targetText(a), 'InputX');
            const asg = kid(a, 'assignment');
            const value = asg ? cdataText(kid(asg, 'from')) : sourceText(a);
            if (port && value !== undefined) workParams[port] = asg ? (value || '') : `$${value}`;
          }
          const workResultTo: Record<string, string> = {};
          for (const a of kids(el, 'dataOutputAssociation')) {
            const port = portName(sourceText(a), 'OutputX');
            const varName = targetText(a);
            if (port && varName) workResultTo[varName] = port;
          }
          const nd: Node = { ...base, type: 'genericTask', handlerName, workParams, workResultTo };
          applyOnEntryExit(el, nd);
          nodes.push(nd);
          break;
        }
        default:
          if (!RAW_SKIP.has(tag)) nodes.push({ ...base, type: 'raw', bpmnLocal: tag, raw: stringifyNode(el) });
          break;
      }
    }
    return { nodes, flows };
  }

  function buildModel(proc: ElementNode): ProcessModel {
    const model: ProcessModel = {
      id: proc.attrs.id || genId('process'),
      name: proc.attrs.name,
      packageName: attr(proc, 'drools:packageName') || 'org.jbpm',
      processType: (proc.attrs.processType as ProcessModel['processType']) || 'Public',
      isExecutable: proc.attrs.isExecutable !== 'false',
      declarations: { signals, errors, messages, escalations },
      variables: [], dataObjects: [], dataStores: [], lanes: [], nodes: [], flows: [],
    };
    kids(proc, 'property').forEach((p) => { (model.variables as Variable[]).push({ name: p.attrs.name || p.attrs.id, type: itemTypes[p.attrs.itemSubjectRef] || 'String' }); });
    kids(proc, 'dataObject').forEach((o) => { (model.dataObjects as DataObject[]).push({ id: o.attrs.id, name: o.attrs.name, type: itemTypes[o.attrs.itemSubjectRef], isCollection: o.attrs.isCollection === 'true' }); });
    kids(proc, 'dataStoreReference').forEach((o) => { (model.dataStores as DataStoreRef[]).push({ id: o.attrs.id, name: o.attrs.name, dataStoreRef: o.attrs.dataStoreRef }); });
    const ls = kid(proc, 'laneSet');
    if (ls) kids(ls, 'lane').forEach((l) => { (model.lanes as Lane[]).push({ id: l.attrs.id, name: l.attrs.name, flowNodeRefs: kids(l, 'flowNodeRef').map((r) => cdataText(r) || r.text) }); });
    const top = parseContainer(proc);
    model.nodes = top.nodes; model.flows = top.flows;
    return model;
  }

  return kids(defs, 'process').map(buildModel);
}

/** Parse the first process in a BPMN file. Use parseBpmnAll for multi-process files. */
export function parseBpmn(xml: string): ProcessModel {
  const all = parseBpmnAll(xml);
  if (!all.length) throw new Error('no <process> found in BPMN');
  return all[0];
}
