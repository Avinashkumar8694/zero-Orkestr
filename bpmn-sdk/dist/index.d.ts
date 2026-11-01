type NodeType = 'startEvent' | 'endEvent' | 'scriptTask' | 'userTask' | 'callActivity' | 'exclusiveGateway' | 'parallelGateway' | 'inclusiveGateway' | 'eventBasedGateway' | 'complexGateway' | 'businessRuleTask' | 'sendTask' | 'receiveTask' | 'manualTask' | 'boundaryEvent' | 'intermediateCatchEvent' | 'intermediateThrowEvent' | 'subProcess' | 'genericTask' | 'raw';
type EventType = 'none' | 'message' | 'timer' | 'signal' | 'error' | 'escalation' | 'conditional' | 'compensation' | 'cancel' | 'link' | 'terminate';
type DataFromKind = 'variable' | 'constant' | 'expression' | 'loopItem' | 'loopOutputItem';
interface Variable {
    name: string;
    /** jBPM variable tags (customTags): required, readonly, restricted … */
    tags?: string[];
    /** structureRef, e.g. "String", "java.util.List", "java.lang.Boolean", or a FQCN */
    type: string;
}
interface SignalDecl {
    id: string;
    name: string;
}
interface ErrorDecl {
    id: string;
    errorCode: string;
}
interface MessageDecl {
    id: string;
    name?: string;
    itemRef?: string;
}
interface EscalationDecl {
    id: string;
    escalationCode?: string;
    name?: string;
}
interface Declarations {
    signals: SignalDecl[];
    errors: ErrorDecl[];
    messages?: MessageDecl[];
    escalations?: EscalationDecl[];
}
interface DataObject {
    id: string;
    name?: string;
    type?: string;
    isCollection?: boolean;
}
interface DataStoreRef {
    id: string;
    name?: string;
    dataStoreRef?: string;
}
interface Lane {
    id: string;
    name?: string;
    flowNodeRefs: string[];
}
interface Position {
    x: number;
    y: number;
    width: number;
    height: number;
    expanded?: boolean;
}
interface Waypoint {
    x: number;
    y: number;
}
interface Flow {
    id: string;
    name?: string;
    sourceRef: string;
    targetRef: string;
    /** boolean expression, e.g. `return "DEATH".equals(claimType);` */
    condition?: string;
    /** condition dialect URI; defaults to Java. e.g. http://www.java.com/java, http://www.mvel.org/2.0 */
    conditionLanguage?: string;
    waypoints?: Waypoint[];
}
interface DataInput {
    name: string;
    from?: DataFromKind;
    value?: string;
}
interface DataOutput {
    name: string;
    to?: string;
    from?: DataFromKind;
}
interface MultiInstance {
    isSequential?: boolean;
    /** jBPM multi-instance completion condition: when true the remaining instances are cancelled */
    completionCondition?: string;
    collectionIn: string;
    collectionOut: string;
    itemVar: string;
    itemOutVar: string;
    passthru?: string[];
}
/** A single flow node. Optional fields apply per `type`/`subtype` (see docs/bpm-nodes). */
interface Node {
    id: string;
    name?: string;
    type: NodeType;
    subtype?: string;
    incoming?: string[];
    outgoing?: string[];
    position?: Position;
    script?: string;
    /** script dialect URI; defaults to Java. e.g. http://www.java.com/java, http://www.mvel.org/2.0, JavaScript */
    scriptFormat?: string;
    calledElement?: string;
    url?: string;
    method?: string;
    onEntry?: string;
    onExit?: string;
    /** dialect URI for onEntry/onExit wrapper scripts; defaults to Java */
    onEntryFormat?: string;
    onExitFormat?: string;
    /** jBPM "Is Async" — <drools:metaData name="customAsync">true */
    async?: boolean;
    /** jBPM "SLA Due Date" — <drools:metaData name="customSLADueDate"> (1d, 2h, PT30M, a date, #{var}) */
    slaDueDate?: string;
    /** jBPM "AdHoc Autostart" — <drools:metaData name="customAutoStart">true */
    autoStart?: boolean;
    /** user task: the data inputs beyond TaskName / Skippable / GroupId (ActorId, Comment, Content, Locale, CreatedBy, BusinessAdministratorGroupId, TaskStakeholderId, suspendUntil, NotStartedReassign …), name -> value */
    taskInputs?: Record<string, string>;
    /** timer: language of timeCycle (e.g. cron) */
    timeCycleLanguage?: string;
    /** call activity: abort the parent when the called process fails */
    abortParent?: boolean;
    /** every OTHER <drools:metaData> on the element (name -> value), kept so a round trip loses nothing */
    metaData?: Record<string, string>;
    reqExtra?: string;
    setVars?: string[];
    rest?: boolean;
    dataInputs?: DataInput[];
    dataOutputs?: DataOutput[];
    multiInstance?: MultiInstance;
    independent?: boolean;
    waitForCompletion?: boolean;
    taskName?: string;
    group?: string;
    skippable?: boolean;
    gatewayDirection?: 'Unspecified' | 'Converging' | 'Diverging' | 'Mixed';
    /** eventBasedGateway: 'Exclusive' | 'Parallel' */
    eventGatewayType?: string;
    instantiate?: boolean;
    /** default outgoing flow id (inclusive/exclusive/complex gateway) */
    default?: string;
    ruleFlowGroup?: string;
    implementation?: string;
    dmnNamespace?: string;
    dmnModel?: string;
    messageRef?: string;
    operationRef?: string;
    eventType?: EventType;
    signalName?: string;
    errorRef?: string;
    escalationRef?: string;
    timeDuration?: string;
    timeCycle?: string;
    timeDate?: string;
    /** conditional event body */
    conditionExpr?: string;
    conditionExprLanguage?: string;
    /** event-subprocess start / boundary interrupting flag */
    isInterrupting?: boolean;
    attachedTo?: string;
    cancelActivity?: boolean;
    /** error ref for the auto event-subprocess (error-start -> terminate) shorthand */
    error?: string;
    /** nested flow nodes (embedded / transaction / event sub-process with children) */
    nodes?: Node[];
    /** nested sequence flows */
    flows?: Flow[];
    isCollection?: boolean;
    dataType?: string;
    raw?: string;
    bpmnLocal?: string;
    /** the WorkItemHandler name (drools:taskName), e.g. "Rest", "Email", a custom handler class's registered name */
    handlerName?: string;
    /** input port name -> literal value, or "$varName" for a process-variable reference */
    workParams?: Record<string, string>;
    /** process variable name -> output port name (e.g. { claimResult: "Result" }) */
    workResultTo?: Record<string, string>;
}
interface ProcessModel {
    id: string;
    name: string;
    packageName?: string;
    processType?: 'None' | 'Public' | 'Private';
    isExecutable?: boolean;
    /** drools:version / drools:adHoc, and the process-level metaData jBPM's designer writes (customSLADueDate, customDescription, others kept) */
    version?: string;
    adHoc?: boolean;
    slaDueDate?: string;
    description?: string;
    metaData?: Record<string, string>;
    /** relative path of the source .bpmn within the project (set by parseProject) */
    sourcePath?: string;
    declarations?: Declarations;
    variables?: Variable[];
    dataObjects?: DataObject[];
    dataStores?: DataStoreRef[];
    lanes?: Lane[];
    nodes: Node[];
    flows: Flow[];
}
interface Gav {
    groupId: string;
    artifactId: string;
    version: string;
    name?: string;
    packaging?: string;
    kieVersion?: string;
}
interface WorkItemHandler {
    name: string;
    resolver: string;
    identifier: string;
}
interface EnvironmentEntry {
    name: string;
    resolver: string;
    identifier: string;
}
interface DeploymentDescriptor {
    persistenceUnit?: string;
    auditPersistenceUnit?: string;
    auditMode?: string;
    persistenceMode?: string;
    runtimeStrategy?: string;
    workItemHandlers?: WorkItemHandler[];
    environmentEntries?: EnvironmentEntry[];
}
/** A work-item definition (a modeler palette entry). parameters/results map name -> DataType short name. */
interface WorkItemDefinition {
    name: string;
    displayName?: string;
    category?: string;
    icon?: string;
    defaultHandler?: string;
    documentation?: string;
    description?: string;
    parameters?: Record<string, string>;
    results?: Record<string, string>;
}
/** Everything a deployable kjar needs beyond the .bpmn files. */
interface ProjectDescriptor {
    gav?: Gav;
    deployment?: DeploymentDescriptor;
    /** work-item definitions (from/for global/WorkDefinitions.wid) */
    workDefinitions?: WorkItemDefinition[];
    /** verbatim asset files (relative path -> content): pom.xml, kmodule.xml, .wid, .drl, .dmn, .java, .frm, … */
    files?: Record<string, string>;
    /** binary files (relative path -> base64) — images, spreadsheets, etc. — carried byte-for-byte */
    binaryFiles?: Record<string, string>;
}
interface Project {
    root: string;
    resourcesRoot?: string;
    descriptor?: ProjectDescriptor;
    processes: ProcessModel[];
}
interface ValidationResult {
    ok: boolean;
    errors: string[];
    warnings: string[];
}

