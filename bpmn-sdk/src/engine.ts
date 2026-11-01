// Engine model <-> jBPM ProcessModel converter.
// Your Node BPM engine authors the clean "engine model" (see docs/engine-model/); fromEngine maps it
// to the SDK's jBPM ProcessModel, then serializeProcess/writeProject produce a kjar. Type *names*
// are resolved to Java FQNs (structureRef / form className / rule facts) and .java POJOs are
// generated from declared type schemas — so the engine never needs real Java classes.
import type { ProcessModel, Node, Flow, Project, ProjectDescriptor, WorkItemHandler, EnvironmentEntry, Gav, WorkItemDefinition } from './types.js';
import { autowire } from './wire.js';
import { buildAsset, parseAsset, assetKind } from './assets.js';
import type { DrlModel, DrlRule, RuleConstraint, RulePattern, LhsElement, RuleAction, RuleAttributes, ConstraintOp, DslEntry } from './assets.js';
import type { ElementNode } from './xml.js';
import { kid, kids, cdataText } from './xml.js';

export type Lang = 'js' | 'java' | 'mvel';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
export type GatewayMode = 'exclusive' | 'parallel' | 'inclusive' | 'event' | 'complex';
export interface EngineTypeField { name: string; type: string; list?: boolean; }
export interface EngineType { name: string; package?: string; fields?: EngineTypeField[]; }
export interface EngineVar { name: string; type: string; /** jBPM variable tags: required, readonly, restricted */ tags?: string[]; }
export interface EngineFlow { id?: string; from: string; to: string; when?: string; lang?: Lang; }

export interface TimerSpec { duration?: string; cycle?: string; date?: string; }
/** An event trigger — exactly one of the fields is set (per position it's start/catch/throw/boundary). */
export interface EventDef {
  signal?: string; message?: string; error?: string; escalation?: string;
  condition?: string; lang?: Lang; timer?: TimerSpec | string;
  /** Throw-side only (throw/send/end): a $var reference (e.g. "$claimId") resolved against the
   *  instance's variables and used to narrow delivery to only the waiting instance(s) whose OWN
   *  correlationKey (set at start()) matches — see execution-engine.ts's broadcast(). Omit for the
   *  default "deliver to every instance waiting on this name" behavior. */
  correlationKey?: string;
}
interface Base { id?: string; name?: string; }
// Real jBPM's generic onEntry-script/onExit-script action hooks — attachable to any activity, not
// just the http/REST wrapper (which has its own `exitScript`, pre-dating this and kept separate since
// it auto-generates a default body). Independent dialects since a real jBPM project's onEntry/onExit
// pair could in principle differ (the underlying ProcessModel keeps them independent too).
interface WithLifecycle {
  onEntry?: string; onExit?: string; onEntryLang?: Lang; onExitLang?: Lang;
  /** jBPM "Is Async" (customAsync) and "SLA Due Date" (customSLADueDate); asyncRetries / asyncRetryDelay are this engine's own, kept as metaData */
  async?: boolean; slaDueDate?: string; asyncRetries?: number; asyncRetryDelay?: string;
}
export interface EngineStart extends Base { type: 'start'; on?: EventDef; }
export interface EngineEnd extends Base { type: 'end'; result?: 'terminate'; throw?: EventDef; }
export interface EngineScript extends Base { type: 'script'; lang?: Lang; code: string; }
export interface EngineHttp extends Base { type: 'http'; method?: HttpMethod; url: string; headers?: Record<string, string>; body?: Record<string, string | number | boolean>; resultTo?: Record<string, string>;
  /** wrapper-script dialect for the generated jBPM onEntry/onExit (default 'java') */
  lang?: Lang;
  /** extra script appended to the onExit wrapper (same dialect); also honored by the Node engine after resultTo, with `resPayload` in scope */
  exitScript?: string; }
export interface EngineCall extends Base, WithLifecycle { type: 'call'; process: string; inputs?: Record<string, string>; outputs?: Record<string, string>; }
export interface EngineForEach extends Base, WithLifecycle { type: 'forEach'; process: string; over: string; as?: string; collectInto?: string; itemResult?: string; parallel?: boolean; pass?: string[]; }
export interface EngineUserTask extends Base, WithLifecycle {
  type: 'userTask'; group?: string; assignee?: string; form?: string; skippable?: boolean;
  businessAdmin?: string; excludedOwners?: string[]; priority?: number;
  /** ISO duration/date/cycle (same shape as TimerSpec) or a plain ISO duration string, e.g. "PT8H". */
  dueDate?: TimerSpec | string;
}
export interface EngineRule extends Base, WithLifecycle { type: 'rule'; ruleflowGroup?: string; dmn?: { namespace: string; model: string; decision: string }; }
export interface EngineSend extends Base, WithLifecycle {
  type: 'send'; message: string; implementation?: string;
  /** $var reference — see EventDef.correlationKey's doc comment (same semantics, throw-side field). */
  correlationKey?: string;
}
export interface EngineReceive extends Base, WithLifecycle { type: 'receive'; message: string; implementation?: string; }
export interface EngineManual extends Base, WithLifecycle { type: 'manual'; }
export interface EngineGateway extends Base { type: 'gateway'; mode: GatewayMode; default?: string; direction?: 'Diverging' | 'Converging'; }
export interface EngineCatch extends Base { type: 'catch'; event: EventDef; }
export interface EngineThrow extends Base { type: 'throw'; event: EventDef; }
// on: host node id, a list of host ids, or '*' (all activities = process-wide error handler).
// On export a multi/global error-catch expands to one BPMN boundary event per host activity.
export interface EngineBoundary extends Base { type: 'boundary'; on: string | string[]; event: EventDef; interrupting?: boolean; }
export interface EngineSubprocess extends Base, WithLifecycle { type: 'subprocess'; transaction?: boolean; on?: { error?: string }; nodes: EngineNode[]; flows: EngineFlow[]; }
export interface EngineRaw extends Base { type: 'raw'; raw?: string; }
// generic custom WorkItemHandler task (jBPM's <bpmn2:task drools:taskName="X">, e.g. its built-in
// "Rest" REST work item, or any customer WorkItemHandler) — matches the Node engine's own `workItem`
// node contract 1:1 (see jbpm-engine/server/src/engine/nodes/work-item/handler.ts).
export interface EngineWorkItem extends Base, WithLifecycle { type: 'workItem'; handler: string; params?: Record<string, string | number | boolean>; resultTo?: Record<string, string>; }
export type EngineNode =
  | EngineStart | EngineEnd | EngineScript | EngineHttp | EngineCall | EngineForEach | EngineUserTask
  | EngineRule | EngineSend | EngineReceive | EngineManual | EngineGateway | EngineCatch | EngineThrow
  | EngineBoundary | EngineSubprocess | EngineWorkItem | EngineRaw;
export interface EngineProcess {
  id: string; name?: string; package?: string;
  /** process-level properties (jBPM version / ad-hoc / SLA due date / instance description template) */
  version?: string; adHoc?: boolean; slaDueDate?: string; description?: string;
  types?: EngineType[]; vars?: EngineVar[];
  lanes?: { id?: string; name?: string; nodes: string[] }[];
  data?: { id?: string; name?: string; type?: string; collection?: boolean }[];
  /** error declarations: a bare string (id = code), or { name, code } when the BPMN error id differs from its errorCode */
  signals?: string[]; errors?: Array<string | { name: string; code: string }>; messages?: string[]; escalations?: string[];
  nodes: EngineNode[]; flows: EngineFlow[];
}
export interface EngineDeployment { runtime?: string; env?: Record<string, string>; handlers?: string[]; }

// ---- Engine-native rules (simple; the SDK synthesizes all the Drools/jBPM detail) ----
// You write facts by NAME, conditions as field/op/value, actions as set/insert/delete/call.
// No package, no Java FQNs, no `modify($c)`, no `ruleflow-group` — fromEngineProject fills those in:
// fact names -> imported FQNs (via the project type registry), `group` -> ruleflow-group + .drl path.
export type CondOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn'
  | 'contains' | 'notContains' | 'matches' | 'memberOf';
export type CondValue = string | number | boolean | Array<string | number | boolean>;
export interface CondRef { ref: string; }   // reference a bound fact/field: "claim.id" -> $claim.id
// A field condition: a bare literal (== ), a bare array (in), a {ref} (== a bound var), or {op: value|ref|array}.
export type WhereSpec = CondValue | CondRef | Partial<Record<CondOp, CondValue | CondRef>>;
export interface EngineWhen {
  fact: string;                 // simple type name (resolved to an FQN + import by the SDK)
  as?: string;                  // binding name WITHOUT '$'; reference it in `then` (SDK emits `$name`)
  where?: Record<string, WhereSpec>;   // field -> literal (eq) | array (in) | {ref} | {op: value|ref}
  exists?: boolean;             // false = fact must NOT exist; true = must exist (unbound); omit = normal match
  not?: boolean;                // alias of `exists: false`
}
export type EngineThen =
  | { set: string; fields: Record<string, string | number | boolean> }       // update a matched fact's fields
  | { insert: string; fields?: Record<string, string | number | boolean> }   // create+insert a new fact (by name)
  | { delete: string }                                                        // remove a matched fact
  | { call: string; args?: Array<string | number | boolean> };               // invoke a helper/global
export interface EngineRuleDef { name: string; priority?: number; noLoop?: boolean; when: EngineWhen[]; then: EngineThen[]; }
export interface EngineRuleset { group: string; package?: string; path?: string; rules: EngineRuleDef[]; }

// ---- Engine-native decisions (DMN decision tables; the SDK synthesizes the DMN 1.2 XML) ----
// You author a table: inputs, outputs, and rules (when: per-input test, then: per-output result).
// No FEEL syntax, no DMN XML, no namespaces — decisionToDmn / fromEngineProject fill those in.
export type FeelType = 'number' | 'string' | 'boolean' | 'date' | 'time' | 'dateTime' | 'any';
export type HitPolicy = 'UNIQUE' | 'FIRST' | 'ANY' | 'PRIORITY' | 'COLLECT' | 'RULE ORDER' | 'OUTPUT ORDER';
export type Aggregation = 'SUM' | 'MIN' | 'MAX' | 'COUNT';
export interface DecisionField { name: string; type?: FeelType; }
// one cell test in a rule's `when` (compiled to a FEEL unary test)
export type InputTest =
  | string | number | boolean                                   // equals a literal ("-" = any)
  | Array<string | number | boolean>                            // in-list (disjunction)
  | { gt: number | string } | { gte: number | string } | { lt: number | string } | { lte: number | string }
  | { between: [number | string, number | string] }            // inclusive range [a..b]
  | { in: Array<string | number | boolean> }
  | { not: string | number | boolean | Array<string | number | boolean> }
  | { any: true }                                               // matches anything (FEEL `-`)
  | { feel: string };                                           // raw FEEL escape hatch
export type OutputResult = string | number | boolean | { feel: string };
export interface DecisionRule { when: Record<string, InputTest>; then: Record<string, OutputResult>; }
export interface EngineDecision {
  name: string; hitPolicy?: HitPolicy; aggregation?: Aggregation;   // aggregation only with hitPolicy COLLECT
  inputs: DecisionField[]; outputs: DecisionField[]; rules: DecisionRule[];
}
export interface EngineDecisionModel { name: string; namespace?: string; path?: string; decisions: EngineDecision[]; }

// ---- Engine-native guided decision table (Business Central .gdst; compiles to DRL) ----
// A TABULAR ruleset over one fact: condition columns (fact.field <op>), action columns (set fact.field),
// and rows supplying the per-row values. The SDK synthesizes the decision-table52 XML.
export type GdstOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
export interface GdstCondition { field: string; op: GdstOp; type?: FeelType; }
export interface GdstAction { field: string; type?: FeelType; }
export interface GdstRow { when: Record<string, string | number | boolean>; then: Record<string, string | number | boolean>; }
export interface EngineGuidedTable {
  name: string; package?: string; path?: string;
  fact: string; bind?: string;              // the fact type the table operates on (+ optional binding)
  conditions: GdstCondition[]; actions: GdstAction[]; rows: GdstRow[];
}

// ---- Engine-native guided rule (Business Central .rdrl; ONE rule authored like a DRL ruleset rule) ----
// `when`/`then` are the exact DRL-ruleset shapes (EngineWhen/EngineThen), executed by the same rule engine.
export interface EngineGuidedRule {
  name: string; package?: string; path?: string; priority?: number; noLoop?: boolean;
  when: EngineWhen[]; then: EngineThen[];
}

// ---- Engine-native guided rule template (Business Central .template; a rule skeleton + a data grid) ----
// `when`/`then` values may be "{param}" placeholders; each `rows` entry fills them -> one rule per row.
export interface EngineGuidedRuleTemplate {
  name: string; package?: string; path?: string; priority?: number; noLoop?: boolean;
  when: EngineWhen[]; then: EngineThen[]; rows: Record<string, string | number | boolean>[];
}

// ---- Engine-native score card (Business Central .scgd; additive scoring; compiles to DRL) ----
// baseline + Σ (first matching band's points, per characteristic) -> the `score` field.
// A band's `when` is the same condition grammar as DRL `where`: bare literal (eq), {op:value}, {between}.
export type ScoreMatch = string | number | boolean | { between: [number, number] } | Partial<Record<GdstOp, string | number | boolean>>;
export interface ScoreBand { when?: ScoreMatch; points: number; }   // no `when` = catch-all
export interface ScoreCharacteristic { field: string; bands: ScoreBand[]; }
export interface EngineScorecard {
  name: string; package?: string; path?: string;
  fact: string; score: string; baseline?: number; characteristics: ScoreCharacteristic[];
}

