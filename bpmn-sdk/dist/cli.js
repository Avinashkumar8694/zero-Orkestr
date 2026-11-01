"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/cli.ts
var cli_exports = {};
__export(cli_exports, {
  run: () => run
});
module.exports = __toCommonJS(cli_exports);
var import_node_fs3 = __toESM(require("fs"));

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
function stringifyNode(el) {
  const a = Object.entries(el.attrs || {}).map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("");
  let inner;
  if (el.children && el.children.length) inner = el.children.map(stringifyNode).join("");
  else if (el.cdata && el.cdata.length) inner = el.cdata.map(cdata).join("");
  else inner = escXml(el.text || "");
  return inner ? `<${el.name}${a}>${inner}</${el.name}>` : `<${el.name}${a}/>`;
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
function attr(el, name) {
  return el.attrs[name] !== void 0 ? el.attrs[name] : el.attrs[name.split(":").pop()];
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
  const io = (el) => ({
    incoming: kids(el, "incoming").map((c) => cdataText(c) || c.text),
    outgoing: kids(el, "outgoing").map((c) => cdataText(c) || c.text)
  });
  const elementName = (el) => {
    const ext = kid(el, "extensionElements");
    if (ext) {
      const md = kids(ext, "metaData").find((m) => m.attrs.name === "elementname");
      if (md) return cdataText(kid(md, "metaValue"));
    }
    return el.attrs.name;
  };
  const targetText = (a) => {
    const t = kid(a, "targetRef");
    return t ? cdataText(t) || t.text : "";
  };
  const sourceText = (a) => {
    const s = kid(a, "sourceRef");
    return s ? cdataText(s) || s.text : "";
  };
  const assignTo = (el, suffix) => {
    const a = kids(el, "dataInputAssociation").find((x) => targetText(x).endsWith(suffix));
    if (!a) return void 0;
    const asg = kid(a, "assignment");
    if (!asg) return void 0;
    return cdataText(kid(asg, "from"));
  };
  function userTaskInputs(el) {
    const spec = kid(el, "ioSpecification");
    const out = {};
    const nameOf = new Map(spec ? kids(spec, "dataInput").map((d) => [d.attrs.id, d.attrs.name]) : []);
    for (const a of spec ? kids(el, "dataInputAssociation") : []) {
      const name = nameOf.get(targetText(a));
      if (!name || name === "TaskName" || name === "Skippable" || name === "GroupId") continue;
      const asg = kid(a, "assignment");
      const v = asg ? cdataText(kid(asg, "from")) : void 0;
      if (v !== void 0) out[name] = v;
    }
    const roleIds = (tag) => kids(el, tag).flatMap((r) => {
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
  function applyOnEntryExit(el, nd) {
    const ext = kid(el, "extensionElements");
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
  function applyEventDef(nd, el) {
    const sg = kid(el, "signalEventDefinition");
    if (sg) {
      nd.eventType = "signal";
      nd.signalName = sigName(sg.attrs.signalRef);
      return;
    }
    const er = kid(el, "errorEventDefinition");
    if (er) {
      nd.eventType = "error";
      nd.errorRef = er.attrs.errorRef;
      return;
    }
    const ms = kid(el, "messageEventDefinition");
    if (ms) {
      nd.eventType = "message";
      nd.messageRef = ms.attrs.messageRef;
      return;
    }
    const es = kid(el, "escalationEventDefinition");
    if (es) {
      nd.eventType = "escalation";
      nd.escalationRef = es.attrs.escalationRef;
      return;
    }
    const cd = kid(el, "conditionalEventDefinition");
    if (cd) {
      nd.eventType = "conditional";
      const c = kid(cd, "condition");
      nd.conditionExpr = cdataText(c);
      if (c && c.attrs.language) nd.conditionExprLanguage = c.attrs.language;
      return;
    }
    const tm = kid(el, "timerEventDefinition");
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
    const tr = kid(el, "terminateEventDefinition");
    if (tr) {
      nd.eventType = "terminate";
      return;
    }
    nd.eventType = "none";
  }
  function parseContainer(container) {
    const nodes = [];
    const flows = [];
    for (const el of container.children) {
      const tag = local(el.name);
      if (tag === "sequenceFlow") {
        const f = { id: el.attrs.id || genId("flow"), sourceRef: el.attrs.sourceRef, targetRef: el.attrs.targetRef };
        if (el.attrs.name) f.name = el.attrs.name;
        const c = kid(el, "conditionExpression");
        if (c) {
          f.condition = cdataText(c);
          if (c.attrs.language) f.conditionLanguage = c.attrs.language;
        }
        if (wps[el.attrs.id]) f.waypoints = wps[el.attrs.id];
        flows.push(f);
        continue;
      }
      const base = { id: el.attrs.id || genId("node"), name: elementName(el), type: "raw", position: pos[el.attrs.id], ...io(el) };
      if (GATEWAYS[tag]) {
        const nd = { ...base, type: GATEWAYS[tag], gatewayDirection: el.attrs.gatewayDirection || "Unspecified" };
        if (el.attrs.default) nd.default = el.attrs.default;
        if (tag === "eventBasedGateway") {
          if (el.attrs.eventGatewayType) nd.eventGatewayType = el.attrs.eventGatewayType;
          if (el.attrs.instantiate) nd.instantiate = el.attrs.instantiate === "true";
        }
        applyOnEntryExit(el, nd);
        nodes.push(nd);
        continue;
      }
      switch (tag) {
        case "startEvent": {
          const nd = { ...base, type: "startEvent" };
          if (el.attrs.isInterrupting) nd.isInterrupting = el.attrs.isInterrupting === "true";
          applyEventDef(nd, el);
          nd.subtype = nd.eventType;
          nodes.push(nd);
          break;
        }
        case "endEvent": {
          const nd = { ...base, type: "endEvent" };
          applyEventDef(nd, el);
          nd.subtype = nd.eventType === "terminate" ? "terminate" : nd.eventType;
          applyOnEntryExit(el, nd);
          nodes.push(nd);
          break;
        }
        case "intermediateCatchEvent": {
          const nd = { ...base, type: "intermediateCatchEvent" };
          applyEventDef(nd, el);
          nodes.push(nd);
          break;
        }
        case "intermediateThrowEvent": {
          const nd = { ...base, type: "intermediateThrowEvent" };
          applyEventDef(nd, el);
          nodes.push(nd);
          break;
        }
        case "boundaryEvent": {
          const nd = { ...base, type: "boundaryEvent", attachedTo: el.attrs.attachedToRef, cancelActivity: el.attrs.cancelActivity !== "false" };
          applyEventDef(nd, el);
          nodes.push(nd);
          break;
        }
        case "scriptTask": {
          const nd = { ...base, type: "scriptTask", script: cdataText(kid(el, "script")), scriptFormat: el.attrs.scriptFormat };
          applyOnEntryExit(el, nd);
          nodes.push(nd);
          break;
        }
        case "userTask": {
          const nd = { ...base, type: "userTask", taskName: assignTo(el, "_TaskNameInputX"), skippable: assignTo(el, "_SkippableInputX") !== "false", group: assignTo(el, "_GroupIdInputX") };
          const ti = userTaskInputs(el);
          if (Object.keys(ti).length) nd.taskInputs = ti;
          applyOnEntryExit(el, nd);
          nodes.push(nd);
          break;
        }
        case "businessRuleTask": {
          const nd = { ...base, type: "businessRuleTask", ruleFlowGroup: attr(el, "drools:ruleFlowGroup"), implementation: el.attrs.implementation };
          if (el.attrs.implementation === "http://www.jboss.org/drools/dmn") {
            nd.dmnNamespace = assignTo(el, "_namespaceInputX");
            nd.dmnModel = assignTo(el, "_modelInputX");
          }
          applyOnEntryExit(el, nd);
          nodes.push(nd);
          break;
        }
        case "sendTask": {
          const nd = { ...base, type: "sendTask", messageRef: el.attrs.messageRef, operationRef: el.attrs.operationRef, implementation: el.attrs.implementation };
          applyOnEntryExit(el, nd);
          nodes.push(nd);
          break;
        }
        case "receiveTask": {
          const nd = { ...base, type: "receiveTask", messageRef: el.attrs.messageRef, implementation: el.attrs.implementation };
          applyOnEntryExit(el, nd);
          nodes.push(nd);
          break;
        }
        case "manualTask": {
          const nd = { ...base, type: "manualTask" };
          applyOnEntryExit(el, nd);
          nodes.push(nd);
          break;
        }
        case "subProcess":
        case "transaction": {
          const nd = { ...base, type: "subProcess", subtype: tag === "transaction" ? "transaction" : el.attrs.triggeredByEvent === "true" ? "event" : "embedded" };
          applyOnEntryExit(el, nd);
          const inner = parseContainer(el);
          nd.nodes = inner.nodes;
          nd.flows = inner.flows;
          nodes.push(nd);
          break;
        }
        case "callActivity": {
          const nd = { ...base, type: "callActivity", calledElement: el.attrs.calledElement, ...attr(el, "drools:abortParent") === "true" ? { abortParent: true } : {} };
          const mi = kid(el, "multiInstanceLoopCharacteristics");
          if (mi) {
            nd.subtype = "multiInstance";
            const idi = kid(mi, "inputDataItem");
            const odi = kid(mi, "outputDataItem");
            const firstIn = kids(el, "dataInputAssociation")[0];
            const firstOut = kids(el, "dataOutputAssociation")[0];
            nd.multiInstance = {
              isSequential: mi.attrs.isSequential === "true",
              itemVar: idi && idi.attrs.name || "item",
              itemOutVar: odi && odi.attrs.name || "result",
              collectionIn: firstIn ? sourceText(firstIn) : "",
              collectionOut: firstOut ? targetText(firstOut) : "",
              ...kid(mi, "completionCondition") ? { completionCondition: cdataText(kid(mi, "completionCondition")) } : {}
            };
          } else if ((el.attrs.calledElement || "").endsWith("pru-rest-executor")) {
            nd.subtype = "rest";
            const url = assignTo(el, "_UrlInputX");
            nd.url = url ? url.replace("#{baseUrl}", "") : void 0;
            nd.method = assignTo(el, "_MethodInputX") || "POST";
          } else {
            nd.subtype = "reusable";
          }
          const portName = (ref, suffix) => ref.startsWith(`${el.attrs.id}_`) && ref.endsWith(suffix) ? ref.slice(el.attrs.id.length + 1, -suffix.length) : ref;
          const inputs = {};
          for (const a of kids(el, "dataInputAssociation")) {
            const port = portName(targetText(a), "InputX");
            const asg = kid(a, "assignment");
            const value = asg ? cdataText(kid(asg, "from")) : sourceText(a);
            if (port && value !== void 0) inputs[port] = asg ? value || "" : `$${value}`;
          }
          const outputs = {};
          for (const a of kids(el, "dataOutputAssociation")) {
            const port = portName(sourceText(a), "OutputX");
            const target = targetText(a);
            if (port && target) outputs[target] = port;
          }
          if (Object.keys(inputs).length) nd.inputs = inputs;
          if (Object.keys(outputs).length) nd.outputs = outputs;
          applyOnEntryExit(el, nd);
          nodes.push(nd);
          break;
        }
        case "task": {
          const handlerName = attr(el, "drools:taskName");
          if (!handlerName) {
            if (!RAW_SKIP.has(tag)) nodes.push({ ...base, type: "raw", bpmnLocal: tag, raw: stringifyNode(el) });
            break;
          }
          const portName = (ref, suffix) => ref.startsWith(`${el.attrs.id}_`) && ref.endsWith(suffix) ? ref.slice(el.attrs.id.length + 1, -suffix.length) : ref;
          const workParams = {};
          for (const a of kids(el, "dataInputAssociation")) {
            const port = portName(targetText(a), "InputX");
            const asg = kid(a, "assignment");
            const value = asg ? cdataText(kid(asg, "from")) : sourceText(a);
            if (port && value !== void 0) workParams[port] = asg ? value || "" : `$${value}`;
          }
          const workResultTo = {};
          for (const a of kids(el, "dataOutputAssociation")) {
            const port = portName(sourceText(a), "OutputX");
            const varName = targetText(a);
            if (port && varName) workResultTo[varName] = port;
          }
          const nd = { ...base, type: "genericTask", handlerName, workParams, workResultTo };
          applyOnEntryExit(el, nd);
          nodes.push(nd);
          break;
        }
        default:
          if (!RAW_SKIP.has(tag)) nodes.push({ ...base, type: "raw", bpmnLocal: tag, raw: stringifyNode(el) });
          break;
      }
    }
    return { nodes, flows };
  }
  function metaValues(el) {
    const ext = kid(el, "extensionElements");
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
    const el = gatewayEl[nd.type];
    const extra = (nd.default ? ` default="${nd.default}"` : "") + (nd.type === "eventBasedGateway" && nd.eventGatewayType ? ` eventGatewayType="${nd.eventGatewayType}"` : "") + (nd.type === "eventBasedGateway" && nd.instantiate != null ? ` instantiate="${nd.instantiate}"` : "");
    return `<bpmn2:${el} id="${nd.id}"${nd.name ? ` name="${escAttr(nd.name)}"` : ""} gatewayDirection="${nd.gatewayDirection || "Diverging"}"${extra}>${extBlock(nd)}${inout(nd)}</bpmn2:${el}>`;
  }
  function eventNode(el, nd, extraAttrs = "") {
    return `<bpmn2:${el} id="${nd.id}" name="${escAttr(nd.name || "")}"${extraAttrs}>${extBlock(nd)}${inout(nd)}${buildEventDef(nd)}</bpmn2:${el}>`;
  }
  function bizTask(nd) {
    const a = (nd.ruleFlowGroup ? ` drools:ruleFlowGroup="${escAttr(nd.ruleFlowGroup)}"` : "") + ` implementation="${nd.implementation || "##unspecified"}"`;
    return `<bpmn2:businessRuleTask id="${nd.id}"${a} name="${escAttr(nd.name)}">${extBlock(nd)}${inout(nd)}${simpleIo(nd)}</bpmn2:businessRuleTask>`;
  }
  function msgTask(el, nd) {
    const a = (nd.messageRef ? ` messageRef="${nd.messageRef}"` : "") + (nd.operationRef ? ` operationRef="${nd.operationRef}"` : "") + (nd.implementation ? ` implementation="${nd.implementation}"` : "");
    return `<bpmn2:${el} id="${nd.id}"${a} name="${escAttr(nd.name)}">${extBlock(nd)}${inout(nd)}${simpleIo(nd)}</bpmn2:${el}>`;
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
var import_node_fs2 = __toESM(require("fs"));
var import_node_path2 = __toESM(require("path"));

// src/scaffold.ts
var import_node_fs = __toESM(require("fs"));
var import_node_path = __toESM(require("path"));
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
  for (const e of import_node_fs.default.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) collectAssets(import_node_path.default.join(dir, e.name), projectDir, out, bin);
      continue;
    }
    const ext = import_node_path.default.extname(e.name).toLowerCase();
    if (ext === ".bpmn" || ext === ".bpmn2") continue;
    const rel = import_node_path.default.relative(projectDir, import_node_path.default.join(dir, e.name));
    if (SCAFFOLD_FILES.includes(rel) || rel === DD_PATH) continue;
    const abs = import_node_path.default.join(dir, e.name);
    if (BINARY_EXTS.has(ext)) bin[rel] = import_node_fs.default.readFileSync(abs).toString("base64");
    else out[rel] = import_node_fs.default.readFileSync(abs, "utf8");
  }
}
var DT_SHORT = (fqn) => fqn.split(".").pop() || fqn;
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
    const abs = import_node_path.default.join(projectDir, rel);
    if (import_node_fs.default.existsSync(abs)) files[rel] = import_node_fs.default.readFileSync(abs, "utf8");
  }
  const binaryFiles = {};
  collectAssets(projectDir, projectDir, files, binaryFiles);
  const gav = files["pom.xml"] ? readGav(files["pom.xml"]) : void 0;
  const ddAbs = import_node_path.default.join(projectDir, DD_PATH);
  const deployment = import_node_fs.default.existsSync(ddAbs) ? readDeployment(import_node_fs.default.readFileSync(ddAbs, "utf8")) : void 0;
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
    const abs = import_node_path.default.join(projectDir, rel);
    import_node_fs.default.mkdirSync(import_node_path.default.dirname(abs), { recursive: true });
    import_node_fs.default.writeFileSync(abs, content);
    written.push(rel);
  };
  for (const [rel, content] of Object.entries(files)) if (rel !== DD_PATH) put(rel, content);
  for (const [rel, b64] of Object.entries(desc.binaryFiles || {})) {
    const abs = import_node_path.default.join(projectDir, rel);
    import_node_fs.default.mkdirSync(import_node_path.default.dirname(abs), { recursive: true });
    import_node_fs.default.writeFileSync(abs, Buffer.from(b64, "base64"));
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
  for (const e of import_node_fs2.default.readdirSync(dir, { withFileTypes: true })) {
    const p = import_node_path2.default.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "target" && e.name !== ".git") walk(p, ext, out);
    } else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}
function parseProject(projectDir) {
  const resRoot = import_node_fs2.default.existsSync(import_node_path2.default.join(projectDir, "src/main/resources")) ? import_node_path2.default.join(projectDir, "src/main/resources") : projectDir;
  const files = [...walk(resRoot, ".bpmn2"), ...walk(resRoot, ".bpmn")];
  const processes = files.map((f) => {
    const model = parseBpmn(import_node_fs2.default.readFileSync(f, "utf8"));
    model.sourcePath = import_node_path2.default.relative(projectDir, f);
    return model;
  });
  return { root: projectDir, resourcesRoot: import_node_path2.default.relative(projectDir, resRoot), descriptor: parseDescriptor(projectDir), processes };
}
function writeProject(project, projectDir, opts = {}) {
  const written = [];
  for (const proc of project.processes) {
    const rel = proc.sourcePath || import_node_path2.default.join(project.resourcesRoot || "src/main/resources", "org/jbpm", `${proc.name}.bpmn`);
    const abs = import_node_path2.default.join(projectDir, rel);
    import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(abs), { recursive: true });
    import_node_fs2.default.writeFileSync(abs, serializeProcess(proc));
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

// src/cli.ts
function usage() {
  console.log(`bpmn-sdk \u2014 jBPM BPMN <-> JSON

Usage:
  bpmn-sdk to-json <projectDir> [out.json]     Parse a BPM project's .bpmn files -> JSON model
  bpmn-sdk to-bpm  <in.json> [projectDir]      Serialize JSON model -> .bpmn files
  bpmn-sdk parse   <file.bpmn> [out.json]      Parse one .bpmn -> JSON
  bpmn-sdk build   <process.json> <out.bpmn>   Serialize one process JSON -> .bpmn
  bpmn-sdk validate <file.bpmn | projectDir>   Structural validation`);
}
function run(argv) {
  const [cmd, a, b] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") return usage();
  if (cmd === "to-json") {
    const project = parseProject(a);
    const json = JSON.stringify(project, null, 2);
    if (b) {
      import_node_fs3.default.writeFileSync(b, json);
      console.log(`Wrote ${b} (${project.processes.length} processes)`);
    } else console.log(json);
    return;
  }
  if (cmd === "to-bpm") {
    const project = JSON.parse(import_node_fs3.default.readFileSync(a, "utf8"));
    const written = writeProject(project, b || project.root);
    console.log(`Wrote ${written.length} file(s):
  ${written.join("\n  ")}`);
    return;
  }
  if (cmd === "parse") {
    const model = parseBpmn(import_node_fs3.default.readFileSync(a, "utf8"));
    const json = JSON.stringify(model, null, 2);
    if (b) {
      import_node_fs3.default.writeFileSync(b, json);
      console.log(`Wrote ${b}`);
    } else console.log(json);
    return;
  }
  if (cmd === "build") {
    const model = JSON.parse(import_node_fs3.default.readFileSync(a, "utf8"));
    import_node_fs3.default.writeFileSync(b, serializeProcess(model));
    console.log(`Wrote ${b}`);
    return;
  }
  if (cmd === "validate") {
    const stat = import_node_fs3.default.statSync(a);
    const models = stat.isDirectory() ? parseProject(a).processes : [parseBpmn(import_node_fs3.default.readFileSync(a, "utf8"))];
    let bad = 0;
    for (const m of models) {
      const r = validateModel(m);
      console.log(`
${m.id || m.name} \u2014 ${r.ok ? "OK" : "ERRORS"}`);
      r.errors.forEach((e) => {
        bad++;
        console.log("  ERROR: " + e);
      });
      r.warnings.forEach((w) => console.log("  warn:  " + w));
    }
    process.exit(bad ? 1 : 0);
  }
  usage();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  run
});
//# sourceMappingURL=cli.js.map