/** Parse ALL processes in a BPMN file (a file may contain more than one <process>). */
declare function parseBpmnAll(xml: string): ProcessModel[];
/** Parse the first process in a BPMN file. Use parseBpmnAll for multi-process files. */
declare function parseBpmn(xml: string): ProcessModel;

declare function serializeProcess(proc: ProcessModel): string;

declare function walk(dir: string, ext: string, out?: string[]): string[];
/** Parse a jBPM project's .bpmn/.bpmn2 files (under src/main/resources) into one model. Real jBPM
 *  projects use both extensions interchangeably — the classic jbpm-playground examples (evaluation,
 *  human-resources, purchases, ...) all use .bpmn2, while newer/bpmn.io-authored files use .bpmn — so
 *  a project importing only one extension silently drops every process built with the other. */
declare function parseProject(projectDir: string): Project;
/**
 * Write a complete project under projectDir: every process's .bpmn PLUS the kjar scaffolding
 * (pom.xml, kmodule.xml, kie-deployment-descriptor.xml, .wid, project.imports/repositories).
 * Pass { scaffold: false } to write only the .bpmn files.
 */
declare function writeProject(project: Project, projectDir: string, opts?: {
    scaffold?: boolean;
}): string[];

/** Best-effort parse of an MVEL WorkDefinitions.wid into work-item definitions. */
declare function parseWid(text: string): WorkItemDefinition[];
/** Generate an MVEL WorkDefinitions.wid from a list of work-item definitions. */
declare function widMvel(defs: WorkItemDefinition[]): string;
declare function parseDescriptor(projectDir: string): ProjectDescriptor;
declare function pomXml(gav: Gav): string;
declare const KMODULE_XML = "<kmodule xmlns=\"http://www.drools.org/xsd/kmodule\" xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\"/>\n";
declare const PROJECT_IMPORTS: string;
declare const PROJECT_REPOSITORIES = "<project-repositories>\n  <repositories>\n    <repository>\n      <include>true</include>\n      <metadata>\n        <id>central</id>\n        <url>https://repo.maven.apache.org/maven2</url>\n        <source>PROJECT</source>\n      </metadata>\n    </repository>\n    <repository>\n      <include>true</include>\n      <metadata>\n        <id>redhat-ga-repository</id>\n        <url>https://maven.repository.redhat.com/ga/</url>\n        <source>SETTINGS</source>\n      </metadata>\n    </repository>\n  </repositories>\n</project-repositories>\n";
declare function deploymentXml(dd: DeploymentDescriptor): string;
/** Write the scaffolding files (verbatim where captured, generated from templates otherwise). */
declare function writeDescriptor(descriptor: ProjectDescriptor | undefined, projectDir: string): string[];

