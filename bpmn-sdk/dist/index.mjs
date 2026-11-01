var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/xml.ts
function decodeEntities(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}
function parseXml(str) {
  let i = 0;
  const n = str.length;
  const isWs = (c) => c === " " || c === "	" || c === "\n" || c === "\r";
  const skipWs = () => {
    while (i < n && isWs(str[i])) i++;
  };
  function parseAttrs(s) {
    const attrs = {};
    const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m;
    while (m = re.exec(s)) {
      attrs[m[1]] = decodeEntities(m[3] !== void 0 ? m[3] : m[4]);
    }
    return attrs;
  }
  function parseNode() {
    i++;
    let name = "";
    while (i < n && !isWs(str[i]) && str[i] !== ">" && str[i] !== "/") name += str[i++];
    let attrStr = "";
    while (i < n && str[i] !== ">" && !(str[i] === "/" && str[i + 1] === ">")) attrStr += str[i++];
    const node = { name, attrs: parseAttrs(attrStr), children: [], text: "", cdata: [] };
    if (str[i] === "/" && str[i + 1] === ">") {
      i += 2;
      return node;
    }
    i++;
    while (i < n) {
      if (str.startsWith("<!--", i)) {
        i = str.indexOf("-->", i) + 3;
        continue;
      }
      if (str.startsWith("<![CDATA[", i)) {
        const end = str.indexOf("]]>", i);
        node.cdata.push(str.slice(i + 9, end));
        node.text += str.slice(i + 9, end);
        i = end + 3;
        continue;
      }
      if (str.startsWith("</", i)) {
        i = str.indexOf(">", i) + 1;
        return node;
      }
      if (str[i] === "<") {
        node.children.push(parseNode());
        continue;
      }
      let t = "";
      while (i < n && str[i] !== "<") t += str[i++];
      if (t.trim()) node.text += decodeEntities(t.trim());
    }
    return node;
  }
  while (i < n) {
    skipWs();
    if (str.startsWith("<?", i)) {
      i = str.indexOf("?>", i) + 2;
      continue;
    }
    if (str.startsWith("<!--", i)) {
      i = str.indexOf("-->", i) + 3;
      continue;
    }
    if (str.startsWith("<!", i)) {
      i = str.indexOf(">", i) + 1;
      continue;
    }
    if (str[i] === "<") break;
    i++;
  }
  return parseNode();
}
function local(name) {
  return name.includes(":") ? name.split(":")[1] : name;
}
function kids(node, localName) {
  return (node.children || []).filter((c) => local(c.name) === localName);
}
function kid(node, localName) {
  return kids(node, localName)[0];
}
function descendants(node, localName, out = []) {
  for (const c of node.children || []) {
    if (local(c.name) === localName) out.push(c);
    descendants(c, localName, out);
  }
  return out;
}
function cdataText(node) {
  return node ? node.cdata.length ? node.cdata.join("") : node.text : "";
}
function escXml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function cdata(s) {
  return `<![CDATA[${s == null ? "" : s}]]>`;
}
function stringifyNode(el2) {
  const a = Object.entries(el2.attrs || {}).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
  let inner;
  if (el2.children && el2.children.length) inner = el2.children.map(stringifyNode).join("");
  else if (el2.cdata && el2.cdata.length) inner = el2.cdata.map(cdata).join("");
  else inner = escXml(el2.text || "");
  return inner ? `<${el2.name}${a}>${inner}</${el2.name}>` : `<${el2.name}${a}/>`;
}

