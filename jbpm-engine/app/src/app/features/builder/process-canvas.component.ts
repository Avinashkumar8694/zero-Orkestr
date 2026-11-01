import { Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, Output, SimpleChanges, computed, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { InstanceApiService } from '../../core/api/instance-api.service';
import { ToastService } from '../../shared/toast.service';
import type { CallableProcess, Catalog, NodeSpec, Problem } from '../../core/models';
import { PropertiesPanelComponent } from './properties-panel.component';
import { ProblemsPanelComponent } from './problems-panel.component';
import { IconComponent } from '../../shared/icon.component';
import { MarkdownViewerComponent } from '../../shared/markdown-viewer.component';

// A canvas node is just an engine node with x/y layout coords stored alongside (ignored by the SDK).
interface CNode { id: string; type: string; name?: string; x: number; y: number; [k: string]: any; }
interface CEdge { id: string; from: string; to: string; when?: string; lang?: string; label?: string; priority?: number; }

const NW = 190, NH = 48;
const COL_W = NW + 100, ROW_H = NH + 46;

// The process designer surface: palette + auto-laid-out canvas, embedded inside the Processes
// workspace (no route navigation to a separate page — see project-processes.component.ts).
//
// Layout is fully automatic (a layered/Sugiyama-style pass: column = longest-path depth from a start
// node, row = barycenter of predecessor rows) and re-runs after every structural change — add, delete,
// connect. This is deliberate: it keeps the graph always readable without the user having to tidy it,
// the way a call-flow / decision-tree builder does. Manual dragging still works between relayouts for
// ad-hoc nudging, but any add/delete/connect snaps back to the computed layout.
//
// Node/edge properties are edited via double-click → popup modal (jBPM-style), not an always-visible
// side panel, so the canvas gets the full width. Validate/Run/Build/Deploy live one level up (the
// workspace's shared toolbar), which calls into this component's public methods/signals via viewChild
// — this component only owns the live model.
@Component({
  selector: 'app-process-canvas',
  standalone: true,
  imports: [IconComponent, FormsModule, PropertiesPanelComponent, ProblemsPanelComponent, MarkdownViewerComponent],
  template: `
    <div class="builder">
      <div class="body">
        <!-- PALETTE (drag onto canvas, or click to append) -->
        <aside class="palette">
          <input class="search" placeholder="Search nodes…" [(ngModel)]="q" />
          @for (cat of cats(); track cat) {
            @if (nodesIn(cat, q).length) {
              <div class="cat-h">{{ cat }}</div>
              <div class="cat-grid">
                @for (n of nodesIn(cat, q); track n.key) {
                  <div class="ptile" draggable="true" (dragstart)="onDragStart($event, n)"
                       (click)="addFromPalette(n)" [title]="'Drag onto canvas, or click to add: ' + n.label">
                    <span class="pic" [style.background]="visual(n.engineType).color"><app-icon [name]="visual(n.engineType).icon" [size]="13" /></span>
                    <span class="plabel">{{ n.label }}</span>
                    <button type="button" class="p-info" (pointerdown)="$event.stopPropagation()" (click)="$event.stopPropagation(); openDocsFor(n.engineType, n.label)" title="View documentation and scenarios" aria-label="Documentation"><app-icon name="info" [size]="12" /></button>
                  </div>
                }
              </div>
            }
          }
        </aside>

        <!-- CANVAS -->
        <main #canvasEl class="canvas" (dragover)="$event.preventDefault()" (drop)="onDrop($event)">
          <div #scrollArea class="scrollArea" [class.panning]="panMode()" (click)="bgClick()" (pointerdown)="onCanvasPointerDown($event)">
            <div class="zoomlayer" [style.zoom]="zoom()" [style.width.px]="canvasWidth()" [style.height.px]="canvasHeight()">
              <svg class="edges" [attr.width]="canvasWidth()" [attr.height]="canvasHeight()" [style.width.px]="canvasWidth()" [style.height.px]="canvasHeight()">
                <defs>
                  <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                    <path d="M0,0 L10,5 L0,10 z" fill="#9aa3b2" />
                  </marker>
                </defs>
                @for (e of edges(); track e.id) {
                  <path [attr.d]="edgePath(e)" class="edge" [class.sel]="selEdge()===e.id" marker-end="url(#arrow)"
                        (click)="selectEdge($event, e)" (dblclick)="$event.stopPropagation(); openEdgeEditor(e)" />
                }
                @if (linkFrom(); as lf) { <path [attr.d]="ghostPath(lf)" class="edge ghost" /> }
              </svg>

              @for (n of nodes(); track n.id) {
                <div class="node" [attr.id]="'node-' + n.id" [class.sel]="selNode()?.id===n.id" [class.linking]="linkFrom()===n.id"
                     [class.droptarget]="linkFrom() && linkFrom()!==n.id && hasIn(n.type)"
                     [class.has-err]="hasErr(n.id) || !isSupported(n.type)" [class.has-warn]="!hasErr(n.id) && isSupported(n.type) && hasWarn(n.id)"
                     [class.node-unsupported]="!isSupported(n.type)"
                     [class.node-circle]="isCircle(n.type)"
                     [class.node-diamond]="isDiamond(n.type)"
                     [class.node-rectangle]="isRectangle(n.type)"
                     [class.node-call]="n.type === 'call'"
                     [class.node-start]="n.type === 'start'"
                     [class.node-end]="n.type === 'end'"
                     [style.left.px]="n.x" [style.top.px]="n.y"
                     [style.width.px]="nodeDims(n.type).w" [style.height.px]="nodeDims(n.type).h"
                     [title]="nodeTooltip(n)"
                     (pointerdown)="startDrag($event, n)" (pointerup)="onNodePointerUp($event, n)"
                     (click)="selectNode($event, n)" (dblclick)="$event.stopPropagation(); openNodeEditor(n)">
                  @if (!isSupported(n.type)) {
                    <span class="nmark err" title="Unsupported construct: click to view recommendations" (click)="$event.stopPropagation(); openNodeProblems(n.id)">!</span>
                  } @else if (hasErr(n.id)) {
                    <span class="nmark err" [title]="nodeProblemTooltip(n.id)" (click)="$event.stopPropagation(); openNodeProblems(n.id)">!</span>
                  } @else if (hasWarn(n.id)) {
                    <span class="nmark warn" [title]="nodeProblemTooltip(n.id)" (click)="$event.stopPropagation(); openNodeProblems(n.id)">!</span>
                  }
                  @if (hasIn(n.type)) { <span class="port in" title="Incoming"></span> }

                  @if (isCircle(n.type)) {
                    <div class="circle-inner" [style.background]="n.type==='start' ? '#f0fdf4' : n.type==='end' ? '#fef2f2' : '#f5f3ff'">
                      <app-icon [name]="visual(n.type).icon" [size]="16" [style.color]="visual(n.type).color" />
                    </div>
                    <div class="ntitle circle-label">{{ n.name || labelFor(n) }}</div>
                  } @else if (isDiamond(n.type)) {
                    <div class="diamond-body">
                      <span class="diamond-marker">{{ gatewayMarker(n) }}</span>
                    </div>
                    <div class="ntitle diamond-label">{{ n.name || labelFor(n) }}</div>
                  } @else {
                    <span class="chip" [style.background]="visual(n.type).color"><app-icon [name]="visual(n.type).icon" [size]="13" /></span>
                    <div class="ntitle">
                      @if (!isSupported(n.type)) { <span class="unsupp-tag">[UNSUPPORTED]</span> }
                      {{ n.name || labelFor(n) }}
                    </div>
                    @if (n.type === 'call') { <span class="call-badge" title="Call Activity / Sub-process">[+]</span> }
                  }

                  @if (hasOut(n.type)) { <span class="port out" title="Drag to a target node to connect" (pointerdown)="startLink($event, n)" (click)="$event.stopPropagation()"></span> }
                  @if (selNode()?.id===n.id) {
                    <button class="ninfo" (pointerdown)="$event.stopPropagation()" (click)="$event.stopPropagation(); openDocsFor(n.type, labelFor(n))" title="Documentation & Scenarios" aria-label="View node documentation"><app-icon name="info" [size]="12" /></button>
                    @if (hasErr(n.id) || !isSupported(n.type)) {
                      <button class="nreplace" (pointerdown)="$event.stopPropagation()" (click)="replaceNode(n.id)" title="Replace with a fresh node from palette (preserves connections)" aria-label="Replace node"><app-icon name="refresh" [size]="11" /></button>
                    }
                    <button class="ndup" (pointerdown)="$event.stopPropagation()" (click)="duplicateNode($event, n)" title="Duplicate node in this project (Ctrl+D / Cmd+D)" aria-label="Duplicate node"><app-icon name="plus" [size]="12" /></button>
                    <button class="ncopy" (pointerdown)="$event.stopPropagation()" (click)="copyNode($event, n)" title="Copy node (Ctrl+C / Cmd+C)" aria-label="Copy node"><app-icon name="copy" [size]="12" /></button>
                    <button class="ndel" (pointerdown)="$event.stopPropagation()" (click)="del($event, n)" title="Delete" aria-label="Delete node"><app-icon name="trash" [size]="13" /></button>
                  }
                </div>
                @if (canAddFrom(n)) {
                  <button class="addbtn" [style.left.px]="n.x + nodeDims(n.type).w + 8" [style.top.px]="n.y + nodeDims(n.type).h/2 - 12"
                          (click)="openAddPopover($event, n)" title="Add next node" aria-label="Add next node">
                    <app-icon name="plus" [size]="13" />
                  </button>
                }
              }

              @for (b of numberedBranches(); track b.edge.id) {
                <div class="branchbadge" [style.left.px]="b.x" [style.top.px]="b.y" (dblclick)="openEdgeEditor(b.edge)" [title]="'Branch ' + b.text + ' — double-click to label'">{{ b.text }}</div>
              }
              @for (b of labeledBranches(); track b.edge.id) {
                <div class="branchpill" [style.left.px]="b.x" [style.top.px]="b.y" (dblclick)="openEdgeEditor(b.edge)" title="Double-click to edit">{{ b.text }}</div>
              }

              @if (nodes().length === 0) {
                <div class="empty">
                  <div class="empty-ic">＋</div>
                  <h3>Build your flow</h3>
                  <p>Drag a node from the palette onto the canvas, or click a palette entry to append one. Double-click a node to configure it.</p>
                </div>
              }
            </div>
          </div>

          @if (addPopoverFor(); as fromId) {
            <div class="addpop" [style.left.px]="addPopoverPos().x" [style.top.px]="addPopoverPos().y" (click)="$event.stopPropagation()">
              <div class="addpop-h">
                <input class="search" placeholder="Search nodes…" [(ngModel)]="addQ" />
                <button class="x" (click)="closeAddPopover()" aria-label="Close"><app-icon name="close" [size]="14" /></button>
              </div>
              <div class="addpop-body">
                @for (cat of cats(); track cat) {
                  @if (nodesIn(cat, addQ).length) {
                    <div class="cat-h">{{ cat }}</div>
                    <div class="cat-grid">
                      @for (n of nodesIn(cat, addQ); track n.key) {
                        <div class="ptile" (click)="pickAdd(n)" [title]="n.label">
                          <span class="pic" [style.background]="visual(n.engineType).color"><app-icon [name]="visual(n.engineType).icon" [size]="13" /></span>
                          <span class="plabel">{{ n.label }}</span>
                          <button type="button" class="p-info" (pointerdown)="$event.stopPropagation()" (click)="$event.stopPropagation(); openDocsFor(n.engineType, n.label)" title="View documentation and scenarios" aria-label="Documentation"><app-icon name="info" [size]="12" /></button>
                        </div>
                      }
                    </div>
                  }
                }
              </div>
            </div>
          }

          <div class="zoomctrl">
            <button (click)="zoomOut()" title="Zoom out" aria-label="Zoom out">−</button>
            <button class="zpct" (click)="zoomReset()" title="Reset zoom">{{ zoomPct() }}%</button>
            <button (click)="zoomIn()" title="Zoom in" aria-label="Zoom in">+</button>
            <button class="hand" [class.active]="panMode()" (click)="panMode.set(!panMode())" title="Pan tool" aria-label="Toggle pan tool"><app-icon name="move" [size]="13" /></button>
          </div>

          @if (linkError()) { <div class="hint-bar err"><app-icon name="error" [size]="14" /> {{ linkError() }}</div> }
          @else if (linkFrom()) { <div class="hint-bar">Release on a target node to connect (or click a node) — click empty space to cancel.</div> }
        </main>
      </div>

      <app-problems-panel [problems]="problems()" [errorCount]="errorCount()" [warnCount]="warnCount()" (pick)="pickProblem($event)" (replace)="replaceNode($event)" (clearActions)="clearNodeLifecycleActions($event)"></app-problems-panel>

      @if (editingNode(); as n) {
        <div class="modal-bg" (click)="closeNodeEditor()">
          <div class="modal" [class.wide]="nodeModalTab() === 'docs'" (click)="$event.stopPropagation()">
            <div class="modal-h">
              <span class="chip sm" [style.background]="visual(n.type).color"><app-icon [name]="visual(n.type).icon" [size]="13" /></span>
              <span>{{ typeLabel(n) }}</span>
              <span class="spacer"></span>
              <div class="m-tabs">
                <button type="button" class="m-tab-btn" [class.active]="nodeModalTab() === 'props'" (click)="nodeModalTab.set('props')">Properties</button>
                <button type="button" class="m-tab-btn" [class.active]="nodeModalTab() === 'docs'" (click)="nodeModalTab.set('docs')"><app-icon name="info" [size]="12" /> Guide & Docs</button>
              </div>
              <button class="x" (click)="closeNodeEditor()" aria-label="Close"><app-icon name="close" [size]="15" /></button>
            </div>
            @if (nodeModalTab() === 'props') {
              <div class="modal-body">
                @if (hasErr(n.id)) {
                  <div class="node-err-banner">
                    <app-icon name="alert-triangle" [size]="18" />
                    <div class="node-err-body">
                      <div class="node-err-msg"><strong>Validation Issue:</strong> {{ getErrorForNode(n.id)?.message }}</div>
                      @if (getErrorForNode(n.id)?.remedy) {
                        <div class="node-err-remedy"><strong>Recommendation:</strong> {{ getErrorForNode(n.id)?.remedy }}</div>
                      }
                    </div>
                    <div class="node-err-actions">
                      <button type="button" class="btn sm btn-node-replace" (click)="replaceNode(n.id)" title="Replace with a fresh node from palette, keeping connections">
                        <app-icon name="refresh" [size]="12" /> Replace Node
                      </button>
                      @if (n['onEntry'] || n['onExit']) {
                        <button type="button" class="btn sm" (click)="clearNodeLifecycleActions(n.id)">Clear Lifecycle Actions</button>
                      }
                    </div>
                  </div>
                }
                <label class="fld"><span>Node ID</span><input [value]="n.id" disabled /></label>
                <app-properties-panel [node]="n" [allNodes]="nodes()" [sections]="schemaFor(n.type)" [assets]="assets" [ownVars]="procVars()" [callableProcesses]="callableProcesses()" [cheatSheetContent]="cheatSheetContent()" [javaReferenceContent]="javaReferenceContent()" (changed)="markDirty()" (openCheatSheet)="openCheatSheet($event)"></app-properties-panel>
                <div class="node-editor-footer-actions">
                  <button type="button" class="btn outline" (click)="replaceNode(n.id)" title="Reset or replace this node with a fresh node of the same type">
                    <app-icon name="refresh" [size]="12" /> Replace with Fresh Node
                  </button>
                  <button class="btn danger" (click)="del($event, n); closeNodeEditor()">Delete node</button>
                </div>
              </div>
            } @else {
              <div class="modal-body docs-scroll-pane">
                <app-markdown-viewer [content]="readmeFor(n.type)" />
              </div>
            }
          </div>
        </div>
      }

      @if (viewingDocs(); as doc) {
        <div class="modal-bg" (click)="closeDocs()">
          <div class="modal wide docs-modal" (click)="$event.stopPropagation()">
            <div class="modal-h">
              <span class="chip sm" [style.background]="visual(doc.engineType).color"><app-icon [name]="visual(doc.engineType).icon" [size]="13" /></span>
              <span>{{ doc.label }} — Guide & Scenarios</span>
              <span class="spacer"></span>
              <button class="x" (click)="closeDocs()" aria-label="Close"><app-icon name="close" [size]="15" /></button>
            </div>
            <div class="modal-body docs-scroll-pane">
              <app-markdown-viewer [content]="doc.content" />
            </div>
          </div>
        </div>
      }

      @if (editingEdge(); as e) {
        <div class="modal-bg" (click)="closeEdgeEditor()">
          <div class="modal narrow" (click)="$event.stopPropagation()">
            <div class="modal-h"><span>Connection</span><span class="spacer"></span><button class="x" (click)="closeEdgeEditor()" aria-label="Close"><app-icon name="close" [size]="15" /></button></div>
            <div class="modal-body">
              @if (siblingCount(e) > 1) {
                <label class="fld"><span>Branch label</span><input [(ngModel)]="e.label" (ngModelChange)="onEdgeChange(e)" placeholder="e.g. Open, Close, Approved…" /></label>
                <p class="hint">Shown on the canvas above this branch. Leave empty for a plain numbered branch.</p>
              }
              <label class="fld">
                <div class="fld-lbl-row">
                  <span>Condition (js)</span>
                  <button type="button" class="cheat-pill" (click)="openCheatSheet()" title="View JavaScript & Flow Variables Cheat Sheet">
                    <app-icon name="code" [size]="12" /> Cheat Sheet
                  </button>
                </div>
                <input [(ngModel)]="e.when" (ngModelChange)="onEdgeChange(e)" placeholder="e.g. amount > 1000 &amp;&amp; riskTier === 'HIGH'" />
              </label>
              <p class="hint">Leave empty for an unconditional / default flow. Evaluates bare variables (<code>amount</code>), <code>vars.key</code>, or functional conditions.</p>
              @if (siblingCount(e) > 1) {
                <label class="fld"><span>Priority</span><input type="number" min="1" [(ngModel)]="e.priority" (ngModelChange)="onEdgeChange(e)" placeholder="1 = tried first" /></label>
                <p class="hint">On an exclusive gateway the lowest number whose condition is true is taken. Empty = after all numbered branches.</p>
              }
              <button class="btn danger full" (click)="delEdge(e.id); closeEdgeEditor()">Delete connection</button>
            </div>
          </div>
        </div>
      }

      @if (showVars()) {
        <div class="modal-bg" (click)="closeVars()">
          <div class="modal" (click)="$event.stopPropagation()">
            <div class="modal-h">
              <span>Process Variables</span>
              <span class="spacer"></span>
              <button type="button" class="cheat-pill mr-2" (click)="openCheatSheet()" title="View JavaScript & Flow Variables Cheat Sheet">
                <app-icon name="code" [size]="12" /> JS &amp; Variables Cheat Sheet
              </button>
              <button class="x" (click)="closeVars()" aria-label="Close"><app-icon name="close" [size]="15" /></button>
            </div>
            <div class="modal-body">
              <p class="hint">Typed data this process carries. Access in scripts via bare names (<code>amount</code>), <code>vars.name</code>, or <code>getVariable('name')</code>.</p>
              <details class="pprops">
                <summary>Process properties</summary>
                <label class="fld"><span>Description template</span><input [ngModel]="meta('description')" (ngModelChange)="setMeta('description', $event)" placeholder="Loan for #{customer}" /></label>
                <label class="fld"><span>SLA due (e.g. 2d, PT4H, #&#123;slaHours&#125;h)</span><input [ngModel]="meta('slaDueDate')" (ngModelChange)="setMeta('slaDueDate', $event)" /></label>
                <label class="fld"><span>Version</span><input [ngModel]="meta('version')" (ngModelChange)="setMeta('version', $event)" placeholder="1.0" /></label>
                <label class="vtag"><input type="checkbox" [checked]="meta('adHoc') === true" (change)="setMeta('adHoc', $any($event.target).checked || undefined)" /> Ad-hoc process (nodes marked autoStart begin on their own)</label>
                @if (meta('adHoc') === true) {
                  <label class="fld"><span>Completion condition</span><input [ngModel]="meta('completionCondition')" (ngModelChange)="setMeta('completionCondition', $event)" placeholder="done === true" /></label>
                }
              </details>
              @for (v of procVars(); track $index) {
                <div class="vrow">
                  <input placeholder="name" [(ngModel)]="v.name" (ngModelChange)="markDirty()" />
                  <select [(ngModel)]="v.type" (ngModelChange)="markDirty()">
                    <option>string</option><option>int</option><option>long</option><option>double</option><option>bool</option><option>date</option><option>object</option><option>list</option><option>map</option>
                  </select>
                  <label class="vtag" title="Must be supplied when the process starts"><input type="checkbox" [checked]="hasTag(v,'required')" (change)="toggleTag(v,'required')" /> required</label>
                  <label class="vtag" title="Scripts and API updates cannot change it after start"><input type="checkbox" [checked]="hasTag(v,'readonly')" (change)="toggleTag(v,'readonly')" /> read-only</label>
                  <button class="x" (click)="rmVar($index)" aria-label="Remove variable"><app-icon name="close" [size]="13" /></button>
                </div>
              }
              @if (!procVars().length) { <p class="muted">No variables yet.</p> }
              <button class="add" (click)="addVar()">+ add variable</button>
            </div>
          </div>
        </div>
      }

      @if (showCheatSheet()) {
        <div class="modal-bg" (click)="closeCheatSheet()">
          <div class="modal wide docs-modal" (click)="$event.stopPropagation()">
            <div class="modal-h">
              <span class="chip sm" [style.background]="cheatSheetLang() === 'java' ? '#d97706' : '#0891b2'" style="color:#fff;"><app-icon name="code" [size]="13" /></span>
              <span>{{ cheatSheetTitle() }}</span>
              <span class="spacer"></span>
              <button class="x" (click)="closeCheatSheet()" aria-label="Close"><app-icon name="close" [size]="15" /></button>
            </div>
            <div class="modal-body docs-scroll-pane">
              <app-markdown-viewer [content]="cheatSheetContent()" />
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .builder { display: flex; flex-direction: column; height: 100%; background: var(--bg); }
    .body { flex: 1; display: flex; min-height: 0; }

    .palette { width: 236px; flex-shrink: 0; background: var(--surface); border-right: 1px solid var(--border); overflow-y: auto; padding: 14px 12px; }
    .search { width: 100%; margin-bottom: 8px; font-size: 13px; }
    .search:focus { outline: none; border-color: var(--primary); }
    .cat-h { font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; margin: 14px 2px 8px; }
    /* Compact single-column rows, not 2-up tiles. The palette carries 30+ node types across six
       categories; as large centred tiles that was ~3 screens of scrolling and pushed the canvas
       into a strip. Icon-left rows fit ~4x more per screen and scan faster. */
    .cat-grid { display: flex; flex-direction: column; gap: 2px; }
    .ptile { display: flex; flex-direction: row; align-items: center; gap: 9px; padding: 6px 8px; border: 1px solid transparent; border-radius: 8px; cursor: grab; background: transparent; text-align: left; transition: background-color .12s, border-color .12s; }
    .ptile:hover { background: var(--primary-50); }
    .ptile:active { cursor: grabbing; }
    .pic { width: 24px; height: 24px; flex-shrink: 0; display: grid; place-items: center; border-radius: 7px; color: #fff; font-size: 12px; font-weight: 600; }
    .plabel { font-size: 12.5px; color: var(--text); line-height: 1.3; flex: 1; min-width: 0; }
    .p-info { margin-left: auto; border: none; background: transparent; color: var(--muted); padding: 3px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; opacity: 0; transition: opacity .12s, background-color .12s, color .12s; flex-shrink: 0; }
    .ptile:hover .p-info { opacity: 0.8; }
    .p-info:hover { opacity: 1 !important; color: var(--primary, #3b82f6); background: var(--surface-2, rgba(0,0,0,0.06)); }

    .canvas { position: relative; flex: 1; overflow: hidden; }
    .scrollArea { position: absolute; inset: 0; overflow: auto; cursor: default;
      background-color: var(--canvas-bg);
      background-image: radial-gradient(circle, var(--canvas-dot) 1.1px, transparent 1.1px);
      background-size: 22px 22px; }
    .scrollArea.panning { cursor: grab; }
    .scrollArea.panning:active { cursor: grabbing; }
    .zoomlayer { position: relative; min-width: 100%; min-height: 100%; }
    .edges { position: absolute; top: 0; left: 0; pointer-events: none; overflow: visible; }
    .edge { fill: none; stroke: var(--border-strong); stroke-width: 2; pointer-events: stroke; cursor: pointer; }
    .edge:hover { stroke: var(--muted); } .edge.sel { stroke: var(--primary); stroke-width: 2.5; }
    .edge.ghost { stroke: var(--primary); stroke-dasharray: 5 4; opacity: .7; }

    /* BPMN 2.0 Standard Nodes */
    .node {
      position: absolute;
      background: var(--surface);
      cursor: grab;
      user-select: none;
      transition: box-shadow .12s, border-color .12s;
    }
    .node:hover { box-shadow: var(--shadow-pop); }
    .node.sel { border-color: var(--primary) !important; box-shadow: 0 0 0 3px rgba(91,61,245,.2), var(--shadow-card); }
    .node.linking { border-color: var(--primary); }
    .node.droptarget { border-color: var(--green) !important; box-shadow: 0 0 0 3px rgba(22,163,74,.22), var(--shadow-card); cursor: alias; }
    .node.has-err { border-color: #ef4444 !important; box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.25), var(--shadow-card); }
    .node.has-err:hover { box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.4), var(--shadow-pop); }
    .node.has-warn { border-color: #f59e0b !important; }

    /* TASK / ACTIVITY RECTANGLE */
    .node.node-rectangle {
      border-radius: 10px;
      border: 1.5px solid var(--border-strong);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 14px;
      box-shadow: var(--shadow-card);
    }
    .node.node-call {
      border: 2px solid #6366f1;
    }
    .call-badge {
      position: absolute;
      bottom: 2px;
      left: 50%;
      transform: translateX(-50%);
      font-size: 10px;
      font-weight: 800;
      color: #6366f1;
      letter-spacing: -0.5px;
    }
    .node .chip {
      width: 28px;
      height: 28px;
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      border-radius: 7px;
      color: #fff;
    }
    .ntitle {
      font-weight: 600;
      font-size: 13px;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* EVENT CIRCLE */
    .node.node-circle {
      border-radius: 50%;
      border: 2px solid var(--border-strong);
      display: grid;
      place-items: center;
      box-shadow: var(--shadow-card);
    }
    .node.node-start {
      border: 2.5px solid #16a34a;
    }
    .node.node-end {
      border: 3.5px solid #dc2626;
    }
    .circle-inner {
      width: 100%;
      height: 100%;
      border-radius: 50%;
      display: grid;
      place-items: center;
    }
    .circle-label {
      position: absolute;
      top: 48px;
      left: 50%;
      transform: translateX(-50%);
      width: 120px;
      text-align: center;
      white-space: normal;
      line-height: 1.2;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--text-secondary);
      pointer-events: none;
    }

    /* GATEWAY DIAMOND */
    .node.node-diamond {
      background: transparent;
      border: none;
      box-shadow: none;
    }
    .diamond-body {
      width: 52px;
      height: 52px;
      transform: rotate(45deg);
      border-radius: 9px;
      border: 2px solid #d97706;
      background: var(--surface);
      box-shadow: var(--shadow-card);
      display: grid;
      place-items: center;
      transition: border-color .12s, box-shadow .12s;
    }
    .node.node-diamond:hover .diamond-body {
      box-shadow: var(--shadow-pop);
    }
    .node.node-diamond.sel .diamond-body {
      border-color: var(--primary) !important;
      box-shadow: 0 0 0 3px rgba(91,61,245,.2), var(--shadow-card);
    }
    .diamond-marker {
      transform: rotate(-45deg);
      font-size: 16px;
      font-weight: 900;
      color: #b45309;
      line-height: 1;
    }
    .diamond-label {
      position: absolute;
      top: 58px;
      left: 50%;
      transform: translateX(-50%);
      width: 120px;
      text-align: center;
      white-space: normal;
      line-height: 1.2;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--text-secondary);
      pointer-events: none;
    }

    .node.node-unsupported {
      border: 2px dashed #ef4444 !important;
      background: #fff5f5 !important;
      box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.2);
    }
    .unsupp-tag {
      font-size: 10px;
      font-weight: 800;
      color: #dc2626;
      background: #fee2e2;
      padding: 1px 5px;
      border-radius: 4px;
      margin-right: 4px;
      display: inline-block;
    }

    .nmark { position: absolute; top: -9px; left: -9px; width: 20px; height: 20px; border-radius: 50%; display: grid; place-items: center; font-weight: 800; font-size: 12px; color: #fff; box-shadow: var(--shadow-card); z-index: 6; }
    .nmark.err { background: var(--red); cursor: pointer; animation: danger-pulse 2s infinite ease-in-out; }
    .nmark.warn { background: #d97706; cursor: pointer; }
    @keyframes danger-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.18); }
    }

    .port { position: absolute; top: 50%; width: 16px; height: 16px; border-radius: 50%; background: var(--surface); border: 2px solid var(--border-strong); transform: translateY(-50%); cursor: crosshair; z-index: 5; }
    .port:hover { border-color: var(--primary); background: #eae6ff; transform: translateY(-50%) scale(1.25); }
    .port.out { right: -8px; box-shadow: 0 0 0 3px rgba(91,61,245,.08); }
    .port.in { left: -8px; }
    .node:hover .port.out { border-color: var(--primary); }
    .ndel { position: absolute; top: -12px; right: -6px; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); cursor: pointer; box-shadow: var(--shadow-card); z-index: 6; }
    .ndel:hover { background: var(--red-bg); border-color: var(--border-strong); }

    .addbtn { position: absolute; width: 24px; height: 24px; border-radius: 50%; border: 1px solid var(--border-strong); background: var(--surface); color: var(--muted); display: grid; place-items: center; cursor: pointer; box-shadow: var(--shadow-card); z-index: 4; }
    .addbtn:hover { border-color: var(--primary); color: var(--primary); background: var(--primary-50); }

    /* Branch markers on multi-output edges */
    .branchbadge { position: absolute; width: 22px; height: 22px; border-radius: 50%; background: var(--text); color: var(--surface); font-size: 11px; font-weight: 700; display: grid; place-items: center; box-shadow: var(--shadow-card); z-index: 3; cursor: pointer; }
    .branchpill { position: absolute; transform: translate(-6px, -30px); background: var(--surface); border: 1px solid var(--border-strong); border-radius: 999px; padding: 3px 12px; font-size: 11.5px; font-weight: 600; color: var(--text-secondary); box-shadow: var(--shadow-card); z-index: 3; cursor: pointer; white-space: nowrap; }

    .empty { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); text-align: center; color: var(--muted); max-width: 340px; }
    .empty-ic { width: 56px; height: 56px; margin: 0 auto 10px; border-radius: 16px; background: var(--surface); border: 1px dashed var(--border-strong); display: grid; place-items: center; font-size: 26px; color: var(--border-strong); }
    .empty h3 { margin: 6px 0; color: var(--text); }
    .hint-bar { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); background: var(--primary); color: #fff; padding: 7px 14px; border-radius: 999px; font-size: 12px; box-shadow: var(--shadow-pop); z-index: 10; }
    .hint-bar.err { background: var(--red); }

    /* Bottom-right zoom + pan control — fixed to the canvas pane, not the scrollable content. */
    .zoomctrl { position: absolute; bottom: 16px; right: 16px; display: flex; align-items: center; gap: 2px; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 4px; box-shadow: var(--shadow-pop); z-index: 20; }
    .zoomctrl button { width: 28px; height: 28px; border: none; background: transparent; border-radius: 50%; cursor: pointer; color: var(--text-secondary); font-size: 15px; display: grid; place-items: center; }
    .zoomctrl button:hover { background: var(--surface-3); color: var(--text); }
    .zoomctrl .zpct { width: auto; padding: 0 8px; font-size: 12px; font-weight: 600; }
    .zoomctrl .hand { margin-left: 2px; border-left: 1px solid var(--border); border-radius: 0 999px 999px 0; }
    .zoomctrl .hand.active { color: var(--primary); background: var(--primary-50); }

    /* Inline "add node" popover — same tile visual as the palette, floating near the + button. */
    .addpop { position: absolute; width: 240px; max-height: 340px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; box-shadow: var(--shadow-pop); z-index: 30; display: flex; flex-direction: column; }
    .addpop-h { display: flex; align-items: center; gap: 6px; padding: 8px; border-bottom: 1px solid var(--border); }
    .addpop-h .search { margin: 0; }
    .addpop-h .x { flex-shrink: 0; border: none; background: transparent; color: var(--muted); cursor: pointer; }
    .addpop-body { overflow: auto; padding: 6px 8px; }

    .fld { display: block; margin-bottom: 12px; } .fld span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
    .fld input, .fld select, .fld textarea { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13px; font-family: inherit; }
    .fld input:focus, .fld select:focus, .fld textarea:focus { outline: none; border-color: var(--primary); }
    .hint { font-size: 12px; color: var(--muted); line-height: 1.5; }
    .btn.full { width: 100%; justify-content: center; margin-top: 8px; }
    .btn.danger { color: var(--red); border-color: var(--border-strong); } .btn.danger:hover { background: var(--red-bg); }

    .modal-bg { position: fixed; inset: 0; background: rgba(16,24,40,.4); display: grid; place-items: center; z-index: 50; }
    .modal { background: var(--surface); border-radius: 14px; width: 480px; max-width: 92vw; max-height: 80vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: var(--shadow-pop); }
    .modal.narrow { width: 400px; }
    .modal.wide { width: 880px; max-width: 95vw; height: 85vh; max-height: 85vh; }
    .m-tabs { display: flex; gap: 4px; background: var(--surface-2, #f1f5f9); padding: 3px; border-radius: 8px; margin-right: 6px; }
    .m-tab-btn { border: none; background: transparent; font-size: 12px; font-weight: 500; color: var(--muted); padding: 4px 10px; border-radius: 6px; cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
    .m-tab-btn.active { background: var(--surface); color: var(--text-strong); font-weight: 600; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }
    .docs-scroll-pane { padding: 18px 24px; overflow-y: auto; flex: 1; background: var(--surface); }
    .ncopy { position: absolute; top: -12px; right: 22px; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text-secondary); display: grid; place-items: center; cursor: pointer; box-shadow: var(--shadow-card); z-index: 6; }
    .ncopy:hover { background: var(--surface-2); color: var(--primary); border-color: var(--primary); }
    .ndup { position: absolute; top: -12px; right: 50px; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--text-secondary); display: grid; place-items: center; cursor: pointer; box-shadow: var(--shadow-card); z-index: 6; }
    .ndup:hover { background: var(--surface-2); color: var(--primary); border-color: var(--primary); }
    .ninfo { position: absolute; top: -12px; right: 78px; width: 24px; height: 24px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface); color: var(--primary, #3b82f6); display: grid; place-items: center; cursor: pointer; box-shadow: var(--shadow-card); z-index: 6; }
    .ninfo:hover { background: var(--primary-50, #eff6ff); border-color: var(--primary); }
    .nreplace { position: absolute; top: -12px; right: 106px; width: 24px; height: 24px; border-radius: 6px; border: 1px solid rgba(239, 68, 68, 0.4); background: #fef2f2; color: #dc2626; display: grid; place-items: center; cursor: pointer; box-shadow: var(--shadow-card); z-index: 6; }
    .nreplace:hover { background: #fee2e2; border-color: #dc2626; }
    .node-err-banner {
      display: flex; gap: 12px; align-items: flex-start;
      background: #fef2f2; border: 1.5px solid #fca5a5; border-radius: 9px;
      padding: 12px 14px; margin-bottom: 14px; color: #991b1b;
    }
    .node-err-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; line-height: 1.45; }
    .node-err-msg { color: #7f1d1d; }
    .node-err-remedy { color: #991b1b; }
    .node-err-actions { display: flex; flex-direction: column; gap: 6px; flex-shrink: 0; }
    .btn-node-replace { background: #dc2626 !important; color: #fff !important; border: none !important; }
    .btn-node-replace:hover { background: #b91c1c !important; }
    .node-editor-footer-actions { display: flex; gap: 8px; justify-content: space-between; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
    .modal-h { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--border); font-weight: 700; }
    .modal-h .chip.sm { width: 24px; height: 24px; border-radius: 7px; color: #fff; display: grid; place-items: center; font-size: 12px; }
    .modal-h .x { border: none; background: transparent; font-size: 16px; cursor: pointer; color: var(--muted); }
    .fld-lbl-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
    .cheat-pill { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border); background: var(--surface-2, rgba(255,255,255,0.06)); border-radius: 6px; padding: 2px 8px; font-size: 11px; font-weight: 600; color: var(--primary); cursor: pointer; transition: all 0.15s ease; }
    .cheat-pill:hover { background: var(--primary-50, rgba(99,102,241,0.15)); border-color: var(--primary); }
    .mr-2 { margin-right: 8px; }
    .modal-body { padding: 16px 18px; overflow: auto; }
    .vtag { display:flex; align-items:center; gap:4px; font-size:12px; white-space:nowrap; }
    .pprops { margin-bottom:10px; } .pprops summary { cursor:pointer; font-weight:600; font-size:12.5px; margin-bottom:6px; }
    .vrow { display: flex; gap: 8px; margin-bottom: 8px; }
    .vrow input { flex: 1; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; }
    .vrow select { flex: 0 0 120px; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; }
    .vrow .x { flex: 0 0 auto; width: 32px; border: 1px solid var(--border); background: var(--surface); border-radius: 8px; cursor: pointer; color: var(--muted); }
    .vrow .x:hover { background: var(--red-bg); color: var(--red); }
    .modal-body .add { border: 1px dashed var(--border); background: var(--surface); border-radius: 8px; padding: 6px 12px; font-size: 13px; cursor: pointer; color: var(--muted); margin-top: 6px; }
    .modal-body .add:hover { border-color: var(--primary); color: var(--primary); }
      @media (max-width: 900px) {
      .body { flex-direction: column; }
      .palette { width: 100%; height: 76px; flex: 0 0 auto; border-right: 0; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 6px; overflow-x: auto; overflow-y: hidden; padding: 8px 12px; }
      .palette .search { flex: 0 0 150px; width: 150px; margin: 0; }
      .palette .cat-h { display: none; }
      .palette .cat-grid { display: contents; }
      .palette .ptile { flex: 0 0 auto; background: var(--surface-3); border-radius: var(--radius-pill); padding: 6px 12px 6px 8px; white-space: nowrap; }
      .canvas { min-height: 320px; }
    }
  `],
})
export class ProcessCanvasComponent implements OnChanges {
  private api = inject(WorkflowApiService);
  private instanceApi = inject(InstanceApiService);
  private toast = inject(ToastService);
  private canvasElRef = viewChild<ElementRef<HTMLElement>>('canvasEl');
  private scrollRef = viewChild<ElementRef<HTMLElement>>('scrollArea');
  private problemsPanel = viewChild(ProblemsPanelComponent);