/** Structural validation of a process model (same checks used to generate this project). */
declare function validateModel(proc: ProcessModel): ValidationResult;

/**
 * Derive every node's `incoming`/`outgoing` from the process's `flows` (recursing sub-processes),
 * so authors only declare flows. Mutates and returns the process.
 */
declare function autowire(p: ProcessModel): ProcessModel;

type AssetKind = 'drl' | 'dmn' | 'dsl' | 'enumeration' | 'guidedDecisionTable' | 'guidedDecisionTree' | 'guidedRule' | 'guidedRuleTemplate' | 'scoreCard' | 'testScenario' | 'testScenarioLegacy' | 'form' | 'dataObject' | 'workItemDefinition' | 'properties' | 'solver' | 'xml' | 'text';
declare function assetKind(pathOrName: string): AssetKind;
interface Asset {
    kind: AssetKind;
    path?: string;
    model: any;
}
declare function parseProperties(text: string): Record<string, string>;
declare function writeProperties(props: Record<string, string>): string;
declare function parseEnumeration(text: string): Record<string, string[]>;
declare function writeEnumeration(enums: Record<string, string[]>): string;
interface DslEntry {
    scope: string;
    nl: string;
    mapping: string;
}
declare function parseDsl(text: string): DslEntry[];
declare function writeDsl(entries: DslEntry[]): string;
interface JavaField {
    name: string;
    type: string;
}
interface DataObjectModel {
    package?: string;
    className: string;
    fields: JavaField[];
    raw?: string;
}
declare function parseDataObject(text: string): DataObjectModel;
declare function writeDataObject(m: DataObjectModel): string;
type ConstraintOp = '==' | '!=' | '>' | '>=' | '<' | '<=' | 'contains' | 'not contains' | 'memberOf' | 'not memberOf' | 'matches' | 'not matches' | 'soundslike' | 'in' | 'not in';
type RuleConstraint = {
    field: string;
    op: ConstraintOp;
    value: string | number | boolean | Array<string | number | boolean>;
} | {
    field: string;
    op: ConstraintOp;
    var: string;
} | {
    bind: string;
    field: string;
} | {
    raw: string;
};
interface RulePattern {
    fact: string;
    bind?: string;
    constraints?: RuleConstraint[];
    from?: string;
    entryPoint?: string;
}
type LhsElement = RulePattern | {
    and: LhsElement[];
} | {
    or: LhsElement[];
} | {
    not: LhsElement;
} | {
    exists: LhsElement;
} | {
    forall: LhsElement[];
} | {
    eval: string;
} | {
    collect: {
        pattern: RulePattern;
        source: LhsElement | string;
    };
} | {
    accumulate: {
        source: LhsElement | string;
        bindings: Array<{
            bind?: string;
            fn: string;
            arg: string;
        }>;
    };
} | {
    raw: string;
};
type RhsValue = string | number | boolean | {
    expr: string;
};
type RuleAction = {
    modify: string;
    set: Record<string, RhsValue>;
} | {
    update: string;
    set: Record<string, RhsValue>;
} | {
    insert: string;
} | {
    insertLogical: string;
} | {
    delete: string;
} | {
    retract: string;
} | {
    call: string;
    args?: Array<string | number | boolean>;
} | {
    raw: string;
};
interface RuleAttributes {
    salience?: number;
    enabled?: boolean;
    dialect?: 'java' | 'mvel';
    ruleflowGroup?: string;
    agendaGroup?: string;
    activationGroup?: string;
    autoFocus?: boolean;
    lockOnActive?: boolean;
    noLoop?: boolean;
    dateEffective?: string;
    dateExpires?: string;
    duration?: number;
    timer?: string;
    calendars?: string[];
}
interface DrlParam {
    type: string;
    name: string;
}
interface DrlFunction {
    name: string;
    returnType?: string;
    params?: DrlParam[];
    body: string;
}
interface DrlDeclareField {
    name: string;
    type: string;
    annotations?: string[];
}
interface DrlDeclare {
    name: string;
    extends?: string;
    annotations?: string[];
    fields: DrlDeclareField[];
}
interface DrlQuery {
    name: string;
    params?: DrlParam[];
    when: string | LhsElement[];
}
interface DrlRule {
    name: string;
    extends?: string;
    meta?: string[];
    attributes?: string[];
    attrs?: RuleAttributes;
    when: string | LhsElement[];
    then: string | RuleAction[];
}
interface DrlModel {
    package?: string;
    unit?: string;
    imports: string[];
    staticImports?: string[];
    functionImports?: string[];
    globals: string[];
    functions?: (DrlFunction | string)[];
    declares?: (DrlDeclare | string)[];
    queries?: (DrlQuery | string)[];
    rules: DrlRule[];
}
declare function compileConstraint(c: RuleConstraint): string;
declare function compilePattern(p: RulePattern): string;
declare function compileLhs(el: LhsElement): string;
declare function compileAction(a: RuleAction): string;
declare function compileFunction(f: DrlFunction | string): string;
declare function compileDeclare(d: DrlDeclare | string): string;
declare function compileQuery(q: DrlQuery | string): string;
declare function parseDrl(text: string): DrlModel;
declare function writeDrl(m: DrlModel): string;
declare function parseForm(text: string): any;
declare function writeForm(model: any): string;
declare function parseAsset(path: string, content: string): Asset;
declare function buildAsset(asset: Asset): string;

