# 06 — UI Spec (Angular)

The builder must match the reference screenshots: a **left sidenav** with app nav + a categorized
**node palette**, a **header** with workflow name/key and action buttons, a **canvas** (node/edge
editor with the exact node-card look), a **right properties panel** (contextual per selected node),
and a **footer**. Plus operations views: deployments, instances (with live executing-flow), task inbox.

## 1. Layout / chrome

```
┌───────────────────────────────────────────────────────────────────────────┐
│ HEADER: [logo] Workflow Name*  |  Key  | [Update][User Permissions][Variables]│
│         [Undo all changes] [import ↥][export ↧]        [run ▷][deploy]        │
├──────────┬────────────────────────────────────────────────┬─────────────────┤
│ SIDENAV  │                   CANVAS                        │ PROPERTIES PANEL │
│ (nav +   │   (@foblex/flow: node cards, edges, minimap,    │  (contextual:    │
│  palette)│    pan/zoom, grid, connect handles, + buttons)  │   node/edge/     │
│          │                                                 │   process)       │
├──────────┴────────────────────────────────────────────────┴─────────────────┤
│ FOOTER: validation status · zoom · version/branch · save state · notifications│
└───────────────────────────────────────────────────────────────────────────┘
```

### HeaderComponent
- Editable **Workflow Name** (required) + read-only **Key** (slug).
- Buttons: **Update** (save version/draft), **User Permissions** (dialog → `WorkflowPermission[]`),
  **Variables** (dialog → typed `EngineVar[]`), **Undo all changes**, **Import** (kjar), **Export**
  (kjar/bpmn), **Run** (start instance dialog), **Deploy** (deploy dialog: environment + tags).
- **Branch/version switcher** (dropdown) showing current branch + version, create-branch, publish.

### SideNavComponent
- **App nav** (icons, collapsible like the reference): Workflow Applications, Dashboard, Create
  Workflow, Create Workflow Form, Workflow Form List, Deployments, Instances, Tasks, Admin.
- **Palette** (when in builder): categorized, searchable, drag source. Categories & items map to the
  SDK node registry (see §4). Matches the reference "Start Task / End Task / User Task / Approval /
  Decision / Web Service / Email / Delay Timer / DB / Call Another Workflow / Compute / SMS …" grid.

### CanvasComponent (@foblex/flow)
- Node **cards** styled per the reference: rounded, white, drop shadow, a colored icon, a title, an
  optional subtitle (e.g. "Add Tag (Default Root)"), input/output **connection dots**, a hover **+**
  add-next affordance, and a selection toolbar (delete / kebab).
