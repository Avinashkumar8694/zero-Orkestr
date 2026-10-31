import { processLabel } from '../../core/process-label';
import { Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SlicePipe } from '@angular/common';
import { InstanceApiService } from '../../core/api/instance-api.service';
import { DeploymentApiService } from '../../core/api/deployment-api.service';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { QueryApiService } from '../../core/api/query-api.service';
import { OpsApiService } from '../../core/api/ops-api.service';
import { SystemApiService } from '../../core/api/system-api.service';
import { RealtimeService } from '../../core/realtime.service';
import { ToastService } from '../../shared/toast.service';
import { ModalService } from '../../shared/modal.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import type { Catalog, Deployment, ExecutionError, Instance, Task, VariableChange, Workflow } from '../../core/models';

// Wider than the original 150 — most real node names ("Leave Request Submitted", "Notify Employee
// (Approved)") were truncating to unreadable, indistinguishable fragments ("Leave Reques...",
// "Notify Emplo..." — the SAME truncated text for two different nodes). Still truncates on very long
// names, but the [title] tooltip on .gn (see template) is the actual guaranteed fallback for those.
const NW = 190, NH = 52;
const COL_W = NW + 100, ROW_H = NH + 46;
type Tab = 'details' | 'diagram' | 'variables' | 'logs' | 'documents';

interface DocRow { variable: string; filename: string; url?: string; mimeType?: string; }

/** Dedicated instance page (ux_design/mockups/process-instance-detail.html + instance-*-tab.html):
 *  header with quick links + lifecycle actions, five tabs. The diagram/graph rendering here mirrors
 *  the logic that used to live inline in the Instances list (kept verbatim — it works). */