interface ElementNode {
    name: string;
    attrs: Record<string, string>;
    children: ElementNode[];
    text: string;
    cdata: string[];
}

type Lang = 'js' | 'java' | 'mvel';
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'HEAD' | 'OPTIONS';
type GatewayMode = 'exclusive' | 'parallel' | 'inclusive' | 'event' | 'complex';
interface EngineTypeField {
    name: string;
    type: string;
    list?: boolean;
}
interface EngineType {
    name: string;
    package?: string;
    fields?: EngineTypeField[];
}
interface EngineVar {
    name: string;
    type: string; /** jBPM variable tags: required, readonly, restricted */
    tags?: string[];
}
interface EngineFlow {
    id?: string;
    from: string;
    to: string;
    when?: string;
    lang?: Lang;
}
interface TimerSpec {
    duration?: string;
    cycle?: string;
    date?: string;
}
/** An event trigger — exactly one of the fields is set (per position it's start/catch/throw/boundary). */
interface EventDef {
    signal?: string;
    message?: string;
    error?: string;
    escalation?: string;
    condition?: string;
    lang?: Lang;
    timer?: TimerSpec | string;
    /** Throw-side only (throw/send/end): a $var reference (e.g. "$claimId") resolved against the
     *  instance's variables and used to narrow delivery to only the waiting instance(s) whose OWN
     *  correlationKey (set at start()) matches — see execution-engine.ts's broadcast(). Omit for the
     *  default "deliver to every instance waiting on this name" behavior. */
    correlationKey?: string;
}
interface Base {
    id?: string;
    name?: string;
}
interface WithLifecycle {
    onEntry?: string;
    onExit?: string;
    onEntryLang?: Lang;
    onExitLang?: Lang;
    /** jBPM "Is Async" (customAsync) and "SLA Due Date" (customSLADueDate); asyncRetries / asyncRetryDelay are this engine's own, kept as metaData */
    async?: boolean;
    slaDueDate?: string;
    asyncRetries?: number;
    asyncRetryDelay?: string;
}
interface EngineStart extends Base {
    type: 'start';
    on?: EventDef;
}
interface EngineEnd extends Base {
    type: 'end';
    result?: 'terminate';
    throw?: EventDef;
}
interface EngineScript extends Base {
    type: 'script';
    lang?: Lang;
    code: string;
}
interface EngineHttp extends Base {
    type: 'http';
    method?: HttpMethod;
    url: string;
    headers?: Record<string, string>;
    body?: Record<string, string | number | boolean>;
    resultTo?: Record<string, string>;
    /** wrapper-script dialect for the generated jBPM onEntry/onExit (default 'java') */
    lang?: Lang;
    /** extra script appended to the onExit wrapper (same dialect); also honored by the Node engine after resultTo, with `resPayload` in scope */
    exitScript?: string;
}
interface EngineCall extends Base, WithLifecycle {
    type: 'call';
    process: string;
    inputs?: Record<string, string>;
    outputs?: Record<string, string>;
}
interface EngineForEach extends Base, WithLifecycle {
    type: 'forEach';
    process: string;
    over: string;
    as?: string;
    collectInto?: string;
    itemResult?: string;
    parallel?: boolean;
    pass?: string[];
}
interface EngineUserTask extends Base, WithLifecycle {
    type: 'userTask';
    group?: string;
    assignee?: string;
    form?: string;
    skippable?: boolean;
    businessAdmin?: string;
    excludedOwners?: string[];
    priority?: number;
    /** ISO duration/date/cycle (same shape as TimerSpec) or a plain ISO duration string, e.g. "PT8H". */
    dueDate?: TimerSpec | string;
}
interface EngineRule extends Base, WithLifecycle {
    type: 'rule';
    ruleflowGroup?: string;
    dmn?: {
        namespace: string;
        model: string;
        decision: string;
    };
}
interface EngineSend extends Base, WithLifecycle {
    type: 'send';
    message: string;
    implementation?: string;
    /** $var reference — see EventDef.correlationKey's doc comment (same semantics, throw-side field). */
    correlationKey?: string;
}
interface EngineReceive extends Base, WithLifecycle {
    type: 'receive';
    message: string;
    implementation?: string;
}
interface EngineManual extends Base, WithLifecycle {
    type: 'manual';
}
interface EngineGateway extends Base {
    type: 'gateway';
    mode: GatewayMode;
    default?: string;
    direction?: 'Diverging' | 'Converging';
}
interface EngineCatch extends Base {
    type: 'catch';
    event: EventDef;
}
interface EngineThrow extends Base {
    type: 'throw';
    event: EventDef;
}
interface EngineBoundary extends Base {
    type: 'boundary';
    on: string | string[];
    event: EventDef;
    interrupting?: boolean;
}
interface EngineSubprocess extends Base, WithLifecycle {
    type: 'subprocess';
    transaction?: boolean;
    on?: {
        error?: string;
    };
    nodes: EngineNode[];
    flows: EngineFlow[];
}
interface EngineRaw extends Base {
    type: 'raw';
    raw?: string;
}
interface EngineWorkItem extends Base, WithLifecycle {
    type: 'workItem';
    handler: string;
    params?: Record<string, string | number | boolean>;
    resultTo?: Record<string, string>;
}
type EngineNode = EngineStart | EngineEnd | EngineScript | EngineHttp | EngineCall | EngineForEach | EngineUserTask | EngineRule | EngineSend | EngineReceive | EngineManual | EngineGateway | EngineCatch | EngineThrow | EngineBoundary | EngineSubprocess | EngineWorkItem | EngineRaw;
interface EngineProcess {
    id: string;
    name?: string;
    package?: string;
    /** process-level properties (jBPM version / ad-hoc / SLA due date / instance description template) */
    version?: string;
    adHoc?: boolean;
    slaDueDate?: string;
    description?: string;
    types?: EngineType[];
    vars?: EngineVar[];
    lanes?: {
        id?: string;
        name?: string;
        nodes: string[];
    }[];
    data?: {
        id?: string;
        name?: string;
        type?: string;
        collection?: boolean;
    }[];
    /** error declarations: a bare string (id = code), or { name, code } when the BPMN error id differs from its errorCode */
    signals?: string[];
    errors?: Array<string | {
        name: string;
        code: string;
    }>;
    messages?: string[];
    escalations?: string[];
    nodes: EngineNode[];
    flows: EngineFlow[];
}
interface EngineDeployment {
    runtime?: string;
    env?: Record<string, string>;
    handlers?: string[];
}
type CondOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'notIn' | 'contains' | 'notContains' | 'matches' | 'memberOf';
type CondValue = string | number | boolean | Array<string | number | boolean>;
interface CondRef {
    ref: string;
}
type WhereSpec = CondValue | CondRef | Partial<Record<CondOp, CondValue | CondRef>>;
interface EngineWhen {
    fact: string;
    as?: string;
    where?: Record<string, WhereSpec>;
    exists?: boolean;
    not?: boolean;
}
type EngineThen = {
    set: string;
    fields: Record<string, string | number | boolean>;
} | {
    insert: string;
    fields?: Record<string, string | number | boolean>;
} | {
    delete: string;
} | {
    call: string;
    args?: Array<string | number | boolean>;
};
interface EngineRuleDef {
    name: string;
    priority?: number;
    noLoop?: boolean;
    when: EngineWhen[];
    then: EngineThen[];
}
interface EngineRuleset {
    group: string;
    package?: string;
    path?: string;
    rules: EngineRuleDef[];
}
type FeelType = 'number' | 'string' | 'boolean' | 'date' | 'time' | 'dateTime' | 'any';
type HitPolicy = 'UNIQUE' | 'FIRST' | 'ANY' | 'PRIORITY' | 'COLLECT' | 'RULE ORDER' | 'OUTPUT ORDER';
type Aggregation = 'SUM' | 'MIN' | 'MAX' | 'COUNT';
interface DecisionField {
    name: string;
    type?: FeelType;
}
type InputTest = string | number | boolean | Array<string | number | boolean> | {
    gt: number | string;
} | {
    gte: number | string;
} | {
    lt: number | string;
} | {
    lte: number | string;
} | {
    between: [number | string, number | string];
} | {
    in: Array<string | number | boolean>;
} | {
    not: string | number | boolean | Array<string | number | boolean>;
} | {
    any: true;
} | {
    feel: string;
};
type OutputResult = string | number | boolean | {
    feel: string;
};
interface DecisionRule {
    when: Record<string, InputTest>;
    then: Record<string, OutputResult>;
}
interface EngineDecision {
    name: string;
    hitPolicy?: HitPolicy;
    aggregation?: Aggregation;
    inputs: DecisionField[];
    outputs: DecisionField[];
    rules: DecisionRule[];
}
interface EngineDecisionModel {
    name: string;
    namespace?: string;
    path?: string;
    decisions: EngineDecision[];
}
type GdstOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';
interface GdstCondition {
    field: string;
    op: GdstOp;
    type?: FeelType;
}
interface GdstAction {
    field: string;
    type?: FeelType;
}
interface GdstRow {
    when: Record<string, string | number | boolean>;
    then: Record<string, string | number | boolean>;
}
interface EngineGuidedTable {
    name: string;
    package?: string;
    path?: string;
    fact: string;
    bind?: string;
    conditions: GdstCondition[];
    actions: GdstAction[];
    rows: GdstRow[];
}
interface EngineGuidedRule {
    name: string;
    package?: string;
    path?: string;
    priority?: number;
    noLoop?: boolean;
    when: EngineWhen[];
    then: EngineThen[];
}
interface EngineGuidedRuleTemplate {
    name: string;
    package?: string;
    path?: string;
    priority?: number;
    noLoop?: boolean;
    when: EngineWhen[];
    then: EngineThen[];
    rows: Record<string, string | number | boolean>[];
}
type ScoreMatch = string | number | boolean | {
    between: [number, number];
} | Partial<Record<GdstOp, string | number | boolean>>;
interface ScoreBand {
    when?: ScoreMatch;
    points: number;
}
interface ScoreCharacteristic {
    field: string;
    bands: ScoreBand[];
}
interface EngineScorecard {
    name: string;
    package?: string;
    path?: string;
    fact: string;
    score: string;
    baseline?: number;
    characteristics: ScoreCharacteristic[];
}
interface TestCase {
    name?: string;
    given: Record<string, string | number | boolean>;
    expect: Record<string, string | number | boolean>;
}
interface EngineTestSuite {
    name: string;
    path?: string;
    target: string;
    cases: TestCase[];
}
interface GdtAction {
    set: string;
    value: string | number | boolean;
}
interface GdtBranch {
    op: GdstOp;
    value: string | number | boolean;
    then: GdtNode | GdtAction[];
}
interface GdtNode {
    field: string;
    branches: GdtBranch[];
}
interface EngineDecisionTree {
    name: string;
    package?: string;
    path?: string;
    fact: string;
    root: GdtNode;
}
type FormWidget = 'text' | 'textarea' | 'integer' | 'number' | 'decimal' | 'checkbox' | 'boolean' | 'dropdown' | 'select' | 'radio' | 'date';
interface FormField {
    bind: string;
    label?: string;
    widget?: FormWidget;
    required?: boolean;
    readOnly?: boolean;
    placeholder?: string;
}
interface EngineForm {
    name: string;
    type?: string;
    path?: string;
    fields: FormField[];
}
interface EngineEnum {
    type: string;
    field: string;
    values: string[];
}
interface EngineProject {
    id?: string;
    gav?: Gav;
    deployment?: EngineDeployment;
    types?: EngineType[];
    assets?: Record<string, {
        kind: string;
        model: any;
    } | string>;
    /** non-BPM binary files (icons, PDFs, decision-table spreadsheets, …), base64-encoded, path -> content */
    binaryAssets?: Record<string, string>;
    rulesets?: EngineRuleset[];
    decisions?: EngineDecisionModel[];
    guidedTables?: EngineGuidedTable[];
    guidedRules?: EngineGuidedRule[];
    guidedRuleTemplates?: EngineGuidedRuleTemplate[];
    scorecards?: EngineScorecard[];
    tests?: EngineTestSuite[];
    decisionTrees?: EngineDecisionTree[];
    forms?: EngineForm[];
    enumerations?: EngineEnum[];
    workItems?: WorkItemDefinition[];
    dsl?: DslEntry[];
    messages?: Record<string, Record<string, string>>;
    processes: EngineProcess[];
}
declare const DEFAULT_WORK_ITEMS: WorkItemDefinition[];
/** name -> Java FQN. Primitives map to boxed jBPM structureRefs; declared type names -> FQN. */
declare function makeTypeResolver(types?: EngineType[]): (type: string) => string;
/** Convert one engine process to a jBPM ProcessModel. */
declare function fromEngine(ep: EngineProcess, sharedTypes?: EngineType[]): ProcessModel;
/**
 * Simple engine ruleset -> jBPM DrlModel. The SDK fills everything jBPM-specific: `resolve` maps fact
 * NAMES to FQNs (and those become `import`s), `pkg` is the rule package, `rs.group` becomes each rule's
 * `ruleflow-group`, and field/op/value + set/insert/delete/call become DRL patterns/actions. The engine
 * JSON stays free of packages, FQNs and Drools syntax.
 */