- Edges: smooth bezier with arrowheads and mid-dots as in the reference.
- Features: pan/zoom, grid/snap, multi-select, marquee, copy/paste, delete, minimap, fit-to-view,
  auto-layout (dagre), keyboard shortcuts, connection validation (can't connect incompatible ports).
- **Live-execution overlay**: in an instance's diagram, active nodes pulse, visited nodes are tinted,
  the active edge animates; driven by `/instances/:id/diagram-state` + WS `node.entered/exited`.

### PropertiesPanelComponent
- Renders a **contextual form** for the selected element, generated from the per-node JSON Schema in
  `docs/bpm-nodes/<type>/node_properties.md` (see §5). Sections mirror the reference "Trigger" panel:
  **General information** (title, status, description), then type-specific groups (e.g. **Trigger
  Schedule**, **Retry Settings**), then **Delete Node**.
- Edits update the `CanvasStore`; autosave (debounced) → `POST /branches/:id/versions`.

### FooterComponent
- Left: validation summary (errors/warnings from `validateModel`), click → jump to node.
- Center: current branch · version · save state (Saved / Saving… / Unsaved).
- Right: zoom control, notifications.

## 2. Feature views (routes)

| Route | View | Key content |
|---|---|---|
| `/home` | **Home (Analytics Hub)** | KPI summary tiles, interactive status donuts, throughput charts, duration percentiles, heatmaps, time window date scoping, strict lazy-loaded tabs |
| `/reports` | **Reports Center** | Tabular operational logs (Executions, SLA breaches, Cases, Audit trail), ad-hoc query engine, one-click CSV and JSON exports |
| `/workflows` | Applications list | cards/table, create, open |
| `/workflows/:id/builder` | **Builder** | canvas, palette, properties panel, validation problems strip, and header |
| `/workflows/:id/deployments` | **Deployments** | table of deployments: version/branch, tags, environment, **active** badge, counts, actions (activate/promote/rollback/undeploy/export) |
| `/workflows/:id/instances` | **Instances** | unified list of Process Instances and Case Instances, case ID binding, mode filters (All/Process/Case), status/date filters |
| `/instances/:id` | **Instance detail** | left: 280px parent/child hierarchy rail with execution tree; center: diagram with live highlight; right: variables, node history (timeline), current tokens, errors, audit; actions: signal/retry/suspend/abort; strict on-demand tab lazy loading |
| `/workflows-mgmt` | **Workflow Definitions** | create/repoint definitions, two-step project -> process selection modal, recursive JSON schema builder, AJV validation toggle |
| `/tasks` | **Task inbox** | my tasks / group tasks; open → form; claim/complete |
| `/admin` | Admin | users, roles, tenants, secrets (Dual-Tier RSA encrypted), endpoints, audit |
| `/forms` | Form list/designer | create/edit forms (SDK form model) |

## 3. State & data

- `CanvasStore` (signals): `nodes`, `edges`, `selection`, `dirty`, `validation`. Single source of
  truth; converts to/from `EngineProcess` via a mapping layer.
- `ApiService` (HttpClient) + typed models mirroring [Data Model](./04-data-model.md).
- `RealtimeService` (WS): subscribe per view; pushes into the relevant store.
- Autosave: debounce 800 ms after last edit → save draft; explicit **Update** forces save.

## 4. Node registry (palette ↔ engine type)

A single `node-registry.ts` drives the palette, canvas rendering, and the properties form. Each entry:
```ts
interface NodeSpec {
  key: string;              // 'userTask'
  label: string;            // 'User Task'
  category: 'Events'|'Tasks'|'Gateways'|'Sub-process'|'Data';
  icon: string;             // asset/emoji
  color: string;            // icon bg (matches reference palette)
  engineType: EngineNode['type'];
  defaults: Partial<EngineNode>;      // seed when dropped
  schemaRef: string;        // docs/bpm-nodes/<folder>/node_properties.md JSON schema
}
```
Categories & items cover the full SDK node set (events, tasks incl. service/REST, gateways, boundary,
intermediate, sub-processes, call/multi-instance, data object, lane).

## 5. Contextual property forms

- Generated from the per-node **JSON Schema** already authored in `docs/bpm-nodes/*/node_properties.md`.
- A small **schema-form** renderer maps JSON-Schema types → controls: string→text, enum→select,
  boolean→toggle, object(event)→grouped subforms, arrays→repeaters, code→code editor (JS with
  highlighting), timer→duration/cycle/date picker (like the reference "Trigger Schedule").
- Validation inline; required fields flagged; unknown/advanced fields under an "Advanced" disclosure.

## 6. Visual design tokens (from screenshots)

- Node card: white `#fff`, radius `12px`, shadow `0 2px 8px rgba(16,24,40,.08)`, padding `16px`,
  icon chip `40px` rounded with brand color; title `14px/600`, subtitle `12px` muted.
- Palette icon colors: green (messaging/forms), blue (tags/data), purple (timers/wait), etc.
- Accent/primary: indigo `#5b3df5`-ish (reference header active nav). Canvas bg: light gray grid.
- Selection: 2px primary ring + soft glow (as in the "Contact Tag" selected card).
- Connection dots: filled gray circles at node mid-sides; hover reveals `+` to add the next node.

## 7. Accessibility & i18n
- Full keyboard nav for canvas (move/connect/delete), ARIA roles on palette/panel, focus rings.
- All labels via i18n (SDK `properties`/messages model can back runtime i18n).
