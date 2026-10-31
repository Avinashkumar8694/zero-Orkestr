import { Component, computed, inject, signal, HostListener } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { SlicePipe, JsonPipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs/operators';
import { DeploymentApiService } from '../../core/api/deployment-api.service';
import { InstanceApiService } from '../../core/api/instance-api.service';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import { ModalService } from '../../shared/modal.service';
import { ToastService } from '../../shared/toast.service';
import type { Catalog, Deployment, DeploymentProcessDef } from '../../core/models';

const NW = 180, NH = 56;
const COL_W = NW + 100, ROW_H = NH + 46;

type Tab = 'overview' | 'diagram' | 'processes' | 'history';

// Page 2 of 2. One deployment, on its own screen: Overview (what it is + what to do next), Diagram (read-only frozen
// snapshot of each process with a process switcher), Processes (the definitions it contains, each startable) and Release history (a timeline of this project's releases in the same
// environment, with one-click rollback). Lifecycle actions live in the header so they are reachable from every tab.
@Component({
  selector: 'app-deployment-detail',
  standalone: true,
  imports: [IconComponent, SlicePipe, JsonPipe, RouterLink, BreadcrumbComponent],
  template: `
    <div class="page">
      @if (dep(); as d) {
        <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Deployments', link: ['/deployments'] }, { label: projectName() + ' · ' + version(d) }]" /></div>

        <header class="card head">
          <a class="back" routerLink="/deployments" title="All deployments" aria-label="Back to all deployments"><app-icon name="chevronLeft" [size]="16" /></a>
          <div class="titles">
            <h1>{{ projectName() }}</h1>
            <div class="meta">
              <span class="badge env">{{ d.environment }}</span>
              <span class="badge">{{ version(d) }}</span>
              <span class="badge" [class.active]="d.status==='active'" [class.inactive]="d.status==='inactive'" [class.archived]="d.status==='archived'">{{ d.status }}</span>
              @if (d.snapshot?.frozen) { <span class="badge freeze" title="This deployment is an immutable snapshot freeze"><app-icon name="lock" [size]="11" /> Frozen snapshot</span> }
              <span class="muted when">Deployed {{ d.deployedAt | slice:0:16 }} by {{ d.deployedBy }}</span>
            </div>
          </div>
          <span class="spacer"></span>
          <div class="actions">
            <button class="btn" (click)="downloadSnapshot(d)" title="Download the complete, self-contained deployment snapshot (.json)"><app-icon name="download" [size]="14" /> Download snapshot</button>
            <button class="btn" [disabled]="busy()" (click)="confirmRestore(d)" title="Restore this snapshot into the project as a new draft"><app-icon name="undo" [size]="14" /> Restore to project</button>
            @if (d.status !== 'active' && d.status !== 'archived') { <button class="btn primary" [disabled]="busy()" (click)="activate(d)">Activate</button> }
            @if (d.status === 'active') { <button class="btn" [disabled]="busy()" (click)="undeploy(d)">Undeploy</button> }
            @if (d.status !== 'archived') { <button class="btn danger" [disabled]="busy()" (click)="archive(d)">Archive</button> }
          </div>
        </header>

        <nav class="tabs" role="tablist" aria-label="Deployment sections">
          <button role="tab" [attr.aria-selected]="tab() === 'overview'" [class.active]="tab() === 'overview'" (click)="setTab('overview')">Overview</button>
          <button role="tab" [attr.aria-selected]="tab() === 'diagram'" [class.active]="tab() === 'diagram'" (click)="setTab('diagram')">Diagram</button>
          <button role="tab" [attr.aria-selected]="tab() === 'processes'" [class.active]="tab() === 'processes'" (click)="setTab('processes')">Processes @if (defs().length) { <span class="tc">{{ defs().length }}</span> }</button>
          <button role="tab" [attr.aria-selected]="tab() === 'history'" [class.active]="tab() === 'history'" (click)="setTab('history')">Release history @if (history().length) { <span class="tc">{{ history().length }}</span> }</button>
        </nav>

        @switch (tab()) {
          @case ('overview') {
            <div class="grid2">
              <section class="card block">
                <h3>Details</h3>
                <dl class="facts">
                  <div><dt>Project</dt><dd><a class="lnk" [routerLink]="['/projects', d.workflowId]">{{ projectName() }}</a></dd></div>
                  <div><dt>Environment</dt><dd>{{ d.environment }}</dd></div>
                  <div><dt>Version</dt><dd>{{ version(d) }}</dd></div>
                  <div><dt>Status</dt><dd><span class="badge" [class.active]="d.status==='active'" [class.inactive]="d.status==='inactive'" [class.archived]="d.status==='archived'">{{ d.status }}</span></dd></div>
                  <div><dt>Deployed</dt><dd class="mono">{{ d.deployedAt | slice:0:19 }}</dd></div>
                  <div><dt>Deployed by</dt><dd>{{ d.deployedBy }}</dd></div>
                  <div><dt>Tags</dt><dd>@for (t of d.tags; track t) { <span class="badge">{{ t }}</span> } @if (!d.tags.length) { <span class="muted">—</span> }</dd></div>
                  <div><dt>Deployment id</dt><dd class="mono">{{ d.id }}</dd></div>
                  @if (d.snapshot?.frozenAt) { <div><dt>Snapshot</dt><dd><span class="badge active">Frozen {{ d.snapshot?.frozenAt | slice:0:19 }}</span></dd></div> }
                  <div><dt>Environment variables</dt><dd>@if (d.env) { <pre class="mono sm">{{ d.env | json }}</pre> } @else { <span class="muted">None</span> }</dd></div>
                </dl>
              </section>
              <section class="card block next">
                <h3>What next?</h3>
                <button class="step" (click)="setTab('processes')">
                  <span class="si"><app-icon name="play" [size]="16" /></span>
                  <span class="st"><b>Start a process</b><small>{{ defs().length ? defs().length + ' definition' + (defs().length === 1 ? '' : 's') + ' in this deployment' : 'See the definitions in this deployment' }}</small></span>
                  <app-icon name="chevronRight" [size]="16" />
                </button>
                <a class="step" [routerLink]="['/instances']" [queryParams]="{ workflowId: d.workflowId }">
                  <span class="si"><app-icon name="instances" [size]="16" /></span>
                  <span class="st"><b>See running instances</b><small>Everything started from {{ projectName() }}</small></span>
                  <app-icon name="chevronRight" [size]="16" />
                </a>
                <button class="step" (click)="setTab('history')">
                  <span class="si"><app-icon name="clock" [size]="16" /></span>
                  <span class="st"><b>Release history</b><small>{{ history().length > 1 ? 'Compare or roll back to an earlier release' : 'This is the only release in ' + d.environment }}</small></span>
                  <app-icon name="chevronRight" [size]="16" />
                </button>
                <a class="step" [routerLink]="['/projects', d.workflowId]">
                  <span class="si"><app-icon name="projects" [size]="16" /></span>
                  <span class="st"><b>Open the project</b><small>Edit processes and publish a new version</small></span>
                  <app-icon name="chevronRight" [size]="16" />
                </a>
              </section>
            </div>
          }
          @case ('diagram') {
            <div class="card diagram-workspace">
          <div class="card diagram-workspace">
            <!-- LEFT: Process switcher rail (Parent vs Child processes) -->
            <aside class="proc-rail">
              <div class="proc-rail-h">
                <span>Processes in Container</span>
                <span class="p-count">{{ processes().length }}</span>
              </div>

              @if (parentProcesses().length) {
                <div class="proc-group-label">Parent / Root Processes</div>
                @for (p of parentProcesses(); track p.id) {
                  <button class="proc-btn" [class.sel]="activeProcess()?.id === p.id" (click)="selectedProcessId.set(p.id); selectedNode.set(null)">
                    <span class="proc-ic-pill parent"><app-icon name="play" [size]="12" /></span>
                    <div class="proc-txt">
                      <span class="proc-name" [title]="p.name || p.id">{{ p.name || p.id }}</span>
                      <span class="proc-id mono">{{ p.id }}</span>
                    </div>
                    <span class="proc-nodes-badge" title="{{ (p.nodes || []).length }} nodes">{{ (p.nodes || []).length }}</span>
                  </button>
                }
              }

              @if (childProcesses().length) {
                <div class="proc-group-label">Child / Sub-processes</div>
                @for (p of childProcesses(); track p.id) {
                  <button class="proc-btn" [class.sel]="activeProcess()?.id === p.id" (click)="selectedProcessId.set(p.id); selectedNode.set(null)">
                    <span class="proc-ic-pill child"><app-icon name="cornerDownRight" [size]="12" /></span>
                    <div class="proc-txt">
                      <span class="proc-name" [title]="p.name || p.id">{{ p.name || p.id }}</span>
                      <span class="proc-id mono">{{ p.id }}</span>
                    </div>
                    <span class="proc-nodes-badge" title="{{ (p.nodes || []).length }} nodes">{{ (p.nodes || []).length }}</span>
                  </button>
                }
              }

              @if (processes().length === 0) {
                <div class="empty-processes">No processes in snapshot</div>
              }
            </aside>

            <!-- MAIN: Read-only BPMN Canvas -->
            <main class="canvas-viewport">
              <div class="canvas-topbar">
                <div class="active-proc-title">
                  <span class="lbl">Active Process:</span>
                  <b>{{ activeProcess()?.name || activeProcess()?.id || '—' }}</b>
                  <code class="mono muted">({{ activeProcess()?.id }})</code>
                </div>
                <div class="proc-stats-pill">
                  <span>{{ (activeProcess()?.nodes || []).length }} nodes</span>
                  <span>·</span>
                  <span>{{ (activeProcess()?.flows || []).length }} flows</span>
                </div>
              </div>

              <div class="dwrap" (click)="selectedNode.set(null)">
                <div class="zoomlayer" [style.zoom]="zoom()" [style.height.px]="dh()" [style.width.px]="dw()">
                  <svg class="edges" [attr.width]="dw()" [attr.height]="dh()" [style.width.px]="dw()" [style.height.px]="dh()">
                    <defs>
                      <marker id="ar-snap" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                        <path d="M0,0 L10,5 L0,10 z" fill="var(--border-strong)"/>
                      </marker>
                    </defs>
                    @for (e of laidEdges(); track e.id || $index) {
                      <path [attr.d]="edge(e)" class="ge" marker-end="url(#ar-snap)" />
                    }
                  </svg>

                  @for (n of laidNodes(); track n.id) {
                    <div class="node" [attr.id]="'node-' + n.id"
                         [class.node-circle]="isCircle(n.type)"
                         [class.node-diamond]="isDiamond(n.type)"
                         [class.node-rectangle]="isRectangle(n.type)"
                         [class.node-call]="n.type === 'call'"
                         [class.node-start]="n.type === 'start'"
                         [class.node-end]="n.type === 'end'"
                         [class.sel]="selectedNode()?.id === n.id"
                         [style.left.px]="n.x" [style.top.px]="n.y"
                         [style.width.px]="nodeDims(n.type).w" [style.height.px]="nodeDims(n.type).h"
                         [title]="n.name || n.id"
                         (click)="$event.stopPropagation(); selectedNode.set(n)">

                      @if (isCircle(n.type)) {
                        <div class="circle-inner" [style.background]="n.type==='start' ? '#f0fdf4' : n.type==='end' ? '#fef2f2' : '#f5f3ff'">
                          <app-icon [name]="visual(n.type).icon" [size]="16" [style.color]="visual(n.type).color" />
                        </div>
                        <div class="ntitle circle-label">{{ n.name || n.id }}</div>
                      } @else if (isDiamond(n.type)) {
                        <div class="diamond-body">
                          <span class="diamond-marker">{{ gatewayMarker(n) }}</span>
                        </div>
                        <div class="ntitle diamond-label">{{ n.name || n.id }}</div>
                      } @else {
                        <span class="chip" [style.background]="visual(n.type).color"><app-icon [name]="visual(n.type).icon" [size]="13" /></span>
                        <div class="ntitle">{{ n.name || n.id }}</div>
                        @if (n.type === 'call') { <span class="call-badge" title="Call Activity / Sub-process">[+]</span> }
                      }
                    </div>
                  }

                  @for (b of numberedBranches(); track b.edge.id || $index) {
                    <div class="branchbadge" [style.left.px]="b.x" [style.top.px]="b.y" [title]="'Branch ' + b.text">{{ b.text }}</div>
                  }
                  @for (b of labeledBranches(); track b.edge.id || $index) {
                    <div class="branchpill" [style.left.px]="b.x" [style.top.px]="b.y" [title]="b.text">{{ b.text }}</div>
                  }

                  <!-- CONTEXTUAL NODE INSPECTOR POPOVER ANCHORED AT CLICKED NODE -->
                  @if (selectedNode(); as sn) {
                    @if (popoverPos(); as pos) {
                      <div class="node-inspector-popover"
                           [style.left.px]="pos.x"
                           [style.top.px]="pos.y"
                           [class.pos-above]="pos.placement === 'above'"
                           [class.pos-below]="pos.placement === 'below'"
                           (click)="$event.stopPropagation()">
                        <div class="popover-arrow" [style.left.px]="pos.arrowLeft"></div>
                        <div class="ni-header">
                          <span class="ni-title">
                            <span class="ni-chip" [style.background]="visual(sn.type).color"><app-icon [name]="visual(sn.type).icon" [size]="12" /></span>
                            <b>{{ sn.name || sn.id }}</b>
                          </span>
                          <button class="ni-close" (click)="selectedNode.set(null)" aria-label="Close">×</button>
                        </div>
                        <div class="ni-body">
                          <div class="ni-row"><span class="k">Type:</span> <span class="v mono">{{ sn.type }}</span></div>
                          <div class="ni-row"><span class="k">Node ID:</span> <span class="v mono">{{ sn.id }}</span></div>
                          @if (sn.type === 'call') {
                            <div class="ni-call-box">
                              <div class="ni-call-label">Sub-process Reference:</div>
                              <div class="ni-call-target mono">{{ sn.calledProcessId || sn.processId || sn.calledElement || '—' }}</div>
                              @if (findProcess(sn.calledProcessId || sn.processId || sn.calledElement); as cp) {
                                <button class="btn sm primary ni-jump" (click)="selectedProcessId.set(cp.id); selectedNode.set(null)">
                                  <app-icon name="cornerDownRight" [size]="12" /> Switch to Sub-process
                                </button>
                              }
                            </div>
                          }
                          @if (sn.ruleflowGroup) {
                            <div class="ni-row"><span class="k">Ruleflow Group:</span> <span class="v mono">{{ sn.ruleflowGroup }}</span></div>
                          }
                          @if (sn.dmn) {
                            <div class="ni-row"><span class="k">DMN Model:</span> <span class="v mono">{{ sn.dmn.model || sn.dmn }}</span></div>
                          }
                          @if (sn.guidedTable) {
                            <div class="ni-row"><span class="k">Guided Table:</span> <span class="v mono">{{ sn.guidedTable }}</span></div>
                          }
                          @if (sn.scorecard) {
                            <div class="ni-row"><span class="k">Scorecard:</span> <span class="v mono">{{ sn.scorecard }}</span></div>
                          }
                          @if (sn.decisionTree) {
                            <div class="ni-row"><span class="k">Decision Tree:</span> <span class="v mono">{{ sn.decisionTree }}</span></div>
                          }
                          @if (sn.form) {
                            <div class="ni-row"><span class="k">Form:</span> <span class="v mono">{{ sn.form }}</span></div>
                          }
                          @if (sn.group) {
                            <div class="ni-row"><span class="k">User Group:</span> <span class="v mono">{{ sn.group }}</span></div>
                          }
                          @if (sn.handler) {
                            <div class="ni-row"><span class="k">Work Handler:</span> <span class="v mono">{{ sn.handler }}</span></div>
                          }
                          @if (sn.code) {
                            <div class="ni-code-block"><label>Script ({{ sn.lang || 'js' }}):</label><pre class="mono sm">{{ sn.code }}</pre></div>
                          }
                        </div>
                      </div>
                    }
                  }
                </div>

                <div class="zoomctrl">
                  <button (click)="zoomOut()" title="Zoom out" aria-label="Zoom out">−</button>
                  <span class="zpct" (click)="zoomReset()" title="Reset zoom">{{ zoomPct() }}%</span>
                  <button (click)="zoomIn()" title="Zoom in" aria-label="Zoom in">+</button>
                  <button (click)="zoomReset()" title="Fit view">⤢</button>
                </div>
              </div>
            </main>
          </div>
            </div>
          }
          @case ('processes') {
            <section class="card">
              <div class="block-h"><h3>Process definitions in this deployment</h3></div>
              @if (defsLoading()) {
                <div class="pad"><div class="skeleton skeleton-line" style="width:100%"></div><div class="skeleton skeleton-line" style="width:70%"></div></div>
              } @else if (defs().length === 0) {
                <div class="empty-state"><div class="es-icon"><app-icon name="code" [size]="24" /></div><h3>No process definitions</h3><p>This deployment contains no process definitions.</p></div>
              } @else {
                <table>
                  <thead><tr><th>Id</th><th>Name</th><th>Nodes</th><th></th></tr></thead>
                  <tbody>
                    @for (pd of defs(); track pd.id) {
                      <tr>
                        <td class="mono">{{ pd.id }}</td><td>{{ pd.name }}</td><td class="muted">{{ pd.nodes }}</td>
                        <td class="ta-r">
                          @if (pd.startable && d.status === 'active') {
                            <button class="btn sm primary" (click)="startInstance(d, pd)" title="Start a new instance of this process"><app-icon name="play" [size]="12" /> Start</button>
                          } @else {
                            <span class="muted sm">{{ pd.startable ? 'activate the deployment to start' : 'not startable' }}</span>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
            </section>
          }
          @case ('history') {
            <section class="card block">
              <h3>Release history · {{ projectName() }} · {{ d.environment }}</h3>
              <p class="muted sub">Newest first. Rolling back activates an earlier release and deactivates the current one — running instances keep running on the release they started on.</p>
              <ol class="timeline">
                @for (h of history(); track h.id) {
                  <li [class.current]="h.id === d.id">
                    <span class="dot" [class.on]="h.status === 'active'"></span>
                    <div class="item">
                      <div class="row1">
                        <b>{{ version(h) }}</b>
                        <span class="badge" [class.active]="h.status==='active'" [class.inactive]="h.status==='inactive'" [class.archived]="h.status==='archived'">{{ h.status }}</span>
                        @if (h.id === d.id) { <span class="badge you">You are here</span> }
                        <span class="spacer"></span>
                        @if (h.id !== d.id) {
                          <a class="btn sm ghost" [routerLink]="['/deployments', h.id]">Open</a>
                          @if (h.status !== 'archived') { <button class="btn sm" [disabled]="busy()" (click)="rollback(d, h)">Roll back to this</button> }
                        }
                      </div>
                      <div class="muted small">{{ h.deployedAt | slice:0:16 }} · {{ h.deployedBy }}@if (h.tags.length) { · {{ h.tags.join(', ') }} }</div>
                    </div>
                  </li>
                }
              </ol>
            </section>
          }
        }
      } @else if (loading()) {
        <div class="card pad"><div class="skeleton skeleton-line" style="width:40%"></div><div class="skeleton skeleton-line" style="width:70%"></div><div class="skeleton skeleton-line" style="width:55%"></div></div>
      } @else {
        <div class="card"><div class="empty-state">
          <div class="es-icon"><app-icon name="search" [size]="24" /></div>
          <h3>Deployment not found</h3><p>It may have been archived and pruned, or the link is wrong.</p>
          <a class="btn" routerLink="/deployments">Back to deployments</a>
        </div></div>
      }
    </div>
  `,
  styles: [`
    .page { padding: 8px 22px 28px; }
    .crumbwrap { margin-bottom: 8px; }
    .head { display: flex; align-items: center; gap: 14px; padding: 16px 20px; margin-bottom: 16px; flex-wrap: wrap; }
    .back { width: 38px; height: 38px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 50%; background: var(--surface-3); color: var(--muted); }
    .back:hover { background: var(--primary-50); color: var(--primary); }
    .titles { min-width: 0; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin-top: 6px; }
    .badge.env { background: var(--primary-50); color: var(--primary); text-transform: uppercase; letter-spacing: .05em; font-size: 11px; }
    .badge.you { background: var(--primary-50); color: var(--primary); }
    .when { font-size: 13px; margin-left: 4px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .tc { margin-left: 6px; font-size: 11px; font-weight: 700; padding: 0 7px; border-radius: var(--radius-pill); background: var(--primary-50); color: var(--primary); }
    .tabs button.active .tc { background: rgba(255, 255, 255, .25); color: #fff; }
    .grid2 { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 16px; align-items: start; }
    .block { padding: 20px 22px; } .block h3 { margin-bottom: 14px; }
    .block-h { padding: 18px 22px 6px; }
    .facts { margin: 0; display: grid; gap: 0; }
    .facts > div { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--border); align-items: center; }
    .facts > div:last-child { border-bottom: 0; }
    .facts dt { color: var(--muted); font-size: 13px; font-weight: 600; } .facts dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
    .lnk { color: var(--primary); font-weight: 650; } .lnk:hover { text-decoration: underline; }
    .next { display: flex; flex-direction: column; gap: 10px; } .next h3 { margin-bottom: 4px; }
    .step { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; padding: 12px 14px; border: 0; border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); cursor: pointer; font: inherit; }
    .step:hover { background: var(--primary-50); }
    .si { width: 38px; height: 38px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 12px; background: var(--grad-brand); color: #fff; }
    .st { flex: 1; min-width: 0; display: flex; flex-direction: column; } .st b { font-size: 14px; } .st small { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
    .step > app-icon:last-child { color: var(--muted); }
    .ta-r { text-align: right; } .mono { font-family: var(--font-mono); font-size: 12.5px; } .small { font-size: 12.5px; } .sm { font-size: 12.5px; }
    .sub { margin: -6px 0 18px; font-size: 13.5px; max-width: 70ch; }
    .timeline { list-style: none; margin: 0; padding: 0; position: relative; }
    .timeline::before { content: ''; position: absolute; left: 9px; top: 12px; bottom: 12px; width: 2px; background: var(--border); }
    .timeline li { position: relative; padding: 0 0 18px 34px; } .timeline li:last-child { padding-bottom: 0; }
    .dot { position: absolute; left: 0; top: 4px; width: 20px; height: 20px; border-radius: 50%; background: var(--surface); border: 3px solid var(--border-strong); }
    .dot.on { border-color: var(--green); background: var(--green-bg); }
    li.current .dot { border-color: var(--primary); box-shadow: 0 0 0 5px var(--primary-50); }
    .item { padding: 12px 16px; border-radius: var(--radius-sm); background: var(--surface-2); }
    li.current .item { background: var(--primary-50); }
    .row1 { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 4px; }
    .pad { padding: 18px 20px; }
    .badge.freeze { background: var(--primary-50); color: var(--primary); display: inline-flex; align-items: center; gap: 4px; }
    pre { margin: 0; font-family: var(--font-mono); white-space: pre-wrap; }
    /* DIAGRAM WORKSPACE */
    .diagram-workspace {
      display: flex;
      height: calc(100vh - 220px);
      min-height: 600px;
      padding: 0;
      overflow: hidden;
    }

    /* PROCESS SWITCHER RAIL */
    .proc-rail {
      width: 280px;
      flex-shrink: 0;
      border-right: 1px solid var(--border);
      background: var(--surface-soft, rgba(0,0,0,0.01));
      display: flex;
      flex-direction: column;
      overflow-y: auto;
      padding: 14px 12px;
      gap: 6px;
    }
    .proc-rail-h {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 6px 10px 6px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .06em;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      margin-bottom: 6px;
    }
    .p-count {
      font-size: 11px;
      background: var(--border);
      padding: 1px 6px;
      border-radius: 999px;
      color: var(--text-secondary);
    }
    .proc-group-label {
      font-size: 10.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: var(--muted);
      padding: 8px 6px 4px 6px;
    }
    .proc-btn {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      border: 1px solid transparent;
      background: transparent;
      text-align: left;
      cursor: pointer;
      transition: all .12s;
    }
    .proc-btn:hover {
      background: var(--surface);
      border-color: var(--border);
    }
    .proc-btn.sel {
      background: var(--surface);
      border-color: var(--primary);
      box-shadow: 0 1px 3px rgba(91,61,245,.1);
    }
    .proc-ic-pill {
      width: 26px;
      height: 26px;
      border-radius: 7px;
      display: grid;
      place-items: center;
      flex-shrink: 0;
    }
    .proc-ic-pill.parent {
      background: #eff6ff;
      color: #2563eb;
    }
    .proc-ic-pill.child {
      background: #faf5ff;
      color: #9333ea;
    }
    .proc-txt {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
    }
    .proc-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .proc-id {
      font-size: 10.5px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .proc-nodes-badge {
      font-size: 10.5px;
      background: var(--border);
      color: var(--muted);
      padding: 2px 6px;
      border-radius: 999px;
      font-weight: 600;
    }
    .empty-processes {
      padding: 24px 12px;
      text-align: center;
      color: var(--muted);
      font-size: 12.5px;
    }

    /* CANVAS VIEWPORT */
    .canvas-viewport {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      position: relative;
      background: var(--canvas-bg, #fcfcfd);
    }
    .canvas-topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 18px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
      font-size: 13px;
    }
    .active-proc-title {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .active-proc-title .lbl { color: var(--muted); font-size: 12px; }
    .proc-stats-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--muted);
    }
    .dwrap {
      flex: 1;
      position: relative;
      overflow: auto;
      background-image: radial-gradient(circle, var(--border) 1px, transparent 1px);
      background-size: 20px 20px;
    }
    .zoomlayer {
      position: relative;
      transform-origin: 0 0;
    }
    .edges {
      position: absolute;
      top: 0;
      left: 0;
      pointer-events: none;
    }
    .ge {
      fill: none;
      stroke: var(--border-strong);
      stroke-width: 1.8;
      stroke-linejoin: round;
      stroke-linecap: round;
    }

    /* BPMN 2.0 SHAPES */
    .node {
      position: absolute;
      background: var(--surface);
      border: 1.5px solid var(--border-strong);
      border-radius: 10px;
      box-shadow: var(--shadow-card);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 12px;
      cursor: pointer;
      user-select: none;
      transition: border-color .15s, box-shadow .15s;
      z-index: 2;
    }
    .node:hover {
      border-color: var(--primary);
      box-shadow: var(--shadow-pop);
    }
    .node.sel {
      border-color: var(--primary) !important;
      box-shadow: 0 0 0 3px rgba(91,61,245,.2), var(--shadow-pop);
    }
    .node.node-call {
      border-width: 2px;
    }
    .call-badge {
      font-size: 10.5px;
      font-weight: 800;
      color: #9333ea;
      margin-left: auto;
      padding: 1px 4px;
      background: #faf5ff;
      border-radius: 4px;
    }

    /* CIRCLE */
    .node.node-circle {
      border-radius: 50%;
      padding: 0;
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
      width: 130px;
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
      width: 130px;
      text-align: center;
      white-space: normal;
      line-height: 1.2;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--text-secondary);
      pointer-events: none;
    }

    /* BRANCH LABELS & BADGES */
    .branchbadge {
      position: absolute;
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: var(--text);
      color: var(--surface);
      font-size: 11px;
      font-weight: 700;
      display: grid;
      place-items: center;
      box-shadow: var(--shadow-card);
      z-index: 3;
    }
    .branchpill {
      position: absolute;
      transform: translate(-6px, -30px);
      background: var(--surface);
      border: 1px solid var(--border-strong);
      border-radius: 999px;
      padding: 3px 12px;
      font-size: 11.5px;
      font-weight: 600;
      color: var(--text);
      box-shadow: var(--shadow-card);
      z-index: 3;
      white-space: nowrap;
    }

    .chip {
      width: 28px;
      height: 28px;
      border-radius: 7px;
      display: grid;
      place-items: center;
      color: #fff;
      flex-shrink: 0;
    }
    .ntitle {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }

    /* ZOOM CONTROLS */
    .zoomctrl {
      position: absolute;
      bottom: 20px;
      right: 20px;
      display: flex;
      align-items: center;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      box-shadow: var(--shadow-card);
      z-index: 10;
      overflow: hidden;
    }
    .zoomctrl button {
      background: transparent;
      border: none;
      padding: 8px 12px;
      font-size: 15px;
      color: var(--text);
      cursor: pointer;
    }
    .zoomctrl button:hover { background: var(--surface-hover); }
    .zpct {
      font-size: 12px;
      font-weight: 600;
      padding: 0 6px;
      cursor: pointer;
      user-select: none;
    }

    /* CONTEXTUAL NODE INSPECTOR POPOVER (ANCHORED TO CLICKED NODE) */
    .node-inspector-popover {
      position: absolute;
      width: 320px;
      max-height: 420px;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-strong);
      background: rgba(255, 255, 255, 0.98);
      backdrop-filter: blur(16px);
      box-shadow: 0 12px 36px -6px rgba(0, 0, 0, 0.22), 0 4px 12px -2px rgba(0, 0, 0, 0.1);
      z-index: 100;
      display: flex;
      flex-direction: column;
      animation: popoverFadeIn .14s cubic-bezier(0.16, 1, 0.3, 1);
    }
    :host-context([data-theme='dark']) .node-inspector-popover {
      background: rgba(24, 24, 28, 0.98);
      border-color: var(--border-strong);
    }
    @keyframes popoverFadeIn {
      from { opacity: 0; transform: translateY(-4px) scale(0.98); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .popover-arrow {
      position: absolute;
      width: 14px;
      height: 14px;
      background: var(--surface);
      border: 1px solid var(--border-strong);
      transform: translateX(-50%) rotate(45deg);
      z-index: 101;
    }
    .pos-below .popover-arrow {
      top: -7px;
      border-bottom: none;
      border-right: none;
    }
    .pos-above .popover-arrow {
      bottom: -7px;
      border-top: none;
      border-left: none;
    }
    .ni-header {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .ni-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13.5px;
      font-weight: 600;
      min-width: 0;
    }
    .ni-title b {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ni-chip {
      width: 22px;
      height: 22px;
      border-radius: 6px;
      display: grid;
      place-items: center;
      color: #fff;
      flex-shrink: 0;
    }
    .ni-close {
      background: transparent;
      border: none;
      font-size: 18px;
      line-height: 1;
      color: var(--muted);
      cursor: pointer;
    }
    .ni-body {
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      overflow-y: auto;
      font-size: 12.5px;
    }
    .ni-row {
      display: flex;
      justify-content: space-between;
      gap: 10px;
    }
    .ni-row .k { color: var(--muted); }
    .ni-call-box {
      background: #faf5ff;
      border: 1px solid #e9d5ff;
      border-radius: var(--radius-sm);
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    :host-context([data-theme='dark']) .ni-call-box {
      background: rgba(147, 51, 234, 0.1);
      border-color: rgba(147, 51, 234, 0.3);
    }
    .ni-call-label {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: #9333ea;
    }
    .ni-call-target { font-weight: 600; }
    .ni-jump {
      margin-top: 4px;
      justify-content: center;
    }
    .ni-code-block pre {
      margin: 4px 0 0 0;
      padding: 8px;
      background: var(--surface-soft);
      border-radius: var(--radius-sm);
      overflow-x: auto;
    }
    @media (max-width: 900px) {
      .page { padding: 4px 12px 24px; }
      .grid2 { grid-template-columns: minmax(0, 1fr); }
      .facts > div { grid-template-columns: 110px minmax(0, 1fr); }
      .head { padding: 14px; } .actions { width: 100%; } .actions .btn { flex: 1; }
      .tabs { display: flex; overflow-x: auto; flex-wrap: nowrap; }
    }
  `],
})
export class DeploymentDetailComponent {
  private api = inject(DeploymentApiService);
  private wfApi = inject(WorkflowApiService);
  private instApi = inject(InstanceApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  private modal = inject(ModalService);

  id = toSignal(this.route.paramMap.pipe(map((m) => m.get('id') || '')), { initialValue: this.route.snapshot.paramMap.get('id') || '' });
  tab = signal<Tab>((['overview', 'diagram', 'processes', 'history'] as const).find((t) => t === this.route.snapshot.queryParamMap.get('tab')) ?? 'overview');
  loading = signal(true);
  busy = signal(false);
  dep = signal<Deployment | null>(null);
  defs = signal<DeploymentProcessDef[]>([]);
  defsLoading = signal(false);
  history = signal<Deployment[]>([]);
  projectName = signal('');
  catalog = signal<Catalog | null>(null);

  // --- read-only diagram snapshot state ---
  selectedProcessId = signal<string | null>(null);
  selectedNode = signal<any | null>(null);
  zoom = signal(1);
  zoomPct = computed(() => Math.round(this.zoom() * 100));

  @HostListener('document:keydown.escape')
  onEscape() {
    this.selectedNode.set(null);
  }

  popoverPos = computed(() => {
    const sn = this.selectedNode();
    if (!sn) return null;
    const dims = this.nodeDims(sn.type);
    const popW = 320;
    const popH = 260;

    // Center horizontally over the node
    const nodeCenterX = sn.x + (dims.w / 2);
    let x = nodeCenterX - (popW / 2);

    // Clamp X so the popover remains within canvas boundaries
    const minX = 16;
    const maxX = Math.max(minX, this.dw() - popW - 16);
    x = Math.max(minX, Math.min(maxX, x));

    // Calculate arrow position relative to the popover's left edge
    const arrowLeft = Math.max(24, Math.min(popW - 24, nodeCenterX - x));

    // Vertical placement: default below the node
    const isCircleOrDiamond = this.isCircle(sn.type) || this.isDiamond(sn.type);
    const labelExtra = isCircleOrDiamond ? 44 : 12;
    const belowY = sn.y + dims.h + labelExtra;

    let y = belowY;
    let placement: 'above' | 'below' = 'below';

    // If placing below exceeds the canvas height and there is room above, place above
    if (belowY + popH > this.dh() && sn.y > popH + 20) {
      y = Math.max(16, sn.y - popH - 14);
      placement = 'above';
    }

    return { x, y, placement, arrowLeft };
  });


  // All processes in this deployment container
  processes = computed(() => {
    const d = this.dep();
    return (d?.engine?.processes || []) as any[];
  });

  // Set of process IDs called as sub-processes
  calledProcessIds = computed(() => {
    const called = new Set<string>();
    for (const p of this.processes()) {
      for (const n of p.nodes || []) {
        if (n.type === 'call') {
          const target = n['calledProcessId'] || n['processId'] || n['process'] || n['calledElement'];
          if (target) called.add(target);
        }
      }
    }
    return called;
  });

  // Parent / Root processes
  parentProcesses = computed(() => {
    const called = this.calledProcessIds();
    const ps = this.processes();
    const roots = ps.filter((p) => !called.has(p.id));
    return roots.length ? roots : ps.slice(0, 1);
  });

  // Child / Sub-processes
  childProcesses = computed(() => {
    const called = this.calledProcessIds();
    return this.processes().filter((p) => called.has(p.id));
  });

  // The active process to display on the canvas
  activeProcess = computed(() => {
    const pid = this.selectedProcessId();
    const ps = this.processes();
    if (pid) {
      const match = ps.find((p) => p.id === pid);
      if (match) return match;
    }
    return this.parentProcesses()[0] || ps[0] || null;
  });

  findProcess(id?: string) {
    if (!id) return null;
    return this.processes().find((p) => p.id === id) || null;
  }

  // Laid out nodes for the active process
  laidNodes = computed(() => {
    const proc = this.activeProcess();
    if (!proc) return [];
    const auto = this.computeLayeredPositions(proc.nodes || [], proc.flows || []);
    return (proc.nodes || []).map((n: any) => {
      const p = auto.get(n.id);
      return { ...n, x: n.x ?? p?.x ?? 40, y: n.y ?? p?.y ?? 40 };
    });
  });

  laidEdges = computed(() => {
    return this.activeProcess()?.flows || [];
  });

  private byId(id: string) { return this.laidNodes().find((n: any) => n.id === id); }

  dw = computed(() => {
    let maxX = 800;
    for (const n of this.laidNodes()) {
      const d = this.nodeDims(n.type);
      const right = n.x + d.w + 60;
      if (right > maxX) maxX = right;
    }
    return maxX + 80;
  });

  dh = computed(() => {
    let maxY = 400;
    for (const n of this.laidNodes()) {
      const d = this.nodeDims(n.type);
      const extra = this.isCircle(n.type) || this.isDiamond(n.type) ? 55 : 0;
      const bottom = n.y + d.h + extra + 40;
      if (bottom > maxY) maxY = bottom;
    }
    return maxY + 50;
  });

  labeledBranches = computed(() => {
    const out: { edge: any; x: number; y: number; text: string }[] = [];
    const flows = this.laidEdges();
    for (const e of flows) {
      if (!e.label && !e.when) continue;
      const text = e.label || e.when;
      const b = this.byId(e.to); if (!b) continue;
      out.push({ edge: e, x: b.x, y: b.y - 28, text });
    }
    return out;
  });

  numberedBranches = computed(() => {
    const out: { edge: any; x: number; y: number; text: string }[] = [];
    const flows = this.laidEdges();
    for (const e of flows) {
      if (e.label || e.when) continue;
      const siblings = flows.filter((x: any) => x.from === e.from);
      if (siblings.length <= 1) continue;
      const b = this.byId(e.to); if (!b) continue;
      out.push({ edge: e, x: b.x - 26, y: b.y + this.nodeDims(b.type).h / 2 - 11, text: String(siblings.indexOf(e) + 1) });
    }
    return out;
  });


  version(d: Deployment) { return d.versionLabel || ('v' + (d.versionNumber ?? '?')); }

  constructor() {
    this.wfApi.catalog().subscribe((c) => this.catalog.set(c));
    this.route.paramMap.subscribe(() => { this.selectedProcessId.set(null); this.selectedNode.set(null); this.load(); });
  }

  setTab(t: Tab) {
    this.tab.set(t);
    this.router.navigate([], { queryParams: { tab: t === 'overview' ? null : t }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  private load() {
    const id = this.route.snapshot.paramMap.get('id') || '';
    this.loading.set(true);
    this.api.getDeployment(id).subscribe({
      next: (d) => {
        this.dep.set(d); this.loading.set(false);
        this.wfApi.listWorkflows().subscribe((ws) => this.projectName.set(ws.find((w) => w.id === d.workflowId)?.name || d.workflowId));
        this.defsLoading.set(true);
        this.api.definitions(d.id).subscribe({ next: (x) => { this.defs.set(x); this.defsLoading.set(false); }, error: () => this.defsLoading.set(false) });
        this.api.listDeploymentsGlobal({ workflowId: d.workflowId }).subscribe((all) =>
          this.history.set(all.filter((x) => x.environment === d.environment).sort((a, b) => b.deployedAt.localeCompare(a.deployedAt))));
      },
      error: () => { this.dep.set(null); this.loading.set(false); },
    });
  }

  private onError(e: any) { this.busy.set(false); this.toast.error(e?.error?.error?.message || 'That action could not be completed'); }
  private done(msg: string) { this.busy.set(false); this.toast.success(msg); this.load(); }

  activate(d: Deployment) { this.busy.set(true); this.api.activate(d.id).subscribe({ next: () => this.done('Deployment activated'), error: (e) => this.onError(e) }); }
  async undeploy(d: Deployment) {
    if (!(await this.modal.confirm({ title: 'Undeploy', message: `Stop serving ${this.projectName()} ${this.version(d)} in ${d.environment}? New instances can't be started from it until you activate it again.`, confirmLabel: 'Undeploy', danger: true }))) return;
    this.busy.set(true); this.api.undeploy(d.id).subscribe({ next: () => this.done('Deployment undeployed'), error: (e) => this.onError(e) });
  }
  async archive(d: Deployment) {
    if (!(await this.modal.confirm({ title: 'Archive deployment', message: `Archive ${this.projectName()} ${this.version(d)}? It disappears from active use and can't be activated again.`, confirmLabel: 'Archive', danger: true }))) return;
    this.busy.set(true); this.api.archive(d.id).subscribe({ next: () => this.done('Deployment archived'), error: (e) => this.onError(e) });
  }
  async rollback(d: Deployment, target: Deployment) {
    if (!(await this.modal.confirm({ title: 'Roll back', message: `Roll ${d.environment} back to ${this.version(target)}? It becomes the active release.`, confirmLabel: 'Roll back', danger: true }))) return;
    this.busy.set(true);
    this.api.rollback(d.id, { environment: d.environment, toDeploymentId: target.id }).subscribe({ next: () => { this.busy.set(false); this.toast.success(`Rolled back to ${this.version(target)}`); this.router.navigate(['/deployments', target.id], { queryParams: { tab: 'history' } }); }, error: (e) => this.onError(e) });
  }
  downloadSnapshot(d: Deployment) {
    this.api.exportSnapshot(d.id).subscribe({
      next: (pkg) => {
        const json = JSON.stringify(pkg, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const env = d.environment.toLowerCase();
        const ver = d.versionLabel || ('v' + (d.versionNumber ?? '1'));
        a.href = url;
        a.download = `deployment-snapshot-${d.id}-${env}-${ver}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.toast.success(`Deployment snapshot exported (${(blob.size / 1024).toFixed(1)} KB)`);
      },
      error: (e) => this.toast.error('Failed to export snapshot: ' + (e?.error?.message || e.message)),
    });
  }

  async confirmRestore(d: Deployment) {
    const name = this.projectName() || d.workflowId;
    if (!(await this.modal.confirm({ title: 'Restore to project', message: `Restore the frozen snapshot of ${name} ${this.version(d)} into the project as a fresh working draft?`, confirmLabel: 'Restore' }))) return;
    this.busy.set(true);
    this.api.restoreToProject(d.id).subscribe({
      next: (res) => { this.busy.set(false); this.toast.success(`Restored deployment snapshot into project "${name}"`); this.router.navigate(['/projects', res.workflowId, 'processes']); },
      error: (e) => { this.busy.set(false); this.toast.error('Failed to restore snapshot: ' + (e?.error?.message || e.message)); },
    });
  }

  /** jBPM's "New Process Instance": start from a deployed definition, then jump to the instances list. */
  startInstance(d: Deployment, pd: DeploymentProcessDef) {
    this.instApi.startInstance({ workflowId: d.workflowId, processId: pd.id, deploymentId: d.id }).subscribe({
      next: (inst) => { this.toast.success(`Instance started: …${inst.id.slice(-7)}`); this.router.navigate(['/instances', inst.id]); },
      error: (e) => this.onError(e),
    });
  }

  // --- Zoom Controls ---
  zoomIn() { this.zoom.update((z) => Math.min(2, +(z + 0.15).toFixed(2))); }
  zoomOut() { this.zoom.update((z) => Math.max(0.4, +(z - 0.15).toFixed(2))); }
  zoomReset() { this.zoom.set(1); }

  // --- BPMN Visual helpers ---
  isCircle(t: string): boolean {
    return t === 'start' || t === 'end' || t === 'intermediateCatch' || t === 'boundary';
  }

  isDiamond(t: string): boolean {
    return t === 'gateway' || t === 'inclusiveGateway' || t === 'parallelGateway' || t === 'eventGateway';
  }

  isRectangle(t: string): boolean {
    return !this.isCircle(t) && !this.isDiamond(t);
  }

  nodeDims(t: string): { w: number; h: number } {
    if (this.isCircle(t)) return { w: 44, h: 44 };
    if (this.isDiamond(t)) return { w: 52, h: 52 };
    return { w: NW, h: NH };
  }

  visual(type: string): { icon: string; color: string } {
    const d = (this.catalog()?.nodes as any[])?.find((x: any) => x.type === type)?.diagram;
    if (d) return { icon: d.icon || 'nodes', color: d.color || '#64748b' };
    const fallback: Record<string, { icon: string; color: string }> = {
      start: { icon: 'play', color: '#16a34a' },
      end: { icon: 'check', color: '#dc2626' },
      gateway: { icon: 'gitBranch', color: '#d97706' },
      inclusiveGateway: { icon: 'gitBranch', color: '#d97706' },
      parallelGateway: { icon: 'gitBranch', color: '#d97706' },
      userTask: { icon: 'user', color: '#2563eb' },
      serviceTask: { icon: 'zap', color: '#0891b2' },
      scriptTask: { icon: 'terminal', color: '#7c3aed' },
      businessRuleTask: { icon: 'table', color: '#9333ea' },
      call: { icon: 'cornerDownRight', color: '#7c3aed' },
    };
    return fallback[type] || { icon: 'zap', color: '#64748b' };
  }

  gatewayMarker(n: any): string {
    const t = n.gatewayType || n.type;
    if (t === 'parallelGateway' || t === 'parallel') return '+';
    if (t === 'inclusiveGateway' || t === 'inclusive') return '○';
    if (t === 'eventGateway') return '⬠';
    return '✕';
  }

  edge(f: any): string {
    const from = this.byId(f.from);
    const to = this.byId(f.to);
    if (!from || !to) return '';
    const fromDims = this.nodeDims(from.type);
    const toDims = this.nodeDims(to.type);

    const x1 = from.x + fromDims.w;
    const y1 = from.y + fromDims.h / 2;
    const x2 = to.x;
    const y2 = to.y + toDims.h / 2;

    if (Math.abs(y1 - y2) < 3) return `M ${x1} ${y1} L ${x2} ${y2}`;
    const mx = x1 + Math.max(28, (x2 - x1) / 2);
    return `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`;
  }

  private computeLayeredPositions(nodes: any[], flows: any[]): Map<string, { x: number; y: number }> {
    const pos = new Map<string, { x: number; y: number }>();
    if (!nodes.length) return pos;

    const inDeg = new Map<string, number>();
    const succ = new Map<string, string[]>();
    for (const n of nodes) { inDeg.set(n.id, 0); succ.set(n.id, []); }
    for (const f of flows) {
      if (inDeg.has(f.to)) inDeg.set(f.to, (inDeg.get(f.to) || 0) + 1);
      if (succ.has(f.from)) succ.get(f.from)!.push(f.to);
    }

    const rank = new Map<string, number>();
    let q: string[] = nodes.filter((n) => (inDeg.get(n.id) || 0) === 0).map((n) => n.id);
    if (!q.length && nodes[0]) q = [nodes[0].id];
    for (const id of q) rank.set(id, 0);

    const visited = new Set<string>();
    while (q.length) {
      const cur = q.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const r = rank.get(cur) || 0;
      for (const nxt of succ.get(cur) || []) {
        rank.set(nxt, Math.max(rank.get(nxt) || 0, r + 1));
        q.push(nxt);
      }
    }

    for (const n of nodes) if (!rank.has(n.id)) rank.set(n.id, 0);

    const byRank = new Map<number, string[]>();
    for (const [id, r] of rank.entries()) {
      if (!byRank.has(r)) byRank.set(r, []);
      byRank.get(r)!.push(id);
    }

    const MARGIN_LEFT = 60, MARGIN_TOP = 80;
    const sortedRanks = [...byRank.keys()].sort((a, b) => a - b);
    for (const r of sortedRanks) {
      const ids = byRank.get(r)!;
      ids.forEach((id, rowIdx) => {
        const node = nodes.find((n) => n.id === id);
        const dims = this.nodeDims(node?.type || '');
        const alignOffset = (NH - dims.h) / 2;
        pos.set(id, {
          x: MARGIN_LEFT + r * COL_W,
          y: MARGIN_TOP + rowIdx * ROW_H + alignOffset,
        });
      });
    }
    return pos;
  }
}