// ---- Engine-native test scenario (Business Central .scesim; JUnit-for-rules/decisions) ----
// Each case pins `given` inputs and asserts `expect` outputs for the `target` decision/ruleset. The
// cases run directly in Node (against the reference evaluators) AND generate the jBPM .scesim.
export interface TestCase { name?: string; given: Record<string, string | number | boolean>; expect: Record<string, string | number | boolean>; }
export interface EngineTestSuite { name: string; path?: string; target: string; cases: TestCase[]; }

// ---- Engine-native guided decision tree (Business Central .gdt; compiles to DRL) ----
// A recursive tree over ONE fact: each node tests a `field`; each branch (op + value) leads to either
// action leaves (set fields) or a nested node. First matching branch per node wins.
export interface GdtAction { set: string; value: string | number | boolean; }
export interface GdtBranch { op: GdstOp; value: string | number | boolean; then: GdtNode | GdtAction[]; }
export interface GdtNode { field: string; branches: GdtBranch[]; }
export interface EngineDecisionTree { name: string; package?: string; path?: string; fact: string; root: GdtNode; }

// ---- Engine-native form (user-task UI; the SDK synthesizes the Business Central .frm) ----
// A form edits a data object: `type` names it, `fields` bind to its fields, and the widget is derived
// from each field's type (override per field with `widget`).
export type FormWidget = 'text' | 'textarea' | 'integer' | 'number' | 'decimal' | 'checkbox' | 'boolean' | 'dropdown' | 'select' | 'radio' | 'date';
export interface FormField { bind: string; label?: string; widget?: FormWidget; required?: boolean; readOnly?: boolean; placeholder?: string; }
export interface EngineForm { name: string; type?: string; path?: string; fields: FormField[]; }

// ---- Engine-native enumeration (allowed values per data-object field -> .enumeration) ----
export interface EngineEnum { type: string; field: string; values: string[]; }

export interface EngineProject {
  id?: string; gav?: Gav; deployment?: EngineDeployment; types?: EngineType[];
  assets?: Record<string, { kind: string; model: any } | string>;
  /** non-BPM binary files (icons, PDFs, decision-table spreadsheets, …), base64-encoded, path -> content */
  binaryAssets?: Record<string, string>;
  rulesets?: EngineRuleset[];   // simple engine rules -> generated .drl (SDK fills package/imports/DRL syntax)
  decisions?: EngineDecisionModel[];  // simple decision tables -> generated .dmn (SDK fills FEEL + DMN XML)
  guidedTables?: EngineGuidedTable[]; // tabular rulesets -> generated .gdst (Business Central editor XML)
  guidedRules?: EngineGuidedRule[];   // single rules -> generated .rdrl (Business Central editor XML)
  guidedRuleTemplates?: EngineGuidedRuleTemplate[]; // rule templates + rows -> generated .template
  scorecards?: EngineScorecard[];     // additive scoring models -> generated .scgd
  tests?: EngineTestSuite[];          // given/expect cases -> generated .scesim (and runnable in Node)
  decisionTrees?: EngineDecisionTree[]; // decision trees -> generated .gdt (Business Central editor XML)
  forms?: EngineForm[];         // user-task forms -> generated .frm (widget derived from field types)
  enumerations?: EngineEnum[];  // allowed values per field -> generated .enumeration (dropdown options)
  workItems?: WorkItemDefinition[];             // custom service-task types -> global/WorkDefinitions.wid
  dsl?: DslEntry[];             // domain language mappings -> generated .dsl (rule readability)
  messages?: Record<string, Record<string, string>>;   // i18n: locale -> key/value -> messages[_<locale>].properties
  processes: EngineProcess[];
}

const PRIM: Record<string, string> = {
  string: 'String', int: 'Integer', integer: 'Integer', long: 'java.lang.Long',
  double: 'java.lang.Double', float: 'java.lang.Double', number: 'java.lang.Double',
  bool: 'java.lang.Boolean', boolean: 'java.lang.Boolean', object: 'java.lang.Object',
  list: 'java.util.List', array: 'java.util.List', map: 'java.util.Map', date: 'java.util.Date',
};
const LANG_URI: Record<string, string> = {
  js: 'http://www.javascript.com/javascript', java: 'http://www.java.com/java', mvel: 'http://www.mvel.org/2.0',
};
const HANDLER_ID: Record<string, string> = {
  Rest: 'new org.jbpm.process.workitem.rest.RESTWorkItemHandler(classLoader)',
  WebService: 'new org.jbpm.process.workitem.webservice.WebServiceWorkItemHandler(ksession)',
  Email: 'new org.jbpm.process.workitem.email.EmailWorkItemHandler()',
  Log: 'new org.jbpm.process.instance.impl.demo.SystemOutWorkItemHandler()',
};
// jBPM's standard built-in work items — the SDK includes these definitions + registers their handlers
// automatically, so you never author them (declare only CUSTOM work items via EngineProject.workItems).
export const DEFAULT_WORK_ITEMS: WorkItemDefinition[] = [
  { name: 'Rest', displayName: 'REST', category: 'Communication', icon: 'defaultresticon.png',
    defaultHandler: 'mvel: new org.jbpm.process.workitem.rest.RESTWorkItemHandler(classLoader)',
    parameters: { Url: 'String', Method: 'String', ContentType: 'String', ContentData: 'String', ConnectTimeout: 'String', ReadTimeout: 'String', Username: 'String', Password: 'String' },
    results: { Result: 'Object', Status: 'Integer' } },
  { name: 'Email', displayName: 'Email', category: 'Communication', icon: 'defaultemailicon.png',
    defaultHandler: 'mvel: new org.jbpm.process.workitem.email.EmailWorkItemHandler()',
    parameters: { From: 'String', To: 'String', Subject: 'String', Body: 'String', Cc: 'String', Bcc: 'String' }, results: {} },
  { name: 'WebService', displayName: 'WS', category: 'Communication', icon: 'defaultservicenodeicon.png',
    defaultHandler: 'mvel: new org.jbpm.process.workitem.webservice.WebServiceWorkItemHandler(ksession)',
    parameters: { Endpoint: 'String', Namespace: 'String', Interface: 'String', Operation: 'String', Parameter: 'Object', Mode: 'String' }, results: { Result: 'Object' } },
  { name: 'Log', displayName: 'Log', category: 'Log', icon: 'defaultlogicon.png',
    defaultHandler: 'mvel: new org.jbpm.process.instance.impl.demo.SystemOutWorkItemHandler()',
    parameters: { Message: 'String' }, results: {} },
];
const fqn = (t: EngineType) => (t.package ? t.package + '.' : '') + t.name;

/** name -> Java FQN. Primitives map to boxed jBPM structureRefs; declared type names -> FQN. */
export function makeTypeResolver(types: EngineType[] = []): (type: string) => string {
  const idx: Record<string, EngineType> = {};
  for (const t of types) idx[t.name] = t;
  return (type: string): string => {
    if (!type) return 'java.lang.Object';
    const p = PRIM[type.toLowerCase()]; if (p) return p;
    if (idx[type]) return fqn(idx[type]);
    return type; // already an FQN or unknown -> passthrough
  };
}
// Java field type (unboxed where natural) for generated POJOs
function javaFieldType(type: string, resolve: (t: string) => string): string {
  const t = type.toLowerCase();
  const map: Record<string, string> = { string: 'String', int: 'int', integer: 'int', long: 'long', double: 'double', float: 'double', number: 'double', bool: 'boolean', boolean: 'boolean', date: 'java.util.Date', list: 'java.util.List', array: 'java.util.List', map: 'java.util.Map', object: 'Object' };
  return map[t] || resolve(type);
}
// boxed element type for generics (Java can't hold primitives in List<...>)
function boxedType(type: string, resolve: (t: string) => string): string {
  const box: Record<string, string> = { string: 'String', int: 'Integer', integer: 'Integer', long: 'Long', double: 'Double', float: 'Double', number: 'Double', bool: 'Boolean', boolean: 'Boolean', date: 'java.util.Date', object: 'Object' };
  return box[type.toLowerCase()] || resolve(type);
}
// full POJO field type honouring `list` (typed collection)
function fieldJavaType(f: EngineTypeField, resolve: (t: string) => string): string {
  return f.list ? `java.util.List<${boxedType(f.type, resolve)}>` : javaFieldType(f.type, resolve);
}

const langUri = (l?: Lang) => LANG_URI[l || 'java'] || LANG_URI.java;
const jstr = (v: any) => JSON.stringify(String(v)); // Java string literal
const isWordUsed = (code: string, name: string) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(code);

// ---- export-time compatibility preambles (see jbpm-engine/docs/15-scripting-and-jbpm-export.md) ----
// The Node engine offers two additive conveniences beyond what real jBPM natively understands: a
// `vars.x` object (any dialect) and, for Java SCRIPTS specifically (never conditions — those already
// get bare-name binding from real jBPM's own compiler), bare variable names. Both round-trip to
// jBPM XML that runs unmodified on a real jBPM/KIE server ONLY because this prepends a small,
// generated preamble that defines the same names in terms of real kcontext — the exported text is
// then plain, valid Java/JS with no dependency on this engine at all.

/** Real jBPM's JS runtime has no `vars` concept. Plain ES5 (`Object.defineProperty`, no `Proxy` —
 *  Nashorn doesn't implement it, and the target engine isn't known at export time) so this preamble
 *  runs correctly on either real jBPM JS runtime. A no-op if `vars` isn't referenced, or there are no
 *  declared process variables to bind (only DECLARED variables round-trip this way — see the doc
 *  above for that documented limitation). */
