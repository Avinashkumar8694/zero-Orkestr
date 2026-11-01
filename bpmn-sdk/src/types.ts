// Public model types for the BPMN <-> JSON SDK.
// Mirrors docs/bpm-nodes/ node.json shapes and _mappings-reference.md vocabulary.

export type NodeType =
  | 'startEvent' | 'endEvent' | 'scriptTask' | 'userTask' | 'callActivity'
  | 'exclusiveGateway' | 'parallelGateway' | 'inclusiveGateway' | 'eventBasedGateway' | 'complexGateway'
  | 'businessRuleTask' | 'sendTask' | 'receiveTask' | 'manualTask'
  | 'boundaryEvent' | 'intermediateCatchEvent' | 'intermediateThrowEvent'
  | 'subProcess' | 'genericTask' | 'raw';

export type EventType =
  | 'none' | 'message' | 'timer' | 'signal' | 'error' | 'escalation'
  | 'conditional' | 'compensation' | 'cancel' | 'link' | 'terminate';

export type DataFromKind = 'variable' | 'constant' | 'expression' | 'loopItem' | 'loopOutputItem';

export interface Variable {
  name: string;
  /** jBPM variable tags (customTags): required, readonly, restricted … */
  tags?: string[];
  /** structureRef, e.g. "String", "java.util.List", "java.lang.Boolean", or a FQCN */
  type: string;
}

export interface SignalDecl { id: string; name: string; }
export interface ErrorDecl { id: string; errorCode: string; }
export interface MessageDecl { id: string; name?: string; itemRef?: string; }
export interface EscalationDecl { id: string; escalationCode?: string; name?: string; }
export interface Declarations {
  signals: SignalDecl[];
  errors: ErrorDecl[];
  messages?: MessageDecl[];
  escalations?: EscalationDecl[];
}

export interface DataObject { id: string; name?: string; type?: string; isCollection?: boolean; }
export interface DataStoreRef { id: string; name?: string; dataStoreRef?: string; }
export interface Lane { id: string; name?: string; flowNodeRefs: string[]; }

export interface Position { x: number; y: number; width: number; height: number; expanded?: boolean; }
export interface Waypoint { x: number; y: number; }

export interface Flow {
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

export interface DataInput { name: string; from?: DataFromKind; value?: string; }
export interface DataOutput { name: string; to?: string; from?: DataFromKind; }

export interface MultiInstance {
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
export interface Node {
  id: string;
  name?: string;
  type: NodeType;
  subtype?: string;
  incoming?: string[];
  outgoing?: string[];
  position?: Position;

  // scriptTask
  script?: string;
  /** script dialect URI; defaults to Java. e.g. http://www.java.com/java, http://www.mvel.org/2.0, JavaScript */
  scriptFormat?: string;

  // callActivity (rest | reusable | multiInstance)
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

  // userTask
  taskName?: string;
  group?: string;
  skippable?: boolean;

  // gateways
  gatewayDirection?: 'Unspecified' | 'Converging' | 'Diverging' | 'Mixed';
  /** eventBasedGateway: 'Exclusive' | 'Parallel' */
  eventGatewayType?: string;
  instantiate?: boolean;
  /** default outgoing flow id (inclusive/exclusive/complex gateway) */
  default?: string;

  // businessRule / send / receive / manual tasks
  ruleFlowGroup?: string;
  implementation?: string;
  // businessRuleTask, implementation="http://www.jboss.org/drools/dmn" only: real jBPM/PAM passes the
  // DMN namespace/model as literal dataInputAssociation values (dataInput names "namespace"/"model"),
  // not static XML attributes — see parse.ts's businessRuleTask case.
  dmnNamespace?: string;
  dmnModel?: string;
  messageRef?: string;
  operationRef?: string;

  // events (start / intermediate catch|throw / end / boundary)
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

  // boundaryEvent
  attachedTo?: string;
  cancelActivity?: boolean;

  // subProcess: 'event' | 'embedded' | 'transaction'
  /** error ref for the auto event-subprocess (error-start -> terminate) shorthand */
  error?: string;
  /** nested flow nodes (embedded / transaction / event sub-process with children) */
  nodes?: Node[];
  /** nested sequence flows */
  flows?: Flow[];

  // dataObject
  isCollection?: boolean;
  dataType?: string;

  // raw (verbatim passthrough for unmodeled elements)
  raw?: string;
  bpmnLocal?: string;

  // genericTask: <bpmn2:task drools:taskName="X"> — jBPM's generic custom-WorkItemHandler task
  // (e.g. the built-in "Rest" REST work item, or any customer WorkItemHandler bound by name).
  /** the WorkItemHandler name (drools:taskName), e.g. "Rest", "Email", a custom handler class's registered name */
  handlerName?: string;
  /** input port name -> literal value, or "$varName" for a process-variable reference */
  workParams?: Record<string, string>;
  /** process variable name -> output port name (e.g. { claimResult: "Result" }) */
  workResultTo?: Record<string, string>;
}

export interface ProcessModel {
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

export interface Gav {
  groupId: string;
  artifactId: string;
  version: string;
  name?: string;
  packaging?: string;
  kieVersion?: string;
}
export interface WorkItemHandler { name: string; resolver: string; identifier: string; }
export interface EnvironmentEntry { name: string; resolver: string; identifier: string; }
export interface DeploymentDescriptor {
  persistenceUnit?: string;
  auditPersistenceUnit?: string;
  auditMode?: string;
  persistenceMode?: string;
  runtimeStrategy?: string;
  workItemHandlers?: WorkItemHandler[];
  environmentEntries?: EnvironmentEntry[];
}
/** A work-item definition (a modeler palette entry). parameters/results map name -> DataType short name. */
export interface WorkItemDefinition {
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
export interface ProjectDescriptor {
  gav?: Gav;
  deployment?: DeploymentDescriptor;
  /** work-item definitions (from/for global/WorkDefinitions.wid) */
  workDefinitions?: WorkItemDefinition[];
  /** verbatim asset files (relative path -> content): pom.xml, kmodule.xml, .wid, .drl, .dmn, .java, .frm, … */
  files?: Record<string, string>;
  /** binary files (relative path -> base64) — images, spreadsheets, etc. — carried byte-for-byte */
  binaryFiles?: Record<string, string>;
}

export interface Project {
  root: string;
  resourcesRoot?: string;
  descriptor?: ProjectDescriptor;
  processes: ProcessModel[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}