  @Input({ required: true }) workflowId!: string;
  @Input({ required: true }) processId!: string;
  /** The project's assets by kind, passed straight through to the property modal's asset-reference
   *  pickers (see properties-panel.component.ts). Owned by ProjectContextService one level up. */
  @Input() assets: Record<string, { name: string; usedBy: number }[]> = {};
  @Input() focusNodeId?: string | null;
  @Output() saved = new EventEmitter<void>();

  catalog = signal<Catalog | null>(null);
  callableProcesses = signal<CallableProcess[]>([]);
  private callableProcessesLoaded = false;
  nodes = signal<CNode[]>([]);
  edges = signal<CEdge[]>([]);
  selNode = signal<CNode | null>(null);
  selEdge = signal<string | null>(null);
  editingNode = signal<CNode | null>(null);
  editingEdge = signal<CEdge | null>(null);
  nodeModalTab = signal<'props' | 'docs'>('props');
  viewingDocs = signal<{ engineType: string; label: string; content: string } | null>(null);

  private readonly CLIPBOARD_PREFIX = 'pru_bpm_canvas_clipboard_';
  projectClipboard = signal<CNode | null>(null);
  clipboardNodeName = computed(() => this.projectClipboard()?.name || this.projectClipboard()?.id);
  hasClipboard = computed(() => this.projectClipboard() !== null);