declare function rulesToDrl(rs: EngineRuleset, resolve?: (t: string) => string, pkg?: string): DrlModel;
/** one engine InputTest -> a FEEL unary test (the text of a decision-table input entry). */
declare function feelTest(test: InputTest): string;
/** one engine OutputResult -> a FEEL literal/expression (the text of an output entry). */
declare function feelResult(r: OutputResult): string;
/**
 * Simple engine decision model -> a jBPM/Kogito DMN 1.2 document (as the `{ xml }` asset model).
 * Synthesizes definitions/inputData/informationRequirement/decisionTable, compiles each cell to FEEL,
 * maps types to FEEL typeRefs, and sets hitPolicy/aggregation. buildAsset({kind:'dmn', model}) serialises.
 */
declare function decisionToDmn(model: EngineDecisionModel, namespace?: string): {
    xml: ElementNode;
};
/** Inverse of feelTest: a decision table input-entry's raw FEEL text -> engine InputTest. Anything
 *  outside this small grammar (a real FEEL expression, function call, etc.) becomes `{feel: text}` —
 *  testMatch() (decisioning.ts) already treats that as an unconditional match, same fallback feelTest
 *  itself uses on the way out, so round-tripping an unrecognized cell doesn't silently misfire. */
declare function parseFeelTest(text: string): InputTest;
/** Inverse of feelResult: an output-entry's raw FEEL text -> engine OutputResult. */
declare function parseFeelResult(text: string): OutputResult;
/** A parsed DMN <definitions> XML tree -> an EngineDecisionModel, keeping only decisionTable-driven
 *  decisions (see dmnDecisionFromXml). Returns undefined if the file declares no such decision at
 *  all (e.g. every decision uses a literalExpression) — nothing usable to wire up. */