// src/parse.ts
var RAW_SKIP = /* @__PURE__ */ new Set([
  "property",
  "sequenceFlow",
  "laneSet",
  "extensionElements",
  "ioSpecification",
  "documentation",
  "dataObject",
  "dataObjectReference",
  "dataStore",
  "dataStoreReference",
  "textAnnotation",
  "association",
  "group",
  // structural children of an activity/container that are not flow nodes:
  "incoming",
  "outgoing",
  "multiInstanceLoopCharacteristics",
  "dataInputAssociation",
  "dataOutputAssociation",
  "dataInput",
  "dataOutput",
  "inputSet",
  "outputSet",
  "conditionExpression"
]);
var GATEWAYS = {
  exclusiveGateway: "exclusiveGateway",
  parallelGateway: "parallelGateway",
  inclusiveGateway: "inclusiveGateway",
  eventBasedGateway: "eventBasedGateway",
  complexGateway: "complexGateway"
};
function attr(el2, name) {
  return el2.attrs[name] !== void 0 ? el2.attrs[name] : el2.attrs[name.split(":").pop()];
}
function parseBpmnAll(xml) {
  const defs = parseXml(xml);
  const itemTypes = {};
  kids(defs, "itemDefinition").forEach((it) => {
    itemTypes[it.attrs.id] = it.attrs.structureRef || "";
  });
  const signals = kids(defs, "signal").map((s) => ({ id: s.attrs.id, name: s.attrs.name }));
  const errors = kids(defs, "error").map((e) => ({ id: e.attrs.id, errorCode: e.attrs.errorCode }));
  const messages = kids(defs, "message").map((m) => ({ id: m.attrs.id, name: m.attrs.name, itemRef: m.attrs.itemRef }));
  const escalations = kids(defs, "escalation").map((e) => ({ id: e.attrs.id, escalationCode: e.attrs.escalationCode, name: e.attrs.name }));
  const sigName = (ref) => (signals.find((s) => s.id === ref) || {}).name || ref;
  let gc = 0;
  const genId = (p) => `_${p}${++gc}`;
  const pos = {};
  const wps = {};
  descendants(defs, "BPMNShape").forEach((sh) => {
    const b = kid(sh, "Bounds");
    if (b) pos[sh.attrs.bpmnElement] = { x: +b.attrs.x, y: +b.attrs.y, width: +b.attrs.width, height: +b.attrs.height, expanded: sh.attrs.isExpanded === "true" };
  });
  descendants(defs, "BPMNEdge").forEach((e) => {
    wps[e.attrs.bpmnElement] = kids(e, "waypoint").map((w) => ({ x: +w.attrs.x, y: +w.attrs.y }));
  });
  const io = (el2) => ({
    incoming: kids(el2, "incoming").map((c) => cdataText(c) || c.text),
    outgoing: kids(el2, "outgoing").map((c) => cdataText(c) || c.text)
  });
  const elementName = (el2) => {
    const ext = kid(el2, "extensionElements");
    if (ext) {
      const md = kids(ext, "metaData").find((m) => m.attrs.name === "elementname");
      if (md) return cdataText(kid(md, "metaValue"));
    }
    return el2.attrs.name;
  };
  const targetText = (a) => {
    const t = kid(a, "targetRef");
    return t ? cdataText(t) || t.text : "";
  };
  const sourceText = (a) => {
    const s = kid(a, "sourceRef");
    return s ? cdataText(s) || s.text : "";
  };
  const assignTo = (el2, suffix) => {
    const a = kids(el2, "dataInputAssociation").find((x) => targetText(x).endsWith(suffix));
    if (!a) return void 0;
    const asg = kid(a, "assignment");
    if (!asg) return void 0;
    return cdataText(kid(asg, "from"));
  };
  function userTaskInputs(el2) {
    const spec = kid(el2, "ioSpecification");
    const out = {};
    const nameOf = new Map(spec ? kids(spec, "dataInput").map((d) => [d.attrs.id, d.attrs.name]) : []);
    for (const a of spec ? kids(el2, "dataInputAssociation") : []) {
      const name = nameOf.get(targetText(a));
      if (!name || name === "TaskName" || name === "Skippable" || name === "GroupId") continue;
      const asg = kid(a, "assignment");
      const v = asg ? cdataText(kid(asg, "from")) : void 0;
      if (v !== void 0) out[name] = v;
    }
    const roleIds = (tag) => kids(el2, tag).flatMap((r) => {
      const ra = kid(r, "resourceAssignmentExpression");
      const fe = ra ? kid(ra, "formalExpression") : void 0;
      return (fe ? cdataText(fe) ?? "" : "").split(",").map((x) => x.trim()).filter(Boolean);
    });
    const merge = (key, add) => {
      if (!add.length) return;
      const have = (out[key] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      out[key] = [.../* @__PURE__ */ new Set([...have, ...add])].join(",");
    };
    merge("ActorId", roleIds("potentialOwner"));
    merge("BusinessAdministratorId", roleIds("businessAdministrator"));
    return out;
  }
  function applyOnEntryExit(el2, nd) {
    const ext = kid(el2, "extensionElements");
    if (!ext) return;
    const onE = kids(ext, "onEntry-script")[0];
    const onX = kids(ext, "onExit-script")[0];
    if (onE) {
      nd.onEntry = cdataText(kid(onE, "script"));
      const f = attr(onE, "scriptFormat");
      if (f) nd.onEntryFormat = f;
    }
    if (onX) {
      nd.onExit = cdataText(kid(onX, "script"));
      const f = attr(onX, "scriptFormat");
      if (f) nd.onExitFormat = f;
    }
    for (const md of kids(ext, "metaData")) {
      const name = md.attrs.name;
      if (!name || name === "elementname") continue;
      const v = cdataText(kid(md, "metaValue")) ?? "";
      if (name === "customAsync") nd.async = v.trim() === "true";
      else if (name === "customSLADueDate") nd.slaDueDate = v;
      else if (name === "customAutoStart") nd.autoStart = v.trim() === "true";
      else (nd.metaData ||= {})[name] = v;
    }
  }
  function applyEventDef(nd, el2) {
    const sg = kid(el2, "signalEventDefinition");
    if (sg) {
      nd.eventType = "signal";
      nd.signalName = sigName(sg.attrs.signalRef);
      return;
    }
    const er = kid(el2, "errorEventDefinition");
    if (er) {
      nd.eventType = "error";
      nd.errorRef = er.attrs.errorRef;
      return;
    }
    const ms = kid(el2, "messageEventDefinition");
    if (ms) {
      nd.eventType = "message";
      nd.messageRef = ms.attrs.messageRef;
      return;
    }
    const es = kid(el2, "escalationEventDefinition");
    if (es) {
      nd.eventType = "escalation";
      nd.escalationRef = es.attrs.escalationRef;
      return;
    }
    const cd = kid(el2, "conditionalEventDefinition");
    if (cd) {
      nd.eventType = "conditional";
      const c = kid(cd, "condition");
      nd.conditionExpr = cdataText(c);
      if (c && c.attrs.language) nd.conditionExprLanguage = c.attrs.language;
      return;
    }
    const tm = kid(el2, "timerEventDefinition");
    if (tm) {
      nd.eventType = "timer";
      const dur = kid(tm, "timeDuration"), cyc = kid(tm, "timeCycle"), dat = kid(tm, "timeDate");
      if (cyc) {
        nd.timeCycle = cdataText(cyc);
        if (cyc.attrs.language) nd.timeCycleLanguage = cyc.attrs.language;
      } else if (dat) nd.timeDate = cdataText(dat);
      else nd.timeDuration = cdataText(dur);
      return;
    }
    const tr = kid(el2, "terminateEventDefinition");
    if (tr) {
      nd.eventType = "terminate";
      return;
    }
    nd.eventType = "none";
  }
  function parseContainer(container) {
    const nodes = [];
    const flows = [];
    for (const el2 of container.children) {
      const tag = local(el2.name);
      if (tag === "sequenceFlow") {
        const f = { id: el2.attrs.id || genId("flow"), sourceRef: el2.attrs.sourceRef, targetRef: el2.attrs.targetRef };
        if (el2.attrs.name) f.name = el2.attrs.name;
        const c = kid(el2, "conditionExpression");
        if (c) {
          f.condition = cdataText(c);
          if (c.attrs.language) f.conditionLanguage = c.attrs.language;
        }
        if (wps[el2.attrs.id]) f.waypoints = wps[el2.attrs.id];
        flows.push(f);
        continue;
      }
      const base = { id: el2.attrs.id || genId("node"), name: elementName(el2), type: "raw", position: pos[el2.attrs.id], ...io(el2) };
      if (GATEWAYS[tag]) {
        const nd = { ...base, type: GATEWAYS[tag], gatewayDirection: el2.attrs.gatewayDirection || "Unspecified" };
        if (el2.attrs.default) nd.default = el2.attrs.default;
        if (tag === "eventBasedGateway") {
          if (el2.attrs.eventGatewayType) nd.eventGatewayType = el2.attrs.eventGatewayType;
          if (el2.attrs.instantiate) nd.instantiate = el2.attrs.instantiate === "true";
        }
        applyOnEntryExit(el2, nd);
        nodes.push(nd);
        continue;
      }
      switch (tag) {
        case "startEvent": {
          const nd = { ...base, type: "startEvent" };
          if (el2.attrs.isInterrupting) nd.isInterrupting = el2.attrs.isInterrupting === "true";
          applyEventDef(nd, el2);
          nd.subtype = nd.eventType;
          nodes.push(nd);
          break;
        }
        case "endEvent": {
          const nd = { ...base, type: "endEvent" };
          applyEventDef(nd, el2);
          nd.subtype = nd.eventType === "terminate" ? "terminate" : nd.eventType;
          applyOnEntryExit(el2, nd);
          nodes.push(nd);
          break;
        }
        case "intermediateCatchEvent": {
          const nd = { ...base, type: "intermediateCatchEvent" };
          applyEventDef(nd, el2);
          nodes.push(nd);
          break;
        }
        case "intermediateThrowEvent": {
          const nd = { ...base, type: "intermediateThrowEvent" };
          applyEventDef(nd, el2);
          nodes.push(nd);
          break;
        }
        case "boundaryEvent": {
          const nd = { ...base, type: "boundaryEvent", attachedTo: el2.attrs.attachedToRef, cancelActivity: el2.attrs.cancelActivity !== "false" };
          applyEventDef(nd, el2);
          nodes.push(nd);
          break;
        }
        case "scriptTask": {
          const nd = { ...base, type: "scriptTask", script: cdataText(kid(el2, "script")), scriptFormat: el2.attrs.scriptFormat };
          applyOnEntryExit(el2, nd);
          nodes.push(nd);
          break;
        }
        case "userTask": {
          const nd = { ...base, type: "userTask", taskName: assignTo(el2, "_TaskNameInputX"), skippable: assignTo(el2, "_SkippableInputX") !== "false", group: assignTo(el2, "_GroupIdInputX") };
          const ti = userTaskInputs(el2);
          if (Object.keys(ti).length) nd.taskInputs = ti;
          applyOnEntryExit(el2, nd);
          nodes.push(nd);
          break;
        }
        case "businessRuleTask": {
          const nd = { ...base, type: "businessRuleTask", ruleFlowGroup: attr(el2, "drools:ruleFlowGroup"), implementation: el2.attrs.implementation };
          if (el2.attrs.implementation === "http://www.jboss.org/drools/dmn") {
            nd.dmnNamespace = assignTo(el2, "_namespaceInputX");
            nd.dmnModel = assignTo(el2, "_modelInputX");
          }
          applyOnEntryExit(el2, nd);
          nodes.push(nd);
          break;
        }
        case "sendTask": {
          const nd = { ...base, type: "sendTask", messageRef: el2.attrs.messageRef, operationRef: el2.attrs.operationRef, implementation: el2.attrs.implementation };
          applyOnEntryExit(el2, nd);
          nodes.push(nd);
          break;
        }
        case "receiveTask": {
          const nd = { ...base, type: "receiveTask", messageRef: el2.attrs.messageRef, implementation: el2.attrs.implementation };
          applyOnEntryExit(el2, nd);
          nodes.push(nd);
          break;
        }
        case "manualTask": {
          const nd = { ...base, type: "manualTask" };
          applyOnEntryExit(el2, nd);
          nodes.push(nd);
          break;
        }
        case "subProcess":
        case "transaction": {
          const nd = { ...base, type: "subProcess", subtype: tag === "transaction" ? "transaction" : el2.attrs.triggeredByEvent === "true" ? "event" : "embedded" };
          applyOnEntryExit(el2, nd);
          const inner = parseContainer(el2);
          nd.nodes = inner.nodes;
          nd.flows = inner.flows;
          nodes.push(nd);
          break;
        }
        case "callActivity": {
          const nd = { ...base, type: "callActivity", calledElement: el2.attrs.calledElement, ...attr(el2, "drools:abortParent") === "true" ? { abortParent: true } : {} };
          const mi = kid(el2, "multiInstanceLoopCharacteristics");
          if (mi) {
            nd.subtype = "multiInstance";
            const idi = kid(mi, "inputDataItem");
            const odi = kid(mi, "outputDataItem");
            const firstIn = kids(el2, "dataInputAssociation")[0];
            const firstOut = kids(el2, "dataOutputAssociation")[0];
            nd.multiInstance = {
              isSequential: mi.attrs.isSequential === "true",
              itemVar: idi && idi.attrs.name || "item",
              itemOutVar: odi && odi.attrs.name || "result",
              collectionIn: firstIn ? sourceText(firstIn) : "",
              collectionOut: firstOut ? targetText(firstOut) : "",
              ...kid(mi, "completionCondition") ? { completionCondition: cdataText(kid(mi, "completionCondition")) } : {}
            };
          } else if ((el2.attrs.calledElement || "").endsWith("pru-rest-executor")) {
            nd.subtype = "rest";
            const url = assignTo(el2, "_UrlInputX");
            nd.url = url ? url.replace("#{baseUrl}", "") : void 0;
            nd.method = assignTo(el2, "_MethodInputX") || "POST";
          } else {
            nd.subtype = "reusable";
          }
          const portName = (ref, suffix) => ref.startsWith(`${el2.attrs.id}_`) && ref.endsWith(suffix) ? ref.slice(el2.attrs.id.length + 1, -suffix.length) : ref;
          const inputs = {};
          for (const a of kids(el2, "dataInputAssociation")) {
            const port = portName(targetText(a), "InputX");
            const asg = kid(a, "assignment");
            const value = asg ? cdataText(kid(asg, "from")) : sourceText(a);
            if (port && value !== void 0) inputs[port] = asg ? value || "" : `$${value}`;
          }
          const outputs = {};
          for (const a of kids(el2, "dataOutputAssociation")) {
            const port = portName(sourceText(a), "OutputX");
            const target = targetText(a);
            if (port && target) outputs[target] = port;
          }
          if (Object.keys(inputs).length) nd.inputs = inputs;
          if (Object.keys(outputs).length) nd.outputs = outputs;
          applyOnEntryExit(el2, nd);
          nodes.push(nd);
          break;
        }
        case "task": {
          const handlerName = attr(el2, "drools:taskName");
          if (!handlerName) {
            if (!RAW_SKIP.has(tag)) nodes.push({ ...base, type: "raw", bpmnLocal: tag, raw: stringifyNode(el2) });
            break;
          }
          const portName = (ref, suffix) => ref.startsWith(`${el2.attrs.id}_`) && ref.endsWith(suffix) ? ref.slice(el2.attrs.id.length + 1, -suffix.length) : ref;
          const workParams = {};
          for (const a of kids(el2, "dataInputAssociation")) {
            const port = portName(targetText(a), "InputX");
            const asg = kid(a, "assignment");
            const value = asg ? cdataText(kid(asg, "from")) : sourceText(a);
            if (port && value !== void 0) workParams[port] = asg ? value || "" : `$${value}`;
          }
          const workResultTo = {};
          for (const a of kids(el2, "dataOutputAssociation")) {
            const port = portName(sourceText(a), "OutputX");
            const varName = targetText(a);
            if (port && varName) workResultTo[varName] = port;
          }
          const nd = { ...base, type: "genericTask", handlerName, workParams, workResultTo };
          applyOnEntryExit(el2, nd);
          nodes.push(nd);
          break;
        }
        default:
          if (!RAW_SKIP.has(tag)) nodes.push({ ...base, type: "raw", bpmnLocal: tag, raw: stringifyNode(el2) });
          break;
      }
    }
    return { nodes, flows };
  }
  function metaValues(el2) {
    const ext = kid(el2, "extensionElements");
    const out = {};
    if (ext) for (const md of kids(ext, "metaData")) {
      const name = md.attrs.name;
      if (name) out[name] = cdataText(kid(md, "metaValue")) ?? "";
    }
    return out;
  }
  function procMeta(proc) {
    const m = metaValues(proc);
    const out = {};
    const rest = {};
    for (const [k, v] of Object.entries(m)) {
      if (k === "customSLADueDate") out.slaDueDate = v;
      else if (k === "customDescription") out.description = v;
      else rest[k] = v;
    }
    if (Object.keys(rest).length) out.metaData = rest;
    return out;
  }
  function buildModel(proc) {
    const model = {
      id: proc.attrs.id || genId("process"),
      name: proc.attrs.name,
      packageName: attr(proc, "drools:packageName") || "org.jbpm",
      processType: proc.attrs.processType || "Public",
      isExecutable: proc.attrs.isExecutable !== "false",
      version: attr(proc, "drools:version") || void 0,
      ...attr(proc, "drools:adHoc") === "true" ? { adHoc: true } : {},
      ...procMeta(proc),
      declarations: { signals, errors, messages, escalations },
      variables: [],
      dataObjects: [],
      dataStores: [],
      lanes: [],
      nodes: [],
      flows: []
    };
    kids(proc, "property").forEach((p) => {
      const tags = (metaValues(p).customTags || "").split(",").map((t) => t.trim()).filter(Boolean);
      model.variables.push({ name: p.attrs.name || p.attrs.id, type: itemTypes[p.attrs.itemSubjectRef] || "String", ...tags.length ? { tags } : {} });
    });
    kids(proc, "dataObject").forEach((o) => {
      model.dataObjects.push({ id: o.attrs.id, name: o.attrs.name, type: itemTypes[o.attrs.itemSubjectRef], isCollection: o.attrs.isCollection === "true" });
    });
    kids(proc, "dataStoreReference").forEach((o) => {
      model.dataStores.push({ id: o.attrs.id, name: o.attrs.name, dataStoreRef: o.attrs.dataStoreRef });
    });
    const ls = kid(proc, "laneSet");
    if (ls) kids(ls, "lane").forEach((l) => {
      model.lanes.push({ id: l.attrs.id, name: l.attrs.name, flowNodeRefs: kids(l, "flowNodeRef").map((r) => cdataText(r) || r.text) });
    });
    const top = parseContainer(proc);
    model.nodes = top.nodes;
    model.flows = top.flows;
    return model;
  }
  return kids(defs, "process").map(buildModel);
}
function parseBpmn(xml) {
  const all = parseBpmnAll(xml);
  if (!all.length) throw new Error("no <process> found in BPMN");
  return all[0];
}

// src/constants.ts
var constants_exports = {};
__export(constants_exports, {
  BUILTIN_ERRORS: () => BUILTIN_ERRORS,
  DEFINITIONS_ATTRS: () => DEFINITIONS_ATTRS,
  ENUMS: () => ENUMS,
  JAVA: () => JAVA,
  REST_INPUTS: () => REST_INPUTS
});
var DEFINITIONS_ATTRS = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns="http://www.omg.org/bpmn20" xmlns:bpmn2="http://www.omg.org/spec/BPMN/20100524/MODEL" xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI" xmlns:dc="http://www.omg.org/spec/DD/20100524/DC" xmlns:di="http://www.omg.org/spec/DD/20100524/DI" xmlns:drools="http://www.jboss.org/drools" xsi:schemaLocation="http://www.omg.org/spec/BPMN/20100524/MODEL BPMN20.xsd http://www.jboss.org/drools drools.xsd http://www.omg.org/spec/DD/20100524/DC DC.xsd http://www.omg.org/spec/DD/20100524/DI DI.xsd " exporter="jBPM Process Modeler" exporterVersion="2.0" targetNamespace="http://www.omg.org/bpmn20"';
var REST_INPUTS = [
  "AcceptCharset",
  "AcceptHeader",
  "AuthType",
  "AuthUrl",
  "ConnectTimeout",
  "ContentData",
  "ContentType",
  "ContentTypeCharset",
  "HandleResponseErrors",
  "Headers",
  "Method",
  "Password",
  "ReadTimeout",
  "ResultClass",
  "Url",
  "Username"
];
var JAVA = "http://www.java.com/java";
var ENUMS = {
  gatewayDirection: ["Unspecified", "Converging", "Diverging", "Mixed"],
  processType: ["None", "Public", "Private"],
  method: ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"],
  scriptFormat: [JAVA, "http://www.mvel.org/2.0"],
  eventType: [
    "none",
    "message",
    "timer",
    "signal",
    "error",
    "escalation",
    "conditional",
    "compensation",
    "cancel",
    "link",
    "terminate",
    "multiple",
    "parallelMultiple"
  ],
  workItem: ["Rest", "WebService", "Email", "Log", "Milestone", "BusinessRuleTask", "DecisionTask"],
  structureRef: [
    "String",
    "Integer",
    "Float",
    "Boolean",
    "Object",
    "java.lang.String",
    "java.lang.Integer",
    "java.lang.Long",
    "java.lang.Float",
    "java.lang.Double",
    "java.lang.Boolean",
    "java.lang.Object",
    "java.util.List",
    "java.util.Map",
    "java.util.Date"
  ],
  fromKind: ["variable", "constant", "expression", "loopItem", "loopOutputItem"]
};
var BUILTIN_ERRORS = {
  WORK_ITEM: "org.jbpm.bpmn2.handler.WorkItemHandlerRuntimeException",
  TERMINATE: "TERMINATE_CASE"
};

// src/serialize.ts
function serializeProcess(proc) {
  let idc = 0;
  const uid = (p = "_id") => `${p}${++idc}`;
  const itemdefs = [];
  const decls = [];
  const props = [];
  const topNodes = [];
  const topFlows = [];
  const shapes = [];
  const edges = [];
  const seenItem = /* @__PURE__ */ new Set();
  const meta = (name) => name == null ? "" : `<bpmn2:extensionElements><drools:metaData name="elementname"><drools:metaValue>${cdata(name)}</drools:metaValue></drools:metaData></bpmn2:extensionElements>`;
  function extraMeta(nd) {
    const md = (name, v) => `<drools:metaData name="${escAttr(name)}"><drools:metaValue>${cdata(v)}</drools:metaValue></drools:metaData>`;
    const out = [];
    if (nd.async) out.push(md("customAsync", "true"));
    if (nd.slaDueDate) out.push(md("customSLADueDate", nd.slaDueDate));
    if (nd.autoStart) out.push(md("customAutoStart", "true"));
    for (const [k, v] of Object.entries(nd.metaData || {})) out.push(md(k, v));
    return out;
  }
  function extBlock(nd) {
    const parts = [];
    if (nd.name != null) parts.push(`<drools:metaData name="elementname"><drools:metaValue>${cdata(nd.name)}</drools:metaValue></drools:metaData>`);
    parts.push(...extraMeta(nd));
    if (nd.onEntry) parts.push(`<drools:onEntry-script scriptFormat="${nd.onEntryFormat || JAVA}"><drools:script>${cdata(nd.onEntry)}</drools:script></drools:onEntry-script>`);
    if (nd.onExit) parts.push(`<drools:onExit-script scriptFormat="${nd.onExitFormat || JAVA}"><drools:script>${cdata(nd.onExit)}</drools:script></drools:onExit-script>`);
    return parts.length ? `<bpmn2:extensionElements>${parts.join("")}</bpmn2:extensionElements>` : "";
  }
  function procExt(p) {
    const md = (name, v) => `<drools:metaData name="${escAttr(name)}"><drools:metaValue>${cdata(v)}</drools:metaValue></drools:metaData>`;
    const parts = [];
    if (p.slaDueDate) parts.push(md("customSLADueDate", p.slaDueDate));
    if (p.description) parts.push(md("customDescription", p.description));
    for (const [k, v] of Object.entries(p.metaData || {})) parts.push(md(k, v));
    return parts.length ? `<bpmn2:extensionElements>${parts.join("")}</bpmn2:extensionElements>` : "";
  }
  function itemDef(id, structureRef) {
    if (seenItem.has(id)) return;
    seenItem.add(id);
    itemdefs.push(`<bpmn2:itemDefinition id="${id}" structureRef="${structureRef}"/>`);
  }
  (proc.variables || []).forEach((v) => {
    var _a;
    const iid = `_${v.name}Item`;
    itemDef(iid, v.type || "String");
    props.push(((_a = v.tags) == null ? void 0 : _a.length) ? `<bpmn2:property id="${v.name}" itemSubjectRef="${iid}" name="${v.name}"><bpmn2:extensionElements><drools:metaData name="customTags"><drools:metaValue>${cdata(v.tags.join(","))}</drools:metaValue></drools:metaData></bpmn2:extensionElements></bpmn2:property>` : `<bpmn2:property id="${v.name}" itemSubjectRef="${iid}" name="${v.name}"/>`);
  });
  const d = proc.declarations || { signals: [], errors: [] };
  const signals = d.signals || [];
  const errors = d.errors || [];
  const messages = d.messages || [];
  const escalations = d.escalations || [];
  errors.forEach((e) => {
    if (!seenItem.has(e.id)) {
      seenItem.add(e.id);
      itemdefs.push(`<bpmn2:error id="${e.id}" errorCode="${e.errorCode || e.id}"/>`);
    }
  });
  signals.forEach((s) => decls.push(`<bpmn2:signal id="${s.id}" name="${escAttr(s.name)}"/>`));
  messages.forEach((m) => decls.push(`<bpmn2:message id="${m.id}"${m.itemRef ? ` itemRef="${m.itemRef}"` : ""}${m.name ? ` name="${escAttr(m.name)}"` : ""}/>`));
  escalations.forEach((e) => decls.push(`<bpmn2:escalation id="${e.id}"${e.escalationCode ? ` escalationCode="${e.escalationCode}"` : ""}${e.name ? ` name="${escAttr(e.name)}"` : ""}/>`));
  (proc.dataStores || []).forEach((ds) => {
    if (ds.dataStoreRef) decls.push(`<bpmn2:dataStore id="${ds.dataStoreRef}" name="${escAttr(ds.name || ds.id)}"/>`);
  });
  const POS = {};
  function place(id, p) {
    const b = { x: 100, y: 100, width: 100, height: 80, ...p || {} };
    POS[id] = b;
    shapes.push(
      `<bpmndi:BPMNShape id="shape_${id}" bpmnElement="${id}"${b.expanded ? ' isExpanded="true"' : ""}><dc:Bounds height="${b.height}.0" width="${b.width}.0" x="${b.x}.0" y="${b.y}.0"/></bpmndi:BPMNShape>`
    );
  }
  function edge(f) {
    const s = POS[f.sourceRef] || { x: 0, y: 0, width: 0, height: 0 };
    const t = POS[f.targetRef] || { x: 0, y: 0, width: 0, height: 0 };
    const wp = f.waypoints || [{ x: s.x + s.width, y: s.y + s.height / 2 }, { x: t.x, y: t.y + t.height / 2 }];
    edges.push(`<bpmndi:BPMNEdge id="edge_${f.id}" bpmnElement="${f.id}">` + wp.map((p) => `<di:waypoint xsi:type="dc:Point" x="${p.x}.0" y="${p.y}.0"/>`).join("") + `</bpmndi:BPMNEdge>`);
  }
  function flowXml(f) {
    const nm = f.name ? ` name="${escAttr(f.name)}"` : "";
    let body = f.name ? meta(f.name) : "";
    if (f.condition) body += `<bpmn2:conditionExpression xsi:type="bpmn2:tFormalExpression" language="${f.conditionLanguage || JAVA}">${cdata(f.condition)}</bpmn2:conditionExpression>`;
    edge(f);
    return `<bpmn2:sequenceFlow id="${f.id}"${nm} sourceRef="${f.sourceRef}" targetRef="${f.targetRef}">${body}</bpmn2:sequenceFlow>`;
  }
  const inout = (nd) => (nd.incoming || []).map((f) => `<bpmn2:incoming>${f}</bpmn2:incoming>`).join("") + (nd.outgoing || []).map((f) => `<bpmn2:outgoing>${f}</bpmn2:outgoing>`).join("");
  const sigId = (name) => (signals.find((x) => x.name === name) || { id: `_sig_${name}` }).id;
  function buildEventDef(nd) {
    switch (nd.eventType) {
      case "signal":
        return `<bpmn2:signalEventDefinition id="${uid()}" signalRef="${sigId(nd.signalName)}"/>`;
      case "error":
        return `<bpmn2:errorEventDefinition id="${uid()}" drools:erefname="${nd.errorRef}" errorRef="${nd.errorRef}"/>`;
      case "message":
        return `<bpmn2:messageEventDefinition id="${uid()}" messageRef="${nd.messageRef}"/>`;
      case "escalation":
        return `<bpmn2:escalationEventDefinition id="${uid()}" escalationRef="${nd.escalationRef}"/>`;
      case "terminate":
        return `<bpmn2:terminateEventDefinition id="${uid()}"/>`;
      case "conditional":
        return `<bpmn2:conditionalEventDefinition id="${uid()}"><bpmn2:condition xsi:type="bpmn2:tFormalExpression" language="${nd.conditionExprLanguage || JAVA}">${cdata(nd.conditionExpr || "")}</bpmn2:condition></bpmn2:conditionalEventDefinition>`;
      case "timer": {
        let t = "";
        if (nd.timeCycle) t = `<bpmn2:timeCycle xsi:type="bpmn2:tFormalExpression"${nd.timeCycleLanguage ? ` language="${escAttr(nd.timeCycleLanguage)}"` : ""} id="${uid()}">${nd.timeCycle}</bpmn2:timeCycle>`;
        else if (nd.timeDate) t = `<bpmn2:timeDate xsi:type="bpmn2:tFormalExpression" id="${uid()}">${nd.timeDate}</bpmn2:timeDate>`;
        else t = `<bpmn2:timeDuration xsi:type="bpmn2:tFormalExpression" id="${uid()}">${nd.timeDuration || "PT1M"}</bpmn2:timeDuration>`;
        return `<bpmn2:timerEventDefinition id="${uid()}">${t}</bpmn2:timerEventDefinition>`;
      }
      default:
        return "";
    }
  }
  function restCall(nd) {
    REST_INPUTS.forEach((p) => itemDef(`__${nd.id}_${p}InputXItem`, ""));
    itemDef(`__${nd.id}_ResultOutputXItem`, "");
    const entry = nd.onEntry || `com.fasterxml.jackson.databind.node.ObjectNode json = new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode();
json.put("piid", String.valueOf(kcontext.getProcessInstance().getId()));
json.putPOJO("caseId", kcontext.getVariable("caseId"));
json.putPOJO("claimId", kcontext.getVariable("claimId"));
` + (nd.reqExtra || "") + `kcontext.setVariable("reqPayload", json.toString());`;
    const exit = nd.onExit || `String response = (String) kcontext.getVariable("resPayload");
if (response != null && !response.isEmpty()) { try {
  com.fasterxml.jackson.databind.JsonNode root = new com.fasterxml.jackson.databind.ObjectMapper().readTree(response);
${(nd.setVars || []).join("")}} catch(Exception e) {} }`;
    const di = REST_INPUTS.map((p) => `<bpmn2:dataInput id="${nd.id}_${p}InputX" drools:dtype="" itemSubjectRef="__${nd.id}_${p}InputXItem" name="${p}"/>`).join("");
    const refs = REST_INPUTS.map((p) => `<bpmn2:dataInputRefs>${nd.id}_${p}InputX</bpmn2:dataInputRefs>`).join("");
    const aval = (p, v) => `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:targetRef>${nd.id}_${p}InputX</bpmn2:targetRef><bpmn2:assignment id="${uid()}"><bpmn2:from xsi:type="bpmn2:tFormalExpression" id="${uid()}">${cdata(v)}</bpmn2:from><bpmn2:to xsi:type="bpmn2:tFormalExpression" id="${uid()}">${nd.id}_${p}InputX</bpmn2:to></bpmn2:assignment></bpmn2:dataInputAssociation>`;
    const ext = `<bpmn2:extensionElements><drools:metaData name="elementname"><drools:metaValue>${cdata(nd.name)}</drools:metaValue></drools:metaData>${extraMeta(nd).join("")}<drools:onEntry-script scriptFormat="${nd.onEntryFormat || JAVA}"><drools:script>${cdata(entry)}</drools:script></drools:onEntry-script><drools:onExit-script scriptFormat="${nd.onExitFormat || JAVA}"><drools:script>${cdata(exit)}</drools:script></drools:onExit-script></bpmn2:extensionElements>`;
    const iospec = `<bpmn2:ioSpecification id="${uid()}">${di}<bpmn2:dataOutput id="${nd.id}_ResultOutputX" drools:dtype="" itemSubjectRef="__${nd.id}_ResultOutputXItem" name="Result"/><bpmn2:inputSet id="${uid()}">${refs}</bpmn2:inputSet><bpmn2:outputSet id="${uid()}"><bpmn2:dataOutputRefs>${nd.id}_ResultOutputX</bpmn2:dataOutputRefs></bpmn2:outputSet></bpmn2:ioSpecification>`;
    const assocs = `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:sourceRef>reqPayload</bpmn2:sourceRef><bpmn2:targetRef>${nd.id}_ContentDataInputX</bpmn2:targetRef></bpmn2:dataInputAssociation>` + aval("ContentType", "application/json") + aval("HandleResponseErrors", "true") + aval("Method", nd.method || "POST") + aval("Url", "#{baseUrl}" + (nd.url || ""));
    const dout = `<bpmn2:dataOutputAssociation id="${uid()}"><bpmn2:sourceRef>${nd.id}_ResultOutputX</bpmn2:sourceRef><bpmn2:targetRef>resPayload</bpmn2:targetRef></bpmn2:dataOutputAssociation>`;
    return `<bpmn2:callActivity id="${nd.id}" drools:independent="true" drools:waitForCompletion="true" name="${escAttr(nd.name)}" calledElement="prudential-claims-submission.pru-rest-executor">${ext}${inout(nd)}${iospec}${assocs}${dout}</bpmn2:callActivity>`;
  }
  function simpleIo(nd) {
    const dins = (nd.dataInputs || []).map((dd, k) => `<bpmn2:dataInput id="${nd.id}_in${k}" name="${dd.name}"/>`);
    const douts = (nd.dataOutputs || []).map((dd, k) => `<bpmn2:dataOutput id="${nd.id}_out${k}" name="${dd.name}"/>`);
    if (!dins.length && !douts.length) return "";
    const inrefs = (nd.dataInputs || []).map((_x, k) => `<bpmn2:dataInputRefs>${nd.id}_in${k}</bpmn2:dataInputRefs>`).join("");
    const outrefs = (nd.dataOutputs || []).map((_x, k) => `<bpmn2:dataOutputRefs>${nd.id}_out${k}</bpmn2:dataOutputRefs>`).join("");
    const ai = (nd.dataInputs || []).map((dd, k) => `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:sourceRef>${dd.value}</bpmn2:sourceRef><bpmn2:targetRef>${nd.id}_in${k}</bpmn2:targetRef></bpmn2:dataInputAssociation>`).join("");
    const ao = (nd.dataOutputs || []).map((dd, k) => `<bpmn2:dataOutputAssociation id="${uid()}"><bpmn2:sourceRef>${nd.id}_out${k}</bpmn2:sourceRef><bpmn2:targetRef>${dd.to}</bpmn2:targetRef></bpmn2:dataOutputAssociation>`).join("");
    return `<bpmn2:ioSpecification id="${uid()}">${dins.join("")}${douts.join("")}<bpmn2:inputSet id="${uid()}">${inrefs}</bpmn2:inputSet><bpmn2:outputSet id="${uid()}">${outrefs}</bpmn2:outputSet></bpmn2:ioSpecification>${ai}${ao}`;
  }
  function miCall(nd) {
    const mi = nd.multiInstance;
    const pass = mi.passthru || [];
    const dins = [`<bpmn2:dataInput id="${nd.id}_incoll" name="IN_COLL"/>`, `<bpmn2:dataInput id="${nd.id}_item" name="${mi.itemVar}"/>`].concat(pass.map((v) => `<bpmn2:dataInput id="${nd.id}_${v}" name="${v}"/>`));
    const douts = [`<bpmn2:dataOutput id="${nd.id}_outcoll" name="OUT_COLL"/>`, `<bpmn2:dataOutput id="${nd.id}_itemout" name="${mi.itemOutVar}"/>`];
    const inrefs = `<bpmn2:dataInputRefs>${nd.id}_incoll</bpmn2:dataInputRefs><bpmn2:dataInputRefs>${nd.id}_item</bpmn2:dataInputRefs>` + pass.map((v) => `<bpmn2:dataInputRefs>${nd.id}_${v}</bpmn2:dataInputRefs>`).join("");
    const outrefs = `<bpmn2:dataOutputRefs>${nd.id}_outcoll</bpmn2:dataOutputRefs><bpmn2:dataOutputRefs>${nd.id}_itemout</bpmn2:dataOutputRefs>`;
    let assoc = `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:sourceRef>${mi.collectionIn}</bpmn2:sourceRef><bpmn2:targetRef>${nd.id}_incoll</bpmn2:targetRef></bpmn2:dataInputAssociation>`;
    pass.forEach((v) => {
      assoc += `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:sourceRef>${v}</bpmn2:sourceRef><bpmn2:targetRef>${nd.id}_${v}</bpmn2:targetRef></bpmn2:dataInputAssociation>`;
    });
    assoc += `<bpmn2:dataOutputAssociation id="${uid()}"><bpmn2:sourceRef>${nd.id}_outcoll</bpmn2:sourceRef><bpmn2:targetRef>${mi.collectionOut}</bpmn2:targetRef></bpmn2:dataOutputAssociation>`;
    const loop = `<bpmn2:multiInstanceLoopCharacteristics${mi.isSequential ? ' isSequential="true"' : ""}><bpmn2:loopDataInputRef>${nd.id}_incoll</bpmn2:loopDataInputRef><bpmn2:loopDataOutputRef>${nd.id}_outcoll</bpmn2:loopDataOutputRef><bpmn2:inputDataItem id="${nd.id}_item" name="${mi.itemVar}"/><bpmn2:outputDataItem id="${nd.id}_itemout" name="${mi.itemOutVar}"/>${mi.completionCondition ? `<bpmn2:completionCondition xsi:type="bpmn2:tFormalExpression" id="${uid()}">${cdata(mi.completionCondition)}</bpmn2:completionCondition>` : ""}</bpmn2:multiInstanceLoopCharacteristics>`;
    return `<bpmn2:callActivity id="${nd.id}" drools:independent="false" drools:waitForCompletion="true" name="${escAttr(nd.name)}" calledElement="${nd.calledElement}">${extBlock(nd)}${inout(nd)}<bpmn2:ioSpecification id="${uid()}">${dins.join("")}${douts.join("")}<bpmn2:inputSet id="${uid()}">${inrefs}</bpmn2:inputSet><bpmn2:outputSet id="${uid()}">${outrefs}</bpmn2:outputSet></bpmn2:ioSpecification>${assoc}${loop}</bpmn2:callActivity>`;
  }
  function genericTask(nd) {
    const params = nd.workParams || {};
    const ports = Object.keys(params);
    ports.forEach((p) => itemDef(`__${nd.id}_${p}InputXItem`, ""));
    const din = (p) => `<bpmn2:dataInput id="${nd.id}_${p}InputX" drools:dtype="" itemSubjectRef="__${nd.id}_${p}InputXItem" name="${p}"/>`;
    const dinAssoc = (p, v) => v.startsWith("$") ? `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:sourceRef>${v.slice(1)}</bpmn2:sourceRef><bpmn2:targetRef>${nd.id}_${p}InputX</bpmn2:targetRef></bpmn2:dataInputAssociation>` : `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:targetRef>${nd.id}_${p}InputX</bpmn2:targetRef><bpmn2:assignment id="${uid()}"><bpmn2:from xsi:type="bpmn2:tFormalExpression" id="${uid()}">${cdata(v)}</bpmn2:from><bpmn2:to xsi:type="bpmn2:tFormalExpression" id="${uid()}">${nd.id}_${p}InputX</bpmn2:to></bpmn2:assignment></bpmn2:dataInputAssociation>`;
    const resultTo = nd.workResultTo || {};
    const outPorts = Object.keys(resultTo).map((varName) => resultTo[varName]);
    outPorts.forEach((p) => itemDef(`__${nd.id}_${p}OutputXItem`, ""));
    const dout = (p) => `<bpmn2:dataOutput id="${nd.id}_${p}OutputX" drools:dtype="" itemSubjectRef="__${nd.id}_${p}OutputXItem" name="${p}"/>`;
    const doutAssoc = (varName, p) => `<bpmn2:dataOutputAssociation id="${uid()}"><bpmn2:sourceRef>${nd.id}_${p}OutputX</bpmn2:sourceRef><bpmn2:targetRef>${varName}</bpmn2:targetRef></bpmn2:dataOutputAssociation>`;
    const dins = ports.map(din).join("");
    const douts = outPorts.map(dout).join("");
    const inrefs = ports.map((p) => `<bpmn2:dataInputRefs>${nd.id}_${p}InputX</bpmn2:dataInputRefs>`).join("");
    const outrefs = outPorts.map((p) => `<bpmn2:dataOutputRefs>${nd.id}_${p}OutputX</bpmn2:dataOutputRefs>`).join("");
    const iospec = ports.length || outPorts.length ? `<bpmn2:ioSpecification id="${uid()}">${dins}${douts}<bpmn2:inputSet id="${uid()}">${inrefs}</bpmn2:inputSet><bpmn2:outputSet id="${uid()}">${outrefs}</bpmn2:outputSet></bpmn2:ioSpecification>` : "";
    const assocs = ports.map((p) => dinAssoc(p, params[p])).join("") + Object.entries(resultTo).map(([varName, p]) => doutAssoc(varName, p)).join("");
    return `<bpmn2:task id="${nd.id}" drools:taskName="${escAttr(nd.handlerName || "")}" name="${escAttr(nd.name || nd.handlerName || "")}">${extBlock(nd)}${inout(nd)}${iospec}${assocs}</bpmn2:task>`;
  }
  function userTask(nd) {
    const extra = Object.keys(nd.taskInputs || {});
    const ports = ["TaskName", "Skippable", ...nd.group ? ["GroupId"] : [], ...extra];
    ports.forEach((p) => itemDef(`__${nd.id}_${p}InputXItem`, ""));
    const din = (p) => `<bpmn2:dataInput id="${nd.id}_${p}InputX" drools:dtype="Object" itemSubjectRef="__${nd.id}_${p}InputXItem" name="${p}"/>`;
    const asg = (p, v) => `<bpmn2:dataInputAssociation id="${uid()}"><bpmn2:targetRef>${nd.id}_${p}InputX</bpmn2:targetRef><bpmn2:assignment id="${uid()}"><bpmn2:from xsi:type="bpmn2:tFormalExpression" id="${uid()}">${cdata(v)}</bpmn2:from><bpmn2:to xsi:type="bpmn2:tFormalExpression" id="${uid()}">${nd.id}_${p}InputX</bpmn2:to></bpmn2:assignment></bpmn2:dataInputAssociation>`;
    const dins = ports.map(din).join("");
    const refs = ports.map((p) => `<bpmn2:dataInputRefs>${nd.id}_${p}InputX</bpmn2:dataInputRefs>`).join("");
    const asgs = asg("TaskName", nd.taskName || nd.name || "Task") + asg("Skippable", String(nd.skippable !== false)) + (nd.group ? asg("GroupId", nd.group) : "") + extra.map((p) => asg(p, nd.taskInputs[p])).join("");
    return `<bpmn2:userTask id="${nd.id}" name="${escAttr(nd.name)}">${extBlock(nd)}${inout(nd)}<bpmn2:ioSpecification id="${uid()}">${dins}<bpmn2:inputSet id="${uid()}">${refs}</bpmn2:inputSet><bpmn2:outputSet id="${uid()}"/></bpmn2:ioSpecification>${asgs}</bpmn2:userTask>`;
  }
  const gatewayEl = {
    exclusiveGateway: "exclusiveGateway",
    parallelGateway: "parallelGateway",
    inclusiveGateway: "inclusiveGateway",
    eventBasedGateway: "eventBasedGateway",
    complexGateway: "complexGateway"
  };
  function gateway(nd) {
    const el2 = gatewayEl[nd.type];
    const extra = (nd.default ? ` default="${nd.default}"` : "") + (nd.type === "eventBasedGateway" && nd.eventGatewayType ? ` eventGatewayType="${nd.eventGatewayType}"` : "") + (nd.type === "eventBasedGateway" && nd.instantiate != null ? ` instantiate="${nd.instantiate}"` : "");
    return `<bpmn2:${el2} id="${nd.id}"${nd.name ? ` name="${escAttr(nd.name)}"` : ""} gatewayDirection="${nd.gatewayDirection || "Diverging"}"${extra}>${extBlock(nd)}${inout(nd)}</bpmn2:${el2}>`;
  }
  function eventNode(el2, nd, extraAttrs = "") {
    return `<bpmn2:${el2} id="${nd.id}" name="${escAttr(nd.name || "")}"${extraAttrs}>${extBlock(nd)}${inout(nd)}${buildEventDef(nd)}</bpmn2:${el2}>`;
  }
  function bizTask(nd) {
    const a = (nd.ruleFlowGroup ? ` drools:ruleFlowGroup="${escAttr(nd.ruleFlowGroup)}"` : "") + ` implementation="${nd.implementation || "##unspecified"}"`;
    return `<bpmn2:businessRuleTask id="${nd.id}"${a} name="${escAttr(nd.name)}">${extBlock(nd)}${inout(nd)}${simpleIo(nd)}</bpmn2:businessRuleTask>`;
  }
  function msgTask(el2, nd) {
    const a = (nd.messageRef ? ` messageRef="${nd.messageRef}"` : "") + (nd.operationRef ? ` operationRef="${nd.operationRef}"` : "") + (nd.implementation ? ` implementation="${nd.implementation}"` : "");
    return `<bpmn2:${el2} id="${nd.id}"${a} name="${escAttr(nd.name)}">${extBlock(nd)}${inout(nd)}${simpleIo(nd)}</bpmn2:${el2}>`;
  }
  function manualTask(nd) {
    return `<bpmn2:manualTask id="${nd.id}" name="${escAttr(nd.name)}">${extBlock(nd)}${inout(nd)}</bpmn2:manualTask>`;
  }
  function subProcess(nd) {
    const tag = nd.subtype === "transaction" ? "transaction" : "subProcess";
    const trig = nd.subtype === "event" ? ' triggeredByEvent="true"' : "";
    let inner = "";
    if (nd.subtype === "event" && nd.error && !(nd.nodes && nd.nodes.length)) {
      inner = `<bpmn2:startEvent id="${nd.id}_start" name="Catch" isInterrupting="true"><bpmn2:outgoing>${nd.id}_f</bpmn2:outgoing><bpmn2:errorEventDefinition id="${uid()}" drools:erefname="${nd.error}" errorRef="${nd.error}"/></bpmn2:startEvent><bpmn2:endEvent id="${nd.id}_end" name="Terminate"><bpmn2:incoming>${nd.id}_f</bpmn2:incoming><bpmn2:terminateEventDefinition id="${uid()}"/></bpmn2:endEvent><bpmn2:sequenceFlow id="${nd.id}_f" sourceRef="${nd.id}_start" targetRef="${nd.id}_end"/>`;
    } else {
      (nd.flows || []).forEach((f) => {
        inner += flowXml(f);
      });
      (nd.nodes || []).forEach((cn) => {
        if (cn.position) place(cn.id, cn.position);
        inner += emitNode(cn);
      });
    }
    return `<bpmn2:${tag} id="${nd.id}" name="${escAttr(nd.name || "")}"${trig}>${extBlock(nd)}${inout(nd)}${inner}</bpmn2:${tag}>`;
  }
  function emitNode(nd) {
    switch (nd.type) {
      case "startEvent":
        return eventNode("startEvent", nd, nd.isInterrupting != null ? ` isInterrupting="${nd.isInterrupting}"` : "");
      case "endEvent": {
        if (!nd.eventType) {
          if (nd.subtype === "terminate") nd.eventType = "terminate";
          else if (nd.subtype === "signalThrow") nd.eventType = "signal";
          else if (nd.subtype === "errorThrow") nd.eventType = "error";
        }
        return eventNode("endEvent", nd);
      }
      case "intermediateCatchEvent":
        return eventNode("intermediateCatchEvent", nd);
      case "intermediateThrowEvent":
        return eventNode("intermediateThrowEvent", nd);
      case "boundaryEvent":
        return `<bpmn2:boundaryEvent id="${nd.id}" drools:boundaryca="true" name="${escAttr(nd.name || "")}" attachedToRef="${nd.attachedTo}"${nd.cancelActivity === false ? ' cancelActivity="false"' : ""}>${meta(nd.name)}${(nd.outgoing || []).map((f) => `<bpmn2:outgoing>${f}</bpmn2:outgoing>`).join("")}${buildEventDef(nd)}</bpmn2:boundaryEvent>`;
      case "scriptTask":
        return `<bpmn2:scriptTask id="${nd.id}" name="${escAttr(nd.name)}" scriptFormat="${nd.scriptFormat || JAVA}">${extBlock(nd)}${inout(nd)}<bpmn2:script>${cdata(nd.script || "")}</bpmn2:script></bpmn2:scriptTask>`;
      case "userTask":
        return userTask(nd);
      case "businessRuleTask":
        return bizTask(nd);
      case "sendTask":
        return msgTask("sendTask", nd);
      case "receiveTask":
        return msgTask("receiveTask", nd);
      case "manualTask":
        return manualTask(nd);
      case "genericTask":
        return genericTask(nd);
      case "exclusiveGateway":
      case "parallelGateway":
      case "inclusiveGateway":
      case "eventBasedGateway":
      case "complexGateway":
        return gateway(nd);
      case "subProcess":
        return subProcess(nd);
      case "callActivity":
        if (nd.subtype === "multiInstance") return miCall(nd);
        if (nd.subtype === "rest" || nd.rest) return restCall(nd);
        return `<bpmn2:callActivity id="${nd.id}"${nd.abortParent ? ' drools:abortParent="true"' : ""} drools:independent="${nd.independent !== false}" drools:waitForCompletion="${nd.waitForCompletion !== false}" name="${escAttr(nd.name)}" calledElement="${nd.calledElement}">${extBlock(nd)}${inout(nd)}${simpleIo(nd)}</bpmn2:callActivity>`;
      case "raw":
        return nd.raw || "";
      default:
        throw new Error(`Unknown node type: ${nd.type} (${nd.id})`);
    }
  }
  const laneSet = proc.lanes && proc.lanes.length ? `<bpmn2:laneSet id="${uid("_ls")}">` + proc.lanes.map((l) => `<bpmn2:lane id="${l.id}"${l.name ? ` name="${escAttr(l.name)}"` : ""}>` + l.flowNodeRefs.map((r) => `<bpmn2:flowNodeRef>${r}</bpmn2:flowNodeRef>`).join("") + `</bpmn2:lane>`).join("") + `</bpmn2:laneSet>` : "";
  const dataObjs = (proc.dataObjects || []).map((o) => {
    if (o.type) itemDef(`_${o.id}Item`, o.type);
    return `<bpmn2:dataObject id="${o.id}"${o.name ? ` name="${escAttr(o.name)}"` : ""}${o.type ? ` itemSubjectRef="_${o.id}Item"` : ""}${o.isCollection ? ' isCollection="true"' : ""}/>`;
  }).join("");
  const dataStoreRefs = (proc.dataStores || []).map((ds) => `<bpmn2:dataStoreReference id="${ds.id}"${ds.name ? ` name="${escAttr(ds.name)}"` : ""}${ds.dataStoreRef ? ` dataStoreRef="${ds.dataStoreRef}"` : ""}/>`).join("");
  (proc.nodes || []).forEach((nd) => {
    if (nd.position) place(nd.id, nd.position);
    topNodes.push(emitNode(nd));
  });
  (proc.flows || []).forEach((f) => topFlows.push(flowXml(f)));
  return `<?xml version="1.0" encoding="UTF-8"?>
<bpmn2:definitions ${DEFINITIONS_ATTRS} id="${uid("_def")}">
${itemdefs.join("\n")}
${decls.join("\n")}
  <bpmn2:process id="${proc.id}" drools:packageName="${proc.packageName || "org.jbpm"}" drools:version="${escAttr(proc.version || "1.0")}"${proc.adHoc ? ' drools:adHoc="true"' : ""} name="${escAttr(proc.name)}" isExecutable="true" processType="${proc.processType || "Public"}">
${procExt(proc)}
${props.join("\n")}
${laneSet}
${dataObjs}
${dataStoreRefs}
${topFlows.join("\n")}
${topNodes.join("\n")}
  </bpmn2:process>
  <bpmndi:BPMNDiagram id="${uid()}"><bpmndi:BPMNPlane id="${uid()}" bpmnElement="${proc.id}">
${shapes.join("\n")}
${edges.join("\n")}
  </bpmndi:BPMNPlane></bpmndi:BPMNDiagram>
</bpmn2:definitions>
`;
}

// src/project.ts
import fs2 from "fs";
import path2 from "path";

// src/scaffold.ts
import fs from "fs";
import path from "path";
var SCAFFOLD_FILES = [
  "pom.xml",
  "src/main/resources/META-INF/kmodule.xml",
  "src/main/resources/META-INF/persistence.xml",
  "global/WorkDefinitions.wid",
  "project.imports",
  "project.repositories"
];
var DD_PATH = "src/main/resources/META-INF/kie-deployment-descriptor.xml";
var SKIP_DIRS = /* @__PURE__ */ new Set(["node_modules", "target", ".git", "dist", "bpmn-sdk", ".mvn"]);
var BINARY_EXTS = /* @__PURE__ */ new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".zip", ".jar", ".gz", ".tar", ".class", ".xls", ".xlsx", ".sxls", ".doc", ".docx", ".ppt", ".pptx", ".pdf", ".so", ".dll"]);
function collectAssets(dir, projectDir, out, bin) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) collectAssets(path.join(dir, e.name), projectDir, out, bin);
      continue;
    }
    const ext = path.extname(e.name).toLowerCase();
    if (ext === ".bpmn" || ext === ".bpmn2") continue;
    const rel = path.relative(projectDir, path.join(dir, e.name));
    if (SCAFFOLD_FILES.includes(rel) || rel === DD_PATH) continue;
    const abs = path.join(dir, e.name);
    if (BINARY_EXTS.has(ext)) bin[rel] = fs.readFileSync(abs).toString("base64");
    else out[rel] = fs.readFileSync(abs, "utf8");
  }
}
var DT_SHORT = (fqn2) => fqn2.split(".").pop() || fqn2;
function parseWid(text) {
  const defs = [];
  const nameRe = /"name"\s*:\s*"([^"]+)"/g;
  const marks = [];
  let m;
  while (m = nameRe.exec(text)) marks.push({ name: m[1], at: m.index });
  for (let i = 0; i < marks.length; i++) {
    const slice = text.slice(marks[i].at, i + 1 < marks.length ? marks[i + 1].at : text.length);
    const g = (re) => {
      const mm = re.exec(slice);
      return mm ? mm[1] : void 0;
    };
    const block = (label) => {
      const b = new RegExp(`"${label}"\\s*:\\s*\\[([\\s\\S]*?)\\]`).exec(slice);
      const map = {};
      if (b) for (const pm of b[1].matchAll(/"([^"]+)"\s*:\s*new\s+([A-Za-z0-9_.]+)\s*\(/g)) map[pm[1]] = DT_SHORT(pm[2]);
      return map;
    };
    defs.push({
      name: marks[i].name,
      displayName: g(/"displayName"\s*:\s*"([^"]*)"/),
      category: g(/"category"\s*:\s*"([^"]*)"/),
      icon: g(/"icon"\s*:\s*"([^"]*)"/),
      defaultHandler: g(/"defaultHandler"\s*:\s*"([^"]*)"/),
      parameters: block("parameters"),
      results: block("results")
    });
  }
  return defs;
}
function widMvel(defs) {
  const kv = (map) => Object.entries(map || {}).map(([k, t]) => `            "${k}" : new ${t.includes(".") ? t : t}()`).join(",\n");
  const entry = (d) => `    [
        "name" : "${d.name}",
        "displayName" : "${d.displayName || d.name}",
        "category" : "${d.category || "Custom"}",
        "icon" : "${d.icon || "defaultservicenodeicon.png"}",
        "defaultHandler" : "${d.defaultHandler || ""}",
        "parameters" : [
${kv(d.parameters)}
        ],
        "results" : [
${kv(d.results)}
        ]
    ]`;
  return `[
${defs.map(entry).join(",\n")}
]
`;
}
function readGav(pomXml2) {
  try {
    const p = parseXml(pomXml2);
    const txt = (n) => {
      const c = kid(p, n);
      return c ? cdataText(c) || c.text : void 0;
    };
    const g = txt("groupId");
    const a = txt("artifactId");
    const v = txt("version");
    if (!a) return void 0;
    return { groupId: g || "org.kie.templates", artifactId: a, version: v || "1.0.0-SNAPSHOT", name: txt("name"), packaging: txt("packaging") || "kjar" };
  } catch {
    return void 0;
  }
}
function readDeployment(xml) {
  try {
    const d = parseXml(xml);
    const t = (n) => {
      const c = kid(d, n);
      return c ? cdataText(c) || c.text : void 0;
    };
    const wih = kid(d, "work-item-handlers");
    const env = kid(d, "environment-entries");
    const readList = (parent, tag) => parent ? kids(parent, tag).map((h) => ({
      name: kid(h, "name") && (cdataText(kid(h, "name")) || kid(h, "name").text) || "",
      resolver: kid(h, "resolver") && (cdataText(kid(h, "resolver")) || kid(h, "resolver").text) || "mvel",
      identifier: kid(h, "identifier") && (cdataText(kid(h, "identifier")) || kid(h, "identifier").text) || ""
    })) : [];
    return {
      persistenceUnit: t("persistence-unit"),
      auditPersistenceUnit: t("audit-persistence-unit"),
      auditMode: t("audit-mode"),
      persistenceMode: t("persistence-mode"),
      runtimeStrategy: t("runtime-strategy"),
      workItemHandlers: readList(wih, "work-item-handler"),
      environmentEntries: readList(env, "environment-entry")
    };
  } catch {
    return void 0;
  }
}
function parseDescriptor(projectDir) {
  const files = {};
  for (const rel of SCAFFOLD_FILES) {
    const abs = path.join(projectDir, rel);
    if (fs.existsSync(abs)) files[rel] = fs.readFileSync(abs, "utf8");
  }
  const binaryFiles = {};
  collectAssets(projectDir, projectDir, files, binaryFiles);
  const gav = files["pom.xml"] ? readGav(files["pom.xml"]) : void 0;
  const ddAbs = path.join(projectDir, DD_PATH);
  const deployment = fs.existsSync(ddAbs) ? readDeployment(fs.readFileSync(ddAbs, "utf8")) : void 0;
  const widText = files["global/WorkDefinitions.wid"];
  const workDefinitions = widText ? parseWid(widText) : void 0;
  return { gav, deployment, workDefinitions, files, ...Object.keys(binaryFiles).length ? { binaryFiles } : {} };
}
function pomXml(gav) {
  const kie = gav.kieVersion || "7.73.0.Final";
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>${gav.groupId}</groupId>
  <artifactId>${gav.artifactId}</artifactId>
  <version>${gav.version}</version>
  <packaging>kjar</packaging>
  <name>${gav.name || gav.artifactId}</name>
  <dependencies>
    <dependency><groupId>org.kie</groupId><artifactId>kie-api</artifactId><version>${kie}</version><scope>provided</scope></dependency>
    <dependency><groupId>org.kie</groupId><artifactId>kie-internal</artifactId><version>${kie}</version><scope>provided</scope></dependency>
  </dependencies>
  <build>
    <plugins>
      <plugin><groupId>org.kie</groupId><artifactId>kie-maven-plugin</artifactId><version>${kie}</version><extensions>true</extensions></plugin>
    </plugins>
  </build>
</project>
`;
}
var KMODULE_XML = '<kmodule xmlns="http://www.drools.org/xsd/kmodule" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>\n';
var PROJECT_IMPORTS = `<configuration>
  <imports>
    <imports>
${[
  "java.lang.Number",
  "java.lang.Boolean",
  "java.lang.String",
  "java.lang.Integer",
  "java.lang.Double",
  "java.util.List",
  "java.util.Collection",
  "java.util.ArrayList"
].map((t) => `      <import>
        <type>${t}</type>
      </import>`).join("\n")}
    </imports>
  </imports>
  <version>1.0</version>
</configuration>
`;
var PROJECT_REPOSITORIES = `<project-repositories>
  <repositories>
    <repository>
      <include>true</include>
      <metadata>
        <id>central</id>
        <url>https://repo.maven.apache.org/maven2</url>
        <source>PROJECT</source>
      </metadata>
    </repository>
    <repository>
      <include>true</include>
      <metadata>
        <id>redhat-ga-repository</id>
        <url>https://maven.repository.redhat.com/ga/</url>
        <source>SETTINGS</source>
      </metadata>
    </repository>
  </repositories>
</project-repositories>
`;
function deploymentXml(dd) {
  const h = (x) => `        <work-item-handler>
            <resolver>${x.resolver}</resolver>
            <identifier>${x.identifier}</identifier>
            <parameters/>
            <name>${x.name}</name>
        </work-item-handler>`;
  const e = (x) => `        <environment-entry>
            <resolver>${x.resolver}</resolver>
            <identifier>${x.identifier}</identifier>
            <parameters/>
            <name>${x.name}</name>
        </environment-entry>`;
  const wih = (dd.workItemHandlers || []).map(h).join("\n");
  const env = (dd.environmentEntries || []).map(e).join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<deployment-descriptor xsi:schemaLocation="http://www.jboss.org/jbpm deployment-descriptor.xsd" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <persistence-unit>${dd.persistenceUnit || "org.jbpm.domain"}</persistence-unit>
    <audit-persistence-unit>${dd.auditPersistenceUnit || "org.jbpm.domain"}</audit-persistence-unit>
    <audit-mode>${dd.auditMode || "JPA"}</audit-mode>
    <persistence-mode>${dd.persistenceMode || "JPA"}</persistence-mode>
    <runtime-strategy>${dd.runtimeStrategy || "SINGLETON"}</runtime-strategy>
    <marshalling-strategies/>
    <event-listeners/>
    <task-event-listeners/>
    <globals/>
    <work-item-handlers>${wih ? "\n" + wih + "\n    " : ""}</work-item-handlers>
    <environment-entries>${env ? "\n" + env + "\n    " : ""}</environment-entries>
    <configurations/>
    <required-roles/>
    <remoteable-classes/>
    <limit-serialization-classes>true</limit-serialization-classes>
</deployment-descriptor>
`;
}
function writeDescriptor(descriptor, projectDir) {
  const written = [];
  const desc = descriptor || {};
  const files = desc.files || {};
  const put = (rel, content) => {
    const abs = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    written.push(rel);
  };
  for (const [rel, content] of Object.entries(files)) if (rel !== DD_PATH) put(rel, content);
  for (const [rel, b64] of Object.entries(desc.binaryFiles || {})) {
    const abs = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(b64, "base64"));
    written.push(rel);
  }
  if (!files["pom.xml"] && desc.gav) put("pom.xml", pomXml(desc.gav));
  if (!files["src/main/resources/META-INF/kmodule.xml"]) put("src/main/resources/META-INF/kmodule.xml", KMODULE_XML);
  if (!files["project.imports"]) put("project.imports", PROJECT_IMPORTS);
  if (!files["project.repositories"]) put("project.repositories", PROJECT_REPOSITORIES);
  if (!files["global/WorkDefinitions.wid"] && desc.workDefinitions && desc.workDefinitions.length) {
    put("global/WorkDefinitions.wid", widMvel(desc.workDefinitions));
  }
  const dd = desc.deployment || {
    workItemHandlers: [{ name: "Rest", resolver: "mvel", identifier: "new org.jbpm.process.workitem.rest.RESTWorkItemHandler(classLoader)" }],
    environmentEntries: [{ name: "INTEGRATION_LAYER_URL", resolver: "mvel", identifier: '"http://localhost:3000"' }]
  };
  put(DD_PATH, deploymentXml(dd));
  return written;
}

