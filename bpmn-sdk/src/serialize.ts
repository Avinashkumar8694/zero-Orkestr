// Serialize a ProcessModel -> jBPM BPMN 2.0 XML string.
import { DEFINITIONS_ATTRS, REST_INPUTS, JAVA } from './constants.js';
import { escAttr, cdata } from './xml.js';
import type { ProcessModel, Node, Flow, Position, SignalDecl, ErrorDecl, MessageDecl, EscalationDecl } from './types.js';

export function serializeProcess(proc: ProcessModel): string {
  let idc = 0;
  const uid = (p = '_id') => `${p}${++idc}`;
  const itemdefs: string[] = [];
  const decls: string[] = [];
  const props: string[] = [];
  const topNodes: string[] = [];
  const topFlows: string[] = [];
  const shapes: string[] = [];
  const edges: string[] = [];
  const seenItem = new Set<string>();

  const meta = (name?: string) =>
    name == null ? '' :
    `<bpmn2:extensionElements><drools:metaData name="elementname">` +
    `<drools:metaValue>${cdata(name)}</drools:metaValue></drools:metaData></bpmn2:extensionElements>`;

  /** Like meta(), but also emits onEntry-script/onExit-script when present — real jBPM's generic
   *  action-hook mechanism, attachable to any activity (used by userTask/bizTask/msgTask/manualTask/
   *  genericTask/subProcess/miCall/reusable callActivity below; restCall has its own variant since it
   *  auto-generates a default onEntry/onExit body rather than omitting it when unset). All pieces
   *  share the ONE <extensionElements> an element may have — never emit two. */
  /** the jBPM designer extras (Is Async, SLA Due Date, AdHoc Autostart, any other metadata) as <drools:metaData> entries */
  function extraMeta(nd: Node): string[] {
    const md = (name: string, v: string) => `<drools:metaData name="${escAttr(name)}"><drools:metaValue>${cdata(v)}</drools:metaValue></drools:metaData>`;
    const out: string[] = [];
    if (nd.async) out.push(md('customAsync', 'true'));
    if (nd.slaDueDate) out.push(md('customSLADueDate', nd.slaDueDate));
    if (nd.autoStart) out.push(md('customAutoStart', 'true'));
    for (const [k, v] of Object.entries(nd.metaData || {})) out.push(md(k, v));
    return out;
  }

  function extBlock(nd: Node): string {
    const parts: string[] = [];
    if (nd.name != null) parts.push(`<drools:metaData name="elementname"><drools:metaValue>${cdata(nd.name)}</drools:metaValue></drools:metaData>`);
    parts.push(...extraMeta(nd));
    if (nd.onEntry) parts.push(`<drools:onEntry-script scriptFormat="${nd.onEntryFormat || JAVA}"><drools:script>${cdata(nd.onEntry)}</drools:script></drools:onEntry-script>`);
    if (nd.onExit) parts.push(`<drools:onExit-script scriptFormat="${nd.onExitFormat || JAVA}"><drools:script>${cdata(nd.onExit)}</drools:script></drools:onExit-script>`);
    return parts.length ? `<bpmn2:extensionElements>${parts.join('')}</bpmn2:extensionElements>` : '';
  }

  function itemDef(id: string, structureRef: string) {
    if (seenItem.has(id)) return;
    seenItem.add(id);
    itemdefs.push(`<bpmn2:itemDefinition id="${id}" structureRef="${structureRef}"/>`);
  }

  (proc.variables || []).forEach((v) => {
    const iid = `_${v.name}Item`;
    itemDef(iid, v.type || 'String');
    props.push(`<bpmn2:property id="${v.name}" itemSubjectRef="${iid}" name="${v.name}"/>`);
  });

  const d = proc.declarations || { signals: [], errors: [] };
  const signals: SignalDecl[] = d.signals || [];
  const errors: ErrorDecl[] = d.errors || [];
  const messages: MessageDecl[] = d.messages || [];
  const escalations: EscalationDecl[] = d.escalations || [];
  errors.forEach((e) => { if (!seenItem.has(e.id)) { seenItem.add(e.id); itemdefs.push(`<bpmn2:error id="${e.id}" errorCode="${e.errorCode || e.id}"/>`); } });
  signals.forEach((s) => decls.push(`<bpmn2:signal id="${s.id}" name="${escAttr(s.name)}"/>`));
  messages.forEach((m) => decls.push(`<bpmn2:message id="${m.id}"${m.itemRef ? ` itemRef="${m.itemRef}"` : ''}${m.name ? ` name="${escAttr(m.name)}"` : ''}/>`));
  escalations.forEach((e) => decls.push(`<bpmn2:escalation id="${e.id}"${e.escalationCode ? ` escalationCode="${e.escalationCode}"` : ''}${e.name ? ` name="${escAttr(e.name)}"` : ''}/>`));
  (proc.dataStores || []).forEach((ds) => { if (ds.dataStoreRef) decls.push(`<bpmn2:dataStore id="${ds.dataStoreRef}" name="${escAttr(ds.name || ds.id)}"/>`); });

  const POS: Record<string, Position> = {};
  function place(id: string, p?: Position) {
    const b = { x: 100, y: 100, width: 100, height: 80, ...(p || {}) } as Position;
    POS[id] = b;
    shapes.push(
      `<bpmndi:BPMNShape id="shape_${id}" bpmnElement="${id}"${b.expanded ? ' isExpanded="true"' : ''}>` +
      `<dc:Bounds height="${b.height}.0" width="${b.width}.0" x="${b.x}.0" y="${b.y}.0"/></bpmndi:BPMNShape>`);
  }
  function edge(f: Flow) {
    const s = POS[f.sourceRef] || { x: 0, y: 0, width: 0, height: 0 };
    const t = POS[f.targetRef] || { x: 0, y: 0, width: 0, height: 0 };
    const wp = f.waypoints || [{ x: s.x + s.width, y: s.y + s.height / 2 }, { x: t.x, y: t.y + t.height / 2 }];
    edges.push(`<bpmndi:BPMNEdge id="edge_${f.id}" bpmnElement="${f.id}">` +
      wp.map((p) => `<di:waypoint xsi:type="dc:Point" x="${p.x}.0" y="${p.y}.0"/>`).join('') + `</bpmndi:BPMNEdge>`);
  }
  function flowXml(f: Flow): string {
    const nm = f.name ? ` name="${escAttr(f.name)}"` : '';
    let body = f.name ? meta(f.name) : '';
    if (f.condition) body += `<bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression" language="${f.conditionLanguage || JAVA}">${cdata(f.condition)}</bpmn2:conditionExpression>`;
    edge(f);
    return `<bpmn2:sequenceFlow id="${f.id}"${nm} sourceRef="${f.sourceRef}" targetRef="${f.targetRef}">${body}</bpmn2:sequenceFlow>`;
  }

  const inout = (nd: Node) =>
    (nd.incoming || []).map((f) => `<bpmn2:incoming>${f}</bpmn2:incoming>`).join('') +
    (nd.outgoing || []).map((f) => `<bpmn2:outgoing>${f}</bpmn2:outgoing>`).join('');

  const sigId = (name?: string) => (signals.find((x) => x.name === name) || { id: `_sig_${name}` }).id;

  function buildEventDef(nd: Node): string {
    switch (nd.eventType) {
      case 'signal': return `<bpmn2:signalEventDefinition id="${uid()}" signalRef="${sigId(nd.signalName)}"/>`;
      case 'error': return `<bpmn2:errorEventDefinition id="${uid()}" drools:erefname="${nd.errorRef}" errorRef="${nd.errorRef}"/>`;
      case 'message': return `<bpmn2:messageEventDefinition id="${uid()}" messageRef="${nd.messageRef}"/>`;
      case 'escalation': return `<bpmn2:escalationEventDefinition id="${uid()}" escalationRef="${nd.escalationRef}"/>`;
      case 'terminate': return `<bpmn2:terminateEventDefinition id="${uid()}"/>`;
      case 'conditional':
        return `<bpmn2:conditionalEventDefinition id="${uid()}"><bpmn2:condition xsi:type="bpmn2:tFormalExpression" language="${nd.conditionExprLanguage || JAVA}">${cdata(nd.conditionExpr || '')}</bpmn2:condition></bpmn2:conditionalEventDefinition>`;
      case 'timer': {
        let t = '';
        if (nd.timeCycle) t = `<bpmn2:timeCycle xsi:type="bpmn2:tFormalExpression" id="${uid()}">${nd.timeCycle}</bpmn2:timeCycle>`;
        else if (nd.timeDate) t = `<bpmn2:timeDate xsi:type="bpmn2:tFormalExpression" id="${uid()}">${nd.timeDate}</bpmn2:timeDate>`;
        else t = `<bpmn2:timeDuration xsi:type="bpmn2:tFormalExpression" id="${uid()}">${nd.timeDuration || 'PT1M'}</bpmn2:timeDuration>`;
        return `<bpmn2:timerEventDefinition id="${uid()}">${t}</bpmn2:timerEventDefinition>`;
      }
      default: return '';
    }
  }

  function restCall(nd: Node): string {
    REST_INPUTS.forEach((p) => itemDef(`__${nd.id}_${p}InputXItem`, ''));
    itemDef(`__${nd.id}_ResultOutputXItem`, '');
    const entry = nd.onEntry || (
      `com.fasterxml.jackson.databind.node.ObjectNode json = new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode();\n` +
      `json.put("piid", String.valueOf(kcontext.getProcessInstance().getId()));\n` +
      `json.putPOJO("caseId", kcontext.getVariable("caseId"));\n` +
      `json.putPOJO("claimId", kcontext.getVariable("claimId"));\n` + (nd.reqExtra || '') +
      `kcontext.setVariable("reqPayload", json.toString());`);
    const exit = nd.onExit || (
      `String response = (String) kcontext.getVariable("resPayload");\n` +
      `if (response != null && !response.isEmpty()) { try {\n` +
      `  com.fasterxml.jackson.databind.JsonNode root = new com.fasterxml.jackson.databind.ObjectMapper().readTree(response);\n` +
      `${(nd.setVars || []).join('')}} catch(Exception e) {} }`);
    const di = REST_INPUTS.map((p) => `<bpmn2:dataInput id="${nd.id}_${p}InputX" drools:dtype="" itemSubjectRef="__${nd.id}_${p}InputXItem" name="${p}"/>`).join('');
    const refs = REST_INPUTS.map((p) => `<bpmn2:dataInputRefs>${nd.id}_${p}InputX</bpmn2:dataInputRefs>`).join('');
    const aval = (p: string, v: string) =>
      `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:targetRef>${nd.id}_${p}InputX</bpmn2:targetRef>` +
      `<bpmn2:assignment id="${uid()}"><bpmn2:from xsi:type="bpmn2:tFormalExpression" id="${uid()}">${cdata(v)}</bpmn2:from>` +
      `<bpmn2:to xsi:type="bpmn2:tFormalExpression" id="${uid()}">${nd.id}_${p}InputX</bpmn2:to></bpmn2:assignment></bpmn2:dataInputAssociation>`;
    const ext = `<bpmn2:extensionElements><drools:metaData name="elementname"><drools:metaValue>${cdata(nd.name)}</drools:metaValue></drools:metaData>${extraMeta(nd).join('')}` +
      `<drools:onEntry-script scriptFormat="${nd.onEntryFormat || JAVA}"><drools:script>${cdata(entry)}</drools:script></drools:onEntry-script>` +
      `<drools:onExit-script scriptFormat="${nd.onExitFormat || JAVA}"><drools:script>${cdata(exit)}</drools:script></drools:onExit-script></bpmn2:extensionElements>`;
    const iospec = `<bpmn2:ioSpecification id="${uid()}">${di}<bpmn2:dataOutput id="${nd.id}_ResultOutputX" drools:dtype="" itemSubjectRef="__${nd.id}_ResultOutputXItem" name="Result"/>` +
      `<bpmn2:inputSet id="${uid()}">${refs}</bpmn2:inputSet><bpmn2:outputSet id="${uid()}"><bpmn2:dataOutputRefs>${nd.id}_ResultOutputX</bpmn2:dataOutputRefs></bpmn2:outputSet></bpmn2:ioSpecification>`;
    const assocs = `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:sourceRef>reqPayload</bpmn2:sourceRef><bpmn2:targetRef>${nd.id}_ContentDataInputX</bpmn2:targetRef></bpmn2:dataInputAssociation>` +
      aval('ContentType', 'application/json') + aval('HandleResponseErrors', 'true') + aval('Method', nd.method || 'POST') + aval('Url', '#{baseUrl}' + (nd.url || ''));
    const dout = `<bpmn2:dataOutputAssociation id="${uid()}"><bpmn2:sourceRef>${nd.id}_ResultOutputX</bpmn2:sourceRef><bpmn2:targetRef>resPayload</bpmn2:targetRef></bpmn2:dataOutputAssociation>`;
    return `<bpmn2:callActivity id="${nd.id}" drools:independent="true" drools:waitForCompletion="true" name="${escAttr(nd.name)}" calledElement="prudential-claims-submission.pru-rest-executor">${ext}${inout(nd)}${iospec}${assocs}${dout}</bpmn2:callActivity>`;
  }

  function simpleIo(nd: Node): string {
    const dins = (nd.dataInputs || []).map((dd, k) => `<bpmn2:dataInput id="${nd.id}_in${k}" name="${dd.name}"/>`);
    const douts = (nd.dataOutputs || []).map((dd, k) => `<bpmn2:dataOutput id="${nd.id}_out${k}" name="${dd.name}"/>`);
    if (!dins.length && !douts.length) return '';
    const inrefs = (nd.dataInputs || []).map((_x, k) => `<bpmn2:dataInputRefs>${nd.id}_in${k}</bpmn2:dataInputRefs>`).join('');
    const outrefs = (nd.dataOutputs || []).map((_x, k) => `<bpmn2:dataOutputRefs>${nd.id}_out${k}</bpmn2:dataOutputRefs>`).join('');
    const ai = (nd.dataInputs || []).map((dd, k) => `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:sourceRef>${dd.value}</bpmn2:sourceRef><bpmn2:targetRef>${nd.id}_in${k}</bpmn2:targetRef></bpmn2:dataInputAssociation>`).join('');
    const ao = (nd.dataOutputs || []).map((dd, k) => `<bpmn2:dataOutputAssociation id="${uid()}"><bpmn2:sourceRef>${nd.id}_out${k}</bpmn2:sourceRef><bpmn2:targetRef>${dd.to}</bpmn2:targetRef></bpmn2:dataOutputAssociation>`).join('');
    return `<bpmn2:ioSpecification id="${uid()}">${dins.join('')}${douts.join('')}<bpmn2:inputSet id="${uid()}">${inrefs}</bpmn2:inputSet><bpmn2:outputSet id="${uid()}">${outrefs}</bpmn2:outputSet></bpmn2:ioSpecification>${ai}${ao}`;
  }

  function miCall(nd: Node): string {
    const mi = nd.multiInstance!;
    const pass = mi.passthru || [];
    const dins = [`<bpmn2:dataInput id="${nd.id}_incoll" name="IN_COLL"/>`, `<bpmn2:dataInput id="${nd.id}_item" name="${mi.itemVar}"/>`]
      .concat(pass.map((v) => `<bpmn2:dataInput id="${nd.id}_${v}" name="${v}"/>`));
    const douts = [`<bpmn2:dataOutput id="${nd.id}_outcoll" name="OUT_COLL"/>`, `<bpmn2:dataOutput id="${nd.id}_itemout" name="${mi.itemOutVar}"/>`];
    const inrefs = `<bpmn2:dataInputRefs>${nd.id}_incoll</bpmn2:dataInputRefs><bpmn2:dataInputRefs>${nd.id}_item</bpmn2:dataInputRefs>` + pass.map((v) => `<bpmn2:dataInputRefs>${nd.id}_${v}</bpmn2:dataInputRefs>`).join('');
    const outrefs = `<bpmn2:dataOutputRefs>${nd.id}_outcoll</bpmn2:dataOutputRefs><bpmn2:dataOutputRefs>${nd.id}_itemout</bpmn2:dataOutputRefs>`;
    let assoc = `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:sourceRef>${mi.collectionIn}</bpmn2:sourceRef><bpmn2:targetRef>${nd.id}_incoll</bpmn2:targetRef></bpmn2:dataInputAssociation>`;
    pass.forEach((v) => { assoc += `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:sourceRef>${v}</bpmn2:sourceRef><bpmn2:targetRef>${nd.id}_${v}</bpmn2:targetRef></bpmn2:dataInputAssociation>`; });
    assoc += `<bpmn2:dataOutputAssociation id="${uid()}"><bpmn2:sourceRef>${nd.id}_outcoll</bpmn2:sourceRef><bpmn2:targetRef>${mi.collectionOut}</bpmn2:targetRef></bpmn2:dataOutputAssociation>`;
    const loop = `<bpmn2:multiInstanceLoopCharacteristics${mi.isSequential ? ' isSequential="true"' : ''}><bpmn2:loopDataInputRef>${nd.id}_incoll</bpmn2:loopDataInputRef><bpmn2:loopDataOutputRef>${nd.id}_outcoll</bpmn2:loopDataOutputRef><bpmn2:inputDataItem id="${nd.id}_item" name="${mi.itemVar}"/><bpmn2:outputDataItem id="${nd.id}_itemout" name="${mi.itemOutVar}"/></bpmn2:multiInstanceLoopCharacteristics>`;
    return `<bpmn2:callActivity id="${nd.id}" drools:independent="false" drools:waitForCompletion="true" name="${escAttr(nd.name)}" calledElement="${nd.calledElement}">${extBlock(nd)}${inout(nd)}<bpmn2:ioSpecification id="${uid()}">${dins.join('')}${douts.join('')}<bpmn2:inputSet id="${uid()}">${inrefs}</bpmn2:inputSet><bpmn2:outputSet id="${uid()}">${outrefs}</bpmn2:outputSet></bpmn2:ioSpecification>${assoc}${loop}</bpmn2:callActivity>`;
  }

  function genericTask(nd: Node): string {
    // <bpmn2:task drools:taskName="X"> — generic custom WorkItemHandler task (e.g. jBPM's built-in
    // "Rest" REST work item, or any customer WorkItemHandler bound by name).
    const params = nd.workParams || {};
    const ports = Object.keys(params);
    ports.forEach((p) => itemDef(`__${nd.id}_${p}InputXItem`, ''));
    const din = (p: string) => `<bpmn2:dataInput id="${nd.id}_${p}InputX" drools:dtype="" itemSubjectRef="__${nd.id}_${p}InputXItem" name="${p}"/>`;
    const dinAssoc = (p: string, v: string) => v.startsWith('$')
      ? `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:sourceRef>${v.slice(1)}</bpmn2:sourceRef><bpmn2:targetRef>${nd.id}_${p}InputX</bpmn2:targetRef></bpmn2:dataInputAssociation>`
      : `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:targetRef>${nd.id}_${p}InputX</bpmn2:targetRef><bpmn2:assignment id="${uid()}"><bpmn2:from xsi:type="bpmn2:tFormalExpression" id="${uid()}">${cdata(v)}</bpmn2:from><bpmn2:to xsi:type="bpmn2:tFormalExpression" id="${uid()}">${nd.id}_${p}InputX</bpmn2:to></bpmn2:assignment></bpmn2:dataInputAssociation>`;
    const resultTo = nd.workResultTo || {};
    const outPorts = Object.keys(resultTo).map((varName) => resultTo[varName]);
    outPorts.forEach((p) => itemDef(`__${nd.id}_${p}OutputXItem`, ''));
    const dout = (p: string) => `<bpmn2:dataOutput id="${nd.id}_${p}OutputX" drools:dtype="" itemSubjectRef="__${nd.id}_${p}OutputXItem" name="${p}"/>`;
    const doutAssoc = (varName: string, p: string) => `<bpmn2:dataOutputAssociation id="${uid()}"><bpmn2:sourceRef>${nd.id}_${p}OutputX</bpmn2:sourceRef><bpmn2:targetRef>${varName}</bpmn2:targetRef></bpmn2:dataOutputAssociation>`;
    const dins = ports.map(din).join('');
    const douts = outPorts.map(dout).join('');
    const inrefs = ports.map((p) => `<bpmn2:dataInputRefs>${nd.id}_${p}InputX</bpmn2:dataInputRefs>`).join('');
    const outrefs = outPorts.map((p) => `<bpmn2:dataOutputRefs>${nd.id}_${p}OutputX</bpmn2:dataOutputRefs>`).join('');
    const iospec = (ports.length || outPorts.length)
      ? `<bpmn2:ioSpecification id="${uid()}">${dins}${douts}<bpmn2:inputSet id="${uid()}">${inrefs}</bpmn2:inputSet><bpmn2:outputSet id="${uid()}">${outrefs}</bpmn2:outputSet></bpmn2:ioSpecification>`
      : '';
    const assocs = ports.map((p) => dinAssoc(p, params[p])).join('') + Object.entries(resultTo).map(([varName, p]) => doutAssoc(varName, p)).join('');
    return `<bpmn2:task id="${nd.id}" drools:taskName="${escAttr(nd.handlerName || '')}" name="${escAttr(nd.name || nd.handlerName || '')}">${extBlock(nd)}${inout(nd)}${iospec}${assocs}</bpmn2:task>`;
  }

  function userTask(nd: Node): string {
    const ports = ['TaskName', 'Skippable', ...(nd.group ? ['GroupId'] : [])];
    ports.forEach((p) => itemDef(`__${nd.id}_${p}InputXItem`, ''));
    const din = (p: string) => `<bpmn2:dataInput id="${nd.id}_${p}InputX" drools:dtype="Object" itemSubjectRef="__${nd.id}_${p}InputXItem" name="${p}"/>`;
    const asg = (p: string, v: string) => `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:targetRef>${nd.id}_${p}InputX</bpmn2:targetRef><bpmn2:assignment id="${uid()}"><bpmn2:from xsi:type="bpmn2:tFormalExpression" id="${uid()}">${cdata(v)}</bpmn2:from><bpmn2:to xsi:type="bpmn2:tFormalExpression" id="${uid()}">${nd.id}_${p}InputX</bpmn2:to></bpmn2:assignment></bpmn2:dataInputAssociation>`;
    const dins = ports.map(din).join('');
    const refs = ports.map((p) => `<bpmn2:dataInputRefs>${nd.id}_${p}InputX</bpmn2:dataInputRefs>`).join('');
    const asgs = asg('TaskName', nd.taskName || nd.name || 'Task') + asg('Skippable', String(nd.skippable !== false)) + (nd.group ? asg('GroupId', nd.group) : '');
    return `<bpmn2:userTask id="${nd.id}" name="${escAttr(nd.name)}">${extBlock(nd)}${inout(nd)}<bpmn2:ioSpecification id="${uid()}">${dins}<bpmn2:inputSet id="${uid()}">${refs}</bpmn2:inputSet><bpmn2:outputSet id="${uid()}"/></bpmn2:ioSpecification>${asgs}</bpmn2:userTask>`;
  }

  const gatewayEl: Record<string, string> = {
    exclusiveGateway: 'exclusiveGateway', parallelGateway: 'parallelGateway',
    inclusiveGateway: 'inclusiveGateway', eventBasedGateway: 'eventBasedGateway', complexGateway: 'complexGateway',
  };
  function gateway(nd: Node): string {
    const el = gatewayEl[nd.type];
    const extra = (nd.default ? ` default="${nd.default}"` : '') +
      (nd.type === 'eventBasedGateway' && nd.eventGatewayType ? ` eventGatewayType="${nd.eventGatewayType}"` : '') +
      (nd.type === 'eventBasedGateway' && nd.instantiate != null ? ` instantiate="${nd.instantiate}"` : '');
    return `<bpmn2:${el} id="${nd.id}"${nd.name ? ` name="${escAttr(nd.name)}"` : ''} gatewayDirection="${nd.gatewayDirection || 'Diverging'}"${extra}>${nd.name ? meta(nd.name) : ''}${inout(nd)}</bpmn2:${el}>`;
  }

  function eventNode(el: string, nd: Node, extraAttrs = ''): string {
    return `<bpmn2:${el} id="${nd.id}" name="${escAttr(nd.name || '')}"${extraAttrs}>${meta(nd.name)}${inout(nd)}${buildEventDef(nd)}</bpmn2:${el}>`;
  }

  function bizTask(nd: Node): string {
    const a = (nd.ruleFlowGroup ? ` drools:ruleFlowGroup="${escAttr(nd.ruleFlowGroup)}"` : '') + ` implementation="${nd.implementation || '##unspecified'}"`;
    return `<bpmn2:businessRuleTask id="${nd.id}"${a} name="${escAttr(nd.name)}">${extBlock(nd)}${inout(nd)}${simpleIo(nd)}</bpmn2:businessRuleTask>`;
  }
  function msgTask(el: string, nd: Node): string {
    const a = (nd.messageRef ? ` messageRef="${nd.messageRef}"` : '') + (nd.operationRef ? ` operationRef="${nd.operationRef}"` : '') + (nd.implementation ? ` implementation="${nd.implementation}"` : '');
    return `<bpmn2:${el} id="${nd.id}"${a} name="${escAttr(nd.name)}">${extBlock(nd)}${inout(nd)}${simpleIo(nd)}</bpmn2:${el}>`;
  }
  function manualTask(nd: Node): string {
    return `<bpmn2:manualTask id="${nd.id}" name="${escAttr(nd.name)}">${extBlock(nd)}${inout(nd)}</bpmn2:manualTask>`;
  }

  function subProcess(nd: Node): string {
    const tag = nd.subtype === 'transaction' ? 'transaction' : 'subProcess';
    const trig = nd.subtype === 'event' ? ' triggeredByEvent="true"' : '';
    let inner = '';
    // event-subprocess shorthand: nd.error and no children -> error start -> terminate
    if (nd.subtype === 'event' && nd.error && !(nd.nodes && nd.nodes.length)) {
      inner =
        `<bpmn2:startEvent id="${nd.id}_start" name="Catch" isInterrupting="true"><bpmn2:outgoing>${nd.id}_f</bpmn2:outgoing><bpmn2:errorEventDefinition id="${uid()}" drools:erefname="${nd.error}" errorRef="${nd.error}"/></bpmn2:startEvent>` +
        `<bpmn2:endEvent id="${nd.id}_end" name="Terminate"><bpmn2:incoming>${nd.id}_f</bpmn2:incoming><bpmn2:terminateEventDefinition id="${uid()}"/></bpmn2:endEvent>` +
        `<bpmn2:sequenceFlow id="${nd.id}_f" sourceRef="${nd.id}_start" targetRef="${nd.id}_end"/>`;
    } else {
      (nd.flows || []).forEach((f) => { inner += flowXml(f); });
      (nd.nodes || []).forEach((cn) => { if (cn.position) place(cn.id, cn.position); inner += emitNode(cn); });
    }
    return `<bpmn2:${tag} id="${nd.id}" name="${escAttr(nd.name || '')}"${trig}>${extBlock(nd)}${inout(nd)}${inner}</bpmn2:${tag}>`;
  }

  function emitNode(nd: Node): string {
    switch (nd.type) {
      case 'startEvent': return eventNode('startEvent', nd, nd.isInterrupting != null ? ` isInterrupting="${nd.isInterrupting}"` : '');
      case 'endEvent': {
        // map legacy subtypes -> eventType
        if (!nd.eventType) {
          if (nd.subtype === 'terminate') nd.eventType = 'terminate';
          else if (nd.subtype === 'signalThrow') nd.eventType = 'signal';
          else if (nd.subtype === 'errorThrow') nd.eventType = 'error';
        }
        return eventNode('endEvent', nd);
      }
      case 'intermediateCatchEvent': return eventNode('intermediateCatchEvent', nd);
      case 'intermediateThrowEvent': return eventNode('intermediateThrowEvent', nd);
      case 'boundaryEvent':
        return `<bpmn2:boundaryEvent id="${nd.id}" drools:boundaryca="true" name="${escAttr(nd.name || '')}" attachedToRef="${nd.attachedTo}"${nd.cancelActivity === false ? ' cancelActivity="false"' : ''}>${meta(nd.name)}${(nd.outgoing || []).map((f) => `<bpmn2:outgoing>${f}</bpmn2:outgoing>`).join('')}${buildEventDef(nd)}</bpmn2:boundaryEvent>`;
      case 'scriptTask':
        return `<bpmn2:scriptTask id="${nd.id}" name="${escAttr(nd.name)}" scriptFormat="${nd.scriptFormat || JAVA}">${meta(nd.name)}${inout(nd)}<bpmn2:script>${cdata(nd.script || '')}</bpmn2:script></bpmn2:scriptTask>`;
      case 'userTask': return userTask(nd);
      case 'businessRuleTask': return bizTask(nd);
      case 'sendTask': return msgTask('sendTask', nd);
      case 'receiveTask': return msgTask('receiveTask', nd);
      case 'manualTask': return manualTask(nd);
      case 'genericTask': return genericTask(nd);
      case 'exclusiveGateway': case 'parallelGateway': case 'inclusiveGateway':
      case 'eventBasedGateway': case 'complexGateway': return gateway(nd);
      case 'subProcess': return subProcess(nd);
      case 'callActivity':
        if (nd.subtype === 'multiInstance') return miCall(nd);
        if (nd.subtype === 'rest' || nd.rest) return restCall(nd);
        return `<bpmn2:callActivity id="${nd.id}" drools:independent="${nd.independent !== false}" drools:waitForCompletion="${nd.waitForCompletion !== false}" name="${escAttr(nd.name)}" calledElement="${nd.calledElement}">${extBlock(nd)}${inout(nd)}${simpleIo(nd)}</bpmn2:callActivity>`;
      case 'raw': return nd.raw || '';
      default: throw new Error(`Unknown node type: ${(nd as Node).type} (${(nd as Node).id})`);
    }
  }

  // ---- process-level extras ----
  const laneSet = (proc.lanes && proc.lanes.length)
    ? `<bpmn2:laneSet id="${uid('_ls')}">` + proc.lanes.map((l) =>
        `<bpmn2:lane id="${l.id}"${l.name ? ` name="${escAttr(l.name)}"` : ''}>` +
        l.flowNodeRefs.map((r) => `<bpmn2:flowNodeRef>${r}</bpmn2:flowNodeRef>`).join('') + `</bpmn2:lane>`).join('') + `</bpmn2:laneSet>`
    : '';
  const dataObjs = (proc.dataObjects || []).map((o) => {
    if (o.type) itemDef(`_${o.id}Item`, o.type);
    return `<bpmn2:dataObject id="${o.id}"${o.name ? ` name="${escAttr(o.name)}"` : ''}${o.type ? ` itemSubjectRef="_${o.id}Item"` : ''}${o.isCollection ? ' isCollection="true"' : ''}/>`;
  }).join('');
  const dataStoreRefs = (proc.dataStores || []).map((ds) =>
    `<bpmn2:dataStoreReference id="${ds.id}"${ds.name ? ` name="${escAttr(ds.name)}"` : ''}${ds.dataStoreRef ? ` dataStoreRef="${ds.dataStoreRef}"` : ''}/>`).join('');

  // ---- emit top-level ----
  (proc.nodes || []).forEach((nd) => { if (nd.position) place(nd.id, nd.position); topNodes.push(emitNode(nd)); });
  (proc.flows || []).forEach((f) => topFlows.push(flowXml(f)));

  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions ${DEFINITIONS_ATTRS} id="${uid('_def')}">
${itemdefs.join('\n')}
${decls.join('\n')}
  <bpmn2:process id="${proc.id}" drools:packageName="${proc.packageName || 'org.jbpm'}" drools:version="1.0" name="${escAttr(proc.name)}" isExecutable="true" processType="${proc.processType || 'Public'}">
${props.join('\n')}
${laneSet}
${dataObjs}
${dataStoreRefs}
${topFlows.join('\n')}
${topNodes.join('\n')}
  </bpmn2:process>
  <bpmndi:BPMNDiagram id="${uid()}"><bpmndi:BPMNPlane id="${uid()}" bpmnElement="${proc.id}">
${shapes.join('\n')}
${edges.join('\n')}
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn2:definitions>
`;
}