function jsVarsPreamble(code: string, varNames: string[]): string {
  if (!/\bvars\s*[.[]/.test(code) || varNames.length === 0) return '';
  let out = 'var vars = {};\n';
  for (const name of varNames) {
    const lit = jstr(name);
    out += `Object.defineProperty(vars, ${lit}, { enumerable: true, get: function(){ return kcontext.getVariable(${lit}); }, set: function(v){ kcontext.setVariable(${lit}, v); } });\n`;
  }
  return out;
}

/** Real jBPM's Java SCRIPT dialect (script task / onEntry / onExit) has no bare-name binding — only
 *  `kcontext.getVariable(...)` is in scope there. If this engine's own additive bare-name convenience
 *  was used authoring a script, prepend the equivalent typed local declaration for each declared
 *  variable actually referenced (a bare-word scan — cheap, and the worst case of a false positive is
 *  one unused extra local, which javac doesn't error on) so the exported text is plain, valid,
 *  kcontext-based Java that runs unmodified on real jBPM. `varType` values are already-resolved Java
 *  type strings (see `makeTypeResolver` above), matching what real jBPM's own generated code would
 *  declare for that variable's structureRef. */
function javaBareNamePreamble(code: string, varType: Record<string, string>): string {
  let out = '';
  for (const [name, type] of Object.entries(varType)) {
    if (!isWordUsed(code, name)) continue;
    out += `${type} ${name} = (${type}) kcontext.getVariable(${jstr(name)});\n`;
  }
  return out;
}

// A THIRD engine convenience, beyond `vars`/bare-name: `instance`/`node` (JS) and a handful of
// meta-locals (Java) as a simpler alternative to `kcontext.getProcessInstance().getX()` chains — see
// jbpm-engine/server/src/engine/sandbox.ts's buildInstanceGlobal/buildNodeGlobal (JS) and
// java-runtime/src/bpmscript/ScriptRunner.java's META_LOCALS (Java) for the execution-side twins this
// must stay textually consistent with. Like `vars`/bare-name, a no-op unless actually referenced.

/** Real jBPM's JS runtime has no `instance`/`node` concept either. Same ES5-only constraint as
 *  jsVarsPreamble (no arrow functions/Proxy — Nashorn support unknown at export time). `instance.
 *  state` intentionally re-derives this engine's OWN status vocabulary from the real STATE_* int
 *  (see sandbox.ts's stateFor for the forward mapping this reverses) — note this is lossy in one
 *  direction already accepted for that field: real jBPM's ACTIVE state doesn't distinguish "running"
 *  from "blocked at a node", so it always reads back as "running" (check `instance.activeNodes.
 *  length` if you need to know whether it's actually blocked). `instance.activeNodes` iterates the
 *  real `java.util.List` returned by getNodeInstances() via `.size()`/`.get(i)`, not `for...of` —
 *  works identically on Nashorn and GraalVM, unlike list/array duck-typing which isn't guaranteed. */
function jsInstanceNodePreamble(code: string): string {
  let out = '';
  if (isWordUsed(code, 'instance')) {
    out += 'var instance = {\n'
      + '  id: kcontext.getProcessInstance().getId(),\n'
      + '  processId: kcontext.getProcessInstance().getProcessId(),\n'
      + '  processName: kcontext.getProcessInstance().getProcessName(),\n'
      + '  correlationKey: kcontext.getProcessInstance().getCorrelationKey(),\n'
      + '  parentId: kcontext.getProcessInstance().getParentProcessInstanceId(),\n'
      + '  state: (function(s){ return s===0?"pending":s===2?"completed":s===3?"aborted":s===4?"suspended":"running"; })(kcontext.getProcessInstance().getState()),\n'
      + '  variables: kcontext.getProcessInstance().getVariables(),\n'
      + '  activeNodes: (function(){ var list = kcontext.getProcessInstance().getNodeInstances(); var out = []; for (var i = 0; i < list.size(); i++) { var ni = list.get(i); out.push({ id: ni.getId(), nodeId: ni.getNodeId(), name: ni.getNodeName() }); } return out; })(),\n'
      + '  signal: function(type, payload){ kcontext.getKieRuntime().signalEvent(type, payload, kcontext.getProcessInstance().getId()); },\n'
      + '  signalOther: function(targetId, type, payload){ kcontext.getKieRuntime().signalEvent(type, payload, targetId); },\n'
      + '  broadcast: function(type, payload){ kcontext.getKieRuntime().signalEvent(type, payload); },\n'
      + '  abort: function(){ kcontext.getKieRuntime().abortProcessInstance(kcontext.getProcessInstance().getId()); },\n'
      + '  abortOther: function(targetId){ kcontext.getKieRuntime().abortProcessInstance(targetId); }\n'
      + '};\n';
  }
  if (isWordUsed(code, 'node')) {
    out += 'var node = { id: kcontext.getNodeInstance().getId(), nodeId: kcontext.getNodeInstance().getNodeId(), name: kcontext.getNodeInstance().getNodeName() };\n';
  }
  return out;
}

/** Java twin of jsInstanceNodePreamble — flat String locals, not an object (Java has no object-literal
 *  syntax), matching ScriptRunner.java's META_LOCALS exactly (name + expression, both lists must stay
 *  in sync). Unlike `javaBareNamePreamble`, no `state`/`activeNodes` equivalent — a Java author
 *  targeting jBPM export already needs `kcontext.getProcessInstance().getState()`/`.getNodeInstances()`
 *  directly for those (real jBPM's own STATE_* int / List<NodeInstance>, not a reinterpretation). */
const JAVA_META_LOCALS: Array<[string, string]> = [
  ['instanceId', 'String.valueOf(kcontext.getProcessInstance().getId())'],
  ['processId', 'kcontext.getProcessInstance().getProcessId()'],
  ['processName', 'kcontext.getProcessInstance().getProcessName()'],
  ['correlationKey', 'kcontext.getProcessInstance().getCorrelationKey()'],
  ['parentInstanceId', 'kcontext.getProcessInstance().getParentProcessInstanceId()'],
  ['currentNodeId', 'kcontext.getNodeInstance().getNodeId()'],
  ['currentNodeName', 'kcontext.getNodeInstance().getNodeName()'],
];
function javaMetaLocalsPreamble(code: string, varType: Record<string, string>): string {
  let out = '';
  for (const [name, expr] of JAVA_META_LOCALS) {
    if (varType[name]) continue; // a declared process variable of the same name always wins
    if (!isWordUsed(code, name)) continue;
    out += `String ${name} = ${expr};\n`;
  }
  return out;
}

/** Java-dialect-only: composes a preamble with a flow condition's text, respecting real jBPM's own
 *  "bare boolean expression OR full body ending in an explicit return" Java condition convention (see
 *  ScriptRunner.java's conditionBody — source-verified against real jBPM). A preamble is a sequence
 *  of local declarations, so in COMPILED Java it can only precede a `return` statement, never sit
 *  inside a bare expression — if the condition text has no explicit `return` yet and a preamble needs
 *  to be added, wrap the ORIGINAL text in `return (...)` first, THEN prepend the preamble in front of
 *  that. A no-op (returns `when` untouched) if the preamble is empty, so conditions that don't
 *  reference the Java meta-locals are never rewritten. NOT used for JS conditions: real jBPM's JS
 *  condition dialect evaluates via plain script-engine `eval` (the last expression's value, no
 *  function wrapper), so forcing a `return` there would risk an "illegal return statement" on a real
 *  jBPM/Nashorn server — a preamble of declarations can simply precede the original text as-is, with
 *  or without its own `return`, exactly as authored. */
function withJavaConditionPreamble(when: string, preamble: string): string {
  if (!preamble) return when;
  const body = /\breturn\b/.test(when) ? when : `return (${when});`;
  return preamble + body;
}

function setEvent(nd: Node, ev: any): void {
  if (!ev) { nd.eventType = 'none'; return; }
  if (ev.signal) { nd.eventType = 'signal'; nd.signalName = ev.signal; }
  else if (ev.message) { nd.eventType = 'message'; nd.messageRef = ev.message; }
  else if (ev.error) { nd.eventType = 'error'; nd.errorRef = ev.error; }
  else if (ev.escalation) { nd.eventType = 'escalation'; nd.escalationRef = ev.escalation; }
  else if (ev.condition) { nd.eventType = 'conditional'; nd.conditionExpr = ev.condition; nd.conditionExprLanguage = langUri(ev.lang); }
  else if (ev.timer) { nd.eventType = 'timer'; if (ev.timer.cron) { nd.timeCycle = ev.timer.cron; nd.timeCycleLanguage = 'cron'; } else if (ev.timer.cycle) nd.timeCycle = ev.timer.cycle; else if (ev.timer.date) nd.timeDate = ev.timer.date; else nd.timeDuration = ev.timer.duration || ev.timer; }
  else nd.eventType = 'none';
}

function pathExpr(jp: string): string {
  const parts = jp.replace(/^\$\.?/, '').split('.').filter(Boolean);
  return 'root' + parts.map((p) => `.path("${p}")`).join('');
}
function accessor(structureRef: string): (e: string) => string {
  switch (structureRef) {
    case 'String': return (e) => `${e}.asText()`;
    case 'java.lang.Boolean': return (e) => `${e}.asBoolean()`;
    case 'Integer': return (e) => `${e}.asInt()`;
    case 'java.lang.Long': return (e) => `${e}.asLong()`;
    case 'java.lang.Double': return (e) => `${e}.asDouble()`;
    default: return (e) => e; // Object/List/Map -> keep the JsonNode
  }
}

/** Convert one engine process to a jBPM ProcessModel. */
export function fromEngine(ep: EngineProcess, sharedTypes: EngineType[] = []): ProcessModel {
  const resolve = makeTypeResolver([...(sharedTypes || []), ...(ep.types || [])]);
  const varType: Record<string, string> = {};
  const variables = (ep.vars || []).map((v) => { const sr = resolve(v.type); varType[v.name] = sr; return { name: v.name, type: sr, ...((v as any).tags?.length ? { tags: (v as any).tags as string[] } : {}) }; });
  const ensure = (name: string, sr: string) => { if (!variables.some((x) => x.name === name)) { variables.push({ name, type: sr }); varType[name] = sr; } };

  const sig = new Set(ep.signals || []);
  const errCode: Record<string, string> = {};
  for (const e of ep.errors || []) if (typeof e === 'object') errCode[e.name] = e.code;
  const err = new Set((ep.errors || []).map((e) => (typeof e === 'string' ? e : e.name)));
  const msg = new Set(ep.messages || []); const esc = new Set(ep.escalations || []);

  // Real jBPM's generic onEntry/onExit action hooks — same preamble treatment already applied to
  // script tasks (jsVarsPreamble/jsInstanceNodePreamble for JS, javaBareNamePreamble/
  // javaMetaLocalsPreamble for Java) so a `vars`/`instance`/`node`/meta-local reference in an
  // onEntry/onExit script still exports to plain, real-jBPM-runnable text. Declared-variable bare
  // names need no preamble here either (real jBPM's own build-time codegen auto-binds those for
  // onEntry/onExit exactly like it does for script tasks — same JavaActionBuilder mechanism).
  const lifecycle = (n: WithLifecycle): Partial<Node> => {
    const out: Partial<Node> = {};
    if (n.onEntry) {
      out.onEntry = (n.onEntryLang === 'js' ? jsVarsPreamble(n.onEntry, Object.keys(varType)) + jsInstanceNodePreamble(n.onEntry)
        : javaBareNamePreamble(n.onEntry, varType) + javaMetaLocalsPreamble(n.onEntry, varType)) + n.onEntry;
      out.onEntryFormat = langUri(n.onEntryLang);
    }
    if (n.onExit) {
      out.onExit = (n.onExitLang === 'js' ? jsVarsPreamble(n.onExit, Object.keys(varType)) + jsInstanceNodePreamble(n.onExit)
        : javaBareNamePreamble(n.onExit, varType) + javaMetaLocalsPreamble(n.onExit, varType)) + n.onExit;
      out.onExitFormat = langUri(n.onExitLang);
    }
    if (n.async) out.async = true;
    const ex = extrasOf(n as any); if (Object.keys(ex).length) out.metaData = { ...(out.metaData || {}), ...ex };
    if ((n as any).autoStart) out.autoStart = true;
    if (n.slaDueDate) out.slaDueDate = n.slaDueDate;
    if (n.asyncRetries !== undefined) (out.metaData ||= {}).asyncRetries = String(n.asyncRetries);
    if (n.asyncRetryDelay) (out.metaData ||= {}).asyncRetryDelay = n.asyncRetryDelay;
    return out;
  };
  const conv = (n: EngineNode): Node => {
    const base: Node = { id: n.id!, type: 'raw', name: n.name };
    switch (n.type) {
      case 'start': { const nd: Node = { ...base, type: 'startEvent' }; setEvent(nd, n.on); nd.subtype = nd.eventType; if (nd.signalName) sig.add(nd.signalName); if (nd.messageRef) msg.add(nd.messageRef); return nd; }
      case 'end': {
        const nd: Node = { ...base, type: 'endEvent' };
        if (n.result === 'terminate') { nd.subtype = 'terminate'; nd.eventType = 'terminate'; }
        else if ((n as any).result === 'cancel') nd.metaData = extrasOf(n as any);
        else if (n.throw) { setEvent(nd, n.throw); nd.subtype = nd.eventType === 'signal' ? 'signalThrow' : nd.eventType === 'error' ? 'errorThrow' : nd.eventType; if (nd.signalName) sig.add(nd.signalName); if (nd.errorRef) err.add(nd.errorRef); if (nd.escalationRef) esc.add(nd.escalationRef); }
        else { nd.subtype = 'none'; nd.eventType = 'none'; }
        return nd;
      }
      case 'script': {
        const code = n.code || '';
        const preamble = n.lang === 'js' ? jsVarsPreamble(code, Object.keys(varType)) + jsInstanceNodePreamble(code)
          : n.lang === 'java' ? javaBareNamePreamble(code, varType) + javaMetaLocalsPreamble(code, varType) : '';
        const { onEntry: _a, onExit: _b, onEntryFormat: _c, onExitFormat: _d, ...meta } = lifecycle(n as any);   // a script task has no onEntry / onExit hooks, but keeps its async / SLA / metadata
        return { ...base, type: 'scriptTask', script: preamble + code, scriptFormat: langUri(n.lang), ...meta };
      }
      case 'http': {
        ensure('reqPayload', 'String'); ensure('resPayload', 'String'); ensure('baseUrl', 'String');
        if (n.lang === 'js') {
          // JavaScript wrapper scripts (kcontext API is the same; JSON via native JS)
          const entryJs = 'var json = {};\n'
            + 'json.piid = String(kcontext.getProcessInstance().getId());\n'
            + Object.entries(n.body || {}).map(([k, v]) =>
              (typeof v === 'string' && v.startsWith('$')) ? `json[${jstr(k)}] = kcontext.getVariable(${jstr(v.slice(1))});\n`
                : `json[${jstr(k)}] = ${typeof v === 'number' || typeof v === 'boolean' ? v : jstr(v)};\n`).join('')
            + 'kcontext.setVariable("reqPayload", JSON.stringify(json));';
          const setsJs = Object.entries(n.resultTo || {}).map(([vn, jp]) => {
            const path = String(jp).replace(/^\$\.?/, '');
            const acc = path === '' || path === '$' ? 'root' : 'root' + path.split('.').map((p) => `[${jstr(p)}]`).join('');
            return `    if (root != null) kcontext.setVariable(${jstr(vn)}, ${acc});\n`;
          }).join('');
          const exitJs = 'var response = kcontext.getVariable("resPayload");\n'
            + 'if (response != null && String(response) !== "") { try {\n'
            + '  var root = JSON.parse(String(response));\n'
            + setsJs + '} catch(e) {} }'
            + (n.exitScript ? '\n' + jsVarsPreamble(n.exitScript, Object.keys(varType)) + jsInstanceNodePreamble(n.exitScript) + n.exitScript : '');
          return { ...base, type: 'callActivity', subtype: 'rest', url: n.url, method: n.method || 'POST',
            onEntry: entryJs, onExit: exitJs, onEntryFormat: LANG_URI.js, onExitFormat: LANG_URI.js };
        }
        const entry = 'com.fasterxml.jackson.databind.node.ObjectNode json = new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode();\n'
          + 'json.put("piid", String.valueOf(kcontext.getProcessInstance().getId()));\n'
          + Object.entries(n.body || {}).map(([k, v]) =>
            (typeof v === 'string' && v.startsWith('$')) ? `json.putPOJO("${k}", kcontext.getVariable("${v.slice(1)}"));\n`
              : `json.put("${k}", ${typeof v === 'number' || typeof v === 'boolean' ? v : jstr(v)});\n`).join('')
          + 'kcontext.setVariable("reqPayload", json.toString());';
        const sets = Object.entries(n.resultTo || {}).map(([vn, jp]) => `    kcontext.setVariable("${vn}", ${accessor(varType[vn] || 'java.lang.Object')(pathExpr(jp as string))});\n`).join('');
        const exit = 'String response = (String) kcontext.getVariable("resPayload");\n'
          + 'if (response != null && !response.isEmpty()) { try {\n'
          + '  com.fasterxml.jackson.databind.JsonNode root = new com.fasterxml.jackson.databind.ObjectMapper().readTree(response);\n'
          + sets + '} catch(Exception e) {} }'
          + (n.exitScript ? '\n' + javaBareNamePreamble(n.exitScript, varType) + javaMetaLocalsPreamble(n.exitScript, varType) + n.exitScript : '');
        return { ...base, type: 'callActivity', subtype: 'rest', url: n.url, method: n.method || 'POST', onEntry: entry, onExit: exit };
      }
      case 'call': return { ...base, type: 'callActivity', subtype: 'reusable', calledElement: n.process, ...((n as any).onChildFailure === 'abort' ? { abortParent: true } : {}),
        dataInputs: Object.entries(n.inputs || {}).map(([k, v]) => ({ name: k, value: String(v).replace(/^\$/, '') })),
        dataOutputs: Object.entries(n.outputs || {}).map(([k, v]) => ({ name: k, to: String(v) })), ...lifecycle(n) };
      case 'forEach': return { ...base, type: 'callActivity', subtype: 'multiInstance', calledElement: n.process,
        multiInstance: { isSequential: n.parallel === false, collectionIn: n.over, collectionOut: n.collectInto || `${n.over}Results`, itemVar: n.as || 'item', itemOutVar: n.itemResult || 'itemResult', passthru: n.pass || [], ...((n as any).completionCondition ? { completionCondition: (n as any).completionCondition } : {}) }, ...lifecycle(n) };
      case 'userTask': {
        const u = n as any; const list = (v: unknown) => (Array.isArray(v) ? v.join(',') : String(v ?? ''));
        const ti: Record<string, string> = {};
        if (u.actors?.length) ti.ActorId = list(u.actors);
        if (u.businessAdmin) ti.BusinessAdministratorId = String(u.businessAdmin);
        if (u.businessAdminGroups?.length) ti.BusinessAdministratorGroupId = list(u.businessAdminGroups);
        if (u.stakeholders?.length) ti.TaskStakeholderId = list(u.stakeholders);
        if (u.excludedOwners?.length) ti.ExcludedOwnerId = list(u.excludedOwners);
        for (const [k, name] of [['comment', 'Comment'], ['content', 'Content'], ['locale', 'Locale'], ['createdBy', 'CreatedBy'], ['suspendUntil', 'suspendUntil'], ['description', 'Description'],
          ['notStartedReassign', 'NotStartedReassign'], ['notCompletedReassign', 'NotCompletedReassign'], ['notStartedNotify', 'NotStartedNotify'], ['notCompletedNotify', 'NotCompletedNotify']] as const) if (u[k]) ti[name] = String(u[k]);
        if (u.priority !== undefined) ti.Priority = String(u.priority);
        const groups = [u.group || u.assignee, ...(Array.isArray(u.groups) ? u.groups : [])].filter(Boolean).join(',');
        return { ...base, type: 'userTask', taskName: n.form || n.name, group: groups || undefined, skippable: n.skippable !== false, ...(Object.keys(ti).length ? { taskInputs: ti } : {}), ...lifecycle(n) };
      }
      case 'rule': return { ...base, type: 'businessRuleTask', ruleFlowGroup: n.ruleflowGroup, implementation: n.dmn ? 'http://www.jboss.org/drools/dmn' : '##unspecified', ...lifecycle(n) };
      case 'send': { if (n.message) msg.add(n.message); return { ...base, type: 'sendTask', messageRef: n.message, implementation: n.implementation || '##WebService', ...lifecycle(n) }; }
      case 'receive': { if (n.message) msg.add(n.message); return { ...base, type: 'receiveTask', messageRef: n.message, implementation: n.implementation || 'Other', ...lifecycle(n) }; }
      case 'manual': return { ...base, type: 'manualTask', ...lifecycle(n) };
      case 'workItem': {
        const workParams: Record<string, string> = {};
        for (const [k, v] of Object.entries(n.params || {})) workParams[k] = typeof v === 'string' && v.startsWith('$') ? v : String(v);
        return { ...base, type: 'genericTask', handlerName: n.handler, workParams, workResultTo: n.resultTo || {}, ...lifecycle(n) };
      }
      case 'gateway': { const map: Record<string, Node['type']> = { exclusive: 'exclusiveGateway', parallel: 'parallelGateway', inclusive: 'inclusiveGateway', event: 'eventBasedGateway', complex: 'complexGateway' }; return { ...base, type: map[n.mode] || 'exclusiveGateway', gatewayDirection: n.direction || 'Diverging', default: n.default, ...((n as any).instantiate ? { instantiate: true } : {}), ...(Object.keys(extrasOf(n as any)).length ? { metaData: extrasOf(n as any) } : {}) }; }
      case 'catch': { const nd: Node = { ...base, type: 'intermediateCatchEvent' }; setEvent(nd, n.event); if (nd.signalName) sig.add(nd.signalName); if (nd.messageRef) msg.add(nd.messageRef); return nd; }
      case 'throw': { const nd: Node = { ...base, type: 'intermediateThrowEvent' }; setEvent(nd, n.event); if (nd.signalName) sig.add(nd.signalName); if (nd.messageRef) msg.add(nd.messageRef); if (nd.escalationRef) esc.add(nd.escalationRef); return nd; }
      case 'boundary': { const host = Array.isArray(n.on) ? (n.on.find((h) => h !== '*') ?? n.on[0]) : n.on; const nd: Node = { ...base, type: 'boundaryEvent', attachedTo: host, cancelActivity: n.interrupting !== false }; setEvent(nd, n.event); if (nd.errorRef) err.add(nd.errorRef); if (nd.signalName) sig.add(nd.signalName); if (nd.messageRef) msg.add(nd.messageRef); if (nd.escalationRef) esc.add(nd.escalationRef); return nd; }
      case 'subprocess': {
        const nd: Node = { ...base, type: 'subProcess', subtype: n.transaction ? 'transaction' : (n.on ? 'event' : 'embedded'), ...lifecycle(n) };
        if (n.on && n.on.error) { nd.error = n.on.error; err.add(n.on.error); }
        nd.nodes = (n.nodes || []).map(conv);
        nd.flows = (n.flows || []).map(convFlow);
        return nd;
      }
      default: return { ...base, type: 'raw', bpmnLocal: n.type, raw: n.raw || `<!-- ${n.type} -->` };
    }
  };
  // Declared-var bare-name binding needs NO preamble here — real jBPM's own build-time codegen
  // (JavaActionBuilder/JavaReturnValueEvaluatorBuilder) ALREADY auto-binds every declared process
  // variable as a bare identifier for conditions, in both dialects. Only THIS engine's own additive
  // names (`vars`/`instance`/`node`/the Java meta-locals — none of which real jBPM's codegen knows
  // about) need a preamble injected here, and only if the condition text actually references one.
  const convFlow = (f: EngineFlow): Flow => {
    if (!f.when) return { id: f.id || `${f.from}__${f.to}`, sourceRef: f.from, targetRef: f.to };
    // JS: a preamble of declarations can simply precede the original text unchanged (see
    // withJavaConditionPreamble's doc for why this differs from the Java branch below).
    const condition = f.lang === 'js' ? (jsVarsPreamble(f.when, Object.keys(varType)) + jsInstanceNodePreamble(f.when)) + f.when
      : f.lang === 'java' ? withJavaConditionPreamble(f.when, javaMetaLocalsPreamble(f.when, varType))
      : f.when;
    return { id: f.id || `${f.from}__${f.to}`, sourceRef: f.from, targetRef: f.to, condition, conditionLanguage: langUri(f.lang) };
  };

  const nodes = ep.nodes.map(conv);
  const flows = ep.flows.map(convFlow);

  // Expand a multi-host / global (*) error-catch into one BPMN boundary event per host activity
  // (BPMN boundaries attach to a single activity). Each clone shares the catch's outgoing (recovery) flow.
  const ACTIVITY = new Set<Node['type']>(['scriptTask', 'userTask', 'businessRuleTask', 'sendTask', 'receiveTask', 'manualTask', 'callActivity', 'subProcess', 'genericTask']);
  const activityIds = () => nodes.filter((x) => ACTIVITY.has(x.type)).map((x) => x.id);
  for (const en of ep.nodes) {
    if (en.type !== 'boundary') continue;
    const on = (en as EngineBoundary).on;
    const list = Array.isArray(on) ? on : [on];
    const isGlobal = list.includes('*');
    const outFlows = flows.filter((f) => f.sourceRef === en.id);
    const recovery = new Set(outFlows.map((f) => f.targetRef));   // don't attach a global catch to its own recovery path
    const hosts = (isGlobal ? activityIds().filter((id) => !recovery.has(id)) : list.filter((h) => h && h !== '*')) as string[];
    if (hosts.length === 0 || (!isGlobal && hosts.length <= 1)) continue;
    const orig = nodes.find((x) => x.id === en.id!)!;
    orig.attachedTo = hosts[0];
    for (let i = 1; i < hosts.length; i++) {
      const cloneId = `${en.id}_${i}`;
      nodes.push({ ...orig, id: cloneId, attachedTo: hosts[i] });
      for (const f of outFlows) flows.push({ ...f, id: `${f.id}_${i}`, sourceRef: cloneId });
    }
  }

  const model: ProcessModel = {
    id: ep.id, name: ep.name || ep.id, packageName: ep.package || 'org.jbpm', processType: 'Public', isExecutable: true,
    ...(ep.version ? { version: ep.version } : {}), ...(ep.adHoc ? { adHoc: true } : {}), ...(ep.slaDueDate ? { slaDueDate: ep.slaDueDate } : {}), ...(ep.description ? { description: ep.description } : {}),
    declarations: {
      signals: [...sig].map((n) => ({ id: `_sig_${n}`, name: n })),
      errors: [...err].map((n) => ({ id: n, errorCode: errCode[n] ?? n })),
      messages: [...msg].map((n) => ({ id: n, name: n })),
      escalations: [...esc].map((n) => ({ id: n, escalationCode: n, name: n })),
    },
    variables,
    dataObjects: (ep.data || []).map((d, i) => ({ id: d.id || d.name || `data${i}`, name: d.name, type: d.type ? resolve(d.type) : undefined, isCollection: d.collection })),
    lanes: (ep.lanes || []).map((l, i) => ({ id: l.id || `lane${i}`, name: l.name, flowNodeRefs: l.nodes })),
    nodes, flows,
  };
  return autowire(model);
}

// friendly condition op -> DRL operator
const COND_OP: Record<CondOp, ConstraintOp> = {
  eq: '==', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=',
  in: 'in', notIn: 'not in', contains: 'contains', notContains: 'not contains',
  matches: 'matches', memberOf: 'memberOf',
};
const isLiteral = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);
const isRef = (v: unknown): v is CondRef => !!v && typeof v === 'object' && 'ref' in (v as object);
const toDrlVar = (r: string) => '$' + r.replace(/^\$/, '');   // "claim.id" -> "$claim.id"
const capF = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// one `where` field entry -> one or more DRL constraints
function whereConstraints(field: string, spec: WhereSpec): RuleConstraint[] {
  if (isLiteral(spec)) return [{ field, op: '==', value: spec as string | number | boolean }];
  if (Array.isArray(spec)) return [{ field, op: 'in', value: spec }];
  if (isRef(spec)) return [{ field, op: '==', var: toDrlVar(spec.ref) }];
  // {op: value|ref} — possibly several ops on the same field (e.g. { gte:1, lte:10 })
  return Object.entries(spec as Record<string, CondValue | CondRef>).map(([op, val]) => {
    const drlOp = COND_OP[op as CondOp] || '==';
    if (isRef(val)) return { field, op: drlOp, var: toDrlVar(val.ref) };
    return { field, op: drlOp, value: val as CondValue };
  });
}