// src/project.ts
function walk(dir, ext, out = []) {
  for (const e of fs2.readdirSync(dir, { withFileTypes: true })) {
    const p = path2.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "target" && e.name !== ".git") walk(p, ext, out);
    } else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}
function parseProject(projectDir) {
  const resRoot = fs2.existsSync(path2.join(projectDir, "src/main/resources")) ? path2.join(projectDir, "src/main/resources") : projectDir;
  const files = [...walk(resRoot, ".bpmn2"), ...walk(resRoot, ".bpmn")];
  const processes = files.map((f) => {
    const model = parseBpmn(fs2.readFileSync(f, "utf8"));
    model.sourcePath = path2.relative(projectDir, f);
    return model;
  });
  return { root: projectDir, resourcesRoot: path2.relative(projectDir, resRoot), descriptor: parseDescriptor(projectDir), processes };
}
function writeProject(project, projectDir, opts = {}) {
  const written = [];
  for (const proc of project.processes) {
    const rel = proc.sourcePath || path2.join(project.resourcesRoot || "src/main/resources", "org/jbpm", `${proc.name}.bpmn`);
    const abs = path2.join(projectDir, rel);
    fs2.mkdirSync(path2.dirname(abs), { recursive: true });
    fs2.writeFileSync(abs, serializeProcess(proc));
    written.push(rel);
  }
  if (opts.scaffold !== false && (project.descriptor || opts.scaffold === true)) {
    written.push(...writeDescriptor(project.descriptor, projectDir));
  }
  return written;
}

