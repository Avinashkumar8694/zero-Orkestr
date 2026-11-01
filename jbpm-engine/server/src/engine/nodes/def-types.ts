// UI config that lives next to each node's backend handler. A node folder holds:
//   def.ts     — palette entries + property schema (what the UI shows)
//   handler.ts — the backend runtime logic (what the engine runs)
// The catalog endpoint serves these defs to the app; the engine dispatches to the handlers.
export type Widget =
  | 'text' | 'number' | 'bool' | 'select' | 'code' | 'textarea'
  | 'keyval' | 'stringlist' | 'event' | 'timer' | 'nodes' | 'assetRef' | 'processRef' | 'varRef';

/** Where a variable-name suggestion list is drawn from, for widgets 'varRef' and the key/value sides
 *  of a 'keyval' field (via `keySource`/`valueSource`):
 *   - 'own'       this process's own declared variables (process.vars) — free text still allowed.
 *   - 'ownRef'    same list, but each suggestion is offered pre-fixed with "$" (the convention this
 *                 engine uses everywhere for "read this process variable" — see call/http/workItem
 *                 handlers), so picking one fills in "$name" directly.
 *   - 'called'    the OTHER process's declared variables — only meaningful on 'call'/'forEach', whose
 *                 `process` field names that other process; resolved client-side once one is picked. */
export type VarSource = 'own' | 'ownRef' | 'called';

/** `assetKind` is required on (and only meaningful for) widget 'assetRef' — it names which of the
 *  project's asset kinds (see assets/index.ts's ASSET_KINDS, e.g. 'forms', 'rulesets', 'decisions')
 *  this field points into. The UI renders it as a free-text field with autocomplete suggestions
 *  drawn from that kind's real asset names — not a hard-locked dropdown, since the target asset may
 *  not exist yet (the author can create it afterwards from the Assets tab). `varSource` is the same
 *  idea for widget 'varRef' (a single $var-style field); `keySource`/`valueSource` do it for the two
 *  columns of a 'keyval' field. widget 'processRef' has no extra config — it always lists every
 *  process behind a currently-active deployment, tenant-wide (matching exactly what a 'call'/'forEach'
 *  node can actually resolve at runtime — see instances/service.ts's resolveCalled). */
export interface UiField {
  key: string; label: string; widget: Widget; options?: string[]; placeholder?: string; help?: string;
  assetKind?: string; varSource?: VarSource; keySource?: VarSource; valueSource?: VarSource;
  /** show this field only while another field has one of these values — e.g. an operation's own parameters */
  when?: { key: string; in: string[] };
}
export interface UiSection { title: string; fields: UiField[]; }

export interface PaletteEntry {
  key: string; label: string; category: string; icon: string; color: string;
  engineType: string; defaults: Record<string, unknown>;
}

/** How many connections a node accepts on each side (self-contained BPMN wiring rule).
 *  maxIn/maxOut: 0 = none, a number = that many, undefined = unlimited (gateways).
 *  A node has an input port when maxIn !== 0, and an output port when maxOut !== 0. */
export interface Ports { maxIn?: number; maxOut?: number; }

export interface NodeScenarioDoc {
  title: string;
  description: string;
  whenToUse: string;
  exampleJson: Record<string, unknown>;
}

export interface NodeFieldDoc {
  key: string;
  label: string;
  type: string;
  options?: string[];
  default?: string | number | boolean;
  required?: boolean;
  description: string;
}

export interface NodeDocs {
  summary: string;
  purpose: string;
  whenToUse: string[];
  whenNotToUse: string[];
  scenarios: NodeScenarioDoc[];
  fields: NodeFieldDoc[];
  gotchas: string[];
}