  readmeFor(type: string): string {
    return this.catalog()?.readmes?.[type] || 'No documentation available for this node.';
  }

  openDocsFor(engineType: string, label?: string) {
    const content = this.readmeFor(engineType);
    const displayLabel = label || this.catalog()?.typeLabels?.[engineType] || engineType;
    this.viewingDocs.set({ engineType, label: displayLabel, content });
  }

  closeDocs() {
    this.viewingDocs.set(null);
  }

  showCheatSheet = signal(false);
  cheatSheetLang = signal<string>('js');

  openCheatSheet(lang: string = 'js') {
    this.cheatSheetLang.set(lang);
    this.showCheatSheet.set(true);
  }

  closeCheatSheet() {
    this.showCheatSheet.set(false);
  }

  cheatSheetTitle(): string {
    return this.cheatSheetLang() === 'java'
      ? 'Java & Imported Script Reference'
      : 'JavaScript & Flow Variables Cheat Sheet';
  }

  cheatSheetContent(): string {
    if (this.cheatSheetLang() === 'java') {
      return this.catalog()?.javaReference || '# Java & Imported Script Reference\n\nNo Java reference content available.';
    }
    return this.catalog()?.cheatSheet || '# JavaScript & Flow Variables Cheat Sheet\n\nNo cheat sheet content available.';
  }