// src/validate.ts
function validateModel(proc) {
  const errors = [];
  const warnings = [];
  const nodeIds = new Set((proc.nodes || []).map((n) => n.id));
  (proc.flows || []).forEach((f) => {
    if (!nodeIds.has(f.sourceRef)) errors.push(`flow ${f.id}: sourceRef '${f.sourceRef}' is not a node`);
    if (!nodeIds.has(f.targetRef)) errors.push(`flow ${f.id}: targetRef '${f.targetRef}' is not a node`);
  });
  const actIn = {};
  const actOut = {};
  (proc.flows || []).forEach((f) => {
    (actOut[f.sourceRef] = actOut[f.sourceRef] || /* @__PURE__ */ new Set()).add(f.id);
    (actIn[f.targetRef] = actIn[f.targetRef] || /* @__PURE__ */ new Set()).add(f.id);
  });
  (proc.nodes || []).forEach((n) => {
    if (n.type === "boundaryEvent" || n.type === "raw") return;
    const din = new Set(n.incoming || []);
    const dout = new Set(n.outgoing || []);
    const ain = actIn[n.id] || /* @__PURE__ */ new Set();
    const aout = actOut[n.id] || /* @__PURE__ */ new Set();
    if ([...din].sort().join() !== [...ain].sort().join()) warnings.push(`node ${n.id}: <incoming> [${[...din]}] != flows [${[...ain]}]`);
    if ([...dout].sort().join() !== [...aout].sort().join()) warnings.push(`node ${n.id}: <outgoing> [${[...dout]}] != flows [${[...aout]}]`);
  });
  const sig = new Set(((proc.declarations || { signals: [] }).signals || []).map((s) => s.name));
  const err = new Set(((proc.declarations || { errors: [] }).errors || []).map((e) => e.id));
  (proc.nodes || []).forEach((n) => {
    if (n.signalName && !sig.has(n.signalName)) warnings.push(`node ${n.id}: signal '${n.signalName}' not declared`);
    if (n.errorRef && !err.has(n.errorRef) && !n.errorRef.startsWith("org.jbpm")) warnings.push(`node ${n.id}: error '${n.errorRef}' not declared`);
    if (n.error && !err.has(n.error)) warnings.push(`event-subprocess ${n.id}: error '${n.error}' not declared`);
    if (n.type !== "raw" && !n.position) warnings.push(`node ${n.id}: no diagram position (auto-placed)`);
  });
  return { ok: errors.length === 0, errors, warnings };
}

// src/wire.ts
function wireContainer(nodes, flows) {
  for (const n of nodes) {
    if (n.type !== "boundaryEvent") n.incoming = flows.filter((f) => f.targetRef === n.id).map((f) => f.id);
    n.outgoing = flows.filter((f) => f.sourceRef === n.id).map((f) => f.id);
    if (n.nodes && n.flows) wireContainer(n.nodes, n.flows);
  }
}
function autowire(p) {
  wireContainer(p.nodes || [], p.flows || []);
  return p;
}

