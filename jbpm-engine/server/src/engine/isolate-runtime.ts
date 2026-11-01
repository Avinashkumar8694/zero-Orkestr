// Source text executed INSIDE the isolated-vm isolate (never on the host). It is a self-contained plain-JS
// port of the java/Jackson/Nashorn shims that used to live in js-compat.ts as host functions, plus the
// kcontext / instance / node / env / console builders that used to live in sandbox.ts. Nothing in here can
// reach the host: the isolate has no `process`, `require`, `fetch`, timers or any other Node API, and the only
// data crossing the boundary is JSON text (in: `__setup(json)`, out: `__collect()` returning JSON text).
// Kept as a string constant (not a .js asset) so it survives the single-file tsup bundle unchanged.
// Authoring rule: no backticks / ${...} in the source below — it is embedded in a String.raw template.
export const ISOLATE_RUNTIME_SOURCE = String.raw`
'use strict';
(function () {
  var G = globalThis;
  var hasOwn = Object.prototype.hasOwnProperty;
  var defHidden = function (o, k, v) { Object.defineProperty(o, k, { value: v, writable: true, configurable: true, enumerable: false }); };
  var def = function (proto, prop, val) {
    try { if (proto && !proto[prop]) defHidden(proto, prop, val); } catch (e) { /* sealed */ }
  };
  // captured before any user code runs (the snapshot is taken here), so a script that clobbers these globals
  // can only break its own run, never the result extraction.
  var stringify = JSON.stringify, objKeys = Object.keys, ownNames = Object.getOwnPropertyNames;
  var truthyStr = function (v) { var s = String(v).trim().toLowerCase(); return s === 'true' || s === '1'; };

  // ---------------------------------------------------------------- Jackson / org.json / java.util shims
  function makeJacksonNode(data) {
    var self = {
      put: function (k, v) { if (data && typeof data === 'object') data[k] = v; return self; },
      putPOJO: function (k, v) { if (data && typeof data === 'object') data[k] = v; return self; },
      putNull: function (k) { if (data && typeof data === 'object') data[k] = null; return self; },
      putArray: function (k) { var a = []; if (data && typeof data === 'object') data[k] = a; return makeJacksonArray(a); },
      set: function (k, v) { if (data && typeof data === 'object') data[k] = v; return self; },
      get: function (k) { return (data && typeof data === 'object') ? data[k] : undefined; },
      path: function (k) { return makeJacksonNode((data && typeof data === 'object') ? data[k] : undefined); },
      has: function (k) { return (data && typeof data === 'object') ? hasOwn.call(data, k) : false; },
      hasNonNull: function (k) { return (data && typeof data === 'object') ? data[k] != null : false; },
      isArray: function () { return Array.isArray(data); },
      asBoolean: function (fb) {
        if (data == null) return fb === undefined ? false : fb;
        if (typeof data === 'boolean') return data;
        return truthyStr(data);
      },
      asInt: function (fb) { var n = parseInt(String(data), 10); return isNaN(n) ? (fb === undefined ? 0 : fb) : n; },
      asText: function (fb) { return data == null ? (fb === undefined ? '' : fb) : String(data); },
      isNull: function () { return data == null; },
      isMissingNode: function () { return data === undefined; },
      size: function () { return Array.isArray(data) ? data.length : (typeof data === 'object' && data !== null ? Object.keys(data).length : 0); },
      toString: function () { return typeof data === 'string' ? data : JSON.stringify(data); }
    };
    return self;
  }
  function makeJacksonArray(arr) {
    var data = arr || [];
    return {
      addObject: function () { var o = {}; data.push(o); return makeJacksonNode(o); },
      add: function (v) { data.push(v); return this; },
      toString: function () { return JSON.stringify(data); }
    };
  }
  function makeArrayList(initial) { return initial ? initial.slice() : []; }

  var MapPrototype = {
    put: function (k, v) { var key = String(k); var old = this[key] !== undefined ? this[key] : null; this[key] = v; return old; },
    get: function (k) { var key = String(k); return this[key] !== undefined ? this[key] : null; },
    remove: function (k) { var key = String(k); var old = this[key] !== undefined ? this[key] : null; delete this[key]; return old; },
    containsKey: function (k) { return hasOwn.call(this, String(k)); },
    size: function () { return Object.keys(this).length; },
    isEmpty: function () { return Object.keys(this).length === 0; },
    clear: function () { var ks = Object.keys(this); for (var i = 0; i < ks.length; i++) delete this[ks[i]]; },
    keySet: function () { return makeArrayList(Object.keys(this)); },
    values: function () { return makeArrayList(Object.values(this)); },
    toString: function () { return '{' + Object.entries(this).map(function (e) { return e[0] + '=' + e[1]; }).join(', ') + '}'; }
  };
  function makeHashMap(initial) {
    var self = Object.create(MapPrototype);
    if (initial && typeof initial === 'object') Object.assign(self, initial);
    return self;
  }
  function makeHashSet() {
    var data = new Set();
    var self = {};
    self.add = function (v) { var had = data.has(v); data.add(v); return !had; };
    self.contains = function (v) { return data.has(v); };
    self.remove = function (v) { var had = data.has(v); data.delete(v); return had; };
    self.size = function () { return data.size; };
    self.isEmpty = function () { return data.size === 0; };
    self.clear = function () { data.clear(); };
    self.toString = function () { return '[' + Array.from(data).join(', ') + ']'; };
    return self;
  }
  var JsonObjectPrototype = {
    put: function (k, v) { this[k] = v; return this; },
    get: function (k) { return this[k]; },
    getString: function (k) { var v = this[k]; return v == null ? null : String(v); },
    optString: function (k, fb) { var v = this[k]; return v == null ? (fb === undefined ? '' : fb) : String(v); },
    optBoolean: function (k, fb) { var v = this[k]; if (v == null) return fb === undefined ? false : fb; if (typeof v === 'boolean') return v; return truthyStr(v); },
    optInt: function (k, fb) { var v = this[k]; if (v == null) return fb === undefined ? 0 : fb; var n = parseInt(String(v), 10); return isNaN(n) ? (fb === undefined ? 0 : fb) : n; },
    has: function (k) { return hasOwn.call(this, k); },
    isNull: function (k) { return this[k] == null; },
    toString: function () { return JSON.stringify(this); }
  };
  function makeJsonObject(initial) {
    var data = {};
    if (initial && typeof initial === 'string') {
      try { var parsed = JSON.parse(initial); if (parsed && typeof parsed === 'object') data = parsed; } catch (e) { /* fallback */ }
    } else if (initial && typeof initial === 'object') {
      data = Object.assign({}, initial);
    }
    var self = Object.create(JsonObjectPrototype);
    Object.assign(self, data);
    return self;
  }
  var COLLECTION_FACTORIES = {
    'java.util.ArrayList': function () { return makeArrayList(); },
    'java.util.LinkedList': function () { return makeArrayList(); },
    'java.util.HashMap': makeHashMap,
    'java.util.LinkedHashMap': makeHashMap,
    'java.util.HashSet': makeHashSet,
    'java.util.LinkedHashSet': makeHashSet
  };
  function javaType(fqn) {
    var factory = COLLECTION_FACTORIES[fqn];
    if (!factory) {
      throw new Error('Java.type("' + fqn + '") is not supported in this engine\'s JS sandbox — only the common ' +
        'java.util collection types (ArrayList, LinkedList, HashMap, LinkedHashMap, HashSet, ' +
        'LinkedHashSet) are shimmed; custom/application classes and anything else on the JDK ' +
        'aren\'t resolvable here (this engine runs JS natively in V8, never a JVM).');
    }
    return function () { return factory(); };
  }

  // ---------------------------------------------------------------- realm prototype shims
  var OP = Object.prototype, AP = Array.prototype, SP = String.prototype;
  def(OP, 'isEmpty', function () {
    if (this == null) return true;
    if (typeof this.length === 'number') return this.length === 0;
    if (typeof this.size === 'function') return this.size() === 0;
    if (typeof this.size === 'number') return this.size === 0;
    return Object.keys(this).length === 0;
  });
  def(OP, 'equals', function (o) {
    if (this === o) return true;
    if (o == null) return false;
    return this.valueOf() === (typeof o.valueOf === 'function' ? o.valueOf() : o);
  });
  def(OP, 'path', function (k) { return makeJacksonNode((this && typeof this === 'object') ? this[k] : undefined); });
  def(OP, 'has', function (k) { return this && typeof this === 'object' && hasOwn.call(this, k); });
  def(OP, 'hasNonNull', function (k) { return this && typeof this === 'object' && this[k] != null; });
  def(OP, 'asText', function (fb) { return this == null ? (fb || '') : String(this); });
  def(OP, 'asBoolean', function (fb) { if (this == null) return !!fb; if (typeof this === 'boolean') return this; return truthyStr(this); });
  def(OP, 'asInt', function (fb) { var n = parseInt(String(this), 10); return isNaN(n) ? (fb || 0) : n; });
  def(OP, 'isNull', function () { return this == null; });
  def(OP, 'isMissingNode', function () { return this === undefined; });
  def(OP, 'size', function () {
    if (Array.isArray(this)) return this.length;
    return typeof this === 'object' && this !== null ? Object.keys(this).length : 0;
  });
  def(AP, 'isEmpty', function () { return this.length === 0; });
  def(AP, 'size', function () { return this.length; });
  def(AP, 'get', function (i) { return this[i]; });
  def(AP, 'set', function (i, v) { var old = this[i]; this[i] = v; return old; });
  def(AP, 'add', function (v) { this.push(v); return true; });
  def(AP, 'remove', function (idxOrVal) {
    if (typeof idxOrVal === 'number' && idxOrVal >= 0 && idxOrVal < this.length) return this.splice(idxOrVal, 1)[0];
    var idx = this.indexOf(idxOrVal);
    if (idx !== -1) return this.splice(idx, 1)[0];
    return null;
  });
  def(AP, 'contains', function (v) { return this.indexOf(v) !== -1; });
  def(AP, 'clear', function () { this.length = 0; });
  def(SP, 'isEmpty', function () { return this.length === 0; });
  def(SP, 'equals', function (o) { return this.valueOf() === String(o); });
  def(SP, 'equalsIgnoreCase', function (o) { return o != null && this.toLowerCase() === String(o).toLowerCase(); });
  def(SP, 'isNull', function () { return false; });
  def(SP, 'asText', function () { return this.valueOf(); });
  def(SP, 'asBoolean', function () { return truthyStr(this); });
  def(SP, 'asInt', function (fb) { var n = parseInt(this, 10); return isNaN(n) ? (fb || 0) : n; });
  def(SP, 'path', function (k) {
    try { var p = JSON.parse(this.valueOf()); return makeJacksonNode(p && typeof p === 'object' ? p[k] : undefined); }
    catch (e) { return makeJacksonNode(undefined); }
  });
  def(SP, 'has', function (k) {
    try { var p = JSON.parse(this.valueOf()); return p && typeof p === 'object' && hasOwn.call(p, k); }
    catch (e) { return false; }
  });
  def(Error.prototype, 'getMessage', function () { return this.message || String(this); });
  def(Error.prototype, 'getLocalizedMessage', function () { return this.message || String(this); });
  def(Error.prototype, 'printStackTrace', function () { console.error(this.stack); });
  String.valueOf = function (o) { return o == null ? 'null' : String(o); };
  if (typeof Boolean.TRUE === 'undefined') {
    Boolean.TRUE = { equals: function (o) { return Boolean(o) === true; }, valueOf: function () { return true; }, toString: function () { return 'true'; } };
    Boolean.FALSE = { equals: function (o) { return Boolean(o) === false; }, valueOf: function () { return false; }, toString: function () { return 'false'; } };
  }

  // ---------------------------------------------------------------- jBPM-style globals (Java/java/org/com/System/KieFunctions/…)
  var logLines = [];
  var envMap = {};
  var envDirty = {};
  var consoleObj = {};
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (lvl) {
    consoleObj[lvl] = function () {
      var args = Array.prototype.slice.call(arguments);
      logLines.push(args.map(function (x) { return typeof x === 'string' ? x : JSON.stringify(x); }).join(' '));
    };
  });
  var logFn = consoleObj.log;
  var hidden = {
    makeJacksonNode: makeJacksonNode,
    Java: { type: javaType },
    Integer: { valueOf: function (x) { return parseInt(x, 10); }, parseInt: function (x) { return parseInt(x, 10); } },
    Long: { valueOf: function (x) { return parseInt(x, 10); }, parseLong: function (x) { return parseInt(x, 10); } },
    Double: { valueOf: function (x) { return parseFloat(x); }, parseDouble: function (x) { return parseFloat(x); } },
    Float: { valueOf: function (x) { return parseFloat(x); }, parseFloat: function (x) { return parseFloat(x); } },
    java: { util: {
      ArrayList: function ArrayList(init) { return makeArrayList(Array.isArray(init) ? init : []); },
      LinkedList: function LinkedList(init) { return makeArrayList(Array.isArray(init) ? init : []); },
      HashMap: function HashMap(init) { return makeHashMap(init); },
      LinkedHashMap: function LinkedHashMap(init) { return makeHashMap(init); },
      HashSet: function HashSet() { return makeHashSet(); },
      LinkedHashSet: function LinkedHashSet() { return makeHashSet(); },
      Map: function Map(init) { return makeHashMap(init); },
      List: function List(init) { return makeArrayList(Array.isArray(init) ? init : []); },
      Set: function Set() { return makeHashSet(); }
    } },
    KieFunctions: {
      equalsTo: function (a, b) { if (a === b) return true; if (a == null || b == null) return false; return String(a) === String(b); },
      isTrue: function (a) { if (typeof a === 'boolean') return a; if (typeof a === 'string') return a.trim().toLowerCase() === 'true' || a.trim() === '1'; return Boolean(a); },
      isFalse: function (a) { if (typeof a === 'boolean') return !a; if (typeof a === 'string') return a.trim().toLowerCase() === 'false' || a.trim() === '0'; return !a; },
      isNull: function (a) { return a == null; },
      notNull: function (a) { return a != null; },
      isEmpty: function (a) {
        if (a == null) return true;
        if (typeof a === 'string') return a.trim() === '';
        if (Array.isArray(a)) return a.length === 0;
        if (typeof a === 'object') return Object.keys(a).length === 0;
        return false;
      },
      contains: function (container, value) {
        if (container == null) return false;
        if (Array.isArray(container)) return container.indexOf(value) >= 0;
        if (typeof container.contains === 'function') return container.contains(value);
        if (typeof container === 'string') return container.indexOf(String(value)) >= 0;
        return false;
      },
      startsWith: function (str, prefix) { if (str == null || prefix == null) return false; return String(str).indexOf(String(prefix)) === 0; },
      endsWith: function (str, suffix) { if (str == null || suffix == null) return false; var x = String(str), y = String(suffix); return x.length >= y.length && x.lastIndexOf(y) === x.length - y.length; },
      greaterThan: function (a, b) { return Number(a) > Number(b); },
      greaterOrEqualThan: function (a, b) { return Number(a) >= Number(b); },
      lessThan: function (a, b) { return Number(a) < Number(b); },
      lessOrEqualThan: function (a, b) { return Number(a) <= Number(b); },
      between: function (val, min, max) { var n = Number(val); return n >= Number(min) && n <= Number(max); }
    },
    org: { json: {
      JSONObject: function JSONObject(init) { return makeJsonObject(init); },
      JSONArray: function JSONArray(init) { return makeArrayList(Array.isArray(init) ? init : (typeof init === 'string' ? JSON.parse(init) : [])); }
    } },
    com: { fasterxml: { jackson: { databind: {
      ObjectMapper: function ObjectMapper() {
        return {
          createObjectNode: function () { return makeJacksonNode({}); },
          createArrayNode: function () { return makeJacksonArray([]); },
          readTree: function (str) { try { return makeJacksonNode(typeof str === 'string' ? JSON.parse(str) : str); } catch (e) { return makeJacksonNode({}); } },
          writeValueAsString: function (obj) { return JSON.stringify(obj); }
        };
      },
      node: {
        ObjectNode: function ObjectNode() { return makeJacksonNode({}); },
        ArrayNode: function ArrayNode() { return makeJacksonArray([]); }
      }
    } } } },
    System: {
      out: { println: function () { logFn.apply(null, arguments); }, print: function () { logFn.apply(null, arguments); } },
      // env only — the host process environment is deliberately NOT reachable (it holds server secrets).
      getenv: function (k) { return (envMap && envMap[k]) || ''; },
      getProperty: function (k) { return (envMap && envMap[k]) || ''; },
      currentTimeMillis: function () { return Date.now(); }
    }
  };
  Object.keys(hidden).forEach(function (k) { defHidden(G, k, hidden[k]); });
  defHidden(G, 'console', consoleObj);

  // ---------------------------------------------------------------- kcontext / instance / node
  var actions = [];
  var vars = {};
  var STATES = { completed: 2, aborted: 3, failed: 3, suspended: 4 };

  function setup(inputJson) {
    var input = JSON.parse(inputJson);
    var info = input.info || {};
    vars = input.vars || {};
    actions = [];
    logLines.length = 0;
    envMap = Object.assign({}, input.env || {});
    envDirty = {};
    var selfId = info.instanceId == null ? '' : String(info.instanceId);
    var instObj = {
      getId: function () { return selfId; },
      getProcessId: function () { return info.processId; },
      getProcessName: function () { return info.processName; },
      getCorrelationKey: function () { return info.correlationKey; },
      getParentProcessInstanceId: function () { return info.parentInstanceId; },
      getState: function () { return STATES[info.state] !== undefined ? STATES[info.state] : 1; },
      getVariables: function () { return vars; },
      getNodeInstances: function () {
        return (info.activeNodeInstances || []).map(function (n) {
          return { getId: function () { return n.id; }, getNodeId: function () { return n.nodeId; }, getNodeName: function () { return n.nodeName == null ? '' : n.nodeName; } };
        });
      },
      signalEvent: function (type, event) { actions.push({ kind: 'signal', type: type, payload: event, targetInstanceId: selfId }); }
    };
    var nodeInst = {
      getId: function () { return info.nodeInstanceId || ''; },
      getNodeId: function () { return info.nodeId || ''; },
      getNodeName: function () { return info.nodeName || ''; }
    };
    var environment = Object.assign({}, envMap, {
      get: function (k) { return envMap[k] != null ? envMap[k] : null; },
      set: function (k, v) { envMap[k] = v; envDirty[k] = String(v); }
    });
    var kieRuntime = {
      getEnvironment: function () { return environment; },
      signalEvent: function (type, event, processInstanceId) { actions.push({ kind: 'signal', type: type, payload: event, targetInstanceId: processInstanceId }); },
      abortProcessInstance: function (pid) { actions.push({ kind: 'abort', targetInstanceId: pid }); }
    };
    var kcontext = {
      getVariable: function (n) { return vars[n]; },
      setVariable: function (n, v) { vars[n] = v; },
      getProcessInstance: function () { return instObj; },
      getNodeInstance: function () { return nodeInst; },
      getKieRuntime: function () { return kieRuntime; }
    };
    var instance = {
      id: selfId, processId: info.processId, processName: info.processName, correlationKey: info.correlationKey,
      parentId: info.parentInstanceId, state: info.state || 'running', variables: vars,
      activeNodes: (info.activeNodeInstances || []).map(function (n) { return { id: n.id, nodeId: n.nodeId, name: n.nodeName == null ? '' : n.nodeName }; }),
      getVariable: function (n) { return vars[n]; },
      setVariable: function (n, v) { vars[n] = v; },
      hasVariable: function (n) { return hasOwn.call(vars, n); },
      getNodeInstances: function () {
        return (info.activeNodeInstances || []).map(function (n) {
          var name = n.nodeName == null ? '' : n.nodeName;
          return { getId: function () { return n.id; }, getNodeId: function () { return n.nodeId; }, getNodeName: function () { return name; }, id: n.id, nodeId: n.nodeId, name: name };
        });
      },
      signal: function (type, payload) { actions.push({ kind: 'signal', type: type, payload: payload, targetInstanceId: selfId }); },
      signalOther: function (t, type, payload) { actions.push({ kind: 'signal', type: type, payload: payload, targetInstanceId: t }); },
      broadcast: function (type, payload) { actions.push({ kind: 'signal', type: type, payload: payload }); },
      abort: function () { actions.push({ kind: 'abort', targetInstanceId: selfId }); },
      abortOther: function (t) { actions.push({ kind: 'abort', targetInstanceId: t }); }
    };
    var node = {
      id: info.nodeInstanceId || '', nodeId: info.nodeId || '', name: info.nodeName || '',
      getId: function () { return info.nodeInstanceId || ''; },
      getNodeId: function () { return info.nodeId || ''; },
      metaData: info.nodeMeta || {},
      getMetaData: function (k) { var m = info.nodeMeta || {}; return m[k] === undefined ? null : m[k]; },
      getNodeName: function () { return info.nodeName || ''; }
    };
    var env = Object.assign({}, input.env || {});

    // fixed globals first; bare-name process variables bind only where nothing already owns the name
    // (so kcontext/vars/console/Object/… can never be shadowed by a same-named variable).
    var fixed = {
      kcontext: kcontext, vars: vars, instance: instance, node: node, env: env,
      getVariable: function (n) { return vars[n]; },
      setVariable: function (n, v) { vars[n] = v; },
      instanceId: selfId, processId: info.processId == null ? '' : info.processId, processName: info.processName == null ? '' : info.processName,
      correlationKey: info.correlationKey == null ? '' : info.correlationKey, parentInstanceId: info.parentInstanceId == null ? '' : info.parentInstanceId,
      currentNodeId: info.nodeId || '', currentNodeName: info.nodeName || ''
    };
    Object.keys(fixed).forEach(function (k) { defHidden(G, k, fixed[k]); });
    var bound = {};
    Object.keys(vars).forEach(function (k) {
      if (hasOwn.call(G, k)) return;
      G[k] = vars[k];
      bound[k] = vars[k];
    });
    (info.declaredVars || []).forEach(function (k) { if (!hasOwn.call(G, k)) { G[k] = null; bound[k] = null; } });   // declared but empty: in scope as null
    var baseline = {};
    ownNames(G).forEach(function (k) { baseline[k] = true; });

    // collect(): the result is whatever the script left in vars (+ changed/new bare-name globals), as JSON.
    defHidden(G, '__collect', function () {
      var out = {};
      objKeys(vars).forEach(function (k) { out[k] = vars[k]; });
      objKeys(G).forEach(function (k) {
        if (typeof G[k] === 'function') return;
        if (hasOwn.call(bound, k)) { if (!Object.is(G[k], bound[k])) out[k] = G[k]; return; }
        if (baseline[k]) return;
        out[k] = G[k];
      });
      return stringify({ vars: out, logs: logLines, actions: actions, env: envDirty });
    });
    defHidden(G, '__logs', function () { return JSON.stringify(logLines); });
  }
  defHidden(G, '__setup', setup);
})();
`;
