import { processLabel } from '../../core/process-label';
import { Component, OnDestroy, computed, inject, signal, HostListener } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { JsonPipe, SlicePipe } from '@angular/common';
import { catchError, finalize, firstValueFrom, forkJoin, Observable, of, switchMap, tap } from 'rxjs';
import { InstanceApiService } from '../../core/api/instance-api.service';
import { DeploymentApiService } from '../../core/api/deployment-api.service';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { WorkflowInstanceApiService } from '../../core/api/workflow-instance-api.service';
import { QueryApiService } from '../../core/api/query-api.service';
import { OpsApiService } from '../../core/api/ops-api.service';
import { SystemApiService } from '../../core/api/system-api.service';
import { IamApiService } from '../../core/api/iam-api.service';
import { AuthService } from '../../core/auth/auth.service';
import { RealtimeService } from '../../core/realtime.service';
import { ToastService } from '../../shared/toast.service';
import { ModalService } from '../../shared/modal.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import type { Catalog, Deployment, ExecutionError, Instance, Task, VariableChange, Workflow, WorkflowInstanceAggregate, WorkflowInstanceAudit, WorkflowInstanceComment } from '../../core/models';

// Wider than the original 150 — most real node names ("Leave Request Submitted", "Notify Employee
// (Approved)") were truncating to unreadable, indistinguishable fragments ("Leave Reques...",
// "Notify Emplo..." — the SAME truncated text for two different nodes). Still truncates on very long
// names, but the [title] tooltip on .gn (see template) is the actual guaranteed fallback for those.
const NW = 180, NH = 56;
const COL_W = NW + 100, ROW_H = NH + 46;
type Tab = 'details' | 'diagram' | 'variables' | 'case' | 'logs' | 'documents';

interface DocRow { variable: string; filename: string; url?: string; mimeType?: string; }

/** Dedicated instance page (ux_design/mockups/process-instance-detail.html + instance-*-tab.html):
 *  header with quick links + lifecycle actions, five tabs. The diagram/graph rendering here mirrors
 *  the logic that used to live inline in the Instances list (kept verbatim — it works). */