@Component({
  selector: 'app-instance-detail',
  standalone: true,
  imports: [IconComponent, RouterLink, FormsModule, SlicePipe, BreadcrumbComponent],
  template: `
    @if (loading()) {
      <div class="page"><div class="card pad"><div class="skeleton skeleton-line" style="width:40%"></div><div class="skeleton skeleton-card"></div></div></div>
    } @else if (!inst()) {
      <div class="page"><div class="empty-state"><div class="es-icon"><app-icon name="search" [size]="24" /></div><h3>Instance not found</h3><p>It may have been pruned, or the id is wrong.</p><a class="btn" [routerLink]="['/instances']">Back to Instances</a></div></div>
    } @else {
      <div class="page" [class.diagram-tab]="tab() === 'diagram'">
        <div class="topbar">
          <a class="btn ghost sm" [routerLink]="['/instances']"><app-icon name="chevronLeft" [size]="13" /> Instances</a>
          <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: procName(inst()!) + ' #' + shortId(inst()!.id) }]" /></div>
          <span class="spacer"></span>
          <a class="btn sm" [routerLink]="['/projects', inst()!.workflowId]">View Process <app-icon name="arrowRight" [size]="12" /></a>
          <a class="btn sm" [routerLink]="['/tasks']" [queryParams]="{instanceId: inst()!.id}">View Tasks <app-icon name="arrowRight" [size]="12" /></a>
          <a class="btn sm" [routerLink]="['/errors']" [queryParams]="{instanceId: inst()!.id}">View Errors <app-icon name="arrowRight" [size]="12" /></a>
        </div>

        <div class="row" style="margin-bottom:2px;">
          <h1>{{ procName(inst()!) }} — <span class="mono">#{{ shortId(inst()!.id) }}</span></h1>
          <span class="badge" [style.color]="statusColor(inst()!.status)">{{ inst()!.status }}</span>
        </div>
        <p class="muted meta">Started by {{ inst()!.startedBy }} · {{ ago(inst()!.startedAt) }} @if (inst()!.correlationKey) { · Correlation key {{ inst()!.correlationKey }} } · Deployment {{ version(inst()!) }}</p>

        <div class="row actionrow">
          @if (isTerminal()) {
            <span class="muted sm">This instance is {{ inst()!.status }} — it's finished and read-only; nothing here can resume, signal, or retry it.</span>
          } @else {
            <!-- Signal needs a live waiting token — blocked on suspended (nothing should touch a paused
                 instance) and failed (the failing token was already removed; "Retry failed node" below
                 is the one real recovery path there), so it follows the same canRetryOrSignal() rule as
                 the diagram's re-trigger panel. Suspend/Resume only makes sense on something actually
                 running/waiting/already-suspended — pausing a failed instance would be a silent no-op
                 (matches bulkSuspend's own running/waiting-only filter on the Instances list). Abort
                 still works on any non-terminal status, failed included, so it always shows here. -->
            @if (canRetryOrSignal()) { <button class="btn sm" (click)="openSignalPrompt()">Signal</button> }
            @if (inst()!.status !== 'failed') {
              <button class="btn sm" (click)="suspendResume()">{{ inst()!.status === 'suspended' ? 'Resume' : 'Suspend' }}</button>
            }
            <button class="btn danger sm" (click)="abort()">Abort</button>
            @if (inst()!.status === 'failed' && inst()!.error?.nodeId) { <button class="btn sm" (click)="retryFailedNode()"><app-icon name="refresh" [size]="12" /> Retry failed node</button> }
          }
        </div>

        <nav class="tabs">
          @for (t of tabDefs; track t.key) { <button [class.active]="tab() === t.key" (click)="setTab(t.key)">{{ t.label }}</button> }
        </nav>

        <div class="tabgrid" [class.full]="tab() === 'diagram'">
          @if (tab() !== 'diagram') {
            <aside class="card relcard">
              <div class="section-title first">Related processes</div>
              <div class="row relrow"><span class="muted lbl">Parent</span>@if (parent()) { <button class="lnkbtn" (click)="goto(parent()!.id)">{{ procName(parent()!) }} #{{ shortId(parent()!.id) }}</button> } @else { <span class="badge">none</span> }</div>
              <div class="row relrow"><span class="muted lbl">This</span><span class="badge active">● {{ procName(inst()!) }} #{{ shortId(inst()!.id) }}</span></div>
              @if (children().length) {
                <div class="section-title">Children</div>
                @for (c of children(); track c.id) {
                  <button class="prow lnkbtn" (click)="goto(c.id)"><span>{{ procName(c) }}</span><span class="badge" [style.color]="statusColor(c.status)">#{{ shortId(c.id) }}</span></button>
                }
              }
            </aside>
          }
          <div class="maincol">
            @switch (tab()) {
              @case ('details') {
                <div class="card pad">
                  <div class="section-title first">Instance facts</div>
                  <table class="kv"><tbody>
                    <tr><td class="muted">Status</td><td><span class="badge" [style.color]="statusColor(inst()!.status)">{{ inst()!.status }}</span></td></tr>
                    <tr><td class="muted">Current activity</td><td>{{ currentActivity() }}</td></tr>
                    <tr><td class="muted">Initiator</td><td>{{ inst()!.startedBy }}</td></tr>
                    <tr><td class="muted">Started</td><td>{{ inst()!.startedAt | slice:0:19 }} ({{ ago(inst()!.startedAt) }})</td></tr>
                    <tr><td class="muted">Ended</td><td>{{ inst()!.endedAt ? (inst()!.endedAt! | slice:0:19) : '—' }}</td></tr>
                    <tr><td class="muted">Correlation key</td><td>{{ inst()!.correlationKey || '—' }}</td></tr>
                    <tr><td class="muted">Deployment</td><td><a class="lnk" [routerLink]="['/deployments']" [queryParams]="{id: inst()!.deploymentId}">{{ version(inst()!) }}</a></td></tr>
                  </tbody></table>

                  <div class="section-title">Open tasks on this instance</div>
                  @if (openTasks().length) {
                    @for (t of openTasks(); track t.id) {
                      <a class="prow" [routerLink]="['/tasks', t.id]"><span><app-icon name="user" [size]="13" /> {{ t.name }}</span><span class="muted sm">{{ t.status }}</span></a>
                    }
                  } @else { <p class="muted sm">No open tasks.</p> }

                  @if (inst()!.error) {
                    <div class="section-title">Error</div>
                    <div class="err-box"><app-icon name="warning" [size]="14" /> {{ inst()!.error!.nodeId || '(no node)' }}: {{ inst()!.error!.message }}</div>
                  }
                </div>
              }
              @case ('diagram') {
                <div class="diagram-wrap">
                  @if (isTerminal()) {
                    <div class="donebanner" [class.aborted]="inst()!.status === 'aborted'">
                      <app-icon [name]="inst()!.status === 'aborted' ? 'warning' : 'check'" [size]="14" />
                      This instance is {{ inst()!.status }} — the path below is its final, immutable execution history. No node can be re-triggered.
                    </div>
                  } @else if (inst()!.status === 'suspended') {
                    <div class="donebanner suspended">
                      <app-icon name="clock" [size]="14" />
                      This instance is suspended — paused mid-flow. Nothing here can be signaled, edited, or re-triggered until it's resumed.
                    </div>
                  }
                  <div class="legend">Node badges show <b>execution count</b>. <span class="lg active"></span> active · <span class="lg visited"></span> visited · <span class="lg failed"></span> failed</div>
                  <div class="dwrap card">
                    <div class="zoomlayer" [style.zoom]="zoom()" [style.height.px]="dh()" [style.width.px]="dw()">
                      <svg class="edges" [attr.width]="dw()" [attr.height]="dh()">
                        <defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="var(--border-strong)"/></marker></defs>
                        @for (e of graph().flows; track $index) { <path [attr.d]="edge(e)" class="ge" marker-end="url(#ar)" /> }
                      </svg>
                      @for (n of laid(); track n.id) {
                        <div class="gn" [style.left.px]="n.x" [style.top.px]="n.y" [style.width.px]="NW" [title]="n.name || n.id"
                             [class.active]="isActive(n.id)" [class.visited]="count(n.id) > 0" [class.failed]="isFailedNode(n.id)" [class.picked]="picked() === n.id"
                             [class.shape-circle]="shapeOf(n.type)==='circle'" [class.shape-diamond]="shapeOf(n.type)==='diamond'" (click)="canRetryOrSignal() && picked.set(n.id)">
                          <span class="gc" [style.background]="visual(n.type).color"><app-icon [name]="visual(n.type).icon" [size]="13" /></span>
                          <span class="gnm">{{ n.name || n.id }}</span>
                          @if (count(n.id) > 0) { <span class="bc" title="executed {{ count(n.id) }}×">{{ count(n.id) }}</span> }
                          @if (isFailedNode(n.id)) { <span class="bc failed" title="{{ inst()!.error?.message }}"><app-icon name="warning" [size]="10" /></span> }
                        </div>
                      }
                    </div>
                    <div class="zoomctrl">
                      <button (click)="zoomOut()" title="Zoom out" aria-label="Zoom out">−</button>
                      <button class="zpct" (click)="zoomReset()" title="Reset zoom">{{ zoomPct() }}%</button>
                      <button (click)="zoomIn()" title="Zoom in" aria-label="Zoom in">+</button>
                    </div>
                  </div>
                  @if (canRetryOrSignal()) {
                    <div class="ops">
                      <div class="op"><label>Re-trigger node {{ picked() ? '(' + picked() + ')' : '' }}</label><button class="btn sm" [disabled]="!picked()" (click)="retryPicked()">Re-trigger selected node</button></div>
                    </div>
                  }
                </div>
              }
              @case ('variables') {
                <div class="card pad">
                  @if (varRows().length) {
                    <table class="kv"><thead><tr><th>Name</th><th>Value</th><th></th></tr></thead><tbody>
                      @for (kv of varRows(); track kv.name) {
                        <tr>
                          <td>{{ kv.name }}</td>
                          <td>
                            @if (editingVar() === kv.name) { <input [(ngModel)]="editValue" (keyup.enter)="saveVar(kv.name)" (keyup.escape)="editingVar.set(null)" /> }
                            @else { <span class="mono">{{ kv.display }}</span> }
                          </td>
                          <td class="ta-r">
                            @if (canEditVars()) {
                              @if (editingVar() === kv.name) {
                                <button class="btn sm" (click)="saveVar(kv.name)">Save</button>
                                <button class="btn ghost sm" (click)="editingVar.set(null)">Cancel</button>
                              } @else {
                                <button class="btn ghost sm" (click)="startEdit(kv.name, kv.raw)" title="Edit" aria-label="Edit"><app-icon name="edit" [size]="12" /></button>
                              }
                            }
                            <button class="btn ghost sm" (click)="toggleHistory(kv.name)" title="Show history" aria-label="Show history"><app-icon name="clock" [size]="12" /></button>
                          </td>
                        </tr>
                        @if (historyFor() === kv.name) {
                          <tr><td colspan="3">
                            @if (history().length) {
                              <table class="histtbl"><tbody>
                                @for (h of history(); track h.at) { <tr><td class="muted sm">{{ ago(h.at) }} · {{ h.actor }}</td><td class="mono sm">{{ fmt(h.from) }} → {{ fmt(h.to) }}</td></tr> }
                              </tbody></table>
                            } @else { <p class="muted sm">No edits recorded for this variable.</p> }
                          </td></tr>
                        }
                      }
                    </tbody></table>
                  } @else { <p class="muted pad">No variables.</p> }
                </div>
              }
              @case ('logs') {
                <div class="card pad">
                  <div class="row" style="margin-bottom:10px;">
                    <select [(ngModel)]="logNodeFilter"><option value="">All nodes</option>@for (nm of logNodeNames(); track nm) { <option [value]="nm">{{ nm }}</option> }</select>
                    <select [(ngModel)]="logTypeFilter"><option value="">All types</option>@for (t of logTypes(); track t) { <option [value]="t">{{ t }}</option> }</select>
                    <input placeholder="Search" [(ngModel)]="logSearch" style="width:160px;" />
                    <button class="btn ghost sm" (click)="resetLogFilters()">Reset</button>
                  </div>
                  @if (filteredLogs().length) {
                    <table class="logs"><thead><tr><th>Date Time</th><th>Node</th><th>Type</th><th>Outcome</th></tr></thead>
                      <tbody>@for (h of filteredLogs(); track $index) { <tr><td class="mono sm">{{ h.enteredAt | slice:0:19 }}</td><td><b>{{ nodeName(h.nodeId) }}</b></td><td class="muted">{{ h.type }}</td><td>{{ h.outcome || '—' }}</td></tr> }</tbody>
                    </table>
                  } @else { <p class="muted pad">No log entries match.</p> }
                </div>
              }
              @case ('documents') {
                <div>
                  <div class="card">
                    @if (documents().length) {
                      <table><thead><tr><th>File</th><th>Bound variable</th><th></th></tr></thead>
                        <tbody>@for (d of documents(); track d.variable) { <tr><td><app-icon name="file" [size]="13" /> {{ d.filename }}</td><td class="muted">{{ d.variable }}</td><td class="ta-r">@if (d.url) { <a class="btn sm" [href]="d.url" target="_blank">Download</a> }</td></tr> }</tbody>
                      </table>
                    } @else {
                      <div class="empty-state">
                        <div class="es-icon"><app-icon name="file" [size]="22" /></div>
                        <h3>No documents</h3>
                        <p>Documents appear here when the instance carries a variable shaped like a file reference (filename + url).</p>
                      </div>
                    }
                  </div>
                </div>
              }
            }
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    /* Diagram tab only: make the canvas a real full-viewport workspace (matching the process builder's
       own canvas) instead of a card that hugs its content — a small diagram floating in a big pannable
       area is the expected, intentional "canvas" feel; a small diagram in a small card just looks
       broken/cramped. :host needs an explicit block+height since the router-outlet host (app.component's
       .main, flex:1) only sizes ITS direct child, and a component host tag is inline by default. */
    :host { display: block; height: 100%; }
    .page { padding: 20px 24px; height: 100%; box-sizing: border-box; }
    .page.diagram-tab { display: flex; flex-direction: column; min-height: 0; }
    .page.diagram-tab .tabgrid.full { flex: 1; min-height: 0; align-items: stretch; }
    .page.diagram-tab .tabgrid.full .maincol { display: flex; flex-direction: column; min-height: 0; }
    .page.diagram-tab .diagram-wrap { flex: 1; min-height: 0; }
    .page.diagram-tab .dwrap { flex: 1; min-height: 0; max-height: none; }
    .topbar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .crumbwrap { margin-left: 4px; }
    h1 { font-size: 18px; margin: 0; }
    .mono { font-family: var(--font-mono); font-size: 13px; }
    .meta { margin: 4px 0 12px; font-size: 12.5px; }
    .actionrow { gap: 8px; margin-bottom: 14px; }
    .badge { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
    .btn.danger { color: var(--red); border-color: var(--border-strong); } .btn.danger:hover { background: var(--red-bg); }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
    .tabs button { border: none; background: transparent; padding: 9px 4px; margin-right: 18px; font-size: 13.5px; font-weight: 600; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; }
    .tabs button.active { color: var(--primary); border-bottom-color: var(--primary); }
    /* Related Processes is a nav aid, not the main content — a narrow LEFT rail keeps it out of the
       way. The Diagram tab drops it entirely (see [class.full]) so the canvas gets the full page width
       instead of losing a fixed column to a panel that's rarely relevant while reading a diagram. */
    .tabgrid { display: grid; grid-template-columns: 200px 1fr; gap: 16px; align-items: start; }
    .tabgrid.full { grid-template-columns: 1fr; }
    .maincol { min-width: 0; }
    .pad { padding: 18px; }
    .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; margin: 16px 0 8px; }
    .section-title.first { margin-top: 0; }
    .kv { width: 100%; } .kv td, .kv th { padding: 7px 4px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: top; text-align: left; } .kv td:first-child { color: var(--muted); width: 34%; }
    .prow { display: flex; justify-content: space-between; text-decoration: none; color: inherit; padding: 8px 4px; border-bottom: 1px solid var(--border); font-size: 13px; }
    .prow:last-child { border-bottom: none; }
    .lnkbtn { border: none; background: none; text-align: left; cursor: pointer; width: 100%; font: inherit; color: inherit; }
    .sm { font-size: 12px; }
    .err-box { background: var(--red-bg); color: var(--red); padding: 8px 12px; border-radius: var(--radius-sm); font-size: 13px; display: flex; align-items: center; gap: 8px; }
    .lnk { color: var(--primary); text-decoration: none; } .lnk:hover { text-decoration: underline; }
    .diagram-wrap { display: flex; flex-direction: column; gap: 10px; }
    .donebanner { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-radius: 8px; background: var(--green-bg); color: var(--green); font-size: 12.5px; font-weight: 600; margin-bottom: 10px; }
    .donebanner.aborted { background: var(--red-bg); color: var(--red); }
    .donebanner.suspended { background: var(--amber-bg); color: var(--amber); }
    .legend { font-size: 12px; color: var(--muted); } .lg { width: 10px; height: 10px; border-radius: 3px; display: inline-block; vertical-align: middle; }
    .lg.active { background: var(--primary); } .lg.visited { background: var(--border-strong); } .lg.failed { background: var(--red); }
    /* .dwrap is the fixed-viewport scroll pane (grows with the page, not the diagram); .zoomlayer is the
       actual diagram at its full logical size (dw()×dh()), with the CSS "zoom" property — not
       transform:scale — so it
       genuinely resizes the box model and the absolutely-positioned nodes/edges inside it lay out (and
       scroll) correctly at any zoom level, matching the builder canvas's own zoom implementation. */
    /* No forced height here — .dwrap sizes to .zoomlayer's actual content (dw()×dh()), capped by
       max-height so it scrolls instead of growing forever on a large process. A fixed min-height
       here would leave a huge empty dotted void under a small diagram (looks like missing content,
       not "there's nothing more to see") — min-height is just enough room for the zoom pill. */
    .dwrap { position: relative; overflow: auto; min-height: 240px; max-height: 72vh; background-color: var(--canvas-bg); background-image: radial-gradient(circle, var(--canvas-dot) 1px, transparent 1px); background-size: 20px 20px; }
    .zoomlayer { position: relative; }
    .zoomctrl { position: absolute; bottom: 14px; right: 14px; display: flex; align-items: center; gap: 2px; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 4px; box-shadow: var(--shadow-pop); z-index: 20; }
    .zoomctrl button { width: 28px; height: 28px; border: none; background: transparent; border-radius: 50%; cursor: pointer; color: var(--text-secondary); font-size: 15px; display: grid; place-items: center; }
    .zoomctrl button:hover { background: var(--surface-3); color: var(--text); }
    .zoomctrl .zpct { width: auto; padding: 0 8px; font-size: 12px; font-weight: 600; }
    .edges { position: absolute; inset: 0; pointer-events: none; } .ge { fill: none; stroke: var(--border-strong); stroke-width: 2; }
    .gn { position: absolute; height: ${NH}px; background: var(--surface); border: 1px solid var(--border); border-radius: 10px; display: flex; align-items: center; gap: 8px; padding: 8px 10px; box-shadow: var(--shadow-card); cursor: pointer; opacity: .5; }
    .gn.visited { opacity: 1; } .gn.active { opacity: 1; border-color: var(--primary); box-shadow: 0 0 0 3px rgba(91,61,245,.2); }
    .gn.failed { opacity: 1; border-color: var(--red); box-shadow: 0 0 0 3px rgba(225,29,72,.2); }
    .gn.picked { outline: 2px dashed var(--amber); }
    .gc { width: 28px; height: 28px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 8px; color: #fff; font-size: 12px; }
    /* Real BPMN 2.0 shape per engine type (see NodeDef.diagram.shape, via /catalog/nodes) — the base
       .gn card is already a task-style rounded rect, so events/gateways need the override here (the
       inverse of process-canvas's pill-by-default card, which only overrides for tasks). */
    .gn.shape-circle { border-radius: 999px; }
    .gn.shape-diamond .gc { border-radius: 4px; transform: rotate(45deg); }
    .gn.shape-diamond .gc app-icon { display: inline-flex; transform: rotate(-45deg); }
    .gnm { font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bc { position: absolute; bottom: -9px; left: 50%; transform: translateX(-50%); min-width: 18px; height: 18px; border-radius: 9px; background: var(--text); color: var(--surface); font-size: 12px; font-weight: 700; display: grid; place-items: center; padding: 0 5px; box-shadow: var(--shadow-card); }
    .bc.failed { bottom: auto; left: auto; top: -9px; right: -9px; transform: none; background: var(--red); }
    .ops { display: flex; flex-direction: column; gap: 8px; }
    .op label { display: block; font-size: 12px; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
    .logs th, .logs td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); font-size: 12px; } .logs th { color: var(--muted); }
    .histtbl { width: 100%; margin: 4px 0 8px; } .histtbl td { padding: 4px 8px; border-bottom: 1px dashed var(--border); }
    .ta-r { text-align: right; white-space: nowrap; }
    .relcard { padding: 12px; align-self: start; font-size: 12.5px; }
    .relcard .section-title { font-size: 10px; margin: 10px 0 6px; }
    .lbl { font-size: 11px; }
    .relcard .prow, .relcard .lnkbtn { font-size: 12px; }
    /* The narrow rail is intentional (see .tabgrid above) — badges here need to wrap onto their own
       line instead of overflowing the card, since "processName #shortId" routinely won't fit 200px. */
    .relrow { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; margin-bottom: 8px; }
    .relcard .badge { white-space: normal; word-break: break-word; line-height: 1.4; }
    .empty-state .btn { margin-top: 10px; }
  `],
})
export class InstanceDetailComponent implements OnDestroy {
  private api = inject(InstanceApiService);
  private deploymentApi = inject(DeploymentApiService);
  private wfApi = inject(WorkflowApiService);
  private queryApi = inject(QueryApiService);
  private opsApi = inject(OpsApiService);
  private systemApi = inject(SystemApiService);
  private realtime = inject(RealtimeService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private unsub?: () => void;

  id = signal(this.route.snapshot.paramMap.get('id')!);
  inst = signal<Instance | null>(null);
  loading = signal(true);
  deployments = signal<Record<string, Deployment>>({});
  workflows = signal<Workflow[]>([]);
  catalog = signal<Catalog | null>(null);
  graph = signal<{ nodes: any[]; flows: any[]; diagram: { activeNodeIds: string[] }; counts: Record<string, number> }>({ nodes: [], flows: [], diagram: { activeNodeIds: [] }, counts: {} });
  parent = signal<Instance | null>(null);
  children = signal<Instance[]>([]);
  openTasks = signal<Task[]>([]);
  errors = signal<ExecutionError[]>([]);
  // Diagram zoom — same range/step as the builder's process canvas (process-canvas.component.ts).
  zoom = signal(1);
  zoomPct = computed(() => Math.round(this.zoom() * 100));
  zoomIn() { this.zoom.set(Math.min(1.5, Math.round((this.zoom() + 0.1) * 10) / 10)); }
  zoomOut() { this.zoom.set(Math.max(0.4, Math.round((this.zoom() - 0.1) * 10) / 10)); }
  zoomReset() { this.zoom.set(1); }
  picked = signal<string | null>(null);
  tab = signal<Tab>((this.route.snapshot.queryParamMap.get('tab') as Tab) || 'details');
  NW = NW;
  tabDefs: { key: Tab; label: string }[] = [
    { key: 'details', label: 'Details' }, { key: 'diagram', label: 'Diagram' },
    { key: 'variables', label: 'Variables' }, { key: 'logs', label: 'Logs' }, { key: 'documents', label: 'Documents' },
  ];

  editingVar = signal<string | null>(null);
  editValue = '';
  historyFor = signal<string | null>(null);
  history = signal<VariableChange[]>([]);
  // Terminal (completed/aborted) is the "definitely read-only" case; 'suspended' gets the same
  // treatment for retry/signal/variable-edits (see InstanceService.retry/signal/updateVariables) even
  // though it isn't terminal — the whole point of a pause is that nothing touches the instance's state
  // until it's resumed, same reasoning, different lifecycle stage.
  isTerminal = computed(() => { const i = this.inst(); return !!i && (i.status === 'completed' || i.status === 'aborted'); });
  // System-wide toggle (Settings → System) for jBPM's normally-permissive "edit variables on a live
  // instance directly" behavior — defaults true (matching DEFAULT_SETTINGS server-side) until the real
  // value loads, so there's no edit-button flash-then-disappear on first render.
  allowRunningVariableEdits = signal(true);
  canEditVars = computed(() => {
    const i = this.inst(); if (!i || i.status === 'completed' || i.status === 'aborted' || i.status === 'suspended') return false;
    if ((i.status === 'running' || i.status === 'waiting') && !this.allowRunningVariableEdits()) return false;
    return true;
  });
  // Retry (diagram re-trigger panel) and Signal are refused on suspended/terminal instances by the
  // backend; 'failed' additionally has no waiting/active token left for either to act on (the failing
  // token was already removed) — "Retry failed node" above is the one real recovery path there instead.
  canRetryOrSignal = computed(() => { const i = this.inst(); return !!i && i.status !== 'completed' && i.status !== 'aborted' && i.status !== 'suspended' && i.status !== 'failed'; });
  isFailedNode = (id: string) => this.inst()?.status === 'failed' && this.inst()?.error?.nodeId === id;

  logNodeFilter = ''; logTypeFilter = ''; logSearch = '';

  // Nodes carry their own x/y only when authored/edited in the process builder (which auto-layouts
  // on every structural change). Fixture-created or pre-builder processes have none, and index-based
  // wrapping (old: i%5 grid) ignored the actual flow graph — a node whose array index happened to
  // land at the start of a wrapped row could be flow-connected to a node several columns away, which
  // then blew out the S-curve bezier's control points (see edge()/orthPath below) far past the
  // canvas bounds and got silently clipped. computeLayeredPositions mirrors process-canvas.component's
  // auto-layout so the diagram reflects real topology (parallel branches side by side, etc.) instead.
  laid = computed(() => {
    const g = this.graph();
    const auto = this.computeLayeredPositions(g.nodes, g.flows);
    return g.nodes.map((n: any) => { const p = auto.get(n.id); return { ...n, x: n.x ?? p?.x ?? 30, y: n.y ?? p?.y ?? 30 }; });
  });
  dw = computed(() => Math.max(560, ...this.laid().map((n: any) => n.x + NW + 40)));
  dh = computed(() => Math.max(220, ...this.laid().map((n: any) => n.y + NH + 40)));

  logNodeNames = computed(() => [...new Set((this.inst()?.history || []).map((h) => this.nodeName(h.nodeId)))]);
  logTypes = computed(() => [...new Set((this.inst()?.history || []).map((h) => h.type))]);
  filteredLogs = computed(() => {
    const i = this.inst(); if (!i) return [];
    const search = this.logSearch.toLowerCase();
    return [...i.history].reverse().filter((h) =>
      (!this.logNodeFilter || this.nodeName(h.nodeId) === this.logNodeFilter)
      && (!this.logTypeFilter || h.type === this.logTypeFilter)
      && (!search || this.nodeName(h.nodeId).toLowerCase().includes(search) || (h.outcome || '').toLowerCase().includes(search)));
  });

  varRows = computed(() => Object.entries(this.inst()?.variables || {}).filter(([, v]) => v !== undefined)
    .map(([name, v]) => ({ name, raw: v, display: typeof v === 'object' ? JSON.stringify(v) : String(v) })));

  documents = computed<DocRow[]>(() => {
    const out: DocRow[] = [];
    for (const [name, v] of Object.entries(this.inst()?.variables || {})) {
      if (v && typeof v === 'object' && ('filename' in (v as any) || 'name' in (v as any)) && ('url' in (v as any) || 'data' in (v as any))) {
        const d = v as any;
        out.push({ variable: name, filename: d.filename || d.name, url: d.url, mimeType: d.mimeType });
      }
    }
    return out;
  });

  currentActivity = computed(() => {
    const i = this.inst(); if (!i) return '—';
    const active = i.tokens.filter((t) => t.state === 'active' || t.state === 'waiting');
    if (!active.length) return '—';
    return active.map((t) => this.nodeName(t.nodeId)).join(', ');
  });

  constructor() {
    this.wfApi.listWorkflows().subscribe((ws) => this.workflows.set(ws));
    this.wfApi.catalog().subscribe((c) => this.catalog.set(c));
    this.systemApi.getSystemSettings().subscribe((s) => this.allowRunningVariableEdits.set(s.allowRunningVariableEdits));
    this.load();
  }
  ngOnDestroy() { this.unsub?.(); }

  private load() {
    this.loading.set(true);
    this.refresh();
    this.unsub?.();
    this.unsub = this.realtime.subscribe(`instance:${this.id()}`, () => this.refresh());
  }

  private refresh() {
    this.api.getInstance(this.id()).subscribe({
      next: (i) => {
        this.inst.set(i); this.loading.set(false);
        this.deploymentApi.getDeployment(i.deploymentId).subscribe((d) => this.deployments.set({ ...this.deployments(), [d.id]: d }));
      },
      error: () => { this.inst.set(null); this.loading.set(false); },
    });
    this.api.instanceGraph(this.id()).subscribe((g) => this.graph.set(g as any));
    this.api.relatedInstances(this.id()).subscribe((r) => { this.parent.set(r.parent); this.children.set(r.children); });
    this.queryApi.instanceTasks(this.id()).subscribe((tasks) => this.openTasks.set(tasks.filter((t) => t.status !== 'completed' && t.status !== 'skipped')));
    this.opsApi.listErrors({ instanceId: this.id(), acknowledged: false }).subscribe((r) => this.errors.set(r.items));
  }

  setTab(t: Tab) { this.tab.set(t); this.router.navigate([], { queryParams: { tab: t }, queryParamsHandling: 'merge', replaceUrl: true }); }
  goto(id: string) { this.router.navigate(['/instances', id]); }

  visual(t: string) { return this.catalog()?.diagram?.[t] || { icon: 'info', color: '#64748b', shape: 'rectangle' as const }; }
  shapeOf(t: string) { return this.visual(t).shape; }
  statusColor(s: string) { return ({ running: '#2563eb', waiting: '#f59e0b', completed: '#16a34a', failed: '#dc2626', aborted: '#6b7280', suspended: '#7c3aed' } as any)[s] || '#6b7280'; }
  procName(i: Instance) { return processLabel(i.processId, i.workflowId); }
  shortId(id: string) { return id.length > 10 ? id.slice(-7) : id; }
  version(i: Instance) { const d = this.deployments()[i.deploymentId]; return d ? (d.versionLabel || ('v' + (d.versionNumber ?? '?'))) + ' · ' + d.environment : '—'; }
  count(id: string) { return this.graph().counts?.[id] || 0; }
  isActive(id: string) { return (this.graph().diagram?.activeNodeIds || []).includes(id); }
  nodeName(id: string) { return this.graph().nodes.find((n: any) => n.id === id)?.name || id; }
  private byId(id: string) { return this.laid().find((n: any) => n.id === id); }

  nodeDims(type: string): { w: number; h: number } {
    if (type === 'start' || type === 'end' || type === 'catch' || type === 'throw' || type === 'boundary') {
      return { w: 44, h: 44 };
    }
    if (type === 'gateway') {
      return { w: 52, h: 52 };
    }
    return { w: 180, h: 56 };
  }
  nodeAnchorOut(n: any): { x: number; y: number } {
    const d = this.nodeDims(n.type);
    return { x: n.x + d.w, y: n.y + d.h / 2 };
  }
  nodeAnchorIn(n: any): { x: number; y: number } {
    const d = this.nodeDims(n.type);
    return { x: n.x, y: n.y + d.h / 2 };
  }

  // Cycle-safe layered auto-layout
  private computeLayeredPositions(nodes: any[], flows: any[]): Map<string, { x: number; y: number }> {
    if (!nodes.length) return new Map();
    const roots = nodes.filter((n) => n.type === 'start' || !flows.some((f) => f.to === n.id));
    const rootIds = (roots.length ? roots : nodes.slice(0, 1)).map((n) => n.id);

    const visited = new Set<string>();
    const inStack = new Set<string>();
    const forwardFlows: any[] = [];

    const dfs = (curr: string) => {
      visited.add(curr);
      inStack.add(curr);
      for (const f of flows) {
        if (f.from !== curr) continue;
        if (!inStack.has(f.to)) {
          forwardFlows.push(f);
          if (!visited.has(f.to)) dfs(f.to);
        }
      }
      inStack.delete(curr);
    };

    for (const r of rootIds) if (!visited.has(r)) dfs(r);
    for (const n of nodes) if (!visited.has(n.id)) dfs(n.id);

    const col = new Map<string, number>();
    for (const id of rootIds) col.set(id, 0);

    for (let pass = 0; pass < nodes.length + 1; pass++) {
      let changed = false;
      for (const f of forwardFlows) {
        if (!col.has(f.from)) continue;
        const c = col.get(f.from)! + 1;
        if (!col.has(f.to) || col.get(f.to)! < c) { col.set(f.to, c); changed = true; }
      }
      if (!changed) break;
    }
    let maxCol = Math.max(0, ...[...col.values()]);
    for (const n of nodes) if (!col.has(n.id)) { maxCol += 1; col.set(n.id, maxCol); }

    const byCol = new Map<number, string[]>();
    for (const n of nodes) { const c = col.get(n.id)!; (byCol.get(c) || byCol.set(c, []).get(c)!).push(n.id); }

    const row = new Map<string, number>();
    const cols = [...byCol.keys()].sort((a, b) => a - b);
    for (const c of cols) {
      const idsInCol = byCol.get(c)!;
      if (c === 0) { idsInCol.forEach((id, i) => row.set(id, i)); continue; }
      const scored = idsInCol.map((id) => {
        const preds = flows.filter((f) => f.to === id && row.has(f.from)).map((f) => row.get(f.from)!);
        const score = preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : idsInCol.indexOf(id);
        return { id, score };
      });
      scored.sort((a, b) => a.score - b.score);
      scored.forEach((s, i) => row.set(s.id, i));
    }

    const out = new Map<string, { x: number; y: number }>();
    for (const n of nodes) out.set(n.id, { x: 30 + col.get(n.id)! * COL_W, y: 30 + row.get(n.id)! * ROW_H });
    return out;
  }

  // Orthogonal (Manhattan) sequence-flow routing with loop bypass
  private orthPath(x1: number, y1: number, x2: number, y2: number, fromNode?: any, toNode?: any): string {
    const R = 8;
    if (Math.abs(y2 - y1) < 4 && x2 >= x1) return `M ${x1} ${y1} L ${x2} ${y2}`;

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

    // Backward loop-back bypass
    const dFrom = fromNode ? this.nodeDims(fromNode.type) : { w: 180, h: 56 };
    const dTo = toNode ? this.nodeDims(toNode.type) : { w: 180, h: 56 };
    const bypassY = Math.max((fromNode?.y ?? y1) + dFrom.h, (toNode?.y ?? y2) + dTo.h) + 38;
    const outX = x1 + 20, inX = x2 - 20;
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
  edge(e: any) {
    const a = this.byId(e.from), b = this.byId(e.to);
    if (!a || !b) return '';
    const p1 = this.nodeAnchorOut(a), p2 = this.nodeAnchorIn(b);
    return this.orthPath(p1.x, p1.y, p2.x, p2.y, a, b);
  }

  ago(iso: string): string {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86_400)}d ago`;
  }
  fmt(v: unknown): string { if (v === undefined) return '(none)'; return typeof v === 'string' ? v : JSON.stringify(v); }
  resetLogFilters() { this.logNodeFilter = ''; this.logTypeFilter = ''; this.logSearch = ''; }

  startEdit(name: string, raw: unknown) { this.editingVar.set(name); this.editValue = typeof raw === 'object' ? JSON.stringify(raw) : String(raw); }
  saveVar(name: string) {
    let value: unknown = this.editValue;
    try { value = JSON.parse(this.editValue); } catch { /* keep as string */ }
    this.api.updateVariables(this.id(), { [name]: value }).subscribe({
      next: (i) => { this.inst.set(i); this.editingVar.set(null); this.toast.success('Variable updated'); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not update variable'),
    });
  }
  toggleHistory(name: string) {
    if (this.historyFor() === name) { this.historyFor.set(null); return; }
    this.historyFor.set(name);
    this.api.variableHistory(this.id(), name).subscribe((h) => this.history.set(h));
  }

  async openSignalPrompt() {
    if (!this.canRetryOrSignal()) return;
    const name = await this.modal.prompt({ title: 'Send signal', message: 'Signal name (a "Message-" prefix targets a message event):', placeholder: 'signal name' });
    if (!name) return;
    this.api.signalInstance(this.id(), name, undefined).subscribe({
      next: () => { this.toast.success('Signal sent'); this.refresh(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not send signal'),
    });
  }
  suspendResume() {
    const i = this.inst(); if (!i) return;
    const resuming = i.status === 'suspended';
    (resuming ? this.api.resumeInstance(i.id) : this.api.suspendInstance(i.id)).subscribe({
      next: () => { this.toast.success(resuming ? 'Instance resumed' : 'Instance suspended'); this.refresh(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not update instance'),
    });
  }
  async abort() {
    const i = this.inst(); if (!i) return;
    const ok = await this.modal.confirm({ title: 'Abort instance', message: `Abort instance #${this.shortId(i.id)}? This also aborts any active sub-process instances.`, confirmLabel: 'Abort', danger: true });
    if (!ok) return;
    this.api.abort(i.id).subscribe({
      next: () => { this.toast.success('Instance aborted'); this.refresh(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not abort'),
    });
  }
  retryFailedNode() {
    const i = this.inst(); if (!i?.error?.nodeId) return;
    this.api.retryNode(i.id, i.error.nodeId).subscribe({
      next: () => { this.toast.success('Node re-triggered'); this.refresh(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not retry node'),
    });
  }
  retryPicked() {
    const n = this.picked(); if (!n || !this.canRetryOrSignal()) return;
    this.api.retryNode(this.id(), n).subscribe({
      next: () => { this.toast.success('Node re-triggered'); this.refresh(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not retry node'),
    });
  }
}