export interface NodeDef {
  engineType: string;      // the EngineNode.type this folder implements
  palette: PaletteEntry[]; // one or more palette tiles that create this node type
  ports: Ports;            // which connection points this node has (drives UI ports + validation)
  schema: UiSection[];     // the properties panel form
  docs?: NodeDocs;         // rich in-app documentation, scenarios, fields & examples
  /** How this engine type renders on a live diagram (process canvas, instance diagram) — one look per
   *  engine type, even though a type can have several palette tiles with their own distinct colors
   *  (e.g. boundary's error-catch/timer/compensation tiles): the diagram can't tell which tile an
   *  existing node came from, only its engineType. `icon` is an IconComponent name (app/shared/
   *  icon.component.ts), NOT the palette's emoji — the diagram uses the app's own icon set, the
   *  palette uses emoji for fast visual scanning in a long list; those are deliberately different
   *  vocabularies, not a duplication to merge. This field IS the single source of truth other UI
   *  code should read (via GET /catalog/nodes) instead of hand-rolling its own per-type map — two such
   *  maps already existed (process-canvas's and instance-detail's) and had already drifted apart
   *  (boundary rendered a different color on each page) before this field replaced them. */
  /** `shape` follows real BPMN 2.0 notation (the same convention every BPMN tool — jBPM's own
   *  Stunner designer, Camunda Modeler, bpmn.io — renders): events are circles, gateways are diamonds,
   *  everything else (tasks, call/sub-process, multi-instance) is a rounded rectangle. */
  diagram: { icon: string; color: string; shape: 'circle' | 'diamond' | 'rectangle' };
  /** One neutral, engine-type-level display name (e.g. "Gateway", "Boundary event") — distinct from
   *  a palette tile's own `label` (e.g. "Exclusive Gateway", "Error Catch"): a type with several
   *  palette variants has one typeLabel but many tile labels, and picking "whichever palette tile
   *  happens to be first in the array" as a stand-in (as process-canvas's own labelFor() does for a
   *  node's fallback display NAME) is fine there, but wrong for a modal title / tooltip describing
   *  the node's TYPE — this is what a second, now-removed hardcoded frontend map was approximating. */
  typeLabel: string;
}

export const CATEGORIES = ['Events', 'Tasks', 'Gateways', 'Sub-process', 'Instances', 'Data'];

// shared "General" section reused by every node's schema
export const GENERAL: UiSection = { title: 'General', fields: [
  { key: 'name', label: 'Name', widget: 'text' },
  { key: 'documentation', label: 'Documentation', widget: 'textarea', placeholder: 'Notes for this node' },
  { key: 'metaData', label: 'Metadata attributes', widget: 'keyval', help: 'Free labels on this node (jBPM metadata). Scripts read them as node.metaData; they never affect routing.' },
] };

/** jBPM activity extras: ad-hoc autostart and compensation-handler marking. */
export const ADVANCED: UiSection = { title: 'Advanced', fields: [
  { key: 'autoStart', label: 'Ad-hoc autostart', widget: 'bool', help: 'In an ad-hoc process, a node that nothing flows into starts by itself when the instance starts.' },
  { key: 'isForCompensation', label: 'Is a compensation handler', widget: 'bool', help: 'Marks this activity as the handler a compensation boundary runs; it is then not reported as unreachable.' },
] };

/** jBPM's "Is Async" (drools:customAsync), shared by every node type that can run in the background. */
export const EXECUTION: UiSection = { title: 'Execution', fields: [
  { key: 'async', label: 'Run in the background (async)', widget: 'bool', help: 'The instance is saved and the caller is released; a worker runs this node. Use for slow scripts, calls and integrations so the start request never waits.' },
  { key: 'asyncRetries', label: 'Async retries', widget: 'number', placeholder: '3', help: 'Extra attempts when the worker cannot run the node (infrastructure failure). A script or HTTP error is not retried here: it follows the error handling of the process.' },
  { key: 'asyncDelay', label: 'Async start delay', widget: 'text', placeholder: 'PT30S  ·  1m', help: 'Wait this long before the background run starts (ISO-8601 or 1h 30m).' },
  { key: 'asyncRetryDelay', label: 'Async retry delay', widget: 'text', placeholder: 'PT10S', help: 'ISO-8601 duration; each further attempt waits this long times the attempt number.' },
] };

/** jBPM "SLA Due Date" (customSLADueDate): a node that is still running past this time is flagged as violating its SLA. */
export const SLA: UiSection = { title: 'Service level (SLA)', fields: [
  { key: 'slaDueDate', label: 'SLA due date', widget: 'text', placeholder: '2h  ·  1d  ·  PT30M  ·  #{deadline}', help: 'How long this step may take from the moment it starts. On breach the instance is flagged, the audit log records it and the person who started it is notified; the process keeps running. A date or #{variable} also works.' },
] };