/**
 * Simple engine ruleset -> jBPM DrlModel. The SDK fills everything jBPM-specific: `resolve` maps fact
 * NAMES to FQNs (and those become `import`s), `pkg` is the rule package, `rs.group` becomes each rule's
 * `ruleflow-group`, and field/op/value + set/insert/delete/call become DRL patterns/actions. The engine
 * JSON stays free of packages, FQNs and Drools syntax.
 */
export function rulesToDrl(rs: EngineRuleset, resolve: (t: string) => string = (t) => t, pkg = 'org.jbpm.rules'): DrlModel {
  const facts = new Set<string>();
  const rules: DrlRule[] = rs.rules.map((r) => {
    const when: LhsElement[] = r.when.map((w) => {
      facts.add(w.fact);
      const constraints: RuleConstraint[] = Object.entries(w.where || {}).flatMap(([f, spec]) => whereConstraints(f, spec));
      const pattern: RulePattern = { fact: w.fact, ...(w.as ? { bind: '$' + w.as } : {}), constraints };
      if (w.not || w.exists === false) return { not: pattern };   // must NOT exist -> `not Fact(...)`
      if (w.exists === true) return { exists: pattern };           // must exist (unbound) -> `exists Fact(...)`
      return pattern;                                              // normal match (+ bind via `as`)
    });
    const then: RuleAction[] = r.then.map((a): RuleAction => {
      if ('set' in a) return { modify: '$' + a.set, set: a.fields };
      if ('delete' in a) return { delete: '$' + a.delete };
      if ('call' in a) return { call: a.call, args: a.args };
      // insert: create a new fact by name (imported), optionally set fields
      facts.add(a.insert);
      const simple = a.insert.split('.').pop() as string;
      if (!a.fields || !Object.keys(a.fields).length) return { insert: `new ${simple}()` };
      const v = '$' + simple.charAt(0).toLowerCase() + simple.slice(1);
      const setters = Object.entries(a.fields)
        .map(([f, val]) => `${v}.set${capF(f)}(${typeof val === 'string' ? JSON.stringify(val) : val});`).join(' ');
      return { raw: `${simple} ${v} = new ${simple}(); ${setters} insert(${v});` };
    });
    const attrs: RuleAttributes = { ruleflowGroup: rs.group };
    if (r.priority != null) attrs.salience = r.priority;   // engine "priority" -> Drools salience
    if (r.noLoop != null) attrs.noLoop = r.noLoop;
    return { name: r.name, attrs, when, then };
  });
  const imports = [...facts].map(resolve).filter((f) => f.includes('.')).sort();
  return { package: pkg, imports, globals: [], rules };
}