declare function dmnToDecisionModel(defsXml: ElementNode): EngineDecisionModel | undefined;
/**
 * Engine guided table -> a Business Central guided decision table (`decision-table52`, EXTENDED_ENTRY).
 * Condition columns become `fact.field <op>`, action columns become `set fact.field`, each row supplies
 * the per-cell values. It compiles to DRL in Business Central (row order = rule order). buildAsset
 * ({kind:'guidedDecisionTable', model}) serialises the returned `{ xml }`.
 */
declare function decisionTableToGdst(m: EngineGuidedTable, pkg?: string, fieldTypes?: Record<string, string>): {
    xml: ElementNode;
};
/**
 * Engine decision tree -> a Business Central guided decision tree (`GuidedDecisionTree` XML). Each node
 * tests a field; each branch (op+value) becomes a constraint node whose children are either an action
 * (set-field) leaf or nested constraints. Best-effort XML (well-formed; BC-load not verified). It
 * compiles to DRL in Business Central. buildAsset({kind:'guidedDecisionTree', model}) serialises it.
 */
declare function decisionTreeToGdt(tree: EngineDecisionTree, fieldTypes?: Record<string, string>, resolve?: (t: string) => string): {
    xml: ElementNode;
};
/**
 * Engine guided rule -> a Business Central guided rule (`RuleModel` `.rdrl` XML): fact patterns with
 * field constraints (LHS) + set/insert/delete actions (RHS), from the same `when`/`then` a DRL ruleset
 * rule uses. Best-effort XML (well-formed; BC-load not verified) — it compiles to DRL in BC, and the
 * same rule engine executes it. buildAsset({kind:'guidedRule', model}) serialises it.
 */