@Component({
  selector: 'app-instance-detail',
  standalone: true,
  imports: [IconComponent, RouterLink, FormsModule, SlicePipe, JsonPipe, BreadcrumbComponent],
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

        <div class="row" style="margin-bottom:2px; align-items:center; gap:10px;">
          <h1>{{ procName(inst()!) }} — <span class="mono">#{{ shortId(inst()!.id) }}</span></h1>
          <span class="badge" [style.color]="statusColor(inst()!.status)">{{ inst()!.status }}</span>
          @if (boundCase(); as bc) {
            <span class="case-chip-header">
              <app-icon name="inbox" [size]="12" /> Case: <b>{{ bc.workflowInstance.workflowName }}</b> #{{ shortId(bc.workflowInstance.id) }}
              <span class="badge" [class.active]="bc.workflowInstance.status !== 'failed'">{{ bc.workflowInstance.status }}</span>
            </span>
          }
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
            <aside class="hierarchy-rail card">
              <div class="hierarchy-head">
                <span class="hierarchy-title"><app-icon name="branch" [size]="14" /> Process Hierarchy</span>
              </div>

              <!-- Parent Node Section -->
              <div class="hierarchy-section">
                <div class="hierarchy-lbl">PARENT PROCESS</div>
                @if (parent(); as p) {
                  <div class="hier-node hier-parent" (click)="goto(p.id)" role="button" tabindex="0" [title]="'Navigate to parent: ' + procName(p)">
                    <div class="node-icon"><app-icon name="arrowLeft" [size]="13" /></div>
                    <div class="node-body">
                      <div class="node-name" [title]="procName(p)">{{ procName(p) }}</div>
                      <div class="node-meta">
                        <span class="mono">#{{ shortId(p.id) }}</span>
                        <span class="status-dot" [style.background]="statusColor(p.status)"></span>
                        <span class="node-status">{{ p.status }}</span>
                      </div>
                    </div>
                  </div>
                } @else {
                  <div class="hier-node hier-root">
                    <span class="muted sm">Root Process (No Parent)</span>
                  </div>
                }
              </div>

              <div class="hier-connector"><div class="connector-line"></div></div>

              <!-- Current Live Instance Node -->
              <div class="hierarchy-section">
                <div class="hier-node hier-current">
                  <div class="node-badge">THIS INSTANCE</div>
                  <div class="node-main">
                    <div class="current-indicator" [style.background]="statusColor(inst()!.status)"></div>
                    <div class="node-body">
                      <div class="node-name bold" [title]="procName(inst()!)">{{ procName(inst()!) }}</div>
                      <div class="node-meta">
                        <span class="mono">#{{ shortId(inst()!.id) }}</span>
                        <span class="status-pill sm" [style.color]="statusColor(inst()!.status)" [style.background]="statusColor(inst()!.status) + '18'">{{ inst()!.status }}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div class="hier-connector"><div class="connector-line"></div></div>

              <!-- Sub-processes / Call Activities -->
              <div class="hierarchy-section">
                <div class="hierarchy-lbl">SUB-PROCESSES ({{ children().length }})</div>
                @if (children().length) {
                  <div class="children-tree">
                    @for (c of children(); track c.id) {
                      <div class="hier-node hier-child" (click)="goto(c.id)" role="button" tabindex="0" [title]="'Navigate to sub-process: ' + procName(c)">
                        <div class="node-icon"><app-icon name="cornerDownRight" [size]="13" /></div>
                        <div class="node-body">
                          <div class="node-name" [title]="procName(c)">{{ procName(c) }}</div>
                          <div class="node-meta">
                            <span class="mono">#{{ shortId(c.id) }}</span>
                            <span class="status-dot" [style.background]="statusColor(c.status)"></span>
                            <span class="node-status">{{ c.status }}</span>
                          </div>
                        </div>
                      </div>
                    }
                  </div>
                } @else {
                  <div class="hier-node hier-none">
                    <span class="muted sm">No sub-processes executed</span>
                  </div>
                }
              </div>
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
                    <tr><td class="muted">Deployment</td><td><a class="lnk" [routerLink]=\"['/deployments', inst()!.deploymentId]\">{{ version(inst()!) }}</a></td></tr>
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
                  <div class="dwrap card" (click)="pickedNode.set(null); picked.set(null)">
                    <div class="zoomlayer" [style.zoom]="zoom()" [style.height.px]="dh()" [style.width.px]="dw()">
                      <svg class="edges" [attr.width]="dw()" [attr.height]="dh()" [style.width.px]="dw()" [style.height.px]="dh()">
                        <defs>
                          <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                            <path d="M0,0 L10,5 L0,10 z" fill="var(--border-strong)"/>
                          </marker>
                          <marker id="ar-taken" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                            <path d="M0,0 L10,5 L0,10 z" fill="var(--primary)"/>
                          </marker>
                        </defs>
                        @for (e of graph().flows; track $index) {
                          <path [attr.d]="edge(e)" class="ge" [class.taken]="isFlowTaken(e)" [attr.marker-end]="isFlowTaken(e) ? 'url(#ar-taken)' : 'url(#ar)'" />
                        }
                      </svg>

                      @for (n of laid(); track n.id) {
                        <div class="node" [attr.id]="'node-' + n.id"
                             [class.node-circle]="isCircle(n.type)"
                             [class.node-diamond]="isDiamond(n.type)"
                             [class.node-rectangle]="isRectangle(n.type)"
                             [class.node-call]="n.type === 'call'"
                             [class.node-start]="n.type === 'start'"
                             [class.node-end]="n.type === 'end'"
                             [class.active]="isActive(n.id)"
                             [class.visited]="count(n.id) > 0"
                             [class.failed]="isFailedNode(n.id)"
                             [class.picked]="picked() === n.id"
                             [style.left.px]="n.x" [style.top.px]="n.y"
                             [style.width.px]="nodeDims(n.type).w" [style.height.px]="nodeDims(n.type).h"
                             [title]="n.name || n.id"
                             (click)="$event.stopPropagation(); selectInstanceNode(n)">

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

                          @if (count(n.id) > 0) {
                            <span class="bc" [class.bc-circle]="isCircle(n.type)" [class.bc-diamond]="isDiamond(n.type)" title="executed {{ count(n.id) }}×">{{ count(n.id) }}</span>
                          }
                          @if (isFailedNode(n.id)) {
                            <span class="bc failed" [class.bc-circle]="isCircle(n.type)" [class.bc-diamond]="isDiamond(n.type)" title="{{ inst()!.error?.message }}"><app-icon name="warning" [size]="10" /></span>
                          }
                        </div>
                      }

                      @for (b of numberedBranches(); track b.edge.id || $index) {
                        <div class="branchbadge" [style.left.px]="b.x" [style.top.px]="b.y" [title]="'Branch ' + b.text">{{ b.text }}</div>
                      }
                      @for (b of labeledBranches(); track b.edge.id || $index) {
                        <div class="branchpill" [style.left.px]="b.x" [style.top.px]="b.y" [title]="b.text">{{ b.text }}</div>
                      }

                      <!-- CONTEXTUAL NODE EXECUTION POPOVER (ANCHORED AT CLICKED NODE) -->
                      @if (pickedNode(); as pn) {
                        @if (instancePopoverPos(); as pos) {
                          <div class="node-inspector-popover"
                               [style.left.px]="pos.x"
                               [style.top.px]="pos.y"
                               [class.pos-above]="pos.placement === 'above'"
                               [class.pos-below]="pos.placement === 'below'"
                               (click)="$event.stopPropagation()">
                            <div class="popover-arrow" [style.left.px]="pos.arrowLeft"></div>
                            <div class="ni-header">
                              <span class="ni-title">
                                <span class="ni-chip" [style.background]="visual(pn.type).color"><app-icon [name]="visual(pn.type).icon" [size]="12" /></span>
                                <b>{{ pn.name || pn.id }}</b>
                              </span>
                              <button class="ni-close" (click)="pickedNode.set(null); picked.set(null)" aria-label="Close">×</button>
                            </div>
                            <div class="ni-body">
                              <div class="ni-status-row">
                                @if (isFailedNode(pn.id)) {
                                  <span class="badge failed"><app-icon name="warning" [size]="11" /> Failed at this node</span>
                                } @else if (isActive(pn.id)) {
                                  <span class="badge active"><app-icon name="clock" [size]="11" /> Active Token</span>
                                } @else if (count(pn.id) > 0) {
                                  <span class="badge success"><app-icon name="check" [size]="11" /> Executed {{ count(pn.id) }}×</span>
                                } @else {
                                  <span class="badge muted">Not reached</span>
                                }
                              </div>

                              @if (isFailedNode(pn.id) && inst()!.error) {
                                <div class="ni-error-box">
                                  <span class="ni-error-title">Failure Reason:</span>
                                  <p class="ni-error-msg mono sm">{{ inst()!.error?.message }}</p>
                                  @if (canRetryOrSignal()) {
                                    <button class="btn sm danger ni-action-btn" (click)="retryPicked()">
                                      <app-icon name="refresh" [size]="12" /> Retry Failed Node
                                    </button>
                                  }
                                </div>
                              }

                              <div class="ni-row"><span class="k">Node Type:</span> <span class="v mono">{{ pn.type }}</span></div>
                              <div class="ni-row"><span class="k">Node ID:</span> <span class="v mono">{{ pn.id }}</span></div>
                              @if (pn.type === 'call') {
                                <div class="ni-call-box">
                                  <div class="ni-call-label">Sub-process Reference:</div>
                                  <div class="ni-call-target mono">{{ pn.calledProcessId || pn.processId || pn.calledElement || '—' }}</div>
                                </div>
                              }
                              @if (pn.group) {
                                <div class="ni-row"><span class="k">Candidate Group:</span> <span class="v mono">{{ pn.group }}</span></div>
                              }
                              @if (pn.form) {
                                <div class="ni-row"><span class="k">Form:</span> <span class="v mono">{{ pn.form }}</span></div>
                              }

                              @if (!isFailedNode(pn.id) && canRetryOrSignal()) {
                                <div class="ni-actions">
                                  <button class="btn sm ni-action-btn" (click)="retryPicked()">
                                    <app-icon name="refresh" [size]="12" /> Re-trigger this node
                                  </button>
                                </div>
                              }
                            </div>
                          </div>
                        }
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
              @case ('case') {
                <div class="case-section">
                  @if (boundCase(); as bc) {
                    @if (isCaseReadOnly()) {
                      <div class="donebanner" style="margin-bottom: 14px;">
                        <app-icon name="check" [size]="14" />
                        <span>This case is <strong>{{ bc.workflowInstance.status }}</strong>@if (inst()?.status) { (process instance is <strong>{{ inst()!.status }}</strong>) } — it is finished and read-only. Business data, task reassignments, and case status cannot be modified.</span>
                      </div>
                    }

                    <div class="card pad" style="margin-bottom: 14px;">
                      <div class="row" style="align-items: center; justify-content: space-between;">
                        <div>
                          <h3 style="margin: 0 0 4px; display: flex; align-items: center; gap: 8px;">
                            <app-icon name="inbox" [size]="16" /> {{ bc.workflowInstance.workflowName }}
                            <span class="badge" [class.active]="bc.workflowInstance.status !== 'failed'" [class.inactive]="bc.workflowInstance.status === 'failed'">
                              {{ bc.workflowInstance.status }}
                            </span>
                          </h3>
                          <p class="muted mono sm" style="margin: 0;">Case ID: {{ bc.workflowInstance.id }} · Created {{ ago(bc.workflowInstance.createdAt) }} by {{ bc.workflowInstance.createdBy }}</p>
                        </div>
                        <button class="btn sm" [disabled]="isCaseReadOnly()" (click)="updateCaseStatus()">Update Case Status</button>
                      </div>
                    </div>

                    <!-- Case Business Data Card -->
                    <div class="card pad" style="margin-bottom: 14px;">
                      <div class="section-title first">Business Data (Case Payload)</div>
                      <p class="muted sm" style="margin-top:-4px; margin-bottom:8px;">Structured business fields validated against the case workflow definition schema.</p>
                      <textarea rows="8" [(ngModel)]="caseDataText" [disabled]="isCaseReadOnly()" style="width:100%; font-family:var(--font-mono); font-size:12.5px; border:1px solid var(--border); border-radius:8px; padding:10px; margin-bottom:8px;"></textarea>
                      @if (caseDataError()) { <p class="err sm">{{ caseDataError() }}</p> }
                      <button class="btn primary sm" [disabled]="isCaseReadOnly()" (click)="saveCaseData()">Save Business Data</button>
                    </div>

                    <!-- Case Tasks Card -->
                    <div class="card pad" style="margin-bottom: 14px;">
                      <div class="section-title first">Case Tasks (Any Depth)</div>
                      @if (bc.tasks.length === 0) {
                        <p class="muted sm">No human tasks registered for this case yet.</p>
                      } @else {
                        @for (t of bc.tasks; track t.id) {
                          <div class="prow" style="flex-direction: column; gap: 4px; border-bottom: 1px solid var(--border); padding: 8px 0;">
                            <div class="row" style="justify-content: space-between; align-items: center;">
                              <b>{{ t.name }}</b>
                              <span class="badge">{{ t.status }}</span>
                            </div>
                            <p class="muted sm" style="margin: 0;">Group: {{ t.group || '—' }} · Assignee: {{ t.assignee || '—' }} · Priority: {{ t.priority || 0 }}</p>
                            @if (t.status !== 'completed' && t.status !== 'skipped' && !isCaseReadOnly()) {
                              <div class="row" style="gap: 6px; margin-top: 4px;">
                                <button class="btn sm primary" (click)="decideCaseTask(t)">Decision</button>
                                <button class="btn sm" (click)="delegateCaseTask(t)">Delegate</button>
                              </div>
                            }
                          </div>
                        }
                      }
                    </div>

                    <!-- Case Comments -->
                    <div class="card pad" style="margin-bottom: 14px;">
                      <div class="section-title first">Case Comments</div>
                      @if (!isCaseReadOnly()) {
                        <div class="row" style="gap: 8px; margin-bottom: 12px;">
                          <input [(ngModel)]="newCaseComment" placeholder="Add a comment to this case…" (keyup.enter)="addCaseComment()" style="flex: 1; border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 13px;" />
                          <button class="btn sm" [disabled]="!newCaseComment.trim()" (click)="addCaseComment()">Post</button>
                        </div>
                      } @else {
                        <p class="muted sm" style="margin-bottom: 10px;">Comments are closed for finalized cases.</p>
                      }
                      @for (c of caseComments(); track c.id) {
                        <div class="crow" style="padding: 8px 0; border-top: 1px solid var(--border);">
                          <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 2px;">
                            <b>{{ c.author }}</b>
                            <div class="row" style="gap: 6px; align-items: center;">
                              <span class="muted sm">{{ ago(c.at) }}</span>
                              @if (!isCaseReadOnly() && c.author === me()) {
                                <button class="btn ghost sm" (click)="deleteCaseComment(c)"><app-icon name="trash" [size]="12" /></button>
                              }
                            </div>
                          </div>
                          <p style="margin: 0; font-size: 13px;">{{ c.body }}</p>
                        </div>
                      }
                      @if (caseComments().length === 0) {
                        <p class="muted sm">No comments on this case yet.</p>
                      }
                    </div>

                    <!-- Case Audit Trail -->
                    <div class="card pad">
                      <div class="section-title first">Case Audit Trail</div>
                      <div class="row" style="gap: 8px; margin-bottom: 12px;">
                        <input [(ngModel)]="newCaseAuditKind" placeholder="kind, e.g. case.note" style="width: 180px; border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 13px;" />
                        <input [(ngModel)]="newCaseAuditData" placeholder='data (JSON, optional)' style="flex: 1; border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 13px;" />
                        <button class="btn sm" (click)="addCaseAudit()">Add Note</button>
                      </div>
                      @for (au of caseAudits(); track au.id) {
                        <div class="crow" style="padding: 8px 0; border-top: 1px solid var(--border);">
                          <div class="row" style="justify-content: space-between; align-items: center;">
                            <strong class="mono sm">{{ au.kind }}</strong>
                            <div class="row" style="gap: 6px; align-items: center;">
                              <span class="muted sm">{{ au.actor }} · {{ ago(au.at) }}</span>
                              <button class="btn ghost sm" (click)="deleteCaseAudit(au)"><app-icon name="trash" [size]="12" /></button>
                            </div>
                          </div>
                          @if (au.data) {
                            <pre class="mono sm" style="background: var(--surface-2); padding: 6px; border-radius: 6px; margin: 4px 0 0; overflow-x: auto;">{{ au.data | json }}</pre>
                          }
                        </div>
                      }
                      @if (caseAudits().length === 0) {
                        <p class="muted sm">No case audit entries yet.</p>
                      }
                    </div>
                  } @else {
                    <div class="card pad">
                      <div class="empty-state">
                        <div class="es-icon"><app-icon name="inbox" [size]="24" /></div>
                        <h3>Standalone Process Instance</h3>
                        <p>This process instance was started directly without a bound Case / Workflow Definition.</p>
                        <p class="muted sm">Case business data, schemas, and case-level comments are available when starting via "New Case".</p>
                      </div>
                    </div>
                  }
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
    .page { padding: 12px 14px; height: 100%; box-sizing: border-box; }
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

    /* Related Processes is a nav aid, not the main content — a narrow LEFT rail keeps it out of the
       way. The Diagram tab drops it entirely (see [class.full]) so the canvas gets the full page width
       instead of losing a fixed column to a panel that's rarely relevant while reading a diagram. */
    .tabgrid { display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 18px; align-items: start; }
    .tabgrid.full { grid-template-columns: 1fr; }
    @media (max-width: 960px) {
      .tabgrid { grid-template-columns: 1fr; }
    }
    @media (max-width: 768px) {
      .page { padding: 12px 14px; }
      .topbar { flex-wrap: wrap; gap: 6px; }
      .actionrow { flex-wrap: wrap; gap: 6px; }
    }
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
    .dwrap { position: relative; overflow: auto; min-height: 240px; max-height: 72vh; background-color: var(--canvas-bg); background-image: radial-gradient(circle, var(--canvas-dot) 1.1px, transparent 1.1px); background-size: 22px 22px; }
    .zoomlayer { position: relative; }
    .zoomctrl { position: absolute; bottom: 14px; right: 14px; display: flex; align-items: center; gap: 2px; background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 4px; box-shadow: var(--shadow-pop); z-index: 20; }
    .zoomctrl button { width: 28px; height: 28px; border: none; background: transparent; border-radius: 50%; cursor: pointer; color: var(--text-secondary); font-size: 15px; display: grid; place-items: center; }
    .zoomctrl button:hover { background: var(--surface-3); color: var(--text); }
    .zoomctrl .zpct { width: auto; padding: 0 8px; font-size: 12px; font-weight: 600; }

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
    .ni-status-row { margin-bottom: 2px; }
    .ni-error-box {
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: var(--radius-sm);
      padding: 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    :host-context([data-theme='dark']) .ni-error-box {
      background: rgba(220, 38, 38, 0.1);
      border-color: rgba(220, 38, 38, 0.3);
    }
    .ni-error-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--red);
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .ni-error-msg { margin: 0; color: var(--red); font-size: 11.5px; }
    .ni-row { display: flex; justify-content: space-between; gap: 10px; }
    .ni-row .k { color: var(--muted); }
    .ni-call-box {
      background: #faf5ff;
      border: 1px solid #e9d5ff;
      border-radius: var(--radius-sm);
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .ni-call-label { font-size: 10.5px; font-weight: 700; text-transform: uppercase; color: #9333ea; }
    .ni-action-btn { justify-content: center; width: 100%; margin-top: 4px; }
    .edges { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
    .ge { fill: none; stroke: var(--border-strong); stroke-width: 2; transition: stroke .2s, stroke-width .2s; }
    .ge.taken { stroke: var(--primary); stroke-width: 2.5; }

    /* BPMN 2.0 Standard Nodes for Instance Diagram */
    .node {
      position: absolute;
      background: var(--surface);
      cursor: pointer;
      user-select: none;
      transition: box-shadow .12s, border-color .12s, opacity .12s;
      opacity: .5;
    }
    .node:hover { box-shadow: var(--shadow-pop); }
    .node.visited { opacity: 1; }
    .node.active {
      opacity: 1;
      border-color: var(--primary) !important;
      box-shadow: 0 0 0 3px rgba(91,61,245,.25), var(--shadow-card);
    }
    .node.failed {
      opacity: 1;
      border-color: var(--red) !important;
      box-shadow: 0 0 0 3px rgba(225,29,72,.25), var(--shadow-card);
    }
    .node.picked {
      outline: 2px dashed var(--amber);
      outline-offset: 3px;
    }

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
    .node.node-diamond.active .diamond-body {
      border-color: var(--primary) !important;
      box-shadow: 0 0 0 3px rgba(91,61,245,.25), var(--shadow-card);
    }
    .node.node-diamond.failed .diamond-body {
      border-color: var(--red) !important;
      box-shadow: 0 0 0 3px rgba(225,29,72,.25), var(--shadow-card);
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

    /* EXECUTION & STATUS BADGES */
    .bc {
      position: absolute;
      bottom: -9px;
      left: 50%;
      transform: translateX(-50%);
      min-width: 18px;
      height: 18px;
      border-radius: 9px;
      background: var(--text);
      color: var(--surface);
      font-size: 11px;
      font-weight: 700;
      display: grid;
      place-items: center;
      padding: 0 5px;
      box-shadow: var(--shadow-card);
      z-index: 5;
    }
    .bc.bc-circle { bottom: -6px; }
    .bc.bc-diamond { bottom: -6px; }
    .bc.failed {
      bottom: auto;
      left: auto;
      top: -8px;
      right: -8px;
      transform: none;
      background: var(--red);
      color: #fff;
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
      color: var(--text-secondary);
      box-shadow: var(--shadow-card);
      z-index: 3;
      white-space: nowrap;
    }
    .ops { display: flex; flex-direction: column; gap: 8px; }
    .op label { display: block; font-size: 12px; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
    .logs th, .logs td { text-align: left; padding: 7px 10px; border-bottom: 1px solid var(--border); font-size: 12px; } .logs th { color: var(--muted); }
    .histtbl { width: 100%; margin: 4px 0 8px; } .histtbl td { padding: 4px 8px; border-bottom: 1px dashed var(--border); }
    .ta-r { text-align: right; white-space: nowrap; }
    .hierarchy-rail { padding: 14px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); display: flex; flex-direction: column; gap: 8px; box-shadow: var(--shadow-sm); }
    .hierarchy-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 8px; border-bottom: 1px solid var(--border); margin-bottom: 2px; }
    .hierarchy-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-secondary); display: flex; align-items: center; gap: 6px; }

    .hierarchy-section { display: flex; flex-direction: column; gap: 6px; }
    .hierarchy-lbl { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }

    .hier-node { border: 1px solid var(--border); border-radius: 8px; padding: 9px 12px; background: var(--surface-2); transition: all 0.15s ease; position: relative; }
    .hier-node.hier-parent, .hier-node.hier-child { cursor: pointer; display: flex; align-items: center; gap: 10px; user-select: none; }
    .hier-node.hier-parent:hover, .hier-node.hier-child:hover { border-color: var(--primary); background: var(--surface-3); transform: translateY(-1px); box-shadow: 0 2px 6px rgba(0,0,0,0.06); }
    .hier-node.hier-root, .hier-node.hier-none { border-style: dashed; background: transparent; padding: 8px 12px; text-align: center; }

    .hier-current { border: 1.5px solid var(--primary); background: var(--surface); box-shadow: 0 2px 8px rgba(37,99,235,0.08); padding: 10px 12px; }
    .node-badge { display: inline-block; font-size: 9.5px; font-weight: 800; letter-spacing: 0.06em; color: var(--primary); margin-bottom: 6px; text-transform: uppercase; }
    .node-main { display: flex; align-items: center; gap: 10px; }
    .current-indicator { width: 8px; height: 8px; border-radius: 50%; box-shadow: 0 0 0 3px rgba(37,99,235,0.2); animation: pulse 2s infinite; flex-shrink: 0; }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(37,99,235,0.4); } 70% { box-shadow: 0 0 0 6px rgba(37,99,235,0); } 100% { box-shadow: 0 0 0 0 rgba(37,99,235,0); } }

    .node-icon { color: var(--muted); display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
    .node-body { flex: 1; min-width: 0; }
    .node-name { font-size: 13px; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .node-name.bold { font-weight: 700; }
    .node-meta { display: flex; align-items: center; gap: 6px; margin-top: 3px; font-size: 11.5px; }
    .status-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
    .node-status { font-size: 11px; text-transform: capitalize; color: var(--text-secondary); }
    .status-pill { padding: 2px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 600; text-transform: capitalize; }

    .hier-connector { display: flex; justify-content: center; height: 12px; align-items: center; }
    .connector-line { width: 2px; height: 100%; background: var(--border); }
    .children-tree { display: flex; flex-direction: column; gap: 6px; }
    .case-chip-header { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px; background: rgba(59,130,246,0.12); color: #2563eb; font-size: 12.5px; border: 1px solid rgba(59,130,246,0.25); }
    .badge.active { background: var(--green-bg); color: var(--green); }
    .badge.inactive { background: var(--red-bg); color: var(--red); }
    .empty-state .btn { margin-top: 10px; }
      .topbar { flex-wrap: wrap; }
    @media (max-width: 900px) { .topbar .spacer { display: none; } .crumbwrap { display: none; } .topbar { gap: 6px; } .row { flex-wrap: wrap; } }
  `],
})
export class InstanceDetailComponent implements OnDestroy {
  private api = inject(InstanceApiService);
  private deploymentApi = inject(DeploymentApiService);
  private wfApi = inject(WorkflowApiService);
  private wfInstApi = inject(WorkflowInstanceApiService);
  private queryApi = inject(QueryApiService);
  private opsApi = inject(OpsApiService);
  private systemApi = inject(SystemApiService);
  private iamApi = inject(IamApiService);
  private auth = inject(AuthService);
  private realtime = inject(RealtimeService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private unsub?: () => void;

  me = computed(() => this.auth.user()?.username);
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
  pickedNode = signal<any | null>(null);

  selectInstanceNode(n: any) {
    this.pickedNode.set(n);
    this.picked.set(n.id);
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    this.pickedNode.set(null);
    this.picked.set(null);
  }

  instancePopoverPos = computed(() => {
    const sn = this.pickedNode();
    if (!sn) return null;
    const dims = this.nodeDims(sn.type);
    const popW = 320;
    const popH = 240;

    const nodeCenterX = sn.x + (dims.w / 2);
    let x = nodeCenterX - (popW / 2);

    const minX = 16;
    const maxX = Math.max(minX, this.dw() - popW - 16);
    x = Math.max(minX, Math.min(maxX, x));

    const arrowLeft = Math.max(24, Math.min(popW - 24, nodeCenterX - x));

    const isCircleOrDiamond = this.isCircle(sn.type) || this.isDiamond(sn.type);
    const labelExtra = isCircleOrDiamond ? 44 : 12;
    const belowY = sn.y + dims.h + labelExtra;

    let y = belowY;
    let placement: 'above' | 'below' = 'below';

    if (belowY + popH > this.dh() && sn.y > popH + 20) {
      y = Math.max(16, sn.y - popH - 14);
      placement = 'above';
    }

    return { x, y, placement, arrowLeft };
  });
  tab = signal<Tab>((this.route.snapshot.queryParamMap.get('tab') as Tab) || 'details');
  NW = NW;
  tabDefs: { key: Tab; label: string }[] = [
    { key: 'details', label: 'Details' }, { key: 'diagram', label: 'Diagram' },
    { key: 'variables', label: 'Variables' }, { key: 'case', label: 'Case & Business Data' },
    { key: 'logs', label: 'Logs' }, { key: 'documents', label: 'Documents' },
  ];

  boundCase = signal<WorkflowInstanceAggregate | null>(null);
  caseDataText = '';
  caseDataError = signal('');
  caseComments = signal<WorkflowInstanceComment[]>([]);
  caseAudits = signal<WorkflowInstanceAudit[]>([]);
  newCaseComment = '';
  newCaseAuditKind = '';
  newCaseAuditData = '';

  editingVar = signal<string | null>(null);
  editValue = '';
  historyFor = signal<string | null>(null);
  history = signal<VariableChange[]>([]);
  // Terminal (completed/aborted) is the "definitely read-only" case; 'suspended' gets the same
  // treatment for retry/signal/variable-edits (see InstanceService.retry/signal/updateVariables) even
  // though it isn't terminal — the whole point of a pause is that nothing touches the instance's state
  // until it's resumed, same reasoning, different lifecycle stage.
  isTerminal = computed(() => { const i = this.inst(); return !!i && (i.status === 'completed' || i.status === 'aborted'); });
  isCaseReadOnly = computed(() => {
    const i = this.inst();
    if (i && (i.status === 'completed' || i.status === 'aborted')) return true;
    const bc = this.boundCase();
    if (!bc) return false;
    const s = (bc.workflowInstance.status || '').toLowerCase();
    const terminal = ['completed', 'closed', 'settled', 'settled_and_closed', 'aborted', 'failed', 'cancelled'];
    return terminal.includes(s);
  });
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
  dw = computed(() => {
    let maxX = 600;
    for (const n of this.laid()) {
      const d = this.nodeDims(n.type);
      const right = n.x + d.w + 60;
      if (right > maxX) maxX = right;
    }
    return maxX + 80;
  });
  dh = computed(() => {
    let maxY = 240;
    for (const n of this.laid()) {
      const d = this.nodeDims(n.type);
      const extra = this.isCircle(n.type) || this.isDiamond(n.type) ? 55 : 0;
      const bottom = n.y + d.h + extra + 40;
      if (bottom > maxY) maxY = bottom;
    }
    return maxY + 50;
  });

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
    this.refresh(true);
    this.unsub?.();
    this.unsub = this.realtime.subscribe(`instance:${this.id()}`, () => this.refresh(false));
  }

  private refresh(showLoader = false) {
    if (showLoader) this.loading.set(true);
    this.api.getInstance(this.id()).subscribe({
      next: (i) => {
        this.inst.set(i);
        const fetches: Observable<any>[] = [
          this.deploymentApi.getDeployment(i.deploymentId).pipe(
            tap((d) => this.deployments.set({ ...this.deployments(), [d.id]: d })),
            catchError(() => of(null))
          ),
          this.api.relatedInstances(this.id()).pipe(
            tap((r) => { this.parent.set(r.parent); this.children.set(r.children); }),
            catchError(() => of(null))
          ),
        ];

        if (i.caseInstanceId) {
          fetches.push(
            this.wfInstApi.aggregate(i.caseInstanceId).pipe(
              tap((agg) => {
                this.boundCase.set(agg);
                this.caseDataText = JSON.stringify(agg.workflowInstance.data || {}, null, 2);
              }),
              catchError(() => of(null))
            )
          );
        } else {
          fetches.push(
            this.wfInstApi.list({ piid: this.id() }).pipe(
              switchMap((cases) => {
                if (cases.length) {
                  return this.wfInstApi.aggregate(cases[0].id).pipe(
                    tap((agg) => {
                      this.boundCase.set(agg);
                      this.caseDataText = JSON.stringify(agg.workflowInstance.data || {}, null, 2);
                    }),
                    catchError(() => of(null))
                  );
                }
                return of(null);
              }),
              catchError(() => of(null))
            )
          );
        }

        const tabObs = this.getTabDataObservable(this.tab());
        if (tabObs) fetches.push(tabObs);

        forkJoin(fetches).pipe(
          finalize(() => { if (showLoader) this.loading.set(false); })
        ).subscribe();
      },
      error: () => {
        // Fallback: check if :id itself is a case instance id
        this.wfInstApi.aggregate(this.id()).pipe(
          finalize(() => { if (showLoader) this.loading.set(false); })
        ).subscribe({
          next: (agg) => {
            this.boundCase.set(agg);
            this.caseDataText = JSON.stringify(agg.workflowInstance.data || {}, null, 2);
            if (agg.bpmInstance) this.inst.set(agg.bpmInstance);
          },
          error: () => { this.inst.set(null); },
        });
      },
    });
  }

  private getTabDataObservable(tab: Tab): Observable<any> | null {
    if (tab === 'diagram') {
      return this.api.instanceGraph(this.id()).pipe(
        tap((g) => this.graph.set(g as any)),
        catchError(() => of(null))
      );
    } else if (tab === 'details') {
      return this.queryApi.instanceTasks(this.id()).pipe(
        tap((tasks) => this.openTasks.set(tasks.filter((t) => t.status !== 'completed' && t.status !== 'skipped'))),
        catchError(() => of(null))
      );
    } else if (tab === 'logs') {
      return this.opsApi.listErrors({ instanceId: this.id(), acknowledged: false }).pipe(
        tap((r) => this.errors.set(r.items)),
        catchError(() => of(null))
      );
    }
    return null;
  }

  private loadedTabs = new Set<string>();

  ensureTabData(tab: Tab, force = false) {
    if (!force && this.loadedTabs.has(tab)) return;
    this.loadedTabs.add(tab);

    if (tab === 'diagram') {
      this.api.instanceGraph(this.id()).subscribe((g) => this.graph.set(g as any));
    } else if (tab === 'details') {
      this.queryApi.instanceTasks(this.id()).subscribe((tasks) =>
        this.openTasks.set(tasks.filter((t) => t.status !== 'completed' && t.status !== 'skipped'))
      );
      if (this.inst()?.status === 'failed') {
        this.opsApi.listErrors({ instanceId: this.id(), acknowledged: false }).subscribe((r) => this.errors.set(r.items));
      }
    } else if (tab === 'case') {
      const bc = this.boundCase();
      if (bc) {
        this.wfInstApi.listComments(bc.workflowInstance.id).subscribe((c) => this.caseComments.set(c));
        this.wfInstApi.listAudits(bc.workflowInstance.id).subscribe((a) => this.caseAudits.set(a));
      }
    } else if (tab === 'logs') {
      this.opsApi.listErrors({ instanceId: this.id(), acknowledged: false }).subscribe((r) => this.errors.set(r.items));
    }
  }

  loadCase(caseId: string) {
    this.wfInstApi.aggregate(caseId).subscribe({
      next: (agg) => {
        this.boundCase.set(agg);
        this.caseDataText = JSON.stringify(agg.workflowInstance.data || {}, null, 2);
        if (this.tab() === 'case') {
          this.wfInstApi.listComments(caseId).subscribe((c) => this.caseComments.set(c));
          this.wfInstApi.listAudits(caseId).subscribe((a) => this.caseAudits.set(a));
        }
      },
      error: () => {},
    });
  }

  saveCaseData() {
    if (this.isCaseReadOnly()) { this.toast.error('Case is read-only'); return; }
    const bc = this.boundCase(); if (!bc) return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(this.caseDataText); } catch { this.caseDataError.set('Invalid JSON format'); return; }
    this.caseDataError.set('');
    this.wfInstApi.updateData(bc.workflowInstance.id, data).subscribe({
      next: (updated) => {
        this.toast.success('Case business data saved');
        this.boundCase.update((curr) => curr ? { ...curr, workflowInstance: updated } : null);
      },
      error: (e) => this.caseDataError.set(e?.error?.error?.message || 'Failed to save data'),
    });
  }

  async updateCaseStatus() {
    if (this.isCaseReadOnly()) { this.toast.error('Case is read-only'); return; }
    const bc = this.boundCase(); if (!bc) return;
    const next = await this.modal.prompt({ title: 'Update Case Status', message: 'Enter new case status:', initialValue: bc.workflowInstance.status });
    if (!next || !next.trim()) return;
    this.wfInstApi.updateStatus(bc.workflowInstance.id, next.trim()).subscribe({
      next: (updated) => {
        this.toast.success('Case status updated');
        this.boundCase.update((curr) => curr ? { ...curr, workflowInstance: updated } : null);
      },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Update failed'),
    });
  }

  addCaseComment() {
    if (this.isCaseReadOnly()) { this.toast.error('Comments are closed for finalized cases'); return; }
    const bc = this.boundCase(); if (!bc || !this.newCaseComment.trim()) return;
    this.wfInstApi.addComment(bc.workflowInstance.id, this.newCaseComment.trim()).subscribe({
      next: (c) => {
        this.caseComments.update((list) => [c, ...list]);
        this.newCaseComment = '';
        this.toast.success('Comment posted');
      },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Failed to post comment'),
    });
  }

  deleteCaseComment(c: WorkflowInstanceComment) {
    const bc = this.boundCase(); if (!bc) return;
    this.wfInstApi.deleteComment(bc.workflowInstance.id, c.id).subscribe({
      next: () => {
        this.caseComments.update((list) => list.filter((x) => x.id !== c.id));
        this.toast.success('Comment deleted');
      },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Failed to delete comment'),
    });
  }

  addCaseAudit() {
    const bc = this.boundCase(); if (!bc || !this.newCaseAuditKind.trim()) return;
    let data: Record<string, unknown> | undefined;
    if (this.newCaseAuditData.trim()) {
      try { data = JSON.parse(this.newCaseAuditData); } catch { this.toast.error('Audit data must be JSON'); return; }
    }
    this.wfInstApi.addAudit(bc.workflowInstance.id, this.newCaseAuditKind.trim(), data).subscribe({
      next: (a) => {
        this.caseAudits.update((list) => [a, ...list]);
        this.newCaseAuditKind = ''; this.newCaseAuditData = '';
        this.toast.success('Audit note recorded');
      },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Failed to add audit'),
    });
  }

  deleteCaseAudit(a: WorkflowInstanceAudit) {
    const bc = this.boundCase(); if (!bc) return;
    this.wfInstApi.deleteAudit(bc.workflowInstance.id, a.id).subscribe({
      next: () => {
        this.caseAudits.update((list) => list.filter((x) => x.id !== a.id));
        this.toast.success('Audit deleted');
      },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Failed to delete audit'),
    });
  }

  async decideCaseTask(t: Task) {
    const bc = this.boundCase(); if (!bc) return;
    const decision = await this.modal.prompt({ title: `Decision: ${t.name}`, message: 'Enter decision (or JSON outputs):', placeholder: 'approved' });
    if (!decision) return;
    let outputs: Record<string, unknown> = { decision };
    try { outputs = JSON.parse(decision); } catch {}
    this.wfInstApi.decision(bc.workflowInstance.id, t.id, outputs).subscribe({
      next: () => { this.toast.success('Decision recorded'); this.load(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Decision failed'),
    });
  }

  async delegateCaseTask(t: Task) {
    const bc = this.boundCase(); if (!bc) return;
    const users = await firstValueFrom(this.iamApi.listUsers()).catch(() => []);
    const activeUsernames = (users || []).filter((u) => u.active !== false).map((u) => u.username);
    const to = await this.modal.prompt({
      title: `Delegate: ${t.name}`,
      message: 'Type or select a registered user to delegate this case task to:',
      options: activeUsernames.length ? activeUsernames : undefined,
      placeholder: 'Type or select username...',
    });
    if (!to || !to.trim()) return;
    const target = to.trim();
    if (activeUsernames.length && !activeUsernames.includes(target)) {
      this.toast.error(`User "${target}" is not a registered active user`);
      return;
    }
    this.wfInstApi.delegate(bc.workflowInstance.id, target, t.id).subscribe({
      next: () => { this.toast.success(`Task delegated to ${target}`); this.load(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Delegate failed'),
    });
  }

  setTab(t: Tab) {
    this.tab.set(t);
    this.router.navigate([], { queryParams: { tab: t }, queryParamsHandling: 'merge', replaceUrl: true });
    this.ensureTabData(t);
  }
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
  isCircle(type: string): boolean { return this.nodeDims(type).w === 44; }
  isDiamond(type: string): boolean { return this.nodeDims(type).w === 52; }
  isRectangle(type: string): boolean { return this.nodeDims(type).w === 180; }
  gatewayMarker(n: any): string {
    const mode = n['mode'] || 'exclusive';
    if (mode === 'parallel') return '+';
    if (mode === 'inclusive') return '○';
    if (mode === 'event') return '⬠';
    return '✕';
  }
  isFlowTaken(e: any): boolean {
    const fromVisited = this.count(e.from) > 0;
    const toVisitedOrActive = this.count(e.to) > 0 || this.isActive(e.to);
    return fromVisited && toVisitedOrActive;
  }
  labeledBranches = computed(() => {
    const out: { edge: any; x: number; y: number; text: string }[] = [];
    const flows = this.graph().flows || [];
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
    const flows = this.graph().flows || [];
    for (const e of flows) {
      if (e.label || e.when) continue;
      const siblings = flows.filter((x: any) => x.from === e.from);
      if (siblings.length <= 1) continue;
      const b = this.byId(e.to); if (!b) continue;
      out.push({ edge: e, x: b.x - 26, y: b.y + this.nodeDims(b.type).h / 2 - 11, text: String(siblings.indexOf(e) + 1) });
    }
    return out;
  });

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
    for (const n of nodes) {
      const h = this.nodeDims(n.type).h;
      const yOffset = (56 - h) / 2;
      out.set(n.id, { x: 30 + col.get(n.id)! * COL_W, y: 30 + row.get(n.id)! * ROW_H + yOffset });
    }
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

  startEdit(name: string, raw: unknown) {
    if (!this.canEditVars()) return;
    this.editingVar.set(name);
    this.editValue = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
  }
  saveVar(name: string) {
    if (!this.canEditVars()) {
      this.toast.error(`Instance is ${this.inst()?.status}; variables cannot be edited`);
      return;
    }
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