// engine field type -> FEEL typeRef ('' = leave untyped)
const FEEL_TYPE: Record<string, string> = {
  number: 'number', int: 'number', integer: 'number', long: 'number', double: 'number', float: 'number',
  string: 'string', bool: 'boolean', boolean: 'boolean', date: 'date', time: 'time',
  dateTime: 'date and time', datetime: 'date and time', any: '', object: '',
};
const feelType = (t?: string) => (t ? (FEEL_TYPE[t] ?? t) : '');
const feelLit = (v: string | number | boolean) => typeof v === 'string' ? `"${v}"` : String(v);
/** one engine InputTest -> a FEEL unary test (the text of a decision-table input entry). */
export function feelTest(test: InputTest): string {
  if (test === '-' || (test && typeof test === 'object' && 'any' in test)) return '-';
  if (Array.isArray(test)) return test.map(feelLit).join(', ');
  if (test === null || typeof test !== 'object') return feelLit(test as string | number | boolean);
  if ('feel' in test) return test.feel;
  if ('gt' in test) return `> ${feelLit(test.gt)}`;
  if ('gte' in test) return `>= ${feelLit(test.gte)}`;
  if ('lt' in test) return `< ${feelLit(test.lt)}`;
  if ('lte' in test) return `<= ${feelLit(test.lte)}`;
  if ('between' in test) return `[${feelLit(test.between[0])}..${feelLit(test.between[1])}]`;
  if ('in' in test) return test.in.map(feelLit).join(', ');
  if ('not' in test) return `not(${Array.isArray(test.not) ? test.not.map(feelLit).join(', ') : feelLit(test.not)})`;
  return '-';
}
/** one engine OutputResult -> a FEEL literal/expression (the text of an output entry). */
export function feelResult(r: OutputResult): string {
  if (r !== null && typeof r === 'object' && 'feel' in r) return r.feel;
  return feelLit(r as string | number | boolean);
}
const el = (name: string, attrs: Record<string, string> = {}, children: ElementNode[] = [], text = ''): ElementNode => ({ name, attrs, children, text, cdata: [] });
const clean = (s: string) => s.replace(/[^\w.-]/g, '_');

/**
 * Simple engine decision model -> a jBPM/Kogito DMN 1.2 document (as the `{ xml }` asset model).
 * Synthesizes definitions/inputData/informationRequirement/decisionTable, compiles each cell to FEEL,
 * maps types to FEEL typeRefs, and sets hitPolicy/aggregation. buildAsset({kind:'dmn', model}) serialises.
 */
export function decisionToDmn(model: EngineDecisionModel, namespace?: string): { xml: ElementNode } {
  const ns = namespace || model.namespace || `https://neutrinos/dmn/${model.name}`;
  const inputMap = new Map<string, string>();
  for (const d of model.decisions) for (const inp of d.inputs) if (!inputMap.has(inp.name)) inputMap.set(inp.name, feelType(inp.type));
  const children: ElementNode[] = [];
  for (const [name, typeRef] of inputMap) {
    children.push(el('inputData', { id: `_id_${clean(name)}`, name }, [
      el('variable', { id: `_var_${clean(name)}`, name, ...(typeRef ? { typeRef } : {}) }),
    ]));
  }
  for (const d of model.decisions) {
    const decId = `_dec_${clean(d.name)}`;
    const infoReqs = d.inputs.map((inp) => el('informationRequirement', { id: `${decId}_ir_${clean(inp.name)}` }, [
      el('requiredInput', { href: `#_id_${clean(inp.name)}` }),
    ]));
    const dt = `${decId}_dt`;
    const inputsX = d.inputs.map((inp) => el('input', { id: `${dt}_in_${clean(inp.name)}`, label: inp.name }, [
      el('inputExpression', { id: `${dt}_ie_${clean(inp.name)}`, ...(feelType(inp.type) ? { typeRef: feelType(inp.type) } : {}) }, [el('text', {}, [], inp.name)]),
    ]));
    const outputsX = d.outputs.map((o) => el('output', { id: `${dt}_out_${clean(o.name)}`, name: o.name, ...(feelType(o.type) ? { typeRef: feelType(o.type) } : {}) }));
    const rulesX = d.rules.map((r, i) => el('rule', { id: `${dt}_r${i}` }, [
      ...d.inputs.map((inp) => el('inputEntry', { id: `${dt}_r${i}_i_${clean(inp.name)}` }, [el('text', {}, [], feelTest(inp.name in r.when ? r.when[inp.name] : '-'))])),
      ...d.outputs.map((o) => el('outputEntry', { id: `${dt}_r${i}_o_${clean(o.name)}` }, [el('text', {}, [], o.name in r.then ? feelResult(r.then[o.name]) : '')])),
    ]));
    const dtAttrs: Record<string, string> = { id: dt, hitPolicy: d.hitPolicy || 'UNIQUE' };
    if (d.aggregation && d.hitPolicy === 'COLLECT') dtAttrs.aggregation = d.aggregation;
    const decVarType = d.outputs.length === 1 ? feelType(d.outputs[0].type) : '';
    children.push(el('decision', { id: decId, name: d.name }, [
      el('variable', { id: `${decId}_var`, name: d.name, ...(decVarType ? { typeRef: decVarType } : {}) }),
      ...infoReqs,
      el('decisionTable', dtAttrs, [...inputsX, ...outputsX, ...rulesX]),
    ]));
  }
  return { xml: el('definitions', { xmlns: 'http://www.omg.org/spec/DMN/20180521/MODEL/', id: `_defs_${clean(model.name)}`, name: model.name, namespace: ns }, children) };
}

// ---- DMN XML -> engine decision model (inverse of decisionToDmn, best-effort) ----
// Only decisionTable-based decisions are recoverable this way — evaluateDmn (the runtime evaluator,
// in the server's decisioning.ts) only ever understood literal/comparison decision tables to begin
// with, never full FEEL. A <decision> driven by a <literalExpression> (an "if X then Y else Z" FEEL
// conditional) or a <businessKnowledgeModel> (a Java-backed function call) — both common in real DMN
// files — has no equivalent here and is skipped rather than guessed at.
const FEEL_LIT = (s: string): string | number | boolean => {
  const t = s.trim();
  if (/^".*"$/.test(t)) return t.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t === 'true' || t === 'false') return t === 'true';
  return t;
};
/** Inverse of feelTest: a decision table input-entry's raw FEEL text -> engine InputTest. Anything
 *  outside this small grammar (a real FEEL expression, function call, etc.) becomes `{feel: text}` —
 *  testMatch() (decisioning.ts) already treats that as an unconditional match, same fallback feelTest
 *  itself uses on the way out, so round-tripping an unrecognized cell doesn't silently misfire. */
export function parseFeelTest(text: string): InputTest {
  const t = text.trim();
  if (t === '' || t === '-') return { any: true };
  let m = /^>=\s*(.+)$/.exec(t); if (m) return { gte: FEEL_LIT(m[1]) as number | string };
  m = /^<=\s*(.+)$/.exec(t); if (m) return { lte: FEEL_LIT(m[1]) as number | string };
  m = /^>\s*(.+)$/.exec(t); if (m) return { gt: FEEL_LIT(m[1]) as number | string };
  m = /^<\s*(.+)$/.exec(t); if (m) return { lt: FEEL_LIT(m[1]) as number | string };
  m = /^\[(.+)\.\.(.+)\]$/.exec(t); if (m) return { between: [FEEL_LIT(m[1]) as number, FEEL_LIT(m[2]) as number] };
  m = /^not\((.+)\)$/.exec(t); if (m) { const inner = m[1].split(',').map((s) => FEEL_LIT(s)); return { not: inner.length > 1 ? inner : inner[0] }; }
  if (t.includes(',')) return t.split(',').map((s) => FEEL_LIT(s));
  if (/^"[^"]*"$/.test(t) || /^-?\d+(\.\d+)?$/.test(t) || t === 'true' || t === 'false') return FEEL_LIT(t);
  return { feel: t };   // real FEEL expression, function call, etc. — not evaluated, always matches
}
/** Inverse of feelResult: an output-entry's raw FEEL text -> engine OutputResult. */
export function parseFeelResult(text: string): OutputResult {
  const t = text.trim();
  if (t === '') return '';
  if (/^"[^"]*"$/.test(t) || /^-?\d+(\.\d+)?$/.test(t) || t === 'true' || t === 'false') return FEEL_LIT(t);
  return { feel: t };
}
/** One <decision><decisionTable> -> an EngineDecision, or undefined if this decision isn't
 *  table-driven (literalExpression/businessKnowledgeModel — see the module comment above). */
function dmnDecisionFromXml(decEl: ElementNode): EngineDecision | undefined {
  const dt = kid(decEl, 'decisionTable');
  if (!dt) return undefined;
  // typeRef round-trips as-is (not translated back through a "real" engine type name): feelType()
  // degrades to the identity function for anything it doesn't recognize, and every value it DOES
  // produce (number/string/boolean/date/...) is also one of its own valid input keys — so feeding a
  // typeRef straight back into `type` always regenerates the identical typeRef on the way out again.
  const inputs: DecisionField[] = kids(dt, 'input').map((inp) => {
    const expr = kid(inp, 'inputExpression');
    const name = (expr && cdataText(kid(expr, 'text')) || inp.attrs.label || inp.attrs.id || '').trim();
    return { name, ...(expr?.attrs.typeRef ? { type: expr.attrs.typeRef as FeelType } : {}) };
  });
  const outputs: DecisionField[] = kids(dt, 'output').map((o) => ({
    name: o.attrs.name || o.attrs.label || o.attrs.id || '', ...(o.attrs.typeRef ? { type: o.attrs.typeRef as FeelType } : {}),
  }));
  const rules: DecisionRule[] = kids(dt, 'rule').map((r) => {
    const ins = kids(r, 'inputEntry'); const outs = kids(r, 'outputEntry');
    const when: Record<string, InputTest> = {}; const then: Record<string, OutputResult> = {};
    inputs.forEach((inp, i) => { if (ins[i]) when[inp.name] = parseFeelTest(cdataText(kid(ins[i], 'text'))); });
    outputs.forEach((o, i) => { if (outs[i]) then[o.name] = parseFeelResult(cdataText(kid(outs[i], 'text'))); });
    return { when, then };
  });
  const hitPolicy = (dt.attrs.hitPolicy as HitPolicy) || 'UNIQUE';
  return { name: decEl.attrs.name || decEl.attrs.id || '', hitPolicy, inputs, outputs, rules,
    ...(dt.attrs.aggregation ? { aggregation: dt.attrs.aggregation as Aggregation } : {}) };
}
/** A parsed DMN <definitions> XML tree -> an EngineDecisionModel, keeping only decisionTable-driven
 *  decisions (see dmnDecisionFromXml). Returns undefined if the file declares no such decision at
 *  all (e.g. every decision uses a literalExpression) — nothing usable to wire up. */
export function dmnToDecisionModel(defsXml: ElementNode): EngineDecisionModel | undefined {
  const decisions = kids(defsXml, 'decision').map(dmnDecisionFromXml).filter((d): d is EngineDecision => !!d);
  if (!decisions.length) return undefined;
  return { name: defsXml.attrs.name || defsXml.attrs.id || 'model', namespace: defsXml.attrs.namespace, decisions };
}