declare function ruleToRdrl(rule: EngineGuidedRule, fieldTypes?: Record<string, string>): {
    xml: ElementNode;
};
/**
 * Engine guided rule template -> a Business Central guided rule template (`TemplateModel` `.template`
 * XML): the rule skeleton (reusing ruleToRdrl — `{param}` values pass through as markers) + the
 * parameter columns + the data rows. Best-effort XML (well-formed; BC-load not verified). It expands to
 * N DRL rules in BC; the runtime `expandTemplate` does the same for a Node engine.
 */
declare function templateToTemplateXml(tmpl: EngineGuidedRuleTemplate, fieldTypes?: Record<string, string>): {
    xml: ElementNode;
};
declare function scorecardToScgd(sc: EngineScorecard, fieldTypes?: Record<string, string>, resolve?: (t: string) => string): {
    xml: ElementNode;
};
/**
 * Engine test suite -> a Business Central test scenario (`ScenarioSimulationModel` `.scesim` XML): GIVEN
 * columns per input + EXPECT columns per output, then one Scenario row per case. Best-effort XML
 * (well-formed; BC-load not verified). The cases also run directly in Node (functions/test-scenario.mjs).
 */
declare function testSuiteToScesim(suite: EngineTestSuite): {
    xml: ElementNode;
};
/**
 * Engine form -> a Business Central form definition (`.frm` JSON model). `type` -> model.className
 * (via resolve), each field -> a bound input whose `code` is the explicit `widget` or one derived from
 * the field's type (`fieldTypes`). buildAsset({kind:'form', model}) serialises the `{ json }`.
 */
declare function formToFrm(form: EngineForm, fieldTypes?: Record<string, string>, resolve?: (t: string) => string): {
    json: unknown;
};
/** Engine enums -> the jBPM `.enumeration` map ( 'Type.field' -> values ). */
declare function enumerationsToModel(enums: EngineEnum[]): {
    enums: Record<string, string[]>;
};
/** Convert a whole engine project to an SDK Project (processes + kjar descriptor + generated .java). */
declare function fromEngineProject(ep: EngineProject): Project;
/**
 * Reverse of fromEngineProject: a jBPM Project -> engine model, recovering assets as STRUCTURED
 * engine models (via parseAsset) and .java data objects as engine `types` (best-effort).
 */
declare function toEngineProject(project: Project): EngineProject;
declare function toEngine(m: ProcessModel): EngineProcess;