  javaReferenceContent(): string {
    return this.catalog()?.javaReference || '# Java & Imported Script Reference\n\nNo Java reference content available.';
  }
  linkFrom = signal<string | null>(null);
  linkError = signal<string>('');
  saveState = signal<'saved' | 'saving' | 'dirty'>('saved');
  showVars = signal(false);
  procVars = signal<{ name: string; type: string; tags?: string[] }[]>([]);
  /** Process-level fields the canvas does not draw (description, SLA, version, ad-hoc, imported extras) — kept so saving never drops them. */
  private procExtra: Record<string, any> = {};
  processName = signal('');
  q = '';
  addQ = '';
  zoom = signal(1);
  panMode = signal(false);
  addPopoverFor = signal<string | null>(null);
  addPopoverPos = signal<{ x: number; y: number }>({ x: 0, y: 0 });
  NW = NW; NH = NH;
  private branchId = ''; private idc = 0; private saveTimer: any;
  private pointer = { x: 0, y: 0 };
  private drag: { id: string; offX: number; offY: number; moved: boolean } | null = null;
  private linkMoved = false;   // did the pointer move while linking? (drag-to-connect vs click-to-arm)

  problems = signal<Problem[]>([]);
  errorCount = computed(() => this.problems().filter((p) => p.severity === 'error').length);
  warnCount = computed(() => this.problems().filter((p) => p.severity === 'warning').length);
  private errIds = computed(() => new Set(this.problems().filter((p) => p.severity === 'error' && p.nodeId).map((p) => p.nodeId!)));
  private warnIds = computed(() => new Set(this.problems().filter((p) => p.severity === 'warning' && p.nodeId).map((p) => p.nodeId!)));
  cats = computed(() => this.catalog()?.categories ?? []);
  saveLabel = computed(() => ({ saved: 'Saved', saving: 'Saving…', dirty: 'Unsaved' }[this.saveState()]));
  zoomPct = computed(() => Math.round(this.zoom() * 100));