// engine type -> Java field type / GDST dataType / operator symbol
const GDST_OP: Record<GdstOp, string> = { eq: '==', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
const GDST_JAVA: Record<string, string> = { string: 'String', number: 'Double', double: 'Double', float: 'Double', int: 'Integer', integer: 'Integer', long: 'Long', bool: 'Boolean', boolean: 'Boolean', date: 'java.util.Date' };
const GDST_DATA: Record<string, string> = { string: 'STRING', number: 'NUMERIC_DOUBLE', double: 'NUMERIC_DOUBLE', float: 'NUMERIC_DOUBLE', int: 'NUMERIC_INTEGER', integer: 'NUMERIC_INTEGER', long: 'NUMERIC_INTEGER', bool: 'BOOLEAN', boolean: 'BOOLEAN', date: 'DATE' };
const gdstJava = (t?: string) => GDST_JAVA[(t || 'string').toLowerCase()] || 'String';
const gdstData = (t?: string) => GDST_DATA[(t || 'string').toLowerCase()] || 'STRING';

/**
 * Engine guided table -> a Business Central guided decision table (`decision-table52`, EXTENDED_ENTRY).
 * Condition columns become `fact.field <op>`, action columns become `set fact.field`, each row supplies
 * the per-cell values. It compiles to DRL in Business Central (row order = rule order). buildAsset
 * ({kind:'guidedDecisionTable', model}) serialises the returned `{ xml }`.
 */
export function decisionTableToGdst(m: EngineGuidedTable, pkg = 'org.jbpm.rules', fieldTypes: Record<string, string> = {}): { xml: ElementNode } {
  const bind = m.bind || m.fact.charAt(0).toLowerCase() + m.fact.slice(1);
  // column type: explicit `type` wins, else look it up from the declared fact type's field, else string
  const ct = (col: { field: string; type?: string }) => col.type || fieldTypes[col.field] || 'string';
  const tdv = (dt: string) => el('typedDefaultValue', {}, [el('valueString', {}, [], ''), el('dataType', {}, [], dt), el('isOtherwise', {}, [], 'false')]);
  const conditions = m.conditions.map((c) => el('condition-column52', {}, [
    tdv(gdstData(ct(c))), el('hideColumn', {}, [], 'false'), el('width', {}, [], '-1'),
    el('header', {}, [], c.field), el('constraintValueType', {}, [], '1'),
    el('factField', {}, [], c.field), el('fieldType', {}, [], gdstJava(ct(c))), el('operator', {}, [], GDST_OP[c.op] || '=='),
  ]));
  const pattern = el('Pattern52', {}, [
    el('factType', {}, [], m.fact), el('boundName', {}, [], bind), el('isNegated', {}, [], 'false'),
    el('conditions', {}, conditions),
  ]);
  const actions = m.actions.map((a) => el('action-set-field-column52', {}, [
    tdv(gdstData(ct(a))), el('hideColumn', {}, [], 'false'), el('width', {}, [], '-1'),
    el('header', {}, [], a.field), el('boundName', {}, [], bind), el('factField', {}, [], a.field),
    el('type', {}, [], gdstJava(ct(a))), el('update', {}, [], 'false'),
  ]));
  const cell = (v: string | number | boolean | undefined, dt: string) => el('value', {}, [el('valueString', {}, [], v == null ? '' : String(v)), el('dataType', {}, [], dt), el('isOtherwise', {}, [], 'false')]);
  const rowNum = (n: number) => el('value', {}, [el('valueNumeric', {}, [], String(n)), el('dataType', {}, [], 'NUMERIC_INTEGER'), el('isOtherwise', {}, [], 'false')]);
  const data = m.rows.map((r, i) => el('list', {}, [
    rowNum(i + 1), cell('', 'STRING'),
    ...m.conditions.map((c) => cell((r.when || {})[c.field], gdstData(ct(c)))),
    ...m.actions.map((a) => cell((r.then || {})[a.field], gdstData(ct(a)))),
  ]));
  return { xml: el('decision-table52', {}, [
    el('tableName', {}, [], m.name),
    el('rowNumberCol', {}, [el('hideColumn', {}, [], 'false')]),
    el('descriptionCol', {}, [el('hideColumn', {}, [], 'false')]),
    el('metadataCols', {}), el('attributeCols', {}),
    el('conditionPatterns', {}, [pattern]),
    el('actionCols', {}, actions),
    el('packageName', {}, [], pkg),
    el('tableFormat', {}, [], 'EXTENDED_ENTRY'),
    el('data', {}, data),
  ]) };
}

// guided decision tree node class FQNs (XStream) — emitted as `class="…"` attrs for a stable parse
const GDT_TYPE = 'org.drools.workbench.models.guided.dtree.shared.model.nodes.impl.TypeNodeImpl';
const GDT_CONSTRAINT = 'org.drools.workbench.models.guided.dtree.shared.model.nodes.impl.ConstraintNodeImpl';
const GDT_ACTION = 'org.drools.workbench.models.guided.dtree.shared.model.nodes.impl.ActionUpdateNodeImpl';
const GDT_FIELDVAL = 'org.drools.workbench.models.guided.dtree.shared.model.values.impl.ActionFieldValueImpl';
const GDT_JAVA: Record<string, string> = { string: 'java.lang.String', number: 'java.lang.Double', double: 'java.lang.Double', float: 'java.lang.Double', int: 'java.lang.Integer', integer: 'java.lang.Integer', long: 'java.lang.Long', bool: 'java.lang.Boolean', boolean: 'java.lang.Boolean' };
const gdtJava = (t?: string) => GDT_JAVA[(t || 'string').toLowerCase()] || 'java.lang.String';

/**
 * Engine decision tree -> a Business Central guided decision tree (`GuidedDecisionTree` XML). Each node
 * tests a field; each branch (op+value) becomes a constraint node whose children are either an action
 * (set-field) leaf or nested constraints. Best-effort XML (well-formed; BC-load not verified). It
 * compiles to DRL in Business Central. buildAsset({kind:'guidedDecisionTree', model}) serialises it.
 */
export function decisionTreeToGdt(tree: EngineDecisionTree, fieldTypes: Record<string, string> = {}, resolve: (t: string) => string = (t) => t): { xml: ElementNode } {
  const fqn = resolve(tree.fact);
  const actionNode = (actions: GdtAction[]): ElementNode => el('node', { class: GDT_ACTION }, [
    el('className', {}, [], fqn),
    el('fieldValues', {}, actions.map((a) => el('fieldValue', { class: GDT_FIELDVAL }, [
      el('fieldName', {}, [], a.set), el('value', { class: gdtJava(fieldTypes[a.set]) }, [], String(a.value)),
    ]))),
  ]);
  const compileNode = (node: GdtNode): ElementNode[] => node.branches.map((b) => el('node', { class: GDT_CONSTRAINT }, [
    el('className', {}, [], fqn),
    el('fieldName', {}, [], node.field),
    el('operator', {}, [], GDST_OP[b.op] || '=='),
    el('value', { class: gdtJava(fieldTypes[node.field]) }, [], String(b.value)),
    el('children', {}, Array.isArray(b.then) ? [actionNode(b.then)] : compileNode(b.then)),
  ]));
  return { xml: el('GuidedDecisionTree', {}, [
    el('treeName', {}, [], tree.name),
    el('root', { class: GDT_TYPE }, [el('className', {}, [], fqn), el('children', {}, compileNode(tree.root))]),
  ]) };
}

/**
 * Engine guided rule -> a Business Central guided rule (`RuleModel` `.rdrl` XML): fact patterns with
 * field constraints (LHS) + set/insert/delete actions (RHS), from the same `when`/`then` a DRL ruleset
 * rule uses. Best-effort XML (well-formed; BC-load not verified) — it compiles to DRL in BC, and the
 * same rule engine executes it. buildAsset({kind:'guidedRule', model}) serialises it.
 */
export function ruleToRdrl(rule: EngineGuidedRule, fieldTypes: Record<string, string> = {}): { xml: ElementNode } {
  const RM = 'org.drools.workbench.models.datamodel.rule.';
  const jType = (f: string) => GDST_JAVA[(fieldTypes[f] || 'string').toLowerCase()] || 'String';
  const attrs: ElementNode[] = [];
  if (rule.priority != null) attrs.push(el('attribute', {}, [el('name', {}, [], 'salience'), el('value', {}, [], String(rule.priority))]));
  if (rule.noLoop) attrs.push(el('attribute', {}, [el('name', {}, [], 'no-loop'), el('value', {}, [], 'true')]));

  const fieldConstraint = (c: { field: string; op?: string; value?: unknown; var?: string }): ElementNode => el('fieldConstraint', { class: RM + 'SingleFieldConstraint' }, [
    el('fieldName', {}, [], c.field), el('fieldType', {}, [], jType(c.field)), el('operator', {}, [], c.op || '=='),
    ...('var' in c ? [el('value', {}, [], '$' + String(c.var).replace(/^\$/, '')), el('constraintValueType', {}, [], '5')]
      : [el('value', {}, [], String(c.value)), el('constraintValueType', {}, [], '1')]),
  ]);
  const factPattern = (w: EngineWhen): ElementNode => {
    const cons = Object.entries(w.where || {}).flatMap(([f, spec]) => whereConstraints(f, spec))
      .filter((c) => 'op' in c) as Array<{ field: string; op: string; value?: unknown; var?: string }>;
    return el('fact', { class: RM + 'FactPattern' }, [
      el('factType', {}, [], w.fact),
      ...(w.as ? [el('boundName', {}, [], w.as)] : []),
      el('constraintList', {}, [el('constraints', {}, cons.map(fieldConstraint))]),
    ]);
  };
  const lhs = (rule.when || []).map((w) => (w.not || w.exists === false)
    ? el('fact', { class: RM + 'CompositeFactPattern', type: 'not' }, [factPattern(w)])   // best-effort negation
    : factPattern(w));

  const fieldValues = (obj: Record<string, string | number | boolean>) => Object.entries(obj).map(([f, v]) =>
    el('fieldValue', { class: RM + 'ActionFieldValue' }, [el('field', {}, [], f), el('value', {}, [], String(v)), el('type', {}, [], jType(f))]));
  const rhs = (rule.then || []).map((a): ElementNode => {
    if ('set' in a) return el('action', { class: RM + 'ActionSetField' }, [el('variable', {}, [], a.set), el('fieldValues', {}, fieldValues(a.fields))]);
    if ('insert' in a) return el('action', { class: RM + 'ActionInsertFact' }, [el('factType', {}, [], a.insert), ...(a.fields ? [el('fieldValues', {}, fieldValues(a.fields))] : [])]);
    if ('delete' in a) return el('action', { class: RM + 'ActionRetractFact' }, [el('variableName', {}, [], a.delete)]);
    return el('action', { class: RM + 'FreeFormLine' }, [el('text', {}, [], 'call' in a ? `${a.call}(${(a.args || []).map((x) => JSON.stringify(x)).join(', ')});` : '')]);
  });

  return { xml: el('rule', {}, [
    el('name', {}, [], rule.name), el('modelVersion', {}, [], '1.0'),
    el('attributes', {}, attrs), el('lhs', {}, lhs), el('rhs', {}, rhs),
  ]) };
}

/**
 * Engine guided rule template -> a Business Central guided rule template (`TemplateModel` `.template`
 * XML): the rule skeleton (reusing ruleToRdrl — `{param}` values pass through as markers) + the
 * parameter columns + the data rows. Best-effort XML (well-formed; BC-load not verified). It expands to
 * N DRL rules in BC; the runtime `expandTemplate` does the same for a Node engine.
 */
export function templateToTemplateXml(tmpl: EngineGuidedRuleTemplate, fieldTypes: Record<string, string> = {}): { xml: ElementNode } {
  const skeleton = ruleToRdrl({ name: tmpl.name, priority: tmpl.priority, noLoop: tmpl.noLoop, when: tmpl.when, then: tmpl.then }, fieldTypes).xml;
  const params = [...new Set(tmpl.rows.flatMap((r) => Object.keys(r)))];
  const tableColumns = el('tableColumns', {}, params.map((p) => el('tableColumn', {}, [], p)));
  const rows = el('rows', {}, tmpl.rows.map((r) => el('row', {}, params.map((p) => el('cell', {}, [], r[p] == null ? '' : String(r[p]))))));
  return { xml: el('templateModel', {}, [...skeleton.children, tableColumns, rows]) };
}

/**
 * Engine scorecard -> a Business Central guided score card (`ScoreCardModel` `.scgd` XML): the score
 * field + initial score + a Characteristic per field, each with Attribute bins (operator/value ->
 * partialScore). Best-effort XML (well-formed; BC-load not verified). It compiles to DRL in BC; the
 * runtime `evaluateScorecard` computes the same total. buildAsset({kind:'scoreCard', model}) serialises.
 */
const SCGD_OP: Record<GdstOp, string> = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' };
export function scorecardToScgd(sc: EngineScorecard, fieldTypes: Record<string, string> = {}, resolve: (t: string) => string = (t) => t): { xml: ElementNode } {
  const fqn = resolve(sc.fact);
  const bandAttr = (band: ScoreBand): ElementNode => {
    let operator = ''; let value = '';
    const w = band.when;
    if (w === undefined) { /* catch-all: empty operator */ }
    else if (typeof w !== 'object') { operator = '='; value = String(w); }               // bare literal (eq)
    else if ('between' in w) { operator = 'in'; value = `${w.between[0]}..${w.between[1]}`; }
    else { const [op, val] = Object.entries(w)[0]; operator = SCGD_OP[op as GdstOp] || '='; value = String(val); }
    return el('Attribute', {}, [el('operator', {}, [], operator), el('value', {}, [], value), el('partialScore', {}, [], String(band.points))]);
  };
  const characteristics = sc.characteristics.map((ch) => el('Characteristic', {}, [
    el('name', {}, [], ch.field), el('factName', {}, [], fqn), el('field', {}, [], ch.field),
    el('dataType', {}, [], gdstJava(fieldTypes[ch.field])), el('attributes', {}, ch.bands.map(bandAttr)),
  ]));
  return { xml: el('ScoreCardModel', {}, [
    el('name', {}, [], sc.name), el('factName', {}, [], fqn), el('fieldName', {}, [], sc.score),
    el('initialScore', {}, [], String(sc.baseline || 0)), el('useReasonCodes', {}, [], 'false'),
    el('characteristics', {}, characteristics),
  ]) };
}

/**
 * Engine test suite -> a Business Central test scenario (`ScenarioSimulationModel` `.scesim` XML): GIVEN
 * columns per input + EXPECT columns per output, then one Scenario row per case. Best-effort XML
 * (well-formed; BC-load not verified). The cases also run directly in Node (functions/test-scenario.mjs).
 */
export function testSuiteToScesim(suite: EngineTestSuite): { xml: ElementNode } {
  const givenKeys = [...new Set(suite.cases.flatMap((c) => Object.keys(c.given)))];
  const expectKeys = [...new Set(suite.cases.flatMap((c) => Object.keys(c.expect)))];
  const factMappings = [
    ...givenKeys.map((k) => el('FactMapping', {}, [el('type', {}, [], 'GIVEN'), el('factName', {}, [], k)])),
    ...expectKeys.map((k) => el('FactMapping', {}, [el('type', {}, [], 'EXPECT'), el('factName', {}, [], k)])),
  ];
  const scenarios = suite.cases.map((c, i) => el('Scenario', {}, [
    el('name', {}, [], c.name || `case ${i + 1}`),
    el('values', {}, [
      ...givenKeys.map((k) => el('value', {}, [el('factName', {}, [], k), el('raw', {}, [], c.given[k] == null ? '' : String(c.given[k]))])),
      ...expectKeys.map((k) => el('value', {}, [el('factName', {}, [], k), el('raw', {}, [], c.expect[k] == null ? '' : String(c.expect[k]))])),
    ]),
  ]));
  return { xml: el('ScenarioSimulationModel', { version: '1.8' }, [
    el('simulation', {}, [
      el('scesimModelDescriptor', {}, [el('factMappings', {}, factMappings)]),
      el('scenarios', {}, scenarios),
    ]),
    el('settings', {}, [el('target', {}, [], suite.target)]),
  ]) };
}

// friendly widget -> jBPM field code; and field-type -> derived code
const WIDGET_CODE: Record<string, string> = { text: 'TextBox', textarea: 'TextArea', integer: 'IntegerBox', number: 'DoubleBox', decimal: 'DoubleBox', checkbox: 'CheckBox', boolean: 'CheckBox', dropdown: 'ListBox', select: 'ListBox', radio: 'RadioGroup', date: 'DatePicker' };
const TYPE_CODE: Record<string, string> = { string: 'TextBox', int: 'IntegerBox', integer: 'IntegerBox', long: 'IntegerBox', double: 'DoubleBox', float: 'DoubleBox', number: 'DoubleBox', bool: 'CheckBox', boolean: 'CheckBox', date: 'DatePicker' };
const humanize = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

/**
 * Engine form -> a Business Central form definition (`.frm` JSON model). `type` -> model.className
 * (via resolve), each field -> a bound input whose `code` is the explicit `widget` or one derived from
 * the field's type (`fieldTypes`). buildAsset({kind:'form', model}) serialises the `{ json }`.
 */
export function formToFrm(form: EngineForm, fieldTypes: Record<string, string> = {}, resolve: (t: string) => string = (t) => t): { json: unknown } {
  const fields = form.fields.map((f) => {
    const code = f.widget ? (WIDGET_CODE[f.widget] || 'TextBox') : (TYPE_CODE[(fieldTypes[f.bind] || 'string').toLowerCase()] || 'TextBox');
    const out: Record<string, unknown> = { id: f.bind, binding: f.bind, label: f.label || humanize(f.bind), code };
    if (f.required) out.required = true;
    if (f.readOnly) out.readOnly = true;
    if (f.placeholder) out.placeHolder = f.placeholder;
    return out;
  });
  const model: Record<string, unknown> = { name: form.name };
  if (form.type) model.className = resolve(form.type);
  return { json: { id: form.name, name: form.name, model, fields } };
}

/** Engine enums -> the jBPM `.enumeration` map ( 'Type.field' -> values ). */
export function enumerationsToModel(enums: EngineEnum[]): { enums: Record<string, string[]> } {
  const out: Record<string, string[]> = {};
  for (const e of enums) out[`${e.type}.${e.field}`] = e.values;
  return { enums: out };
}

/** Convert a whole engine project to an SDK Project (processes + kjar descriptor + generated .java). */
export function fromEngineProject(ep: EngineProject): Project {
  // `package` on a type is optional — default it so engine JSON stays free of Java packaging.
  const basePkg = ep.processes[0]?.package || 'org.jbpm';
  const modelPkg = `${basePkg}.model`;
  const fill = (ts?: EngineType[]) => (ts || []).map((t) => (t.package ? t : { ...t, package: modelPkg }));
  const epTypes = fill(ep.types);
  const filledProcesses = ep.processes.map((p) => ({ ...p, types: fill(p.types) }));
  const allTypes = [...epTypes, ...filledProcesses.flatMap((p) => p.types || [])];
  const resolve = makeTypeResolver(allTypes);
  const processes = filledProcesses.map((p) => fromEngine(p, epTypes));

  const files: Record<string, string> = {};
  // generate a .java POJO for every declared type
  const seen = new Set<string>();
  for (const t of allTypes) {
    const key = fqn(t); if (seen.has(key)) continue; seen.add(key);
    const rel = 'src/main/java/' + (t.package || '').replace(/\./g, '/') + (t.package ? '/' : '') + `${t.name}.java`;
    files[rel] = buildAsset({ kind: 'dataObject', model: { package: t.package, className: t.name, fields: (t.fields || []).map((f) => ({ name: f.name, type: fieldJavaType(f, resolve) })) } });
  }
  // carry engine assets (structured -> buildAsset, or raw string)
  for (const [path, val] of Object.entries(ep.assets || {})) files[path] = typeof val === 'string' ? val : buildAsset(val as any);
  // simple engine rulesets -> generated .drl (SDK synthesizes package/imports/ruleflow-group/DRL syntax)
  for (const rs of ep.rulesets || []) {
    const pkg = rs.package || `${basePkg}.rules`;
    const path = rs.path || `src/main/resources/${pkg.replace(/\./g, '/')}/${rs.group}.drl`;
    files[path] = buildAsset({ kind: 'drl', model: rulesToDrl(rs, resolve, pkg) });
  }
  // simple engine decisions -> generated .dmn (SDK synthesizes FEEL + DMN XML + namespace)
  for (const dm of ep.decisions || []) {
    const ns = dm.namespace || `https://${basePkg.replace(/\./g, '/')}/dmn/${dm.name}`;
    const path = dm.path || `src/main/resources/${dm.name}.dmn`;
    files[path] = buildAsset({ kind: 'dmn', model: decisionToDmn(dm, ns) });
  }
  // engine guided tables -> generated .gdst (Business Central decision-table52 XML)
  for (const gt of ep.guidedTables || []) {
    const pkg = gt.package || `${basePkg}.rules`;
    const path = gt.path || `src/main/resources/${pkg.replace(/\./g, '/')}/${clean(gt.name)}.gdst`;
    // column types are derived from the declared `fact` type's fields (columns need only name + op)
    const declared = allTypes.find((t) => t.name === gt.fact);
    const fieldTypes: Record<string, string> = {};
    for (const f of declared?.fields || []) fieldTypes[f.name] = f.type;
    files[path] = buildAsset({ kind: 'guidedDecisionTable', model: decisionTableToGdst(gt, pkg, fieldTypes) });
  }
  // engine guided rules -> generated .rdrl (Business Central RuleModel XML)
  for (const rule of ep.guidedRules || []) {
    const pkg = rule.package || `${basePkg}.rules`;
    const path = rule.path || `src/main/resources/${pkg.replace(/\./g, '/')}/${clean(rule.name)}.rdrl`;
    const fieldTypes: Record<string, string> = {};
    for (const w of rule.when || []) { const d = allTypes.find((t) => t.name === w.fact); for (const f of d?.fields || []) fieldTypes[f.name] = f.type; }
    files[path] = buildAsset({ kind: 'guidedRule', model: ruleToRdrl(rule, fieldTypes) });
  }
  // engine guided rule templates -> generated .template (Business Central TemplateModel XML)
  for (const tmpl of ep.guidedRuleTemplates || []) {
    const pkg = tmpl.package || `${basePkg}.rules`;
    const path = tmpl.path || `src/main/resources/${pkg.replace(/\./g, '/')}/${clean(tmpl.name)}.template`;
    const fieldTypes: Record<string, string> = {};
    for (const w of tmpl.when || []) { const d = allTypes.find((t) => t.name === w.fact); for (const f of d?.fields || []) fieldTypes[f.name] = f.type; }
    files[path] = buildAsset({ kind: 'guidedRuleTemplate', model: templateToTemplateXml(tmpl, fieldTypes) });
  }
  // engine scorecards -> generated .scgd (Business Central ScoreCardModel XML)
  for (const sc of ep.scorecards || []) {
    const pkg = sc.package || `${basePkg}.rules`;
    const path = sc.path || `src/main/resources/${pkg.replace(/\./g, '/')}/${clean(sc.name)}.scgd`;
    const declared = allTypes.find((t) => t.name === sc.fact);
    const fieldTypes: Record<string, string> = {};
    for (const f of declared?.fields || []) fieldTypes[f.name] = f.type;
    files[path] = buildAsset({ kind: 'scoreCard', model: scorecardToScgd(sc, fieldTypes, resolve) });
  }
  // engine test suites -> generated .scesim (test resources; also runnable in Node)
  for (const suite of ep.tests || []) {
    const path = suite.path || `src/test/resources/${clean(suite.name)}.scesim`;
    files[path] = buildAsset({ kind: 'testScenario', model: testSuiteToScesim(suite) });
  }
  // engine decision trees -> generated .gdt (Business Central GuidedDecisionTree XML)
  for (const tree of ep.decisionTrees || []) {
    const pkg = tree.package || `${basePkg}.rules`;
    const path = tree.path || `src/main/resources/${pkg.replace(/\./g, '/')}/${clean(tree.name)}.gdt`;
    const declared = allTypes.find((t) => t.name === tree.fact);
    const fieldTypes: Record<string, string> = {};
    for (const f of declared?.fields || []) fieldTypes[f.name] = f.type;
    files[path] = buildAsset({ kind: 'guidedDecisionTree', model: decisionTreeToGdt(tree, fieldTypes, resolve) });
  }
  // engine forms -> generated .frm (user-task UI; widget derived from the bound type's field types)
  for (const form of ep.forms || []) {
    const path = form.path || `src/main/resources/forms/${form.name}.frm`;
    const declared = allTypes.find((t) => t.name === form.type);
    const fieldTypes: Record<string, string> = {};
    for (const f of declared?.fields || []) fieldTypes[f.name] = f.type;
    files[path] = buildAsset({ kind: 'form', model: formToFrm(form, fieldTypes, resolve) });
  }
  // engine enumerations -> a single generated .enumeration (dropdown value lists)
  if ((ep.enumerations || []).length) {
    files['src/main/resources/enumerations.enumeration'] = buildAsset({ kind: 'enumeration', model: enumerationsToModel(ep.enumerations as EngineEnum[]) });
  }
  // engine DSL entries -> a generated .dsl (rule readability sugar)
  if ((ep.dsl || []).length) {
    files['src/main/resources/dsl/definitions.dsl'] = buildAsset({ kind: 'dsl', model: { entries: ep.dsl } });
  }
  // engine i18n messages (keyed by locale) -> generated .properties files; the SDK owns the filenames
  for (const [locale, entries] of Object.entries(ep.messages || {})) {
    const suffix = locale === 'default' ? '' : `_${locale}`;
    files[`src/main/resources/messages${suffix}.properties`] = buildAsset({ kind: 'properties', model: { props: entries } });
  }

  const dep = ep.deployment || {};
  // batteries-included: always ship jBPM's standard work-item definitions + register their handlers.
  // Custom `workItems` extend/override by name; extra `deployment.handlers` are added on top.
  const custom = ep.workItems || [];
  const workDefinitions = [...DEFAULT_WORK_ITEMS.filter((d) => !custom.some((c) => c.name === d.name)), ...custom];
  const handlerNames = [...new Set([...workDefinitions.map((w) => w.name), ...(dep.handlers || [])])];
  const descriptor: ProjectDescriptor = {
    gav: ep.gav,
    deployment: {
      runtimeStrategy: dep.runtime || 'SINGLETON',
      workItemHandlers: handlerNames.map((name): WorkItemHandler => ({ name, resolver: 'mvel', identifier: HANDLER_ID[name] || `new ${name}()` })),
      environmentEntries: Object.entries(dep.env || {}).map(([name, v]): EnvironmentEntry => ({ name, resolver: 'mvel', identifier: `"${v}"` })),
    },
    workDefinitions,      // -> global/WorkDefinitions.wid (defaults + any custom)
    files,
    ...(ep.binaryAssets && Object.keys(ep.binaryAssets).length ? { binaryFiles: ep.binaryAssets } : {}),
  };
  return { root: ep.id || '.', descriptor, processes };
}

// Scaffolding files handled by gav/deployment (not surfaced as engine assets)
const SCAFFOLD_FILES = new Set([
  'pom.xml', 'src/main/resources/META-INF/kmodule.xml', 'src/main/resources/META-INF/persistence.xml',
  'src/main/resources/META-INF/kie-deployment-descriptor.xml', 'project.imports', 'project.repositories',
]);
const JAVA_TO_ENGINE: Record<string, string> = {
  String: 'string', int: 'int', integer: 'int', long: 'long', double: 'double', float: 'double',
  boolean: 'bool', Boolean: 'bool', 'java.util.List': 'list', 'java.util.Map': 'map', 'java.util.Date': 'date', Object: 'object',
};

/**
 * Reverse of fromEngineProject: a jBPM Project -> engine model, recovering assets as STRUCTURED
 * engine models (via parseAsset) and .java data objects as engine `types` (best-effort).
 */
export function toEngineProject(project: Project): EngineProject {
  const files = (project.descriptor && project.descriptor.files) || {};
  const types: EngineType[] = [];
  const assets: Record<string, { kind: string; model: any }> = {};
  for (const [p, content] of Object.entries(files)) {
    if (SCAFFOLD_FILES.has(p)) continue;
    const kind = assetKind(p);
    if (kind === 'dataObject') {
      const a = parseAsset(p, content);
      types.push({ name: a.model.className, package: a.model.package, fields: (a.model.fields || []).map((f: any) => ({ name: f.name, type: JAVA_TO_ENGINE[f.type] || f.type })) });
    } else {
      assets[p] = parseAsset(p, content) as { kind: string; model: any };
    }
  }
  const dep = (project.descriptor && project.descriptor.deployment) || {};
  const binaryFiles = project.descriptor && project.descriptor.binaryFiles;
  return {
    id: project.root,
    gav: project.descriptor && project.descriptor.gav,
    deployment: {
      runtime: dep.runtimeStrategy,
      env: Object.fromEntries((dep.environmentEntries || []).map((e) => [e.name, e.identifier.replace(/^"|"$/g, '')])),
      handlers: (dep.workItemHandlers || []).map((h) => h.name),
    },
    types,
    assets,
    ...(binaryFiles && Object.keys(binaryFiles).length ? { binaryAssets: binaryFiles } : {}),
    processes: project.processes.map(toEngine),
  };
}

// ---- reverse (best-effort): jBPM ProcessModel -> engine model ----
const SR_TO_ENGINE: Record<string, string> = { String: 'string', Integer: 'int', 'java.lang.Long': 'long', 'java.lang.Double': 'double', 'java.lang.Boolean': 'bool', 'java.lang.Object': 'object', 'java.util.List': 'list', 'java.util.Map': 'map', 'java.util.Date': 'date' };
const dialectToLang = (u?: string): Lang => u && u.includes('javascript') ? 'js' : u && u.includes('mvel') ? 'mvel' : 'java';

/** Engine features jBPM has no field for travel in one metaData entry, so exporting to BPMN and importing back loses nothing
 *  (jBPM / Business Central ignore metadata keys they do not know). */
const EXTRA_KEYS = ['on', 'interrupting', 'adHoc', 'completionCondition', 'multiInstance', 'instantiate', 'activationCondition', 'assignmentStrategy', 'swimlane', 'autoClaim', 'isForCompensation', 'onChildFailure', 'errorVar', 'result', 'metaData'] as const;
export const EXTRAS_META = 'engine.extras';
const extrasOf = (n: Record<string, any>): Record<string, string> => {
  const e: Record<string, unknown> = {};
  for (const k of EXTRA_KEYS) if (n[k] !== undefined && !(k === 'onChildFailure' && n[k] === 'abort') && !(k === 'result' && n[k] !== 'cancel')) e[k] = n[k];
  return Object.keys(e).length ? { [EXTRAS_META]: JSON.stringify(e) } : {};
};
const restoreExtras = (md?: Record<string, string>): Record<string, unknown> => { try { return md?.[EXTRAS_META] ? JSON.parse(md[EXTRAS_META]) : {}; } catch { return {}; } };

export function toEngine(m: ProcessModel): EngineProcess {
  const ev = (n: Node) => n.eventType === 'signal' ? { signal: n.signalName } : n.eventType === 'message' ? { message: n.messageRef }
    : n.eventType === 'error' ? { error: n.errorRef } : n.eventType === 'escalation' ? { escalation: n.escalationRef }
      : n.eventType === 'timer' ? { timer: n.timeCycleLanguage === 'cron' ? { cron: n.timeCycle } : { duration: n.timeDuration, cycle: n.timeCycle, date: n.timeDate } }
        : n.eventType === 'conditional' ? { condition: n.conditionExpr, lang: dialectToLang(n.conditionExprLanguage) } : undefined;
  const gwMode: Record<string, string> = { exclusiveGateway: 'exclusive', parallelGateway: 'parallel', inclusiveGateway: 'inclusive', eventBasedGateway: 'event', complexGateway: 'complex' };
  // Reverse of fromEngine's lifecycle() — onEntry/onExit round-trip byte-for-byte here (no preamble
  // to strip: real jBPM projects never contain this engine's own vars/instance/node/meta-local
  // preamble, since that's this engine's own addition, not something a real jBPM project authors).
  const revLifecycle = (n: Node): Partial<EngineNode> => ({
    ...(n.onEntry ? { onEntry: n.onEntry, onEntryLang: dialectToLang(n.onEntryFormat) } : {}),
    ...(n.onExit ? { onExit: n.onExit, onExitLang: dialectToLang(n.onExitFormat) } : {}),
    ...(n.async ? { async: true } : {}),
    ...restoreExtras(n.metaData),
    ...(n.autoStart ? { autoStart: true } : {}),
    ...(n.slaDueDate ? { slaDueDate: n.slaDueDate } : {}),
    ...(n.metaData?.asyncRetries !== undefined && Number.isInteger(Number(n.metaData.asyncRetries)) ? { asyncRetries: Number(n.metaData.asyncRetries) } : {}),
    ...(n.metaData?.asyncRetryDelay ? { asyncRetryDelay: n.metaData.asyncRetryDelay } : {}),
  });
  // toEngine is a best-effort reverse: jBPM fields may be undefined and don't always satisfy the
  // strict EngineNode union (e.g. an http node with no reversible url), so the builder returns `any`.
  const conv = (n: Node): any => {
    const b: EngineNode = {
      id: n.id,
      type: 'raw',
      name: n.name,
      ...(n.position ? { x: Math.round(n.position.x), y: Math.round(n.position.y) } : {}),
    };
    switch (n.type) {
      case 'startEvent': return { ...b, type: 'start', ...(ev(n) ? { on: ev(n) } : {}) };
      case 'endEvent': return n.eventType === 'terminate' || n.subtype === 'terminate' ? { ...b, type: 'end', result: 'terminate' } : { ...b, type: 'end', ...(ev(n) ? { throw: ev(n) } : {}), ...restoreExtras(n.metaData) };
      case 'scriptTask': { const { onEntry: _a, onExit: _b, onEntryLang: _c, onExitLang: _d, ...meta } = revLifecycle(n) as any; return { ...b, type: 'script', lang: dialectToLang(n.scriptFormat), code: n.script, ...meta }; }
      case 'userTask': {
        const ti = n.taskInputs || {}; const split = (v?: string) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);
        const groups = split(n.group); const extra: Record<string, unknown> = {};
        if (ti.ActorId) extra.actors = split(ti.ActorId);
        if (ti.BusinessAdministratorId) extra.businessAdmin = ti.BusinessAdministratorId;
        if (ti.BusinessAdministratorGroupId) extra.businessAdminGroups = split(ti.BusinessAdministratorGroupId);
        if (ti.TaskStakeholderId) extra.stakeholders = split(ti.TaskStakeholderId);
        if (ti.ExcludedOwnerId) extra.excludedOwners = split(ti.ExcludedOwnerId);
        for (const [name, k] of [['Comment', 'comment'], ['Content', 'content'], ['Locale', 'locale'], ['CreatedBy', 'createdBy'], ['suspendUntil', 'suspendUntil'], ['Description', 'description'],
          ['NotStartedReassign', 'notStartedReassign'], ['NotCompletedReassign', 'notCompletedReassign'], ['NotStartedNotify', 'notStartedNotify'], ['NotCompletedNotify', 'notCompletedNotify']] as const) if (ti[name] !== undefined) extra[k] = ti[name];
        if (ti.Priority !== undefined && !Number.isNaN(Number(ti.Priority))) extra.priority = Number(ti.Priority);
        return { ...b, type: 'userTask', name: n.name, group: groups[0], ...(groups.length > 1 ? { groups: groups.slice(1) } : {}), form: n.taskName, ...extra, ...revLifecycle(n) };
      }
      // dmnModel present (implementation="...drools/dmn") -> real DMN wiring; decision name is left
      // unset (real jBPM's own dataInputAssociation convention never names one explicitly either — see
      // parse.ts) and defaults to the model's first decision at evaluation time (decisioning.ts).
      case 'businessRuleTask': return { ...b, type: 'rule', ruleflowGroup: n.ruleFlowGroup,
        ...(n.dmnModel ? { dmn: { namespace: n.dmnNamespace || '', model: n.dmnModel, decision: '' } } : {}), ...revLifecycle(n) };
      case 'sendTask': return { ...b, type: 'send', message: n.messageRef, ...revLifecycle(n) };
      case 'receiveTask': return { ...b, type: 'receive', message: n.messageRef, ...revLifecycle(n) };
      case 'manualTask': return { ...b, type: 'manual', name: n.name, ...revLifecycle(n) };
      case 'genericTask': {
        const params: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(n.workParams || {})) params[k] = v;
        return { ...b, type: 'workItem', handler: n.handlerName, params, resultTo: n.workResultTo || {}, ...revLifecycle(n) };
      }
      case 'exclusiveGateway': case 'parallelGateway': case 'inclusiveGateway': case 'eventBasedGateway': case 'complexGateway':
        return { ...b, type: 'gateway', mode: gwMode[n.type], default: n.default, direction: n.gatewayDirection, ...(n.instantiate ? { instantiate: true } : {}), ...restoreExtras(n.metaData) };
      case 'intermediateCatchEvent': return { ...b, type: 'catch', event: ev(n) };
      case 'intermediateThrowEvent': return { ...b, type: 'throw', event: ev(n) };
      case 'boundaryEvent': return { ...b, type: 'boundary', on: n.attachedTo, event: ev(n), interrupting: n.cancelActivity };
      case 'subProcess': {
        const innerNodes = (n.nodes || []).map(conv);
        // jBPM marks an event subprocess via triggeredByEvent="true" (captured as subtype 'event' by
        // the parser); the trigger itself is whatever start event lives inside (usually an error start).
        const errStart = n.subtype === 'event' ? (n.nodes || []).find((x) => x.type === 'startEvent' && x.eventType === 'error') : undefined;
        const on = n.subtype === 'event' ? (errStart?.errorRef ? { error: errStart.errorRef } : {}) : undefined;
        return { ...b, type: 'subprocess', transaction: n.subtype === 'transaction' || undefined, on, nodes: innerNodes, ...restoreExtras(n.metaData), flows: (n.flows || []).map((f) => ({ id: f.id, from: f.sourceRef, to: f.targetRef, ...(f.condition ? { when: f.condition, lang: dialectToLang(f.conditionLanguage) } : {}) })), ...revLifecycle(n) };
      }
      case 'callActivity':
        if (n.subtype === 'multiInstance' && n.multiInstance) return { ...b, type: 'forEach', process: n.calledElement, over: n.multiInstance.collectionIn, as: n.multiInstance.itemVar, collectInto: n.multiInstance.collectionOut, itemResult: n.multiInstance.itemOutVar, parallel: !n.multiInstance.isSequential, pass: n.multiInstance.passthru, ...(n.multiInstance.completionCondition ? { completionCondition: n.multiInstance.completionCondition } : {}), ...revLifecycle(n) };
        if (n.subtype === 'rest') return { ...b, type: 'http', method: n.method, url: n.url, ...(String(n.onExitFormat || '').includes('javascript') ? { lang: 'js' as Lang } : {}) }; // body/resultTo not reversed
        return { ...b, type: 'call', process: n.calledElement, ...(n.abortParent ? { onChildFailure: 'abort' } : {}), ...((n as any).inputs ? { inputs: (n as any).inputs } : {}), ...((n as any).outputs ? { outputs: (n as any).outputs } : {}), ...revLifecycle(n) };
      default: return { ...b, type: 'raw', raw: n.raw };
    }
  };
  return {
    id: m.id, name: m.name, package: m.packageName,
    ...(m.version && m.version !== '1.0' ? { version: m.version } : {}), ...(m.adHoc ? { adHoc: true } : {}), ...(m.slaDueDate ? { slaDueDate: m.slaDueDate } : {}), ...(m.description ? { description: m.description } : {}),
    vars: (m.variables || []).map((v) => ({ name: v.name, type: SR_TO_ENGINE[v.type] || v.type, ...(v.tags?.length ? { tags: v.tags } : {}) })),
    signals: (m.declarations?.signals || []).map((s) => s.name),
    errors: (m.declarations?.errors || []).map((e) => (e.id === e.errorCode ? e.id : { name: e.id, code: e.errorCode })),
    messages: (m.declarations?.messages || []).map((x) => x.id),
    escalations: (m.declarations?.escalations || []).map((x) => x.id),
    lanes: (m.lanes || []).map((l) => ({ id: l.id, name: l.name, nodes: l.flowNodeRefs })),
    data: (m.dataObjects || []).map((d) => ({ id: d.id, name: d.name, type: d.type ? (SR_TO_ENGINE[d.type] || d.type) : undefined, collection: d.isCollection })),
    nodes: m.nodes.map(conv),
    flows: m.flows.map((f) => ({ id: f.id, from: f.sourceRef, to: f.targetRef, ...(f.condition ? { when: f.condition, lang: dialectToLang(f.conditionLanguage) } : {}) })),
  };
}