// src/assets.ts
var EXT_KIND = {
  ".drl": "drl",
  ".dmn": "dmn",
  ".dsl": "dsl",
  ".enumeration": "enumeration",
  ".gdst": "guidedDecisionTable",
  ".gdt": "guidedDecisionTree",
  ".rdrl": "guidedRule",
  ".rdslr": "guidedRule",
  ".template": "guidedRuleTemplate",
  ".scgd": "scoreCard",
  ".scesim": "testScenario",
  ".scenario": "testScenarioLegacy",
  ".frm": "form",
  ".form": "form",
  ".java": "dataObject",
  ".wid": "workItemDefinition",
  ".properties": "properties"
};
var XML_KINDS = /* @__PURE__ */ new Set([
  "dmn",
  "guidedDecisionTable",
  "guidedDecisionTree",
  "guidedRule",
  "guidedRuleTemplate",
  "scoreCard",
  "testScenario",
  "testScenarioLegacy",
  "solver",
  "xml"
]);
function assetKind(pathOrName) {
  if (pathOrName.endsWith(".solver.xml")) return "solver";
  const ext = pathOrName.slice(pathOrName.lastIndexOf(".")).toLowerCase();
  return EXT_KIND[ext] || (ext === ".xml" ? "xml" : "text");
}
function parseProperties(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("!")) continue;
    const i = t.search(/[=:]/);
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}
function writeProperties(props) {
  return Object.entries(props).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
}
function parseEnumeration(text) {
  const out = {};
  const re = /'([^']+)'\s*:\s*\[([^\]]*)\]/g;
  let m;
  while (m = re.exec(text)) {
    out[m[1]] = m[2].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean);
  }
  return out;
}
function writeEnumeration(enums) {
  return Object.entries(enums).map(([k, vs]) => `'${k}' : [ ${vs.map((v) => `'${v}'`).join(", ")} ]`).join("\n") + "\n";
}
function parseDsl(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\[(when|then|\*|keyword)\]([^=]*)=(.*)$/.exec(line.trim());
    if (m) out.push({ scope: m[1], nl: m[2], mapping: m[3] });
  }
  return out;
}
function writeDsl(entries) {
  return entries.map((e) => `[${e.scope}]${e.nl}=${e.mapping}`).join("\n") + "\n";
}
function parseDataObject(text) {
  const pkg = /package\s+([\w.]+)\s*;/.exec(text);
  const cls = /class\s+(\w+)/.exec(text);
  const fields = [];
  const re = /(?:private|protected|public)\s+([\w.<>\[\]]+)\s+(\w+)\s*;/g;
  let m;
  while (m = re.exec(text)) fields.push({ type: m[1], name: m[2] });
  return { package: pkg ? pkg[1] : void 0, className: cls ? cls[1] : "Data", fields };
}
var cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function writeDataObject(m) {
  const fields = m.fields.map((f) => `    private ${f.type} ${f.name};`).join("\n");
  const acc = m.fields.map((f) => `    public ${f.type} get${cap(f.name)}() { return ${f.name}; }
    public void set${cap(f.name)}(${f.type} ${f.name}) { this.${f.name} = ${f.name}; }`).join("\n");
  return `${m.package ? `package ${m.package};

` : ""}public class ${m.className} {
${fields}${fields ? "\n" : ""}${acc}
}
`;
}
var drlLit = (v) => typeof v === "string" ? JSON.stringify(v) : String(v);
var drlVal = (v) => v && typeof v === "object" && "expr" in v ? v.expr : drlLit(v);
function compileConstraint(c) {
  if ("raw" in c) return c.raw;
  if ("bind" in c) return `${c.bind} : ${c.field}`;
  if ("var" in c) return `${c.field} ${c.op} ${c.var}`;
  if (c.op === "in" || c.op === "not in") {
    const arr = Array.isArray(c.value) ? c.value : [c.value];
    return `${c.field} ${c.op} ( ${arr.map(drlLit).join(", ")} )`;
  }
  return `${c.field} ${c.op} ${drlLit(c.value)}`;
}
function compilePattern(p) {
  const cs = (p.constraints || []).map(compileConstraint).join(", ");
  let s = `${p.bind ? p.bind + " : " : ""}${p.fact}( ${cs} )`;
  if (p.from) s += ` from ${p.from}`;
  if (p.entryPoint) s += ` from entry-point ${JSON.stringify(p.entryPoint)}`;
  return s;
}
function compileLhs(el2) {
  if ("raw" in el2) return el2.raw;
  if ("and" in el2) return `( ${el2.and.map(compileLhs).join(" and ")} )`;
  if ("or" in el2) return `( ${el2.or.map(compileLhs).join(" or ")} )`;
  if ("not" in el2) return `not ${compileLhs(el2.not)}`;
  if ("exists" in el2) return `exists ${compileLhs(el2.exists)}`;
  if ("forall" in el2) return `forall ( ${el2.forall.map(compileLhs).join(" ")} )`;
  if ("eval" in el2) return `eval( ${el2.eval} )`;
  if ("collect" in el2) {
    const src = typeof el2.collect.source === "string" ? el2.collect.source : compileLhs(el2.collect.source);
    return `${compilePattern(el2.collect.pattern)} from collect( ${src} )`;
  }
  if ("accumulate" in el2) {
    const src = typeof el2.accumulate.source === "string" ? el2.accumulate.source : compileLhs(el2.accumulate.source);
    const binds = el2.accumulate.bindings.map((b) => `${b.bind ? b.bind + " : " : ""}${b.fn}( ${b.arg} )`).join(", ");
    return `accumulate( ${src}; ${binds} )`;
  }
  return compilePattern(el2);
}
function compileAction(a) {
  if ("modify" in a) return `modify( ${a.modify} ) { ${Object.entries(a.set).map(([f, v]) => `set${cap(f)}( ${drlVal(v)} )`).join(", ")} }`;
  if ("update" in a) return Object.entries(a.set).map(([f, v]) => `${a.update}.set${cap(f)}( ${drlVal(v)} );`).join(" ") + ` update( ${a.update} );`;
  if ("insertLogical" in a) return `insertLogical( ${a.insertLogical} );`;
  if ("insert" in a) return `insert( ${a.insert} );`;
  if ("delete" in a) return `delete( ${a.delete} );`;
  if ("retract" in a) return `retract( ${a.retract} );`;
  if ("call" in a) return `${a.call}(${(a.args || []).map(drlLit).join(", ")});`;
  return a.raw;
}
var whenText = (w) => typeof w === "string" ? w : w.map(compileLhs).join("\n        ");
var thenText = (t) => typeof t === "string" ? t : t.map(compileAction).join("\n        ");
function compileAttrs(r) {
  const out = [];
  const a = r.attrs;
  if (a) {
    if (a.salience != null) out.push(`salience ${a.salience}`);
    if (a.enabled != null) out.push(`enabled ${a.enabled}`);
    if (a.dialect) out.push(`dialect "${a.dialect}"`);
    if (a.ruleflowGroup) out.push(`ruleflow-group "${a.ruleflowGroup}"`);
    if (a.agendaGroup) out.push(`agenda-group "${a.agendaGroup}"`);
    if (a.activationGroup) out.push(`activation-group "${a.activationGroup}"`);
    if (a.autoFocus != null) out.push(`auto-focus ${a.autoFocus}`);
    if (a.lockOnActive != null) out.push(`lock-on-active ${a.lockOnActive}`);
    if (a.noLoop != null) out.push(`no-loop ${a.noLoop}`);
    if (a.dateEffective) out.push(`date-effective "${a.dateEffective}"`);
    if (a.dateExpires) out.push(`date-expires "${a.dateExpires}"`);
    if (a.duration != null) out.push(`duration ${a.duration}`);
    if (a.timer) out.push(`timer (${a.timer})`);
    (a.calendars || []).forEach((c) => out.push(`calendars "${c}"`));
  }
  (r.attributes || []).forEach((x) => out.push(x));
  return out;
}
function compileFunction(f) {
  if (typeof f === "string") return f;
  const params = (f.params || []).map((p) => `${p.type} ${p.name}`).join(", ");
  return `function ${f.returnType || "void"} ${f.name}(${params}) {
    ${f.body}
}`;
}
function compileDeclare(d) {
  if (typeof d === "string") return d;
  const lines = [`declare ${d.name}${d.extends ? ` extends ${d.extends}` : ""}`];
  (d.annotations || []).forEach((a) => lines.push(`    ${a}`));
  d.fields.forEach((f) => lines.push(`    ${f.name} : ${f.type}${(f.annotations || []).map((a) => ` ${a}`).join("")}`));
  lines.push("end");
  return lines.join("\n");
}
function compileQuery(q) {
  if (typeof q === "string") return q;
  const params = (q.params || []).map((p) => `${p.type} ${p.name}`).join(", ");
  const head = params ? `query "${q.name}"(${params})` : `query "${q.name}"`;
  return `${head}
        ${whenText(q.when)}
end`;
}
function extractFunctions(text) {
  const functions = [];
  const re = /\bfunction\s+[\w.$<>\[\],\s]+?\([^)]*\)\s*\{/g;
  const removals = [];
  let m;
  while (m = re.exec(text)) {
    let depth = 0;
    let j = m.index + m[0].length - 1;
    for (; j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}") {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
    }
    functions.push(text.slice(m.index, j).trim());
    removals.push([m.index, j]);
    re.lastIndex = j;
  }
  let rest = "";
  let idx = 0;
  for (const [s, e] of removals) {
    rest += text.slice(idx, s);
    idx = e;
  }
  rest += text.slice(idx);
  return { functions, rest };
}
function parseDrl(text) {
  const pkg = /^\s*package\s+([\w.]+)\s*;?/m.exec(text);
  const unit = /^\s*unit\s+([\w.]+)\s*;?/m.exec(text);
  const staticImports = [...text.matchAll(/^\s*import\s+static\s+([\w.*]+)\s*;?/mg)].map((m) => m[1]);
  const functionImports = [...text.matchAll(/^\s*import\s+function\s+([\w.*]+)\s*;?/mg)].map((m) => m[1]);
  const imports = [...text.matchAll(/^\s*import\s+(?!static\b)(?!function\b)([\w.*]+)\s*;?/mg)].map((m) => m[1]);
  const globals = [...text.matchAll(/^\s*global\s+(.+?)\s*;?\s*$/mg)].map((m) => m[1]);
  const rules = [];
  let work = text;
  work = work.replace(
    /rule\s+"([^"]+)"([\s\S]*?)\bwhen\b([\s\S]*?)\bthen\b([\s\S]*?)\bend\b/g,
    (_full, name, attrsRaw, when, then) => {
      const ext = /\bextends\s+"([^"]+)"/.exec(attrsRaw);
      const attributes = attrsRaw.replace(/\bextends\s+"[^"]+"/, "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      rules.push({ name, ...ext ? { extends: ext[1] } : {}, attributes, when: when.trim(), then: then.trim() });
      return "";
    }
  );
  const fx = extractFunctions(work);
  work = fx.rest;
  const declares = [];
  work = work.replace(/\bdeclare\b[\s\S]*?\bend\b/g, (mm) => {
    declares.push(mm.trim());
    return "";
  });
  const queries = [];
  work = work.replace(/\bquery\b[\s\S]*?\bend\b/g, (mm) => {
    queries.push(mm.trim());
    return "";
  });
  const model = { imports, globals, rules };
  if (pkg) model.package = pkg[1];
  if (unit) model.unit = unit[1];
  if (staticImports.length) model.staticImports = staticImports;
  if (functionImports.length) model.functionImports = functionImports;
  if (fx.functions.length) model.functions = fx.functions;
  if (declares.length) model.declares = declares;
  if (queries.length) model.queries = queries;
  return model;
}
function writeDrl(m) {
  const parts = [];
  if (m.package) parts.push(`package ${m.package};`);
  if (m.unit) parts.push(`unit ${m.unit};`);
  (m.imports || []).forEach((i) => parts.push(`import ${i};`));
  (m.staticImports || []).forEach((i) => parts.push(`import static ${i};`));
  (m.functionImports || []).forEach((i) => parts.push(`import function ${i};`));
  (m.globals || []).forEach((g) => parts.push(`global ${g};`));
  if (parts.length) parts.push("");
  (m.functions || []).forEach((f) => {
    parts.push(compileFunction(f));
    parts.push("");
  });
  (m.declares || []).forEach((d) => {
    parts.push(compileDeclare(d));
    parts.push("");
  });
  (m.queries || []).forEach((q) => {
    parts.push(compileQuery(q));
    parts.push("");
  });
  for (const r of m.rules) {
    parts.push(`rule "${r.name}"${r.extends ? ` extends "${r.extends}"` : ""}`);
    (r.meta || []).forEach((mm) => parts.push(`    ${mm}`));
    compileAttrs(r).forEach((a) => parts.push(`    ${a}`));
    parts.push("    when");
    parts.push(`        ${whenText(r.when)}`);
    parts.push("    then");
    parts.push(`        ${thenText(r.then)}`);
    parts.push("end");
    parts.push("");
  }
  return parts.join("\n").replace(/\n+$/, "\n");
}
function parseForm(text) {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return { json: JSON.parse(text) };
  return { xml: parseXml(text) };
}
function writeForm(model) {
  if (model.json !== void 0) return JSON.stringify(model.json, null, 2) + "\n";
  return stringifyNode(model.xml);
}
function parseAsset(path3, content) {
  const kind = assetKind(path3);
  if (kind === "guidedRule" && !content.trimStart().startsWith("<")) return { kind: "drl", path: path3, model: parseDrl(content) };
  if (XML_KINDS.has(kind)) return { kind, path: path3, model: { xml: parseXml(content) } };
  switch (kind) {
    case "properties":
      return { kind, path: path3, model: { props: parseProperties(content) } };
    case "enumeration":
      return { kind, path: path3, model: { enums: parseEnumeration(content) } };
    case "dsl":
      return { kind, path: path3, model: { entries: parseDsl(content) } };
    case "workItemDefinition":
      return { kind, path: path3, model: { definitions: parseWid(content) } };
    case "dataObject":
      return { kind, path: path3, model: parseDataObject(content) };
    case "drl":
      return { kind, path: path3, model: parseDrl(content) };
    case "form":
      return { kind, path: path3, model: parseForm(content) };
    default:
      return { kind, path: path3, model: { text: content } };
  }
}
function buildAsset(asset) {
  const { kind, model } = asset;
  if (XML_KINDS.has(kind)) return '<?xml version="1.0" encoding="UTF-8"?>\n' + stringifyNode(model.xml);
  switch (kind) {
    case "properties":
      return writeProperties(model.props);
    case "enumeration":
      return writeEnumeration(model.enums);
    case "dsl":
      return writeDsl(model.entries);
    case "workItemDefinition":
      return widMvel(model.definitions);
    case "dataObject":
      return writeDataObject(model);
    case "drl":
      return writeDrl(model);
    case "form":
      return writeForm(model);
    default:
      return model && model.text || "";
  }
}