  /** Node dimensions per BPMN 2.0 shape:
   *  - Events (start, end, catch, throw, boundary): 44x44 circle
   *  - Gateways: 52x52 diamond
   *  - Tasks / Activities / Call Activities / Subprocesses: 180x56 rounded rectangle */
  nodeDims(type: string): { w: number; h: number } {
    if (type === 'start' || type === 'end' || type === 'catch' || type === 'throw' || type === 'boundary') {
      return { w: 44, h: 44 };
    }
    if (type === 'gateway') {
      return { w: 52, h: 52 };
    }
    return { w: 180, h: 56 };
  }
  isCircle(type: string): boolean { return this.nodeDims(type).w === 44; }
  isDiamond(type: string): boolean { return this.nodeDims(type).w === 52; }
  isRectangle(type: string): boolean { return this.nodeDims(type).w === 180; }

  nodeAnchorOut(n: CNode): { x: number; y: number } {
    const d = this.nodeDims(n.type);
    return { x: n.x + d.w, y: n.y + d.h / 2 };
  }
  nodeAnchorIn(n: CNode): { x: number; y: number } {
    const d = this.nodeDims(n.type);
    return { x: n.x, y: n.y + d.h / 2 };
  }

  gatewayMarker(n: CNode): string {
    const mode = n['mode'] || 'exclusive';
    if (mode === 'parallel') return '+';
    if (mode === 'inclusive') return '○';
    if (mode === 'event') return '⬠';
    return '✕';
  }

  /** Branches (multi-output edges) that the user has given an explicit name — rendered as a pill
   *  above the branch, e.g. "Open" / "Close" on a business-hours gateway. */
  labeledBranches = computed(() => {
    const out: { edge: CEdge; x: number; y: number; text: string }[] = [];
    for (const e of this.edges()) {
      if (!e.label) continue;
      if (this.siblingCount(e) <= 1) continue;
      const b = this.nodeById(e.to); if (!b) continue;
      out.push({ edge: e, x: b.x, y: b.y - 28, text: e.label });
    }
    return out;
  });
  /** Branches with no explicit label get a small numbered circle instead (1, 2, 3…), sitting on the
   *  incoming connector just before the target node. */
  numberedBranches = computed(() => {
    const out: { edge: CEdge; x: number; y: number; text: string }[] = [];
    for (const e of this.edges()) {
      if (e.label) continue;
      const siblings = this.edges().filter((x) => x.from === e.from);
      if (siblings.length <= 1) continue;
      const b = this.nodeById(e.to); if (!b) continue;
      out.push({ edge: e, x: b.x - 26, y: b.y + this.nodeDims(b.type).h / 2 - 11, text: String(siblings.indexOf(e) + 1) });
    }
    return out;
  });
  siblingCount(e: CEdge) { return this.edges().filter((x) => x.from === e.from).length; }

  /**
   * Dynamic canvas dimension signals:
   * Explicitly sizes `.zoomlayer` and `<svg class="edges">` to enclose all nodes, branch badges,
   * loopback routing gutters, and labels, PLUS a generous workspace padding (900px horizontal, 600px vertical).
   *
   * Without explicit width/height, `.zoomlayer` collapses to the viewport width, and browsers hard-stop
   * scrolling right at the outermost node border (or clip nodes under CSS `zoom`), preventing users from
   * seeing subsequent flows, inspecting end-events, or having room to add new nodes to expand the flow.
   */
  canvasWidth = computed(() => {
    let maxX = 2400;
    for (const n of this.nodes()) {
      const d = this.nodeDims(n.type);
      const right = n.x + d.w;
      if (right > maxX) maxX = right;
    }
    for (const b of this.labeledBranches()) {
      if (b.x + 160 > maxX) maxX = b.x + 160;
    }
    for (const e of this.edges()) {
      const fromNode = this.nodeById(e.from);
      const toNode = this.nodeById(e.to);
      if (fromNode && toNode && toNode.x < fromNode.x) {
        const outX = fromNode.x + this.nodeDims(fromNode.type).w + 20;
        if (outX > maxX) maxX = outX;
      }
    }
    return maxX + 900;
  });

  canvasHeight = computed(() => {
    let maxY = 1400;
    for (const n of this.nodes()) {
      const d = this.nodeDims(n.type);
      const bottom = n.y + d.h;
      if (bottom > maxY) maxY = bottom;
    }
    for (const e of this.edges()) {
      const fromNode = this.nodeById(e.from);
      const toNode = this.nodeById(e.to);
      if (fromNode && toNode && toNode.x < fromNode.x) {
        const fromBottom = fromNode.y + this.nodeDims(fromNode.type).h;
        const toBottom = toNode.y + this.nodeDims(toNode.type).h;
        const bypassY = Math.max(fromBottom, toBottom) + 50;
        if (bypassY > maxY) maxY = bypassY;
      }
    }
    return maxY + 600;
  });

  hasErr(id: string) { return this.errIds().has(id); }
  hasWarn(id: string) { return this.warnIds().has(id); }
  private runValidate() {
    this.api.validateProcess(this.buildProcess()).subscribe((r) => this.problems.set(r.problems));
  }
  pickProblem(id: string) {
    const n = this.nodes().find((x) => x.id === id);
    if (n) { this.selNode.set(n); this.selEdge.set(null); return; }
    const e = this.edges().find((x) => x.id === id);
    if (e) { this.selEdge.set(e.id); this.selNode.set(null); }
  }

  getErrorForNode(id: string): Problem | undefined {
    return this.problems().find((p) => p.nodeId === id && p.severity === 'error') || this.problems().find((p) => p.nodeId === id);
  }

  replaceNode(nodeId: string) {
    const current = this.nodes().find((n) => n.id === nodeId);
    if (!current) return;
    let targetType = current.type;
    let spec = this.catalog()?.nodes.find((s) => s.engineType === targetType);
    if (!spec || !this.isSupported(targetType)) {
      targetType = 'script';
      spec = this.catalog()?.nodes.find((s) => s.engineType === 'script');
    }
    const defaults = spec?.defaults ? JSON.parse(JSON.stringify(spec.defaults)) : { type: targetType, code: '// Replaced unsupported construct\nkcontext.setVariable("replaced", true);' };
    const freshNode: CNode = {
      ...defaults,
      id: current.id, // Preserves sequence flow connections!
      type: targetType,
      name: current.name || spec?.label || targetType,
      x: current.x,
      y: current.y,
    };
    this.nodes.set(this.nodes().map((n) => (n.id === nodeId ? freshNode : n)));
    if (this.selNode()?.id === nodeId) this.selNode.set(freshNode);
    if (this.editingNode()?.id === nodeId) this.editingNode.set(freshNode);
    this.markDirty();
    this.toast.success(`Replaced "${current.name || current.type}" with a fresh ${targetType} task.`);
    this.validate();
  }

  clearNodeLifecycleActions(nodeId: string) {
    const current = this.nodes().find((n) => n.id === nodeId);
    if (!current) return;
    const updated: CNode = { ...current };
    delete updated['onEntry'];
    delete updated['onEntryLang'];
    delete updated['onExit'];
    delete updated['onExitLang'];
    this.nodes.set(this.nodes().map((n) => (n.id === nodeId ? updated : n)));
    if (this.selNode()?.id === nodeId) this.selNode.set(updated);
    if (this.editingNode()?.id === nodeId) this.editingNode.set(updated);
    this.markDirty();
    this.toast.success(`Cleared lifecycle actions on "${current.name || current.type}".`);
    this.validate();
  }

  nodeProblemTooltip(id: string): string {
    const probs = this.problems().filter((p) => p.nodeId === id);
    if (!probs.length) return '';
    return probs.map((p) => `[${p.severity.toUpperCase()}] ${p.rule}: ${p.message}${p.remedy ? '\n💡 Fix: ' + p.remedy : ''}`).join('\n\n');
  }

  nodeTooltip(n: CNode): string {
    if (!this.isSupported(n.type)) {
      return `[UNSUPPORTED CONSTRUCT] "${n.name || n.id}" (${n.type}) is not supported by the execution engine.\n💡 Recommendation: Click the refresh icon to replace this node with a supported task from the palette.`;
    }
    const base = `${this.typeLabel(n)}${n.name ? ': ' + n.name : ''}`;
    const probs = this.problems().filter((p) => p.nodeId === n.id);
    if (!probs.length) return base;
    const probSummary = probs.map((p) => `• [${p.severity.toUpperCase()}] ${p.message}${p.remedy ? '\n  💡 Fix: ' + p.remedy : ''}`).join('\n');
    return `${base}\n\nValidation Issues:\n${probSummary}`;
  }

