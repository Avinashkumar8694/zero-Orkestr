# Coverage — what the SDK handles

Honest answer to "does it handle all possible nodes, combinations, mappings, and variables?"

## Two levels of support
1. **Semantic** — modeled as clean JSON fields: you can read, edit, and generate the node from
   scratch. Full control.
2. **Raw passthrough** (`type: "raw"`) — any element the SDK doesn't model semantically is captured
   as a verbatim XML blob and re-emitted **byte-for-byte**. It **round-trips losslessly** (proven:
   parallel gateway, business-rule/send tasks, JS-dialect scripts survive a double round-trip
   identically), but you can't edit it via typed fields, and to author it from scratch you must
   supply the raw XML.

**So:**
- **BPM project → JSON → BPM project (round-trip of existing files): lossless and complete.** Nothing
  is dropped — modeled nodes via fields, everything else via `raw`.
- **Authoring ANY node/combination from scratch via clean JSON: only the modeled subset below.**
  Other node types need `raw` XML or a small SDK extension.

## Semantic coverage (clean model — editable & authorable)
| Area | Covered |
|------|---------|
| Events | start (none, signal, **message, timer, conditional, escalation, error**), end (none, terminate, signal, error, **message, escalation**), intermediate **catch** (timer, **message, signal, conditional**), intermediate **throw** (**none, signal, message, escalation**), boundary (error, timer, **message, signal, conditional, escalation**; interrupting + non-interrupting) |
| Tasks | scriptTask (+ Java/MVEL/JavaScript dialect), userTask, **businessRuleTask** (ruleFlowGroup/DMN), **sendTask**, **receiveTask**, **manualTask** |
| Activities | callActivity: reusable, REST-wrapper (16 ports + scripts), multi-instance (sequential/parallel) |
| Gateways | **exclusive, parallel, inclusive, event-based, complex** (direction, default, eventGatewayType) |
| Sub-process | **embedded** (recursive nodes/flows), **transaction**, event sub-process (error-start → terminate) |
| Flows | sequenceFlow + condition + condition dialect + waypoints |
| Data | process variables (every `structureRef`), **dataObject** (+ isCollection), **dataStoreReference**, REST/user-task ports |
| Declarations | signals, errors, **messages, escalations** |
| Organisation | **lanes / laneSet** (flowNodeRefs) |
| Diagram | BPMNShape positions (incl. expanded sub-process), BPMNEdge waypoints |
| Scripts | scriptTask body + dialect; REST on-entry/on-exit; **preserved** |

**All node types the user asked about are now first-class** (parse + serialize + authorable + docs):
parallel/inclusive/event-based gateways, business-rule/send/receive/manual tasks,
message/escalation/conditional events, embedded/transaction sub-processes, data objects, lanes.

## Raw passthrough (lossless, still not semantically modeled)
Remaining less-common constructs round-trip verbatim via `raw`: complex-gateway activation
conditions, compensation / cancel / link events, ad-hoc sub-processes, `dataObjectReference`
(vs `dataObject`), pools / participants / `collaboration` (cross-process), and artifacts
(group, text annotation). All survive round-trip byte-for-byte; promote any via the roadmap below.

## Mappings & variables
- **Process variables: fully handled** (types, scope, seeding — see `../docs/bpm-nodes/_process-variables-reference.md`).
- **Mappings**: `../docs/bpm-nodes/_mappings-reference.md` enumerates every valid value. The
  serializer implements the values needed by the modeled nodes; any other value that appears in a
  raw element is preserved verbatim (not validated).

## Making it fully semantic (roadmap)
To promote a `raw` type to first-class (editable + authorable), add, per node type:
1. a parse case in `src/parse.ts` (XML → fields),
2. an emit function + dispatch case in `src/serialize.ts` (fields → XML),
3. optional fields on `Node` in `src/types.ts`.
Priority order for typical jBPM projects: `parallelGateway` → `inclusiveGateway` → `businessRuleTask`
→ `sendTask`/`receiveTask` → message/signal/timer **start** & **intermediate** events →
embedded `subProcess` (with children) → `eventBasedGateway` → data objects → lanes/pools.
Each is ~20–40 lines mirroring an existing case. Ask and these can be added.

## Guarantee summary
| Question | Answer |
|----------|--------|
| Round-trip an existing BPM project losslessly? | **Yes** (semantic + raw) |
| Generate a **complete deployable kjar** from JSON (pom, kmodule, deployment descriptor, .bpmn)? | **Yes** (via `writeProject` + `descriptor`) |
| Round-trip rules/decisions/Java/forms (`.drl`/`.dmn`/`.java`/`.frm`) and the `.wid`? | **Yes** — auto-captured verbatim into `descriptor.files`; `.wid` also parsed to a model + generatable from JSON |
| Get **structured JSON** for asset types (edit/generate them)? | **Yes** — `parseAsset`/`buildAsset`: generic XML tree for DMN/guided/scorecard/tests/solver; typed models for DRL/Java/properties/enumeration/DSL/wid/forms (round-trip-stable; DRL/Java best-effort) |
| Author in a **clean engine model** and convert to jBPM? | **Yes** — `fromEngine`/`fromEngineProject` (+ `toEngine` reverse); type *names* resolve to Java FQNs and generate POJOs (`makeTypeResolver`). See `docs/engine-model/`. |
| Preserve scripts, script dialects, conditions, variables, DI? | **Yes** |
| Preserve node types the SDK doesn't model? | **Yes**, verbatim via `raw` |
| Author the common BPMN node set from scratch via clean JSON? | **Yes** — all gateways, tasks, message/escalation/conditional events, sub-processes, data objects, lanes are first-class |
| Author *every* exotic construct (compensation, ad-hoc, pools/collaboration) from scratch? | **Not yet** — round-trips via `raw`; promote via the roadmap |

## Release 2.0.0 additions (engine ⇄ BPMN)
Process: `drools:version`, `drools:adHoc`, `customSLADueDate`, `customDescription`, variable `customTags`.
Activities: `customAsync`, `customSLADueDate`, `customAutoStart`, free `drools:metaData`; user-task data inputs (ActorId, GroupId, BusinessAdministrator*, TaskStakeholderId, ExcludedOwnerId, Comment, Content, Locale, CreatedBy, suspendUntil, Priority, Description, NotStarted/NotCompleted Reassign/Notify); `timeCycle language="cron"`; multi-instance `completionCondition`; `drools:abortParent`.
Engine-only features ride in one `engine.extras` metadata entry (see jbpm-engine/docs/20 §13), so a round trip is lossless.