// src/engine.ts
var PRIM = {
  string: "String",
  int: "Integer",
  integer: "Integer",
  long: "java.lang.Long",
  double: "java.lang.Double",
  float: "java.lang.Double",
  number: "java.lang.Double",
  bool: "java.lang.Boolean",
  boolean: "java.lang.Boolean",
  object: "java.lang.Object",
  list: "java.util.List",
  array: "java.util.List",
  map: "java.util.Map",
  date: "java.util.Date"
};
var LANG_URI = {
  js: "http://www.javascript.com/javascript",
  java: "http://www.java.com/java",
  mvel: "http://www.mvel.org/2.0"
};
var HANDLER_ID = {
  Rest: "new org.jbpm.process.workitem.rest.RESTWorkItemHandler(classLoader)",
  WebService: "new org.jbpm.process.workitem.webservice.WebServiceWorkItemHandler(ksession)",
  Email: "new org.jbpm.process.workitem.email.EmailWorkItemHandler()",
  Log: "new org.jbpm.process.instance.impl.demo.SystemOutWorkItemHandler()"
};
var DEFAULT_WORK_ITEMS = [
  {
    name: "Rest",
    displayName: "REST",
    category: "Communication",
    icon: "defaultresticon.png",
    defaultHandler: "mvel: new org.jbpm.process.workitem.rest.RESTWorkItemHandler(classLoader)",
    parameters: { Url: "String", Method: "String", ContentType: "String", ContentData: "String", ConnectTimeout: "String", ReadTimeout: "String", Username: "String", Password: "String" },
    results: { Result: "Object", Status: "Integer" }
  },
  {
    name: "Email",
    displayName: "Email",
    category: "Communication",
    icon: "defaultemailicon.png",
    defaultHandler: "mvel: new org.jbpm.process.workitem.email.EmailWorkItemHandler()",
    parameters: { From: "String", To: "String", Subject: "String", Body: "String", Cc: "String", Bcc: "String" },
    results: {}
  },
  {
    name: "WebService",
    displayName: "WS",
    category: "Communication",
    icon: "defaultservicenodeicon.png",
    defaultHandler: "mvel: new org.jbpm.process.workitem.webservice.WebServiceWorkItemHandler(ksession)",
    parameters: { Endpoint: "String", Namespace: "String", Interface: "String", Operation: "String", Parameter: "Object", Mode: "String" },
    results: { Result: "Object" }
  },
  {
    name: "Log",
    displayName: "Log",
    category: "Log",
    icon: "defaultlogicon.png",
    defaultHandler: "mvel: new org.jbpm.process.instance.impl.demo.SystemOutWorkItemHandler()",
    parameters: { Message: "String" },
    results: {}
  }
];
var fqn = (t) => (t.package ? t.package + "." : "") + t.name;
function makeTypeResolver(types = []) {
  const idx = {};
  for (const t of types) idx[t.name] = t;
  return (type) => {
    if (!type) return "java.lang.Object";
    const p = PRIM[type.toLowerCase()];
    if (p) return p;
    if (idx[type]) return fqn(idx[type]);
    return type;
  };
}
function javaFieldType(type, resolve) {
  const t = type.toLowerCase();
  const map = { string: "String", int: "int", integer: "int", long: "long", double: "double", float: "double", number: "double", bool: "boolean", boolean: "boolean", date: "java.util.Date", list: "java.util.List", array: "java.util.List", map: "java.util.Map", object: "Object" };
  return map[t] || resolve(type);
}
function boxedType(type, resolve) {
  const box = { string: "String", int: "Integer", integer: "Integer", long: "Long", double: "Double", float: "Double", number: "Double", bool: "Boolean", boolean: "Boolean", date: "java.util.Date", object: "Object" };
  return box[type.toLowerCase()] || resolve(type);
}
function fieldJavaType(f, resolve) {
  return f.list ? `java.util.List<${boxedType(f.type, resolve)}>` : javaFieldType(f.type, resolve);
}
var langUri = (l) => LANG_URI[l || "java"] || LANG_URI.java;
var jstr = (v) => JSON.stringify(String(v));
var isWordUsed = (code, name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(code);
function jsVarsPreamble(code, varNames) {
  if (!/\bvars\s*[.[]/.test(code) || varNames.length === 0) return "";
  let out = "var vars = {};\n";
  for (const name of varNames) {
    const lit = jstr(name);
    out += `Object.defineProperty(vars, ${lit}, { enumerable: true, get: function(){ return kcontext.getVariable(${lit}); }, set: function(v){ kcontext.setVariable(${lit}, v); } });
`;
  }
  return out;
}
function javaBareNamePreamble(code, varType) {
  let out = "";
  for (const [name, type] of Object.entries(varType)) {
    if (!isWordUsed(code, name)) continue;
    out += `${type} ${name} = (${type}) kcontext.getVariable(${jstr(name)});
`;
  }
  return out;
}
function jsInstanceNodePreamble(code) {
  let out = "";
  if (isWordUsed(code, "instance")) {
    out += 'var instance = {\n  id: kcontext.getProcessInstance().getId(),\n  processId: kcontext.getProcessInstance().getProcessId(),\n  processName: kcontext.getProcessInstance().getProcessName(),\n  correlationKey: kcontext.getProcessInstance().getCorrelationKey(),\n  parentId: kcontext.getProcessInstance().getParentProcessInstanceId(),\n  state: (function(s){ return s===0?"pending":s===2?"completed":s===3?"aborted":s===4?"suspended":"running"; })(kcontext.getProcessInstance().getState()),\n  variables: kcontext.getProcessInstance().getVariables(),\n  activeNodes: (function(){ var list = kcontext.getProcessInstance().getNodeInstances(); var out = []; for (var i = 0; i < list.size(); i++) { var ni = list.get(i); out.push({ id: ni.getId(), nodeId: ni.getNodeId(), name: ni.getNodeName() }); } return out; })(),\n  signal: function(type, payload){ kcontext.getKieRuntime().signalEvent(type, payload, kcontext.getProcessInstance().getId()); },\n  signalOther: function(targetId, type, payload){ kcontext.getKieRuntime().signalEvent(type, payload, targetId); },\n  broadcast: function(type, payload){ kcontext.getKieRuntime().signalEvent(type, payload); },\n  abort: function(){ kcontext.getKieRuntime().abortProcessInstance(kcontext.getProcessInstance().getId()); },\n  abortOther: function(targetId){ kcontext.getKieRuntime().abortProcessInstance(targetId); }\n};\n';
  }
  if (isWordUsed(code, "node")) {
    out += "var node = { id: kcontext.getNodeInstance().getId(), nodeId: kcontext.getNodeInstance().getNodeId(), name: kcontext.getNodeInstance().getNodeName() };\n";
  }
  return out;
}
var JAVA_META_LOCALS = [
  ["instanceId", "String.valueOf(kcontext.getProcessInstance().getId())"],
  ["processId", "kcontext.getProcessInstance().getProcessId()"],
  ["processName", "kcontext.getProcessInstance().getProcessName()"],
  ["correlationKey", "kcontext.getProcessInstance().getCorrelationKey()"],
  ["parentInstanceId", "kcontext.getProcessInstance().getParentProcessInstanceId()"],
  ["currentNodeId", "kcontext.getNodeInstance().getNodeId()"],
  ["currentNodeName", "kcontext.getNodeInstance().getNodeName()"]
];
function javaMetaLocalsPreamble(code, varType) {
  let out = "";
  for (const [name, expr] of JAVA_META_LOCALS) {
    if (varType[name]) continue;
    if (!isWordUsed(code, name)) continue;
    out += `String ${name} = ${expr};
`;
  }
  return out;
}
function withJavaConditionPreamble(when, preamble) {
  if (!preamble) return when;
  const body = /\breturn\b/.test(when) ? when : `return (${when});`;
  return preamble + body;
}
function setEvent(nd, ev) {
  if (!ev) {
    nd.eventType = "none";
    return;
  }
  if (ev.signal) {
    nd.eventType = "signal";
    nd.signalName = ev.signal;
  } else if (ev.message) {
    nd.eventType = "message";
    nd.messageRef = ev.message;
  } else if (ev.error) {
    nd.eventType = "error";
    nd.errorRef = ev.error;
  } else if (ev.escalation) {
    nd.eventType = "escalation";
    nd.escalationRef = ev.escalation;
  } else if (ev.condition) {
    nd.eventType = "conditional";
    nd.conditionExpr = ev.condition;
    nd.conditionExprLanguage = langUri(ev.lang);
  } else if (ev.timer) {
    nd.eventType = "timer";
    if (ev.timer.cron) {
      nd.timeCycle = ev.timer.cron;
      nd.timeCycleLanguage = "cron";
    } else if (ev.timer.cycle) nd.timeCycle = ev.timer.cycle;
    else if (ev.timer.date) nd.timeDate = ev.timer.date;
    else nd.timeDuration = ev.timer.duration || ev.timer;
  } else nd.eventType = "none";
}
function pathExpr(jp) {
  const parts = jp.replace(/^\$\.?/, "").split(".").filter(Boolean);
  return "root" + parts.map((p) => `.path("${p}")`).join("");
}
function accessor(structureRef) {
  switch (structureRef) {
    case "String":
      return (e) => `${e}.asText()`;
    case "java.lang.Boolean":
      return (e) => `${e}.asBoolean()`;
    case "Integer":
      return (e) => `${e}.asInt()`;
    case "java.lang.Long":
      return (e) => `${e}.asLong()`;
    case "java.lang.Double":
      return (e) => `${e}.asDouble()`;
    default:
      return (e) => e;
  }
}
function fromEngine(ep, sharedTypes = []) {
  const resolve = makeTypeResolver([...sharedTypes || [], ...ep.types || []]);
  const varType = {};
  const variables = (ep.vars || []).map((v) => {
    var _a;
    const sr = resolve(v.type);
    varType[v.name] = sr;
    return { name: v.name, type: sr, ...((_a = v.tags) == null ? void 0 : _a.length) ? { tags: v.tags } : {} };
  });
  const ensure = (name, sr) => {
    if (!variables.some((x) => x.name === name)) {
      variables.push({ name, type: sr });
      varType[name] = sr;
    }
  };
  const sig = new Set(ep.signals || []);
  const errCode = {};
  for (const e of ep.errors || []) if (typeof e === "object") errCode[e.name] = e.code;
  const err = new Set((ep.errors || []).map((e) => typeof e === "string" ? e : e.name));
  const msg = new Set(ep.messages || []);
  const esc = new Set(ep.escalations || []);
  const lifecycle = (n) => {
    const out = {};
    if (n.onEntry) {
      out.onEntry = (n.onEntryLang === "js" ? jsVarsPreamble(n.onEntry, Object.keys(varType)) + jsInstanceNodePreamble(n.onEntry) : javaBareNamePreamble(n.onEntry, varType) + javaMetaLocalsPreamble(n.onEntry, varType)) + n.onEntry;
      out.onEntryFormat = langUri(n.onEntryLang);
    }
    if (n.onExit) {
      out.onExit = (n.onExitLang === "js" ? jsVarsPreamble(n.onExit, Object.keys(varType)) + jsInstanceNodePreamble(n.onExit) : javaBareNamePreamble(n.onExit, varType) + javaMetaLocalsPreamble(n.onExit, varType)) + n.onExit;
      out.onExitFormat = langUri(n.onExitLang);
    }
    if (n.async) out.async = true;
    const ex = extrasOf(n);
    if (Object.keys(ex).length) out.metaData = { ...out.metaData || {}, ...ex };
    if (n.autoStart) out.autoStart = true;
    if (n.slaDueDate) out.slaDueDate = n.slaDueDate;
    if (n.asyncRetries !== void 0) (out.metaData ||= {}).asyncRetries = String(n.asyncRetries);
    if (n.asyncRetryDelay) (out.metaData ||= {}).asyncRetryDelay = n.asyncRetryDelay;
    return out;
  };
  const conv = (n) => {
    var _a, _b, _c, _d;
    const base = { id: n.id, type: "raw", name: n.name };
    switch (n.type) {
      case "start": {
        const nd = { ...base, type: "startEvent" };
        setEvent(nd, n.on);
        nd.subtype = nd.eventType;
        if (nd.signalName) sig.add(nd.signalName);
        if (nd.messageRef) msg.add(nd.messageRef);
        return nd;
      }
      case "end": {
        const nd = { ...base, type: "endEvent" };
        if (n.result === "terminate") {
          nd.subtype = "terminate";
          nd.eventType = "terminate";
        } else if (n.result === "cancel") nd.metaData = extrasOf(n);
        else if (n.throw) {
          setEvent(nd, n.throw);
          nd.subtype = nd.eventType === "signal" ? "signalThrow" : nd.eventType === "error" ? "errorThrow" : nd.eventType;
          if (nd.signalName) sig.add(nd.signalName);
          if (nd.errorRef) err.add(nd.errorRef);
          if (nd.escalationRef) esc.add(nd.escalationRef);
        } else {
          nd.subtype = "none";
          nd.eventType = "none";
        }
        return nd;
      }
      case "script": {
        const code = n.code || "";
        const preamble = n.lang === "js" ? jsVarsPreamble(code, Object.keys(varType)) + jsInstanceNodePreamble(code) : n.lang === "java" ? javaBareNamePreamble(code, varType) + javaMetaLocalsPreamble(code, varType) : "";
        const { onEntry: _a2, onExit: _b2, onEntryFormat: _c2, onExitFormat: _d2, ...meta } = lifecycle(n);
        return { ...base, type: "scriptTask", script: preamble + code, scriptFormat: langUri(n.lang), ...meta };
      }
      case "http": {
        ensure("reqPayload", "String");
        ensure("resPayload", "String");
        ensure("baseUrl", "String");
        if (n.lang === "js") {
          const entryJs = "var json = {};\njson.piid = String(kcontext.getProcessInstance().getId());\n" + Object.entries(n.body || {}).map(([k, v]) => typeof v === "string" && v.startsWith("$") ? `json[${jstr(k)}] = kcontext.getVariable(${jstr(v.slice(1))});
` : `json[${jstr(k)}] = ${typeof v === "number" || typeof v === "boolean" ? v : jstr(v)};
`).join("") + 'kcontext.setVariable("reqPayload", JSON.stringify(json));';
          const setsJs = Object.entries(n.resultTo || {}).map(([vn, jp]) => {
            const path3 = String(jp).replace(/^\$\.?/, "");
            const acc = path3 === "" || path3 === "$" ? "root" : "root" + path3.split(".").map((p) => `[${jstr(p)}]`).join("");
            return `    if (root != null) kcontext.setVariable(${jstr(vn)}, ${acc});
`;
          }).join("");
          const exitJs = 'var response = kcontext.getVariable("resPayload");\nif (response != null && String(response) !== "") { try {\n  var root = JSON.parse(String(response));\n' + setsJs + "} catch(e) {} }" + (n.exitScript ? "\n" + jsVarsPreamble(n.exitScript, Object.keys(varType)) + jsInstanceNodePreamble(n.exitScript) + n.exitScript : "");
          return {
            ...base,
            type: "callActivity",
            subtype: "rest",
            url: n.url,
            method: n.method || "POST",
            onEntry: entryJs,
            onExit: exitJs,
            onEntryFormat: LANG_URI.js,
            onExitFormat: LANG_URI.js
          };
        }
        const entry = 'com.fasterxml.jackson.databind.node.ObjectNode json = new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode();\njson.put("piid", String.valueOf(kcontext.getProcessInstance().getId()));\n' + Object.entries(n.body || {}).map(([k, v]) => typeof v === "string" && v.startsWith("$") ? `json.putPOJO("${k}", kcontext.getVariable("${v.slice(1)}"));
` : `json.put("${k}", ${typeof v === "number" || typeof v === "boolean" ? v : jstr(v)});
`).join("") + 'kcontext.setVariable("reqPayload", json.toString());';
        const sets = Object.entries(n.resultTo || {}).map(([vn, jp]) => `    kcontext.setVariable("${vn}", ${accessor(varType[vn] || "java.lang.Object")(pathExpr(jp))});
`).join("");
        const exit = 'String response = (String) kcontext.getVariable("resPayload");\nif (response != null && !response.isEmpty()) { try {\n  com.fasterxml.jackson.databind.JsonNode root = new com.fasterxml.jackson.databind.ObjectMapper().readTree(response);\n' + sets + "} catch(Exception e) {} }" + (n.exitScript ? "\n" + javaBareNamePreamble(n.exitScript, varType) + javaMetaLocalsPreamble(n.exitScript, varType) + n.exitScript : "");
        return { ...base, type: "callActivity", subtype: "rest", url: n.url, method: n.method || "POST", onEntry: entry, onExit: exit };
      }
      case "call":
        return {
          ...base,
          type: "callActivity",
          subtype: "reusable",
          calledElement: n.process,
          ...n.onChildFailure === "abort" ? { abortParent: true } : {},
          dataInputs: Object.entries(n.inputs || {}).map(([k, v]) => ({ name: k, value: String(v).replace(/^\$/, "") })),
          dataOutputs: Object.entries(n.outputs || {}).map(([k, v]) => ({ name: k, to: String(v) })),
          ...lifecycle(n)
        };
      case "forEach":
        return {
          ...base,
          type: "callActivity",
          subtype: "multiInstance",
          calledElement: n.process,
          multiInstance: { isSequential: n.parallel === false, collectionIn: n.over, collectionOut: n.collectInto || `${n.over}Results`, itemVar: n.as || "item", itemOutVar: n.itemResult || "itemResult", passthru: n.pass || [], ...n.completionCondition ? { completionCondition: n.completionCondition } : {} },
          ...lifecycle(n)
        };
      case "userTask": {
        const u = n;
        const list = (v) => Array.isArray(v) ? v.join(",") : String(v ?? "");
        const ti = {};
        if ((_a = u.actors) == null ? void 0 : _a.length) ti.ActorId = list(u.actors);
        if (u.businessAdmin) ti.BusinessAdministratorId = String(u.businessAdmin);
        if ((_b = u.businessAdminGroups) == null ? void 0 : _b.length) ti.BusinessAdministratorGroupId = list(u.businessAdminGroups);
        if ((_c = u.stakeholders) == null ? void 0 : _c.length) ti.TaskStakeholderId = list(u.stakeholders);
        if ((_d = u.excludedOwners) == null ? void 0 : _d.length) ti.ExcludedOwnerId = list(u.excludedOwners);
        for (const [k, name] of [
          ["comment", "Comment"],
          ["content", "Content"],
          ["locale", "Locale"],
          ["createdBy", "CreatedBy"],
          ["suspendUntil", "suspendUntil"],
          ["description", "Description"],
          ["notStartedReassign", "NotStartedReassign"],
          ["notCompletedReassign", "NotCompletedReassign"],
          ["notStartedNotify", "NotStartedNotify"],
          ["notCompletedNotify", "NotCompletedNotify"]
        ]) if (u[k]) ti[name] = String(u[k]);
        if (u.priority !== void 0) ti.Priority = String(u.priority);
        const groups = [u.group || u.assignee, ...Array.isArray(u.groups) ? u.groups : []].filter(Boolean).join(",");
        return { ...base, type: "userTask", taskName: n.form || n.name, group: groups || void 0, skippable: n.skippable !== false, ...Object.keys(ti).length ? { taskInputs: ti } : {}, ...lifecycle(n) };
      }
      case "rule":
        return { ...base, type: "businessRuleTask", ruleFlowGroup: n.ruleflowGroup, implementation: n.dmn ? "http://www.jboss.org/drools/dmn" : "##unspecified", ...lifecycle(n) };
      case "send": {
        if (n.message) msg.add(n.message);
        return { ...base, type: "sendTask", messageRef: n.message, implementation: n.implementation || "##WebService", ...lifecycle(n) };
      }
      case "receive": {
        if (n.message) msg.add(n.message);
        return { ...base, type: "receiveTask", messageRef: n.message, implementation: n.implementation || "Other", ...lifecycle(n) };
      }
      case "manual":
        return { ...base, type: "manualTask", ...lifecycle(n) };
      case "workItem": {
        const workParams = {};
        for (const [k, v] of Object.entries(n.params || {})) workParams[k] = typeof v === "string" && v.startsWith("$") ? v : String(v);
        return { ...base, type: "genericTask", handlerName: n.handler, workParams, workResultTo: n.resultTo || {}, ...lifecycle(n) };
      }
      case "gateway": {
        const map = { exclusive: "exclusiveGateway", parallel: "parallelGateway", inclusive: "inclusiveGateway", event: "eventBasedGateway", complex: "complexGateway" };
        return { ...base, type: map[n.mode] || "exclusiveGateway", gatewayDirection: n.direction || "Diverging", default: n.default, ...n.instantiate ? { instantiate: true } : {}, ...Object.keys(extrasOf(n)).length ? { metaData: extrasOf(n) } : {} };
      }
      case "catch": {
        const nd = { ...base, type: "intermediateCatchEvent" };
        setEvent(nd, n.event);
        if (nd.signalName) sig.add(nd.signalName);
        if (nd.messageRef) msg.add(nd.messageRef);
        return nd;
      }
      case "throw": {
        const nd = { ...base, type: "intermediateThrowEvent" };
        setEvent(nd, n.event);
        if (nd.signalName) sig.add(nd.signalName);
        if (nd.messageRef) msg.add(nd.messageRef);
        if (nd.escalationRef) esc.add(nd.escalationRef);
        return nd;
      }
      case "boundary": {
        const host = Array.isArray(n.on) ? n.on.find((h) => h !== "*") ?? n.on[0] : n.on;
        const nd = { ...base, type: "boundaryEvent", attachedTo: host, cancelActivity: n.interrupting !== false };
        setEvent(nd, n.event);
        if (nd.errorRef) err.add(nd.errorRef);
        if (nd.signalName) sig.add(nd.signalName);
        if (nd.messageRef) msg.add(nd.messageRef);
        if (nd.escalationRef) esc.add(nd.escalationRef);
        return nd;
      }
      case "subprocess": {
        const nd = { ...base, type: "subProcess", subtype: n.transaction ? "transaction" : n.on ? "event" : "embedded", ...lifecycle(n) };
        if (n.on && n.on.error) {
          nd.error = n.on.error;
          err.add(n.on.error);
        }
        nd.nodes = (n.nodes || []).map(conv);
        nd.flows = (n.flows || []).map(convFlow);
        return nd;
      }
      default:
        return { ...base, type: "raw", bpmnLocal: n.type, raw: n.raw || `<!-- ${n.type} -->` };
    }
  };
  const convFlow = (f) => {
    if (!f.when) return { id: f.id || `${f.from}__${f.to}`, sourceRef: f.from, targetRef: f.to };
    const condition = f.lang === "js" ? jsVarsPreamble(f.when, Object.keys(varType)) + jsInstanceNodePreamble(f.when) + f.when : f.lang === "java" ? withJavaConditionPreamble(f.when, javaMetaLocalsPreamble(f.when, varType)) : f.when;
    return { id: f.id || `${f.from}__${f.to}`, sourceRef: f.from, targetRef: f.to, condition, conditionLanguage: langUri(f.lang) };
  };
  const nodes = ep.nodes.map(conv);
  const flows = ep.flows.map(convFlow);
  const ACTIVITY = /* @__PURE__ */ new Set(["scriptTask", "userTask", "businessRuleTask", "sendTask", "receiveTask", "manualTask", "callActivity", "subProcess", "genericTask"]);
  const activityIds = () => nodes.filter((x) => ACTIVITY.has(x.type)).map((x) => x.id);
  for (const en of ep.nodes) {
    if (en.type !== "boundary") continue;
    const on = en.on;
    const list = Array.isArray(on) ? on : [on];
    const isGlobal = list.includes("*");
    const outFlows = flows.filter((f) => f.sourceRef === en.id);
    const recovery = new Set(outFlows.map((f) => f.targetRef));
    const hosts = isGlobal ? activityIds().filter((id) => !recovery.has(id)) : list.filter((h) => h && h !== "*");
    if (hosts.length === 0 || !isGlobal && hosts.length <= 1) continue;
    const orig = nodes.find((x) => x.id === en.id);
    orig.attachedTo = hosts[0];
    for (let i = 1; i < hosts.length; i++) {
      const cloneId = `${en.id}_${i}`;
      nodes.push({ ...orig, id: cloneId, attachedTo: hosts[i] });
      for (const f of outFlows) flows.push({ ...f, id: `${f.id}_${i}`, sourceRef: cloneId });
    }
  }
  const model = {
    id: ep.id,
    name: ep.name || ep.id,
    packageName: ep.package || "org.jbpm",
    processType: "Public",
    isExecutable: true,
    ...ep.version ? { version: ep.version } : {},
    ...ep.adHoc ? { adHoc: true } : {},
    ...ep.slaDueDate ? { slaDueDate: ep.slaDueDate } : {},
    ...ep.description ? { description: ep.description } : {},
    declarations: {
      signals: [...sig].map((n) => ({ id: `_sig_${n}`, name: n })),
      errors: [...err].map((n) => ({ id: n, errorCode: errCode[n] ?? n })),
      messages: [...msg].map((n) => ({ id: n, name: n })),
      escalations: [...esc].map((n) => ({ id: n, escalationCode: n, name: n }))
    },
    variables,
    dataObjects: (ep.data || []).map((d, i) => ({ id: d.id || d.name || `data${i}`, name: d.name, type: d.type ? resolve(d.type) : void 0, isCollection: d.collection })),
    lanes: (ep.lanes || []).map((l, i) => ({ id: l.id || `lane${i}`, name: l.name, flowNodeRefs: l.nodes })),
    nodes,
    flows
  };
  return autowire(model);
}
var COND_OP = {
  eq: "==",
  ne: "!=",
  gt: ">",
  gte: ">=",
  lt: "<",
  lte: "<=",
  in: "in",
  notIn: "not in",
  contains: "contains",
  notContains: "not contains",
  matches: "matches",
  memberOf: "memberOf"
};
var isLiteral = (v) => v === null || ["string", "number", "boolean"].includes(typeof v);
var isRef = (v) => !!v && typeof v === "object" && "ref" in v;
var toDrlVar = (r) => "$" + r.replace(/^\$/, "");
var capF = (s) => s.charAt(0).toUpperCase() + s.slice(1);
function whereConstraints(field, spec) {
  if (isLiteral(spec)) return [{ field, op: "==", value: spec }];
  if (Array.isArray(spec)) return [{ field, op: "in", value: spec }];
  if (isRef(spec)) return [{ field, op: "==", var: toDrlVar(spec.ref) }];
  return Object.entries(spec).map(([op, val]) => {
    const drlOp = COND_OP[op] || "==";
    if (isRef(val)) return { field, op: drlOp, var: toDrlVar(val.ref) };
    return { field, op: drlOp, value: val };
  });
}
function rulesToDrl(rs, resolve = (t) => t, pkg = "org.jbpm.rules") {
  const facts = /* @__PURE__ */ new Set();
  const rules = rs.rules.map((r) => {
    const when = r.when.map((w) => {
      facts.add(w.fact);
      const constraints = Object.entries(w.where || {}).flatMap(([f, spec]) => whereConstraints(f, spec));
      const pattern = { fact: w.fact, ...w.as ? { bind: "$" + w.as } : {}, constraints };
      if (w.not || w.exists === false) return { not: pattern };
      if (w.exists === true) return { exists: pattern };
      return pattern;
    });
    const then = r.then.map((a) => {
      if ("set" in a) return { modify: "$" + a.set, set: a.fields };
      if ("delete" in a) return { delete: "$" + a.delete };
      if ("call" in a) return { call: a.call, args: a.args };
      facts.add(a.insert);
      const simple = a.insert.split(".").pop();
      if (!a.fields || !Object.keys(a.fields).length) return { insert: `new ${simple}()` };
      const v = "$" + simple.charAt(0).toLowerCase() + simple.slice(1);
      const setters = Object.entries(a.fields).map(([f, val]) => `${v}.set${capF(f)}(${typeof val === "string" ? JSON.stringify(val) : val});`).join(" ");
      return { raw: `${simple} ${v} = new ${simple}(); ${setters} insert(${v});` };
    });
    const attrs = { ruleflowGroup: rs.group };
    if (r.priority != null) attrs.salience = r.priority;
    if (r.noLoop != null) attrs.noLoop = r.noLoop;
    return { name: r.name, attrs, when, then };
  });
  const imports = [...facts].map(resolve).filter((f) => f.includes(".")).sort();
  return { package: pkg, imports, globals: [], rules };
}
var FEEL_TYPE = {
  number: "number",
  int: "number",
  integer: "number",
  long: "number",
  double: "number",
  float: "number",
  string: "string",
  bool: "boolean",
  boolean: "boolean",
  date: "date",
  time: "time",
  dateTime: "date and time",
  datetime: "date and time",
  any: "",
  object: ""
};
var feelType = (t) => t ? FEEL_TYPE[t] ?? t : "";
var feelLit = (v) => typeof v === "string" ? `"${v}"` : String(v);
function feelTest(test) {
  if (test === "-" || test && typeof test === "object" && "any" in test) return "-";
  if (Array.isArray(test)) return test.map(feelLit).join(", ");
  if (test === null || typeof test !== "object") return feelLit(test);
  if ("feel" in test) return test.feel;
  if ("gt" in test) return `> ${feelLit(test.gt)}`;
  if ("gte" in test) return `>= ${feelLit(test.gte)}`;
  if ("lt" in test) return `< ${feelLit(test.lt)}`;
  if ("lte" in test) return `<= ${feelLit(test.lte)}`;
  if ("between" in test) return `[${feelLit(test.between[0])}..${feelLit(test.between[1])}]`;
  if ("in" in test) return test.in.map(feelLit).join(", ");
  if ("not" in test) return `not(${Array.isArray(test.not) ? test.not.map(feelLit).join(", ") : feelLit(test.not)})`;
  return "-";
}
function feelResult(r) {
  if (r !== null && typeof r === "object" && "feel" in r) return r.feel;
  return feelLit(r);
}
var el = (name, attrs = {}, children = [], text = "") => ({ name, attrs, children, text, cdata: [] });
var clean = (s) => s.replace(/[^\w.-]/g, "_");
function decisionToDmn(model, namespace) {
  const ns = namespace || model.namespace || `https://neutrinos/dmn/${model.name}`;
  const inputMap = /* @__PURE__ */ new Map();
  for (const d of model.decisions) for (const inp of d.inputs) if (!inputMap.has(inp.name)) inputMap.set(inp.name, feelType(inp.type));
  const children = [];
  for (const [name, typeRef] of inputMap) {
    children.push(el("inputData", { id: `_id_${clean(name)}`, name }, [
      el("variable", { id: `_var_${clean(name)}`, name, ...typeRef ? { typeRef } : {} })
    ]));
  }
  for (const d of model.decisions) {
    const decId = `_dec_${clean(d.name)}`;
    const infoReqs = d.inputs.map((inp) => el("informationRequirement", { id: `${decId}_ir_${clean(inp.name)}` }, [
      el("requiredInput", { href: `#_id_${clean(inp.name)}` })
    ]));
    const dt = `${decId}_dt`;
    const inputsX = d.inputs.map((inp) => el("input", { id: `${dt}_in_${clean(inp.name)}`, label: inp.name }, [
      el("inputExpression", { id: `${dt}_ie_${clean(inp.name)}`, ...feelType(inp.type) ? { typeRef: feelType(inp.type) } : {} }, [el("text", {}, [], inp.name)])
    ]));
    const outputsX = d.outputs.map((o) => el("output", { id: `${dt}_out_${clean(o.name)}`, name: o.name, ...feelType(o.type) ? { typeRef: feelType(o.type) } : {} }));
    const rulesX = d.rules.map((r, i) => el("rule", { id: `${dt}_r${i}` }, [
      ...d.inputs.map((inp) => el("inputEntry", { id: `${dt}_r${i}_i_${clean(inp.name)}` }, [el("text", {}, [], feelTest(inp.name in r.when ? r.when[inp.name] : "-"))])),
      ...d.outputs.map((o) => el("outputEntry", { id: `${dt}_r${i}_o_${clean(o.name)}` }, [el("text", {}, [], o.name in r.then ? feelResult(r.then[o.name]) : "")]))
    ]));
    const dtAttrs = { id: dt, hitPolicy: d.hitPolicy || "UNIQUE" };
    if (d.aggregation && d.hitPolicy === "COLLECT") dtAttrs.aggregation = d.aggregation;
    const decVarType = d.outputs.length === 1 ? feelType(d.outputs[0].type) : "";
    children.push(el("decision", { id: decId, name: d.name }, [
      el("variable", { id: `${decId}_var`, name: d.name, ...decVarType ? { typeRef: decVarType } : {} }),
      ...infoReqs,
      el("decisionTable", dtAttrs, [...inputsX, ...outputsX, ...rulesX])
    ]));
  }
  return { xml: el("definitions", { xmlns: "http://www.omg.org/spec/DMN/20180521/MODEL/", id: `_defs_${clean(model.name)}`, name: model.name, namespace: ns }, children) };
}
var FEEL_LIT = (s) => {
  const t = s.trim();
  if (/^".*"$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === "true" || t === "false") return t === "true";
  return t;
};
function parseFeelTest(text) {
  const t = text.trim();
  if (t === "" || t === "-") return { any: true };
  let m = /^>=\s*(.+)$/.exec(t);
  if (m) return { gte: FEEL_LIT(m[1]) };
  m = /^<=\s*(.+)$/.exec(t);
  if (m) return { lte: FEEL_LIT(m[1]) };
  m = /^>\s*(.+)$/.exec(t);
  if (m) return { gt: FEEL_LIT(m[1]) };
  m = /^<\s*(.+)$/.exec(t);
  if (m) return { lt: FEEL_LIT(m[1]) };
  m = /^\[(.+)\.\.(.+)\]$/.exec(t);
  if (m) return { between: [FEEL_LIT(m[1]), FEEL_LIT(m[2])] };
  m = /^not\((.+)\)$/.exec(t);
  if (m) {
    const inner = m[1].split(",").map((s) => FEEL_LIT(s));
    return { not: inner.length > 1 ? inner : inner[0] };
  }
  if (t.includes(",")) return t.split(",").map((s) => FEEL_LIT(s));
  if (/^"[^"]*"$/.test(t) || /^-?\d+(\.\d+)?$/.test(t) || t === "true" || t === "false") return FEEL_LIT(t);
  return { feel: t };
}
function parseFeelResult(text) {
  const t = text.trim();
  if (t === "") return "";
  if (/^"[^"]*"$/.test(t) || /^-?\d+(\.\d+)?$/.test(t) || t === "true" || t === "false") return FEEL_LIT(t);
  return { feel: t };
}
function dmnDecisionFromXml(decEl) {
  const dt = kid(decEl, "decisionTable");
  if (!dt) return void 0;
  const inputs = kids(dt, "input").map((inp) => {
    const expr = kid(inp, "inputExpression");
    const name = (expr && cdataText(kid(expr, "text")) || inp.attrs.label || inp.attrs.id || "").trim();
    return { name, ...(expr == null ? void 0 : expr.attrs.typeRef) ? { type: expr.attrs.typeRef } : {} };
  });
  const outputs = kids(dt, "output").map((o) => ({
    name: o.attrs.name || o.attrs.label || o.attrs.id || "",
    ...o.attrs.typeRef ? { type: o.attrs.typeRef } : {}
  }));
  const rules = kids(dt, "rule").map((r) => {
    const ins = kids(r, "inputEntry");
    const outs = kids(r, "outputEntry");
    const when = {};
    const then = {};
    inputs.forEach((inp, i) => {
      if (ins[i]) when[inp.name] = parseFeelTest(cdataText(kid(ins[i], "text")));
    });
    outputs.forEach((o, i) => {
      if (outs[i]) then[o.name] = parseFeelResult(cdataText(kid(outs[i], "text")));
    });
    return { when, then };
  });
  const hitPolicy = dt.attrs.hitPolicy || "UNIQUE";
  return {
    name: decEl.attrs.name || decEl.attrs.id || "",
    hitPolicy,
    inputs,
    outputs,
    rules,
    ...dt.attrs.aggregation ? { aggregation: dt.attrs.aggregation } : {}
  };
}
function dmnToDecisionModel(defsXml) {
  const decisions = kids(defsXml, "decision").map(dmnDecisionFromXml).filter((d) => !!d);
  if (!decisions.length) return void 0;
  return { name: defsXml.attrs.name || defsXml.attrs.id || "model", namespace: defsXml.attrs.namespace, decisions };
}
var GDST_OP = { eq: "==", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
var GDST_JAVA = { string: "String", number: "Double", double: "Double", float: "Double", int: "Integer", integer: "Integer", long: "Long", bool: "Boolean", boolean: "Boolean", date: "java.util.Date" };
var GDST_DATA = { string: "STRING", number: "NUMERIC_DOUBLE", double: "NUMERIC_DOUBLE", float: "NUMERIC_DOUBLE", int: "NUMERIC_INTEGER", integer: "NUMERIC_INTEGER", long: "NUMERIC_INTEGER", bool: "BOOLEAN", boolean: "BOOLEAN", date: "DATE" };
var gdstJava = (t) => GDST_JAVA[(t || "string").toLowerCase()] || "String";
var gdstData = (t) => GDST_DATA[(t || "string").toLowerCase()] || "STRING";
function decisionTableToGdst(m, pkg = "org.jbpm.rules", fieldTypes = {}) {
  const bind = m.bind || m.fact.charAt(0).toLowerCase() + m.fact.slice(1);
  const ct = (col) => col.type || fieldTypes[col.field] || "string";
  const tdv = (dt) => el("typedDefaultValue", {}, [el("valueString", {}, [], ""), el("dataType", {}, [], dt), el("isOtherwise", {}, [], "false")]);
  const conditions = m.conditions.map((c) => el("condition-column52", {}, [
    tdv(gdstData(ct(c))),
    el("hideColumn", {}, [], "false"),
    el("width", {}, [], "-1"),
    el("header", {}, [], c.field),
    el("constraintValueType", {}, [], "1"),
    el("factField", {}, [], c.field),
    el("fieldType", {}, [], gdstJava(ct(c))),
    el("operator", {}, [], GDST_OP[c.op] || "==")
  ]));
  const pattern = el("Pattern52", {}, [
    el("factType", {}, [], m.fact),
    el("boundName", {}, [], bind),
    el("isNegated", {}, [], "false"),
    el("conditions", {}, conditions)
  ]);
  const actions = m.actions.map((a) => el("action-set-field-column52", {}, [
    tdv(gdstData(ct(a))),
    el("hideColumn", {}, [], "false"),
    el("width", {}, [], "-1"),
    el("header", {}, [], a.field),
    el("boundName", {}, [], bind),
    el("factField", {}, [], a.field),
    el("type", {}, [], gdstJava(ct(a))),
    el("update", {}, [], "false")
  ]));
  const cell = (v, dt) => el("value", {}, [el("valueString", {}, [], v == null ? "" : String(v)), el("dataType", {}, [], dt), el("isOtherwise", {}, [], "false")]);
  const rowNum = (n) => el("value", {}, [el("valueNumeric", {}, [], String(n)), el("dataType", {}, [], "NUMERIC_INTEGER"), el("isOtherwise", {}, [], "false")]);
  const data = m.rows.map((r, i) => el("list", {}, [
    rowNum(i + 1),
    cell("", "STRING"),
    ...m.conditions.map((c) => cell((r.when || {})[c.field], gdstData(ct(c)))),
    ...m.actions.map((a) => cell((r.then || {})[a.field], gdstData(ct(a))))
  ]));
  return { xml: el("decision-table52", {}, [
    el("tableName", {}, [], m.name),
    el("rowNumberCol", {}, [el("hideColumn", {}, [], "false")]),
    el("descriptionCol", {}, [el("hideColumn", {}, [], "false")]),
    el("metadataCols", {}),
    el("attributeCols", {}),
    el("conditionPatterns", {}, [pattern]),
    el("actionCols", {}, actions),
    el("packageName", {}, [], pkg),
    el("tableFormat", {}, [], "EXTENDED_ENTRY"),
    el("data", {}, data)
  ]) };
}
var GDT_TYPE = "org.drools.workbench.models.guided.dtree.shared.model.nodes.impl.TypeNodeImpl";
var GDT_CONSTRAINT = "org.drools.workbench.models.guided.dtree.shared.model.nodes.impl.ConstraintNodeImpl";
var GDT_ACTION = "org.drools.workbench.models.guided.dtree.shared.model.nodes.impl.ActionUpdateNodeImpl";
var GDT_FIELDVAL = "org.drools.workbench.models.guided.dtree.shared.model.values.impl.ActionFieldValueImpl";
var GDT_JAVA = { string: "java.lang.String", number: "java.lang.Double", double: "java.lang.Double", float: "java.lang.Double", int: "java.lang.Integer", integer: "java.lang.Integer", long: "java.lang.Long", bool: "java.lang.Boolean", boolean: "java.lang.Boolean" };
var gdtJava = (t) => GDT_JAVA[(t || "string").toLowerCase()] || "java.lang.String";
function decisionTreeToGdt(tree, fieldTypes = {}, resolve = (t) => t) {
  const fqn2 = resolve(tree.fact);
  const actionNode = (actions) => el("node", { class: GDT_ACTION }, [
    el("className", {}, [], fqn2),
    el("fieldValues", {}, actions.map((a) => el("fieldValue", { class: GDT_FIELDVAL }, [
      el("fieldName", {}, [], a.set),
      el("value", { class: gdtJava(fieldTypes[a.set]) }, [], String(a.value))
    ])))
  ]);
  const compileNode = (node) => node.branches.map((b) => el("node", { class: GDT_CONSTRAINT }, [
    el("className", {}, [], fqn2),
    el("fieldName", {}, [], node.field),
    el("operator", {}, [], GDST_OP[b.op] || "=="),
    el("value", { class: gdtJava(fieldTypes[node.field]) }, [], String(b.value)),
    el("children", {}, Array.isArray(b.then) ? [actionNode(b.then)] : compileNode(b.then))
  ]));
  return { xml: el("GuidedDecisionTree", {}, [
    el("treeName", {}, [], tree.name),
    el("root", { class: GDT_TYPE }, [el("className", {}, [], fqn2), el("children", {}, compileNode(tree.root))])
  ]) };
}
function ruleToRdrl(rule, fieldTypes = {}) {
  const RM = "org.drools.workbench.models.datamodel.rule.";
  const jType = (f) => GDST_JAVA[(fieldTypes[f] || "string").toLowerCase()] || "String";
  const attrs = [];
  if (rule.priority != null) attrs.push(el("attribute", {}, [el("name", {}, [], "salience"), el("value", {}, [], String(rule.priority))]));
  if (rule.noLoop) attrs.push(el("attribute", {}, [el("name", {}, [], "no-loop"), el("value", {}, [], "true")]));
  const fieldConstraint = (c) => el("fieldConstraint", { class: RM + "SingleFieldConstraint" }, [
    el("fieldName", {}, [], c.field),
    el("fieldType", {}, [], jType(c.field)),
    el("operator", {}, [], c.op || "=="),
    ..."var" in c ? [el("value", {}, [], "$" + String(c.var).replace(/^\$/, "")), el("constraintValueType", {}, [], "5")] : [el("value", {}, [], String(c.value)), el("constraintValueType", {}, [], "1")]
  ]);
  const factPattern = (w) => {
    const cons = Object.entries(w.where || {}).flatMap(([f, spec]) => whereConstraints(f, spec)).filter((c) => "op" in c);
    return el("fact", { class: RM + "FactPattern" }, [
      el("factType", {}, [], w.fact),
      ...w.as ? [el("boundName", {}, [], w.as)] : [],
      el("constraintList", {}, [el("constraints", {}, cons.map(fieldConstraint))])
    ]);
  };
  const lhs = (rule.when || []).map((w) => w.not || w.exists === false ? el("fact", { class: RM + "CompositeFactPattern", type: "not" }, [factPattern(w)]) : factPattern(w));
  const fieldValues = (obj) => Object.entries(obj).map(([f, v]) => el("fieldValue", { class: RM + "ActionFieldValue" }, [el("field", {}, [], f), el("value", {}, [], String(v)), el("type", {}, [], jType(f))]));
  const rhs = (rule.then || []).map((a) => {
    if ("set" in a) return el("action", { class: RM + "ActionSetField" }, [el("variable", {}, [], a.set), el("fieldValues", {}, fieldValues(a.fields))]);
    if ("insert" in a) return el("action", { class: RM + "ActionInsertFact" }, [el("factType", {}, [], a.insert), ...a.fields ? [el("fieldValues", {}, fieldValues(a.fields))] : []]);
    if ("delete" in a) return el("action", { class: RM + "ActionRetractFact" }, [el("variableName", {}, [], a.delete)]);
    return el("action", { class: RM + "FreeFormLine" }, [el("text", {}, [], "call" in a ? `${a.call}(${(a.args || []).map((x) => JSON.stringify(x)).join(", ")});` : "")]);
  });
  return { xml: el("rule", {}, [
    el("name", {}, [], rule.name),
    el("modelVersion", {}, [], "1.0"),
    el("attributes", {}, attrs),
    el("lhs", {}, lhs),
    el("rhs", {}, rhs)
  ]) };
}
function templateToTemplateXml(tmpl, fieldTypes = {}) {
  const skeleton = ruleToRdrl({ name: tmpl.name, priority: tmpl.priority, noLoop: tmpl.noLoop, when: tmpl.when, then: tmpl.then }, fieldTypes).xml;
  const params = [...new Set(tmpl.rows.flatMap((r) => Object.keys(r)))];
  const tableColumns = el("tableColumns", {}, params.map((p) => el("tableColumn", {}, [], p)));
  const rows = el("rows", {}, tmpl.rows.map((r) => el("row", {}, params.map((p) => el("cell", {}, [], r[p] == null ? "" : String(r[p]))))));
  return { xml: el("templateModel", {}, [...skeleton.children, tableColumns, rows]) };
}
var SCGD_OP = { eq: "=", ne: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=" };
function scorecardToScgd(sc, fieldTypes = {}, resolve = (t) => t) {
  const fqn2 = resolve(sc.fact);
  const bandAttr = (band) => {
    let operator = "";
    let value = "";
    const w = band.when;
    if (w === void 0) {
    } else if (typeof w !== "object") {
      operator = "=";
      value = String(w);
    } else if ("between" in w) {
      operator = "in";
      value = `${w.between[0]}..${w.between[1]}`;
    } else {
      const [op, val] = Object.entries(w)[0];
      operator = SCGD_OP[op] || "=";
      value = String(val);
    }
    return el("Attribute", {}, [el("operator", {}, [], operator), el("value", {}, [], value), el("partialScore", {}, [], String(band.points))]);
  };
  const characteristics = sc.characteristics.map((ch) => el("Characteristic", {}, [
    el("name", {}, [], ch.field),
    el("factName", {}, [], fqn2),
    el("field", {}, [], ch.field),
    el("dataType", {}, [], gdstJava(fieldTypes[ch.field])),
    el("attributes", {}, ch.bands.map(bandAttr))
  ]));
  return { xml: el("ScoreCardModel", {}, [
    el("name", {}, [], sc.name),
    el("factName", {}, [], fqn2),
    el("fieldName", {}, [], sc.score),
    el("initialScore", {}, [], String(sc.baseline || 0)),
    el("useReasonCodes", {}, [], "false"),
    el("characteristics", {}, characteristics)
  ]) };
}
function testSuiteToScesim(suite) {
  const givenKeys = [...new Set(suite.cases.flatMap((c) => Object.keys(c.given)))];
  const expectKeys = [...new Set(suite.cases.flatMap((c) => Object.keys(c.expect)))];
  const factMappings = [
    ...givenKeys.map((k) => el("FactMapping", {}, [el("type", {}, [], "GIVEN"), el("factName", {}, [], k)])),
    ...expectKeys.map((k) => el("FactMapping", {}, [el("type", {}, [], "EXPECT"), el("factName", {}, [], k)]))
  ];
  const scenarios = suite.cases.map((c, i) => el("Scenario", {}, [
    el("name", {}, [], c.name || `case ${i + 1}`),
    el("values", {}, [
      ...givenKeys.map((k) => el("value", {}, [el("factName", {}, [], k), el("raw", {}, [], c.given[k] == null ? "" : String(c.given[k]))])),
      ...expectKeys.map((k) => el("value", {}, [el("factName", {}, [], k), el("raw", {}, [], c.expect[k] == null ? "" : String(c.expect[k]))]))
    ])
  ]));
  return { xml: el("ScenarioSimulationModel", { version: "1.8" }, [
    el("simulation", {}, [
      el("scesimModelDescriptor", {}, [el("factMappings", {}, factMappings)]),
      el("scenarios", {}, scenarios)
    ]),
    el("settings", {}, [el("target", {}, [], suite.target)])
  ]) };
}
var WIDGET_CODE = { text: "TextBox", textarea: "TextArea", integer: "IntegerBox", number: "DoubleBox", decimal: "DoubleBox", checkbox: "CheckBox", boolean: "CheckBox", dropdown: "ListBox", select: "ListBox", radio: "RadioGroup", date: "DatePicker" };
var TYPE_CODE = { string: "TextBox", int: "IntegerBox", integer: "IntegerBox", long: "IntegerBox", double: "DoubleBox", float: "DoubleBox", number: "DoubleBox", bool: "CheckBox", boolean: "CheckBox", date: "DatePicker" };
var humanize = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
function formToFrm(form, fieldTypes = {}, resolve = (t) => t) {
  const fields = form.fields.map((f) => {
    const code = f.widget ? WIDGET_CODE[f.widget] || "TextBox" : TYPE_CODE[(fieldTypes[f.bind] || "string").toLowerCase()] || "TextBox";
    const out = { id: f.bind, binding: f.bind, label: f.label || humanize(f.bind), code };
    if (f.required) out.required = true;
    if (f.readOnly) out.readOnly = true;
    if (f.placeholder) out.placeHolder = f.placeholder;
    return out;
  });
  const model = { name: form.name };
  if (form.type) model.className = resolve(form.type);
  return { json: { id: form.name, name: form.name, model, fields } };
}
function enumerationsToModel(enums) {
  const out = {};
  for (const e of enums) out[`${e.type}.${e.field}`] = e.values;
  return { enums: out };
}
function fromEngineProject(ep) {
  var _a;
  const basePkg = ((_a = ep.processes[0]) == null ? void 0 : _a.package) || "org.jbpm";
  const modelPkg = `${basePkg}.model`;
  const fill = (ts) => (ts || []).map((t) => t.package ? t : { ...t, package: modelPkg });
  const epTypes = fill(ep.types);
  const filledProcesses = ep.processes.map((p) => ({ ...p, types: fill(p.types) }));
  const allTypes = [...epTypes, ...filledProcesses.flatMap((p) => p.types || [])];
  const resolve = makeTypeResolver(allTypes);
  const processes = filledProcesses.map((p) => fromEngine(p, epTypes));
  const files = {};
  const seen = /* @__PURE__ */ new Set();
  for (const t of allTypes) {
    const key = fqn(t);
    if (seen.has(key)) continue;
    seen.add(key);
    const rel = "src/main/java/" + (t.package || "").replace(/\./g, "/") + (t.package ? "/" : "") + `${t.name}.java`;
    files[rel] = buildAsset({ kind: "dataObject", model: { package: t.package, className: t.name, fields: (t.fields || []).map((f) => ({ name: f.name, type: fieldJavaType(f, resolve) })) } });
  }
  for (const [path3, val] of Object.entries(ep.assets || {})) files[path3] = typeof val === "string" ? val : buildAsset(val);
  for (const rs of ep.rulesets || []) {
    const pkg = rs.package || `${basePkg}.rules`;
    const path3 = rs.path || `src/main/resources/${pkg.replace(/\./g, "/")}/${rs.group}.drl`;
    files[path3] = buildAsset({ kind: "drl", model: rulesToDrl(rs, resolve, pkg) });
  }
  for (const dm of ep.decisions || []) {
    const ns = dm.namespace || `https://${basePkg.replace(/\./g, "/")}/dmn/${dm.name}`;
    const path3 = dm.path || `src/main/resources/${dm.name}.dmn`;
    files[path3] = buildAsset({ kind: "dmn", model: decisionToDmn(dm, ns) });
  }
  for (const gt of ep.guidedTables || []) {
    const pkg = gt.package || `${basePkg}.rules`;
    const path3 = gt.path || `src/main/resources/${pkg.replace(/\./g, "/")}/${clean(gt.name)}.gdst`;
    const declared = allTypes.find((t) => t.name === gt.fact);
    const fieldTypes = {};
    for (const f of (declared == null ? void 0 : declared.fields) || []) fieldTypes[f.name] = f.type;
    files[path3] = buildAsset({ kind: "guidedDecisionTable", model: decisionTableToGdst(gt, pkg, fieldTypes) });
  }
  for (const rule of ep.guidedRules || []) {
    const pkg = rule.package || `${basePkg}.rules`;
    const path3 = rule.path || `src/main/resources/${pkg.replace(/\./g, "/")}/${clean(rule.name)}.rdrl`;
    const fieldTypes = {};
    for (const w of rule.when || []) {
      const d = allTypes.find((t) => t.name === w.fact);
      for (const f of (d == null ? void 0 : d.fields) || []) fieldTypes[f.name] = f.type;
    }
    files[path3] = buildAsset({ kind: "guidedRule", model: ruleToRdrl(rule, fieldTypes) });
  }
  for (const tmpl of ep.guidedRuleTemplates || []) {
    const pkg = tmpl.package || `${basePkg}.rules`;
    const path3 = tmpl.path || `src/main/resources/${pkg.replace(/\./g, "/")}/${clean(tmpl.name)}.template`;
    const fieldTypes = {};
    for (const w of tmpl.when || []) {
      const d = allTypes.find((t) => t.name === w.fact);
      for (const f of (d == null ? void 0 : d.fields) || []) fieldTypes[f.name] = f.type;
    }
    files[path3] = buildAsset({ kind: "guidedRuleTemplate", model: templateToTemplateXml(tmpl, fieldTypes) });
  }
  for (const sc of ep.scorecards || []) {
    const pkg = sc.package || `${basePkg}.rules`;
    const path3 = sc.path || `src/main/resources/${pkg.replace(/\./g, "/")}/${clean(sc.name)}.scgd`;
    const declared = allTypes.find((t) => t.name === sc.fact);
    const fieldTypes = {};
    for (const f of (declared == null ? void 0 : declared.fields) || []) fieldTypes[f.name] = f.type;
    files[path3] = buildAsset({ kind: "scoreCard", model: scorecardToScgd(sc, fieldTypes, resolve) });
  }
  for (const suite of ep.tests || []) {
    const path3 = suite.path || `src/test/resources/${clean(suite.name)}.scesim`;
    files[path3] = buildAsset({ kind: "testScenario", model: testSuiteToScesim(suite) });
  }
  for (const tree of ep.decisionTrees || []) {
    const pkg = tree.package || `${basePkg}.rules`;
    const path3 = tree.path || `src/main/resources/${pkg.replace(/\./g, "/")}/${clean(tree.name)}.gdt`;
    const declared = allTypes.find((t) => t.name === tree.fact);
    const fieldTypes = {};
    for (const f of (declared == null ? void 0 : declared.fields) || []) fieldTypes[f.name] = f.type;
    files[path3] = buildAsset({ kind: "guidedDecisionTree", model: decisionTreeToGdt(tree, fieldTypes, resolve) });
  }
  for (const form of ep.forms || []) {
    const path3 = form.path || `src/main/resources/forms/${form.name}.frm`;
    const declared = allTypes.find((t) => t.name === form.type);
    const fieldTypes = {};
    for (const f of (declared == null ? void 0 : declared.fields) || []) fieldTypes[f.name] = f.type;
    files[path3] = buildAsset({ kind: "form", model: formToFrm(form, fieldTypes, resolve) });
  }
  if ((ep.enumerations || []).length) {
    files["src/main/resources/enumerations.enumeration"] = buildAsset({ kind: "enumeration", model: enumerationsToModel(ep.enumerations) });
  }
  if ((ep.dsl || []).length) {
    files["src/main/resources/dsl/definitions.dsl"] = buildAsset({ kind: "dsl", model: { entries: ep.dsl } });
  }
  for (const [locale, entries] of Object.entries(ep.messages || {})) {
    const suffix = locale === "default" ? "" : `_${locale}`;
    files[`src/main/resources/messages${suffix}.properties`] = buildAsset({ kind: "properties", model: { props: entries } });
  }
  const dep = ep.deployment || {};
  const custom = ep.workItems || [];
  const workDefinitions = [...DEFAULT_WORK_ITEMS.filter((d) => !custom.some((c) => c.name === d.name)), ...custom];
  const handlerNames = [.../* @__PURE__ */ new Set([...workDefinitions.map((w) => w.name), ...dep.handlers || []])];
  const descriptor = {
    gav: ep.gav,
    deployment: {
      runtimeStrategy: dep.runtime || "SINGLETON",
      workItemHandlers: handlerNames.map((name) => ({ name, resolver: "mvel", identifier: HANDLER_ID[name] || `new ${name}()` })),
      environmentEntries: Object.entries(dep.env || {}).map(([name, v]) => ({ name, resolver: "mvel", identifier: `"${v}"` }))
    },
    workDefinitions,
    // -> global/WorkDefinitions.wid (defaults + any custom)
    files,
    ...ep.binaryAssets && Object.keys(ep.binaryAssets).length ? { binaryFiles: ep.binaryAssets } : {}
  };
  return { root: ep.id || ".", descriptor, processes };
}
var SCAFFOLD_FILES2 = /* @__PURE__ */ new Set([
  "pom.xml",
  "src/main/resources/META-INF/kmodule.xml",
  "src/main/resources/META-INF/persistence.xml",
  "src/main/resources/META-INF/kie-deployment-descriptor.xml",
  "project.imports",
  "project.repositories"
]);
var JAVA_TO_ENGINE = {
  String: "string",
  int: "int",
  integer: "int",
  long: "long",
  double: "double",
  float: "double",
  boolean: "bool",
  Boolean: "bool",
  "java.util.List": "list",
  "java.util.Map": "map",
  "java.util.Date": "date",
  Object: "object"
};
function toEngineProject(project) {
  const files = project.descriptor && project.descriptor.files || {};
  const types = [];
  const assets = {};
  for (const [p, content] of Object.entries(files)) {
    if (SCAFFOLD_FILES2.has(p)) continue;
    const kind = assetKind(p);
    if (kind === "dataObject") {
      const a = parseAsset(p, content);
      types.push({ name: a.model.className, package: a.model.package, fields: (a.model.fields || []).map((f) => ({ name: f.name, type: JAVA_TO_ENGINE[f.type] || f.type })) });
    } else {
      assets[p] = parseAsset(p, content);
    }
  }
  const dep = project.descriptor && project.descriptor.deployment || {};
  const binaryFiles = project.descriptor && project.descriptor.binaryFiles;
  return {
    id: project.root,
    gav: project.descriptor && project.descriptor.gav,
    deployment: {
      runtime: dep.runtimeStrategy,
      env: Object.fromEntries((dep.environmentEntries || []).map((e) => [e.name, e.identifier.replace(/^"|"$/g, "")])),
      handlers: (dep.workItemHandlers || []).map((h) => h.name)
    },
    types,
    assets,
    ...binaryFiles && Object.keys(binaryFiles).length ? { binaryAssets: binaryFiles } : {},
    processes: project.processes.map(toEngine)
  };
}
var SR_TO_ENGINE = { String: "string", Integer: "int", "java.lang.Long": "long", "java.lang.Double": "double", "java.lang.Boolean": "bool", "java.lang.Object": "object", "java.util.List": "list", "java.util.Map": "map", "java.util.Date": "date" };
var dialectToLang = (u) => u && u.includes("javascript") ? "js" : u && u.includes("mvel") ? "mvel" : "java";
var EXTRA_KEYS = ["on", "interrupting", "adHoc", "completionCondition", "multiInstance", "instantiate", "activationCondition", "assignmentStrategy", "swimlane", "autoClaim", "isForCompensation", "onChildFailure", "errorVar", "result", "metaData"];
var EXTRAS_META = "engine.extras";
var extrasOf = (n) => {
  const e = {};
  for (const k of EXTRA_KEYS) if (n[k] !== void 0 && !(k === "onChildFailure" && n[k] === "abort") && !(k === "result" && n[k] !== "cancel")) e[k] = n[k];
  return Object.keys(e).length ? { [EXTRAS_META]: JSON.stringify(e) } : {};
};
var restoreExtras = (md) => {
  try {
    return (md == null ? void 0 : md[EXTRAS_META]) ? JSON.parse(md[EXTRAS_META]) : {};
  } catch {
    return {};
  }
};
function toEngine(m) {
  var _a, _b, _c, _d;
  const ev = (n) => n.eventType === "signal" ? { signal: n.signalName } : n.eventType === "message" ? { message: n.messageRef } : n.eventType === "error" ? { error: n.errorRef } : n.eventType === "escalation" ? { escalation: n.escalationRef } : n.eventType === "timer" ? { timer: n.timeCycleLanguage === "cron" ? { cron: n.timeCycle } : { duration: n.timeDuration, cycle: n.timeCycle, date: n.timeDate } } : n.eventType === "conditional" ? { condition: n.conditionExpr, lang: dialectToLang(n.conditionExprLanguage) } : void 0;
  const gwMode = { exclusiveGateway: "exclusive", parallelGateway: "parallel", inclusiveGateway: "inclusive", eventBasedGateway: "event", complexGateway: "complex" };
  const revLifecycle = (n) => {
    var _a2, _b2;
    return {
      ...n.onEntry ? { onEntry: n.onEntry, onEntryLang: dialectToLang(n.onEntryFormat) } : {},
      ...n.onExit ? { onExit: n.onExit, onExitLang: dialectToLang(n.onExitFormat) } : {},
      ...n.async ? { async: true } : {},
      ...restoreExtras(n.metaData),
      ...n.autoStart ? { autoStart: true } : {},
      ...n.slaDueDate ? { slaDueDate: n.slaDueDate } : {},
      ...((_a2 = n.metaData) == null ? void 0 : _a2.asyncRetries) !== void 0 && Number.isInteger(Number(n.metaData.asyncRetries)) ? { asyncRetries: Number(n.metaData.asyncRetries) } : {},
      ...((_b2 = n.metaData) == null ? void 0 : _b2.asyncRetryDelay) ? { asyncRetryDelay: n.metaData.asyncRetryDelay } : {}
    };
  };
  const conv = (n) => {
    const b = {
      id: n.id,
      type: "raw",
      name: n.name,
      ...n.position ? { x: Math.round(n.position.x), y: Math.round(n.position.y) } : {}
    };
    switch (n.type) {
      case "startEvent":
        return { ...b, type: "start", ...ev(n) ? { on: ev(n) } : {} };
      case "endEvent":
        return n.eventType === "terminate" || n.subtype === "terminate" ? { ...b, type: "end", result: "terminate" } : { ...b, type: "end", ...ev(n) ? { throw: ev(n) } : {}, ...restoreExtras(n.metaData) };
      case "scriptTask": {
        const { onEntry: _a2, onExit: _b2, onEntryLang: _c2, onExitLang: _d2, ...meta } = revLifecycle(n);
        return { ...b, type: "script", lang: dialectToLang(n.scriptFormat), code: n.script, ...meta };
      }
      case "userTask": {
        const ti = n.taskInputs || {};
        const split = (v) => v ? v.split(",").map((x) => x.trim()).filter(Boolean) : [];
        const groups = split(n.group);
        const extra = {};
        if (ti.ActorId) extra.actors = split(ti.ActorId);
        if (ti.BusinessAdministratorId) extra.businessAdmin = ti.BusinessAdministratorId;
        if (ti.BusinessAdministratorGroupId) extra.businessAdminGroups = split(ti.BusinessAdministratorGroupId);
        if (ti.TaskStakeholderId) extra.stakeholders = split(ti.TaskStakeholderId);
        if (ti.ExcludedOwnerId) extra.excludedOwners = split(ti.ExcludedOwnerId);
        for (const [name, k] of [
          ["Comment", "comment"],
          ["Content", "content"],
          ["Locale", "locale"],
          ["CreatedBy", "createdBy"],
          ["suspendUntil", "suspendUntil"],
          ["Description", "description"],
          ["NotStartedReassign", "notStartedReassign"],
          ["NotCompletedReassign", "notCompletedReassign"],
          ["NotStartedNotify", "notStartedNotify"],
          ["NotCompletedNotify", "notCompletedNotify"]
        ]) if (ti[name] !== void 0) extra[k] = ti[name];
        if (ti.Priority !== void 0 && !Number.isNaN(Number(ti.Priority))) extra.priority = Number(ti.Priority);
        return { ...b, type: "userTask", name: n.name, group: groups[0], ...groups.length > 1 ? { groups: groups.slice(1) } : {}, form: n.taskName, ...extra, ...revLifecycle(n) };
      }
      // dmnModel present (implementation="...drools/dmn") -> real DMN wiring; decision name is left
      // unset (real jBPM's own dataInputAssociation convention never names one explicitly either — see
      // parse.ts) and defaults to the model's first decision at evaluation time (decisioning.ts).
      case "businessRuleTask":
        return {
          ...b,
          type: "rule",
          ruleflowGroup: n.ruleFlowGroup,
          ...n.dmnModel ? { dmn: { namespace: n.dmnNamespace || "", model: n.dmnModel, decision: "" } } : {},
          ...revLifecycle(n)
        };
      case "sendTask":
        return { ...b, type: "send", message: n.messageRef, ...revLifecycle(n) };
      case "receiveTask":
        return { ...b, type: "receive", message: n.messageRef, ...revLifecycle(n) };
      case "manualTask":
        return { ...b, type: "manual", name: n.name, ...revLifecycle(n) };
      case "genericTask": {
        const params = {};
        for (const [k, v] of Object.entries(n.workParams || {})) params[k] = v;
        return { ...b, type: "workItem", handler: n.handlerName, params, resultTo: n.workResultTo || {}, ...revLifecycle(n) };
      }
      case "exclusiveGateway":
      case "parallelGateway":
      case "inclusiveGateway":
      case "eventBasedGateway":
      case "complexGateway":
        return { ...b, type: "gateway", mode: gwMode[n.type], default: n.default, direction: n.gatewayDirection, ...n.instantiate ? { instantiate: true } : {}, ...restoreExtras(n.metaData) };
      case "intermediateCatchEvent":
        return { ...b, type: "catch", event: ev(n) };
      case "intermediateThrowEvent":
        return { ...b, type: "throw", event: ev(n) };
      case "boundaryEvent":
        return { ...b, type: "boundary", on: n.attachedTo, event: ev(n), interrupting: n.cancelActivity };
      case "subProcess": {
        const innerNodes = (n.nodes || []).map(conv);
        const errStart = n.subtype === "event" ? (n.nodes || []).find((x) => x.type === "startEvent" && x.eventType === "error") : void 0;
        const on = n.subtype === "event" ? (errStart == null ? void 0 : errStart.errorRef) ? { error: errStart.errorRef } : {} : void 0;
        return { ...b, type: "subprocess", transaction: n.subtype === "transaction" || void 0, on, nodes: innerNodes, ...restoreExtras(n.metaData), flows: (n.flows || []).map((f) => ({ id: f.id, from: f.sourceRef, to: f.targetRef, ...f.condition ? { when: f.condition, lang: dialectToLang(f.conditionLanguage) } : {} })), ...revLifecycle(n) };
      }
      case "callActivity":
        if (n.subtype === "multiInstance" && n.multiInstance) return { ...b, type: "forEach", process: n.calledElement, over: n.multiInstance.collectionIn, as: n.multiInstance.itemVar, collectInto: n.multiInstance.collectionOut, itemResult: n.multiInstance.itemOutVar, parallel: !n.multiInstance.isSequential, pass: n.multiInstance.passthru, ...n.multiInstance.completionCondition ? { completionCondition: n.multiInstance.completionCondition } : {}, ...revLifecycle(n) };
        if (n.subtype === "rest") return { ...b, type: "http", method: n.method, url: n.url, ...String(n.onExitFormat || "").includes("javascript") ? { lang: "js" } : {} };
        return { ...b, type: "call", process: n.calledElement, ...n.abortParent ? { onChildFailure: "abort" } : {}, ...n.inputs ? { inputs: n.inputs } : {}, ...n.outputs ? { outputs: n.outputs } : {}, ...revLifecycle(n) };
      default:
        return { ...b, type: "raw", raw: n.raw };
    }
  };
  return {
    id: m.id,
    name: m.name,
    package: m.packageName,
    ...m.version && m.version !== "1.0" ? { version: m.version } : {},
    ...m.adHoc ? { adHoc: true } : {},
    ...m.slaDueDate ? { slaDueDate: m.slaDueDate } : {},
    ...m.description ? { description: m.description } : {},
    vars: (m.variables || []).map((v) => {
      var _a2;
      return { name: v.name, type: SR_TO_ENGINE[v.type] || v.type, ...((_a2 = v.tags) == null ? void 0 : _a2.length) ? { tags: v.tags } : {} };
    }),
    signals: (((_a = m.declarations) == null ? void 0 : _a.signals) || []).map((s) => s.name),
    errors: (((_b = m.declarations) == null ? void 0 : _b.errors) || []).map((e) => e.id === e.errorCode ? e.id : { name: e.id, code: e.errorCode }),
    messages: (((_c = m.declarations) == null ? void 0 : _c.messages) || []).map((x) => x.id),
    escalations: (((_d = m.declarations) == null ? void 0 : _d.escalations) || []).map((x) => x.id),
    lanes: (m.lanes || []).map((l) => ({ id: l.id, name: l.name, nodes: l.flowNodeRefs })),
    data: (m.dataObjects || []).map((d) => ({ id: d.id, name: d.name, type: d.type ? SR_TO_ENGINE[d.type] || d.type : void 0, collection: d.isCollection })),
    nodes: m.nodes.map(conv),
    flows: m.flows.map((f) => ({ id: f.id, from: f.sourceRef, to: f.targetRef, ...f.condition ? { when: f.condition, lang: dialectToLang(f.conditionLanguage) } : {} }))
  };
}
export {
  DEFAULT_WORK_ITEMS,
  KMODULE_XML,
  PROJECT_IMPORTS,
  PROJECT_REPOSITORIES,
  assetKind,
  autowire,
  buildAsset,
  compileAction,
  compileConstraint,
  compileDeclare,
  compileFunction,
  compileLhs,
  compilePattern,
  compileQuery,
  constants_exports as constants,
  decisionTableToGdst,
  decisionToDmn,
  decisionTreeToGdt,
  deploymentXml,
  dmnToDecisionModel,
  enumerationsToModel,
  feelResult,
  feelTest,
  formToFrm,
  fromEngine,
  fromEngineProject,
  makeTypeResolver,
  parseAsset,
  parseBpmn,
  parseBpmnAll,
  parseDataObject,
  parseDescriptor,
  parseDrl,
  parseDsl,
  parseEnumeration,
  parseFeelResult,
  parseFeelTest,
  parseForm,
  parseProject,
  parseProperties,
  parseWid,
  pomXml,
  ruleToRdrl,
  rulesToDrl,
  scorecardToScgd,
  serializeProcess,
  templateToTemplateXml,
  testSuiteToScesim,
  toEngine,
  toEngineProject,
  validateModel,
  walk,
  widMvel,
  writeDataObject,
  writeDescriptor,
  writeDrl,
  writeDsl,
  writeEnumeration,
  writeForm,
  writeProject,
  writeProperties
};
//# sourceMappingURL=index.mjs.map