  openNodeProblems(id: string) {
    this.pickProblem(id);
    const panel = this.problemsPanel();
    if (panel) {
      panel.collapsed.set(false);
    }
  }

  ngOnChanges(changes: SimpleChanges) {
    if (changes['processId'] || changes['workflowId']) {
      this.refreshProjectClipboard();
      this.selNode.set(null); this.selEdge.set(null); this.editingNode.set(null); this.editingEdge.set(null);
      this.zoom.set(1); this.panMode.set(false); this.addPopoverFor.set(null);
      if (!this.catalog()) this.api.catalog().subscribe((c) => this.catalog.set(c));
      if (!this.callableProcessesLoaded) { this.callableProcessesLoaded = true; this.api.callableProcesses().subscribe((ps) => this.callableProcesses.set(ps)); }
      this.api.getProcess(this.workflowId, this.processId).subscribe((p) => this.loadProcess(p));
      this.api.getWorkflow(this.workflowId).subscribe((w) => { this.branchId = w.defaultBranchId; });
    } else if (changes['focusNodeId']?.currentValue) {
      this.focusOnNode(this.focusNodeId!);
    }
  }

  focusOnNode(nodeId: string) {
    const target = this.nodes().find((n) => n.id === nodeId);
    if (!target) return;
    this.openNodeEditor(target);
    setTimeout(() => {
      const el = document.getElementById(`node-${target.id}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
    }, 50);
  }

  // ---- visuals / labels ----
  visual(t: string) { return this.catalog()?.diagram?.[t] || { icon: 'info', color: '#64748b', shape: 'rectangle' as const }; }
  shapeOf(t: string) { return this.visual(t).shape; }
  labelFor(n: CNode) { return this.catalog()?.nodes.find((s) => s.engineType === n.type)?.label || n.type; }
  typeLabel(n: CNode) { return this.catalog()?.typeLabels?.[n.type] || n.type; }
  nodesIn(cat: string, query: string): NodeSpec[] {
    const q = query.trim().toLowerCase();
    return (this.catalog()?.nodes ?? []).filter((n) => n.category === cat && (!q || n.label.toLowerCase().includes(q)));
  }

  // ---- load / map (a single process within the project) ----
  private loadProcess(proc: any) {
    if (!proc) return;
    this.processName.set(proc.name || this.processId);
    this.procVars.set([...(proc.vars || [])]);
    const { id: _i, name: _n, package: _p, vars: _v, nodes: _no, flows: _f, ...extra } = proc;
    this.procExtra = extra;
    const hasExistingPositions = (proc.nodes || []).some((n: any) => n.x != null && n.y != null);
    const cn: CNode[] = (proc.nodes || []).map((n: any, i: number) => ({
      ...n, x: n.x ?? (100 + (i % 4) * 230), y: n.y ?? (90 + Math.floor(i / 4) * 150),
    }));
    this.nodes.set(cn);
    this.edges.set((proc.flows || []).map((f: any, i: number) => ({ id: f.id || `e${i}_${f.from}_${f.to}`, from: f.from, to: f.to, when: f.when, lang: f.lang, label: f.label, priority: f.priority })));
    // Preserve saved / imported coordinates; auto-layout only if fresh/unpositioned
    if (!hasExistingPositions) {
      this.applyAutoLayout();
    }
    this.saveState.set('saved');
    this.runValidate();
    if (this.focusNodeId) {
      setTimeout(() => this.focusOnNode(this.focusNodeId!), 100);
    }
  }

  private buildProcess() {
    return {
      ...this.procExtra,
      id: this.processId, name: this.processName(), package: 'com.acme', vars: this.procVars(),
      nodes: this.nodes().map((n) => ({ ...n })),
      flows: this.edges().map((e) => ({ id: e.id, from: e.from, to: e.to, ...(e.when ? { when: e.when, lang: 'js' } : {}), ...(e.label ? { label: e.label } : {}), ...(e.priority ? { priority: Number(e.priority) } : {}) })),
    };
  }

  // ---- palette drag → drop ----
  onDragStart(ev: DragEvent, spec: NodeSpec) { ev.dataTransfer?.setData('text/plain', spec.key); if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy'; }
  onDrop(ev: DragEvent) {
    ev.preventDefault();
    const key = ev.dataTransfer?.getData('text/plain');
    const spec = this.catalog()?.nodes.find((s) => s.key === key);
    if (!spec) return;
    if (!this.isSupported(spec.engineType)) {
      this.toast.error(`Node type "${spec.engineType}" is not supported by the execution engine`);
      return;
    }
    const { x: px, y: py } = this.toLocal(ev.clientX, ev.clientY);
    const node: CNode = { id: this.newId(spec.engineType), ...(spec.defaults as any), name: (spec.defaults as any).name || spec.label, x: Math.max(10, Math.round(px)), y: Math.max(10, Math.round(py)) };
    this.nodes.set([...this.nodes(), node]);
    this.selNode.set(node); this.selEdge.set(null);
    this.markDirty();
  }
  private newId(type: string) { return `${type}_${(this.idc++).toString(36)}${Date.now().toString(36).slice(-3)}`; }

  /** Click-to-add fallback (works even where native HTML5 drag doesn't). */
  addFromPalette(spec: NodeSpec) {
    if (!this.isSupported(spec.engineType)) {
      this.toast.error(`Node type "${spec.engineType}" is not supported by the execution engine`);
      return;
    }
    const sel = this.selNode();
    const x = sel ? sel.x + 220 : 100 + (this.nodes().length % 4) * 220;
    const y = sel ? sel.y : 100 + Math.floor(this.nodes().length / 4) * 120;
    const node: CNode = { id: this.newId(spec.engineType), ...(spec.defaults as any), name: (spec.defaults as any).name || spec.label, x, y };
    this.nodes.set([...this.nodes(), node]);
    this.selNode.set(node); this.selEdge.set(null);
    this.markDirty();
  }

  // ---- inline "+" add: append (and connect) a node straight from an existing one ----
  canAddFrom(n: CNode): boolean {
    if (!this.isSupported(n.type)) return false;
    if (!this.hasOut(n.type)) return false;
    const p = this.portsFor(n.type);
    const outCount = this.edges().filter((e) => e.from === n.id).length;
    return p.maxOut == null || outCount < p.maxOut;
  }
  openAddPopover(ev: Event, n: CNode) {
    ev.stopPropagation();
    const btn = ev.currentTarget as HTMLElement;
    const canvasEl = this.canvasElRef()?.nativeElement; if (!canvasEl) return;
    const br = btn.getBoundingClientRect(), cr = canvasEl.getBoundingClientRect();
    this.addPopoverPos.set({ x: Math.min(br.left - cr.left + 30, cr.width - 250), y: Math.min(Math.max(0, br.top - cr.top - 40), cr.height - 340) });
    this.addPopoverFor.set(n.id);
    this.addQ = '';
  }
  closeAddPopover() { this.addPopoverFor.set(null); }
  pickAdd(spec: NodeSpec) {
    const fromId = this.addPopoverFor(); if (!fromId) return;
    const from = this.nodes().find((x) => x.id === fromId);
    this.addPopoverFor.set(null);
    if (!from) return;
    const fromDims = this.nodeDims(from.type);
    const node: CNode = { id: this.newId(spec.engineType), ...(spec.defaults as any), name: (spec.defaults as any).name || spec.label, x: from.x + fromDims.w + 60, y: from.y };
    const check = this.canConnect(from, node);
    this.nodes.set([...this.nodes(), node]);
    if (check.ok) this.edges.set([...this.edges(), { id: `e${this.idc++}_${fromId}_${node.id}`, from: fromId, to: node.id }]);
    else this.toast.error(check.reason || 'Added the node, but could not auto-connect it');
    this.selNode.set(node); this.selEdge.set(null);
    this.markDirty();
  }

  // ---- node drag (pointer) ----
  startDrag(ev: PointerEvent, n: CNode) {
    if ((ev.target as HTMLElement).classList.contains('port') || (ev.target as HTMLElement).closest('.port')) return;
    const { x: px, y: py } = this.toLocal(ev.clientX, ev.clientY);
    this.drag = { id: n.id, offX: px - n.x, offY: py - n.y, moved: false };
    (ev.currentTarget as HTMLElement).setPointerCapture?.(ev.pointerId);
  }
  @HostListener('document:pointermove', ['$event'])
  onMove(ev: PointerEvent) {
    const el = this.scrollRef()?.nativeElement; if (!el) return;
    this.pointer = this.toLocal(ev.clientX, ev.clientY);
    if (this.linkFrom()) this.linkMoved = true;
    if (this.drag) {
      const n = this.nodes().find((x) => x.id === this.drag!.id);
      if (n) {
        n.x = Math.max(10, Math.round(this.pointer.x - this.drag.offX));
        n.y = Math.max(10, Math.round(this.pointer.y - this.drag.offY));
        this.drag.moved = true;
        this.nodes.set([...this.nodes()]);
      }
    }

    // Edge auto-scroll: if dragging a node or a connection line near viewport edges,
    // smoothly scroll the viewport so the user can easily drag across long diagrams.
    if (this.drag || this.linkFrom()) {
      const rect = el.getBoundingClientRect();
      const margin = 50;
      const step = 16;
      if (ev.clientX > rect.right - margin) el.scrollLeft += step;
      else if (ev.clientX < rect.left + margin) el.scrollLeft -= step;
      if (ev.clientY > rect.bottom - margin) el.scrollTop += step;
      else if (ev.clientY < rect.top + margin) el.scrollTop -= step;
    }
  }

  @HostListener('wheel', ['$event'])
  onWheel(ev: WheelEvent) {
    if (ev.ctrlKey || ev.metaKey) {
      ev.preventDefault();
      if (ev.deltaY < 0) this.zoomIn();
      else if (ev.deltaY > 0) this.zoomOut();
    }
  }
  @HostListener('document:pointerup')
  onUp() {
    if (this.drag?.moved) {
      this.markDirty();
    }
    this.drag = null;
    if (this.linkFrom() && this.linkMoved) { this.linkFrom.set(null); this.linkMoved = false; }
  }

  // ---- Project-scoped Copy / Paste / Duplicate ----
  refreshProjectClipboard() {
    if (!this.workflowId) {
      this.projectClipboard.set(null);
      return;
    }
    try {
      const raw = sessionStorage.getItem(this.CLIPBOARD_PREFIX + this.workflowId);
      if (raw) {
        const payload = JSON.parse(raw);
        if (payload && payload.workflowId === this.workflowId && payload.node) {
          this.projectClipboard.set(payload.node);
          return;
        }
      }
    } catch {}
    this.projectClipboard.set(null);
  }

  copySelected() {
    const n = this.selNode();
    if (n) this.copyNode(undefined, n);
  }

  copyNode(ev?: Event, n?: CNode) {
    if (ev) ev.stopPropagation();
    const target = n || this.selNode();
    if (!target) return;
    const payload = {
      workflowId: this.workflowId,
      sourceProcessId: this.processId,
      node: JSON.parse(JSON.stringify(target)),
      copiedAt: new Date().toISOString(),
    };
    try {
      sessionStorage.setItem(this.CLIPBOARD_PREFIX + this.workflowId, JSON.stringify(payload));
    } catch {}
    this.projectClipboard.set(payload.node);
    this.toast.success(`Copied "${target.name || target.id}" to project clipboard`);
  }

  canPaste(): boolean {
    return this.hasClipboard();
  }

  pasteNode() {
    let payload: { workflowId: string; node: CNode } | null = null;
    try {
      const raw = sessionStorage.getItem(this.CLIPBOARD_PREFIX + this.workflowId);
      if (raw) payload = JSON.parse(raw);
    } catch {}

    if (!payload || payload.workflowId !== this.workflowId || !payload.node) {
      this.toast.error('Nothing copied to clipboard for this project. Select a node and press Ctrl+C / Cmd+C first.');
      return;
    }

    const base = payload.node;
    const baseType = base.type || 'task';
    let newId = `${baseType}_${++this.idc}_${Date.now().toString(36).slice(-3)}`;
    while (this.nodes().some((x) => x.id === newId)) {
      newId = `${baseType}_${++this.idc}_${Date.now().toString(36).slice(-3)}`;
    }

    let newX = (base.x || 100) + 40;
    let newY = (base.y || 100) + 40;
    while (this.nodes().some((n) => Math.abs(n.x - newX) < 15 && Math.abs(n.y - newY) < 15)) {
      newX += 30;
      newY += 30;
    }

    const newNode: CNode = {
      ...JSON.parse(JSON.stringify(base)),
      id: newId,
      name: base.name ? `${base.name} (Copy)` : newId,
      x: newX,
      y: newY,
    };

    this.nodes.set([...this.nodes(), newNode]);
    this.selNode.set(newNode);
    this.selEdge.set(null);
    this.markDirty();
    this.toast.success(`Pasted "${newNode.name}" into canvas`);
  }

  duplicateNode(ev?: Event, n?: CNode) {
    if (ev) ev.stopPropagation();
    const target = n || this.selNode();
    if (!target) return;
    this.copyNode(undefined, target);
    this.pasteNode();
  }

  @HostListener('document:keydown', ['$event'])
  onKeyDown(ev: KeyboardEvent) {
    if (this.editingNode() || this.editingEdge() || this.showVars() || this.showCheatSheet() || this.viewingDocs()) {
      return;
    }

    const activeEl = document.activeElement as HTMLElement | null;
    if (activeEl) {
      const tag = activeEl.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || activeEl.isContentEditable || activeEl.closest('.modal') || activeEl.closest('.modal-bg')) {
        return;
      }
    }

    const isMod = ev.ctrlKey || ev.metaKey;

    // Ctrl+C / Cmd+C -> Copy
    if (isMod && (ev.key === 'c' || ev.key === 'C')) {
      if (this.selNode()) {
        ev.preventDefault();
        this.copySelected();
      }
      return;
    }

    // Ctrl+V / Cmd+V -> Paste
    if (isMod && (ev.key === 'v' || ev.key === 'V')) {
      if (this.canPaste()) {
        ev.preventDefault();
        this.pasteNode();
      }
      return;
    }

    // Ctrl+D / Cmd+D -> Duplicate
    if (isMod && (ev.key === 'd' || ev.key === 'D')) {
      if (this.selNode()) {
        ev.preventDefault();
        this.duplicateNode(undefined, this.selNode()!);
      }
      return;
    }

    // Delete or Backspace -> Delete selected node or edge
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (this.selNode()) {
        ev.preventDefault();
        this.del(ev, this.selNode()!);
      } else if (this.selEdge()) {
        ev.preventDefault();
        this.delEdge(this.selEdge()!);
      }
      return;
    }
  }

  /** Screen (clientX/Y) → logical canvas coordinates, correcting for the CSS `zoom` on `.zoomlayer`
   *  (zoom rescales rendered/hit-tested size, so raw client-space deltas must be divided back down). */
  private toLocal(clientX: number, clientY: number): { x: number; y: number } {
    const el = this.scrollRef()!.nativeElement;
    const rect = el.getBoundingClientRect();
    const z = this.zoom();
    return { x: (clientX - rect.left + el.scrollLeft) / z, y: (clientY - rect.top + el.scrollTop) / z };
  }

  // ---- selection (single click highlights; double-click opens the property modal) ----
  selectNode(ev: Event, n: CNode) { ev.stopPropagation(); if (this.linkFrom()) { this.completeLink(n); return; } this.selNode.set(n); this.selEdge.set(null); }
  selectEdge(ev: Event, e: CEdge) { ev.stopPropagation(); this.selEdge.set(e.id); this.selNode.set(null); }
  bgClick() { this.linkFrom.set(null); this.linkMoved = false; this.linkError.set(''); this.selNode.set(null); this.selEdge.set(null); this.addPopoverFor.set(null); }
  openNodeEditor(n: CNode) { this.selNode.set(n); this.selEdge.set(null); this.editingNode.set(n); this.nodeModalTab.set('props'); }
  closeNodeEditor() { this.editingNode.set(null); }
  openEdgeEditor(e: CEdge) { this.selEdge.set(e.id); this.selNode.set(null); this.editingEdge.set(e); }
  closeEdgeEditor() { this.editingEdge.set(null); }

  // ---- pan tool: drag the background to scroll (toggled via the zoom control's hand button or middle-click) ----
  onCanvasPointerDown(ev: PointerEvent) {
    const isMiddle = ev.button === 1;
    if (!this.panMode() && !isMiddle) return;
    if ((ev.target as HTMLElement).closest('.node, .addbtn, .branchpill, .branchbadge')) return;
    if (isMiddle) ev.preventDefault();
    const el = this.scrollRef()!.nativeElement;
    const startX = ev.clientX, startY = ev.clientY, startLeft = el.scrollLeft, startTop = el.scrollTop;
    const move = (e: PointerEvent) => { el.scrollLeft = startLeft - (e.clientX - startX); el.scrollTop = startTop - (e.clientY - startY); };
    const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }

  // ---- zoom ----
  zoomIn() { this.zoom.set(Math.min(1.5, Math.round((this.zoom() + 0.1) * 10) / 10)); }
  zoomOut() { this.zoom.set(Math.max(0.5, Math.round((this.zoom() - 0.1) * 10) / 10)); }
  zoomReset() { this.zoom.set(1); }

  // ---- connect: drag from a node's output port to a target node (jBPM sequence-flow rules) ----
  startLink(ev: PointerEvent, n: CNode) {
    ev.stopPropagation(); ev.preventDefault();   // don't start a node drag; begin a link drag
    this.linkError.set(''); this.selNode.set(null); this.linkFrom.set(n.id);
  }
  // pointer released over a node while linking → complete (ignore release on the source itself)
  onNodePointerUp(_ev: Event, n: CNode) { const f = this.linkFrom(); if (f && f !== n.id) this.completeLink(n); }
  private completeLink(to: CNode) {
    const fromId = this.linkFrom();
    const clear = () => { this.linkFrom.set(null); this.linkMoved = false; };
    if (!fromId) return;
    if (fromId === to.id) { clear(); return; }
    const from = this.nodes().find((x) => x.id === fromId);
    if (!from) { clear(); return; }
    const check = this.canConnect(from, to);
    if (!check.ok) { this.linkError.set(check.reason!); clear(); setTimeout(() => this.linkError.set(''), 3500); return; }
    this.edges.set([...this.edges(), { id: `e${this.idc++}_${fromId}_${to.id}`, from: fromId, to: to.id }]);
    clear();
    this.markDirty();
  }
  // per-node config from the backend catalog (single source of truth for ports + property schema)
  portsFor(type: string) { return this.catalog()?.ports?.[type] || {}; }
  isSupported(type: string): boolean {
    if (!type) return false;
    const cat = this.catalog();
    if (!cat) return true; // loading fallback
    return Boolean(cat.ports && cat.ports[type]);
  }
  hasIn(type: string) {
    if (!this.isSupported(type)) return false;
    return this.portsFor(type).maxIn !== 0;
  }
  hasOut(type: string) {
    if (!this.isSupported(type)) return false;
    return this.portsFor(type).maxOut !== 0;
  }
  schemaFor(type: string) { return this.catalog()?.schemas?.[type] || []; }

  /** Connection validity from each node type's declared ports + cardinality (matches the backend). */
  canConnect(from: CNode, to: CNode): { ok: boolean; reason?: string } {
    if (from.id === to.id) return { ok: false, reason: 'Self-connecting loop is not permitted on a single node' };
    if (!this.isSupported(from.type)) {
      return { ok: false, reason: `Node "${from.name || from.id}" (${from.type}) is an unsupported construct and cannot connect to other nodes. Recommendation: Replace with a supported task from the palette.` };
    }
    if (!this.isSupported(to.type)) {
      return { ok: false, reason: `Node "${to.name || to.id}" (${to.type}) is an unsupported construct and cannot receive incoming connections. Recommendation: Replace with a supported task from the palette.` };
    }
    const fp = this.portsFor(from.type), tp = this.portsFor(to.type);
    if (fp.maxOut === 0) return { ok: false, reason: `A ${from.type} has no outgoing connection` };
    if (tp.maxIn === 0) return { ok: false, reason: `A ${to.type} has no incoming connection` };
    if (this.edges().some((e) => e.from === from.id && e.to === to.id)) return { ok: false, reason: 'That connection already exists' };
    const outCount = this.edges().filter((e) => e.from === from.id).length;
    const inCount = this.edges().filter((e) => e.to === to.id).length;
    if (fp.maxOut != null && outCount >= fp.maxOut) return { ok: false, reason: `A ${from.type} allows only ${fp.maxOut} outgoing connection${fp.maxOut === 1 ? '' : 's'}` };
    if (tp.maxIn != null && inCount >= tp.maxIn) return { ok: false, reason: `A ${to.type} allows only ${tp.maxIn} incoming connection${tp.maxIn === 1 ? '' : 's'}` };
    return { ok: true };
  }
  /** `e` is the same object living inside the `edges` signal's array — mutating a field on it in
   *  place does NOT change the array's reference, so `computed()`s that depend on `edges()` (the
   *  branch-badge/pill lists) would never re-run without this explicit re-set. */
  onEdgeChange(_e: CEdge) { this.edges.set([...this.edges()]); this.markDirty(); }

  // ---- delete ----
  del(ev: Event, n: CNode) {
    ev.stopPropagation();
    this.nodes.set(this.nodes().filter((x) => x.id !== n.id));
    this.edges.set(this.edges().filter((e) => e.from !== n.id && e.to !== n.id));
    this.selNode.set(null);
    this.markDirty();
  }
  delEdge(id: string) {
    this.edges.set(this.edges().filter((e) => e.id !== id));
    this.selEdge.set(null);
    this.markDirty();
  }

  // ---- geometry ----
  private nodeById(id: string) { return this.nodes().find((n) => n.id === id); }

  /**
   * Orthogonal ("Manhattan") sequence-flow routing with obstacle & loop bypass.
   *
   * BPMN 2.0 sequence flows render as right-angled polylines with rounded corners.
   * - Forward flows: horizontal run -> vertical midpoint turn -> horizontal run into target.
   * - Backward flows (loops): route out right, vertically down through a bypass gutter below
   *   both nodes, horizontally back across, and up into target input port to avoid collision.
   */
  private orthPath(x1: number, y1: number, x2: number, y2: number, fromNode?: CNode, toNode?: CNode): string {
    const R = 8; // corner radius

    // Direct forward flow on the same row:
    if (Math.abs(y2 - y1) < 4 && x2 >= x1) {
      return `M ${x1} ${y1} L ${x2} ${y2}`;
    }

    // Forward flow (toNode is downstream / to the right)
    if (x2 >= x1 + 24) {
      const midX = Math.round(x1 + (x2 - x1) / 2);
      const down = y2 > y1;
      const r = Math.min(R, Math.abs(y2 - y1) / 2, Math.abs(midX - x1), Math.abs(x2 - midX));
      const vSign = down ? 1 : -1;
      return [
        `M ${x1} ${y1}`,
        `L ${midX - r} ${y1}`,
        `Q ${midX} ${y1} ${midX} ${y1 + r * vSign}`,
        `L ${midX} ${y2 - r * vSign}`,
        `Q ${midX} ${y2} ${midX + r} ${y2}`,
        `L ${x2} ${y2}`,
      ].join(' ');
    }

    // Backward flow / Conditional loopback:
    // Route around nodes through a bypass gutter so we never cut across node bodies
    const dFrom = fromNode ? this.nodeDims(fromNode.type) : { w: 180, h: 56 };
    const dTo = toNode ? this.nodeDims(toNode.type) : { w: 180, h: 56 };
    const fromBottom = (fromNode?.y ?? (y1 - dFrom.h / 2)) + dFrom.h;
    const toBottom = (toNode?.y ?? (y2 - dTo.h / 2)) + dTo.h;
    const bypassY = Math.max(fromBottom, toBottom) + 38;

    const outX = x1 + 20;
    const inX = x2 - 20;
    const r = Math.min(R, Math.abs(bypassY - y1) / 2, Math.abs(bypassY - y2) / 2, 16);

    return [
      `M ${x1} ${y1}`,
      `L ${outX - r} ${y1}`,
      `Q ${outX} ${y1} ${outX} ${y1 + r}`,
      `L ${outX} ${bypassY - r}`,
      `Q ${outX} ${bypassY} ${outX - r} ${bypassY}`,
      `L ${inX + r} ${bypassY}`,
      `Q ${inX} ${bypassY} ${inX} ${bypassY - r}`,
      `L ${inX} ${y2 + r}`,
      `Q ${inX} ${y2} ${inX + r} ${y2}`,
      `L ${x2} ${y2}`,
    ].join(' ');
  }

  edgePath(e: CEdge) {
    const a = this.nodeById(e.from), b = this.nodeById(e.to);
    if (!a || !b) return '';
    const p1 = this.nodeAnchorOut(a), p2 = this.nodeAnchorIn(b);
    return this.orthPath(p1.x, p1.y, p2.x, p2.y, a, b);
  }
  ghostPath(fromId: string) {
    const a = this.nodeById(fromId); if (!a) return '';
    const p1 = this.nodeAnchorOut(a);
    return this.orthPath(p1.x, p1.y, this.pointer.x, this.pointer.y, a);
  }

  // ---- process variables (this process's own variables) ----
  openVars() { this.showVars.set(true); }
  meta(k: string): any { return this.procExtra[k] ?? (k === 'adHoc' ? false : ''); }
  setMeta(k: string, v: any) { if (v === '' || v === undefined || v === false) delete this.procExtra[k]; else this.procExtra[k] = v; this.markDirty(); }
  hasTag(v: { tags?: string[] }, t: string) { return !!v.tags?.includes(t); }
  toggleTag(v: { tags?: string[] }, t: string) { const s = new Set(v.tags || []); s.has(t) ? s.delete(t) : s.add(t); v.tags = [...s]; if (!v.tags.length) delete v.tags; this.markDirty(); }
  addVar() { this.procVars.set([...this.procVars(), { name: '', type: 'string' }]); this.markDirty(); }
  rmVar(i: number) { const v = [...this.procVars()]; v.splice(i, 1); this.procVars.set(v); this.markDirty(); }
  closeVars() { this.showVars.set(false); this.saveNow(); }

  /**
   * Cycle-safe Layered auto-layout:
   *  - Identifies forward edges vs back-edges to prevent infinite depth loops.
   *  - Positions nodes without destroying manually-nudged positions on structural events.
   */
  private computeLayeredPositions(): Map<string, { x: number; y: number }> {
    const ns = this.nodes(), es = this.edges();
    if (ns.length === 0) return new Map();

    const roots = ns.filter((n) => n.type === 'start' || !es.some((e) => e.to === n.id));
    const rootIds = (roots.length ? roots : ns.slice(0, 1)).map((n) => n.id);

    // Identify back-edges using DFS to avoid cycles inflating column depths
    const visited = new Set<string>();
    const inStack = new Set<string>();
    const forwardEdges: CEdge[] = [];

    const dfs = (curr: string) => {
      visited.add(curr);
      inStack.add(curr);
      for (const e of es) {
        if (e.from !== curr) continue;
        if (!inStack.has(e.to)) {
          forwardEdges.push(e);
          if (!visited.has(e.to)) dfs(e.to);
        }
      }
      inStack.delete(curr);
    };

    for (const r of rootIds) if (!visited.has(r)) dfs(r);
    for (const n of ns) if (!visited.has(n.id)) dfs(n.id);

    // Compute column depths along forward edges only
    const col = new Map<string, number>();
    for (const id of rootIds) col.set(id, 0);

    for (let pass = 0; pass < ns.length + 1; pass++) {
      let changed = false;
      for (const e of forwardEdges) {
        if (!col.has(e.from)) continue;
        const c = col.get(e.from)! + 1;
        if (!col.has(e.to) || col.get(e.to)! < c) {
          col.set(e.to, c);
          changed = true;
        }
      }
      if (!changed) break;
    }

    let maxCol = Math.max(0, ...[...col.values()]);
    for (const n of ns) if (!col.has(n.id)) { maxCol += 1; col.set(n.id, maxCol); }

    const byCol = new Map<number, string[]>();
    for (const n of ns) {
      const c = col.get(n.id) ?? 0;
      (byCol.get(c) || byCol.set(c, []).get(c)!).push(n.id);
    }

    const row = new Map<string, number>();
    const cols = [...byCol.keys()].sort((a, b) => a - b);
    for (const c of cols) {
      const idsInCol = byCol.get(c)!;
      if (c === 0) {
        idsInCol.forEach((id, i) => row.set(id, i));
        continue;
      }
      const scored = idsInCol.map((id) => {
        const preds = es.filter((e) => e.to === id && row.has(e.from)).map((e) => row.get(e.from)!);
        const score = preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : idsInCol.indexOf(id);
        return { id, score };
      });
      scored.sort((a, b) => a.score - b.score);
      scored.forEach((s, i) => row.set(s.id, i));
    }

    const out = new Map<string, { x: number; y: number }>();
    for (const n of ns) {
      const c = col.get(n.id) ?? 0;
      const r = row.get(n.id) ?? 0;
      out.set(n.id, { x: 50 + c * COL_W, y: 50 + r * ROW_H });
    }
    return out;
  }

  applyAutoLayout() {
    const pos = this.computeLayeredPositions();
    const ns = this.nodes();
    for (const n of ns) { const p = pos.get(n.id); if (p) { n.x = p.x; n.y = p.y; } }
    this.nodes.set([...ns]);
  }
  /** Public re-snap, wired to the workspace toolbar's "Auto-layout" button. */
  autoLayout() { this.applyAutoLayout(); this.markDirty(); }

  // ---- persistence ----
  markDirty() {
    this.saveState.set('dirty');
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.save(); this.runValidate(); }, 800);
  }
  saveNow() { clearTimeout(this.saveTimer); this.save(); }
  private save() {
    this.saveState.set('saving');
    this.api.saveProcess(this.workflowId, this.processId, this.buildProcess()).subscribe({
      next: () => {
        this.saveState.set('saved');
        this.saved.emit();
      },
      error: () => this.saveState.set('dirty'),
    });
  }
  validate() {
    this.api.validateProcess(this.buildProcess()).subscribe((r) => {
      this.problems.set(r.problems);
      const panel = this.problemsPanel();
      if (!r.ok && panel) {
        panel.collapsed.set(false);
      }
      if (r.ok) {
        this.toast.success('Process is valid and ready for build & deployment.');
      } else {
        const firstErr = r.errors[0];
        const remedyText = firstErr?.remedy ? `\n💡 Fix: ${firstErr.remedy}` : '';
        this.toast.error(`${r.errors.length} validation error(s) found:\n${firstErr?.message}${remedyText}`);
      }
    });
  }

  // ---- run (starts an instance of this process) ----
  run() {
    this.saveNow();
    this.instanceApi.startInstance({ workflowId: this.workflowId, processId: this.processId, environment: 'prod' }).subscribe({
      next: (i) => this.toast.success(`Instance started: ${i.id}\nStatus: ${i.status}`),
      error: (e) => this.toast.error(`Cannot run: ${e?.error?.error?.message || 'deploy the project to prod first'}`),
    });
  }
}