declare const DEFINITIONS_ATTRS: string;
declare const REST_INPUTS: readonly ["AcceptCharset", "AcceptHeader", "AuthType", "AuthUrl", "ConnectTimeout", "ContentData", "ContentType", "ContentTypeCharset", "HandleResponseErrors", "Headers", "Method", "Password", "ReadTimeout", "ResultClass", "Url", "Username"];
declare const JAVA = "http://www.java.com/java";
declare const ENUMS: {
    readonly gatewayDirection: readonly ["Unspecified", "Converging", "Diverging", "Mixed"];
    readonly processType: readonly ["None", "Public", "Private"];
    readonly method: readonly ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
    readonly scriptFormat: readonly ["http://www.java.com/java", "http://www.mvel.org/2.0"];
    readonly eventType: readonly ["none", "message", "timer", "signal", "error", "escalation", "conditional", "compensation", "cancel", "link", "terminate", "multiple", "parallelMultiple"];
    readonly workItem: readonly ["Rest", "WebService", "Email", "Log", "Milestone", "BusinessRuleTask", "DecisionTask"];
    readonly structureRef: readonly ["String", "Integer", "Float", "Boolean", "Object", "java.lang.String", "java.lang.Integer", "java.lang.Long", "java.lang.Float", "java.lang.Double", "java.lang.Boolean", "java.lang.Object", "java.util.List", "java.util.Map", "java.util.Date"];
    readonly fromKind: readonly ["variable", "constant", "expression", "loopItem", "loopOutputItem"];
};
declare const BUILTIN_ERRORS: {
    readonly WORK_ITEM: "org.jbpm.bpmn2.handler.WorkItemHandlerRuntimeException";
    readonly TERMINATE: "TERMINATE_CASE";
};

declare const constants_BUILTIN_ERRORS: typeof BUILTIN_ERRORS;
declare const constants_DEFINITIONS_ATTRS: typeof DEFINITIONS_ATTRS;
declare const constants_ENUMS: typeof ENUMS;
declare const constants_JAVA: typeof JAVA;
declare const constants_REST_INPUTS: typeof REST_INPUTS;
declare namespace constants {
  export { constants_BUILTIN_ERRORS as BUILTIN_ERRORS, constants_DEFINITIONS_ATTRS as DEFINITIONS_ATTRS, constants_ENUMS as ENUMS, constants_JAVA as JAVA, constants_REST_INPUTS as REST_INPUTS };
}

export { type Aggregation, type Asset, type AssetKind, type CondOp, type CondRef, type CondValue, type ConstraintOp, DEFAULT_WORK_ITEMS, type DataFromKind, type DataInput, type DataObject, type DataObjectModel, type DataOutput, type DataStoreRef, type DecisionField, type DecisionRule, type Declarations, type DeploymentDescriptor, type DrlDeclare, type DrlDeclareField, type DrlFunction, type DrlModel, type DrlParam, type DrlQuery, type DrlRule, type DslEntry, type EngineBoundary, type EngineCall, type EngineCatch, type EngineDecision, type EngineDecisionModel, type EngineDecisionTree, type EngineDeployment, type EngineEnd, type EngineEnum, type EngineFlow, type EngineForEach, type EngineForm, type EngineGateway, type EngineGuidedRule, type EngineGuidedRuleTemplate, type EngineGuidedTable, type EngineHttp, type EngineManual, type EngineNode, type EngineProcess, type EngineProject, type EngineRaw, type EngineReceive, type EngineRule, type EngineRuleDef, type EngineRuleset, type EngineScorecard, type EngineScript, type EngineSend, type EngineStart, type EngineSubprocess, type EngineTestSuite, type EngineThen, type EngineThrow, type EngineType, type EngineTypeField, type EngineUserTask, type EngineVar, type EngineWhen, type EngineWorkItem, type EnvironmentEntry, type ErrorDecl, type EscalationDecl, type EventDef, type EventType, type FeelType, type Flow, type FormField, type FormWidget, type GatewayMode, type Gav, type GdstAction, type GdstCondition, type GdstOp, type GdstRow, type GdtAction, type GdtBranch, type GdtNode, type HitPolicy, type HttpMethod, type InputTest, type JavaField, KMODULE_XML, type Lane, type Lang, type LhsElement, type MessageDecl, type MultiInstance, type Node, type NodeType, type OutputResult, PROJECT_IMPORTS, PROJECT_REPOSITORIES, type Position, type ProcessModel, type Project, type ProjectDescriptor, type RhsValue, type RuleAction, type RuleAttributes, type RuleConstraint, type RulePattern, type ScoreBand, type ScoreCharacteristic, type ScoreMatch, type SignalDecl, type TestCase, type TimerSpec, type ValidationResult, type Variable, type Waypoint, type WhereSpec, type WorkItemDefinition, type WorkItemHandler, assetKind, autowire, buildAsset, compileAction, compileConstraint, compileDeclare, compileFunction, compileLhs, compilePattern, compileQuery, constants, decisionTableToGdst, decisionToDmn, decisionTreeToGdt, deploymentXml, dmnToDecisionModel, enumerationsToModel, feelResult, feelTest, formToFrm, fromEngine, fromEngineProject, makeTypeResolver, parseAsset, parseBpmn, parseBpmnAll, parseDataObject, parseDescriptor, parseDrl, parseDsl, parseEnumeration, parseFeelResult, parseFeelTest, parseForm, parseProject, parseProperties, parseWid, pomXml, ruleToRdrl, rulesToDrl, scorecardToScgd, serializeProcess, templateToTemplateXml, testSuiteToScesim, toEngine, toEngineProject, validateModel, walk, widMvel, writeDataObject, writeDescriptor, writeDrl, writeDsl, writeEnumeration, writeForm, writeProject, writeProperties };
