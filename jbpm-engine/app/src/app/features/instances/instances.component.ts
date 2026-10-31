import { processLabel } from '../../core/process-label';
import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SlicePipe } from '@angular/common';
import { InstanceApiService } from '../../core/api/instance-api.service';
import { DeploymentApiService } from '../../core/api/deployment-api.service';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { WorkflowDefinitionApiService } from '../../core/api/workflow-definition-api.service';
import { WorkflowInstanceApiService } from '../../core/api/workflow-instance-api.service';
import { SystemApiService } from '../../core/api/system-api.service';
import { ToastService } from '../../shared/toast.service';
import { ModalService } from '../../shared/modal.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import type { Deployment, Instance, SystemSettings, Workflow, WorkflowDefinition } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';

const STATUSES = ['running', 'waiting', 'suspended', 'failed', 'completed', 'aborted'] as const;
interface SavedFilter { name: string; stateSet: string[]; typeFilter: string; errorsOnly: boolean; q: string; qBy: string; projectFilter: string; isDefault?: boolean; }
const SAVED_KEY = 'instances.savedFilters';

export interface TableColumnDef {
  key: string;
  label: string;
  visible: boolean;
  mandatory?: boolean;
}

const DEFAULT_COLUMNS: TableColumnDef[] = [
  { key: 'select', label: 'Checkbox', visible: true, mandatory: true },
  { key: 'piid', label: 'PIID (Instance ID)', visible: true, mandatory: true },
  { key: 'caseId', label: 'Case ID', visible: false, mandatory: false }, // Hidden by default as requested!
  { key: 'process', label: 'Process & Project', visible: true, mandatory: false },
  { key: 'status', label: 'Status', visible: true, mandatory: true },
  { key: 'initiator', label: 'Initiator', visible: true, mandatory: false },
  { key: 'started', label: 'Started Time', visible: true, mandatory: false },
  { key: 'duration', label: 'Duration', visible: true, mandatory: false },
  { key: 'errors', label: 'Errors Count', visible: true, mandatory: false },
  { key: 'actions', label: 'Row Actions', visible: true, mandatory: true },
];

@Component({
  selector: 'app-instances',
  standalone: true,
  imports: [IconComponent, RouterLink, FormsModule, SlicePipe, BreadcrumbComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Instances' }]" /></div>
      <header class="pagehead">
        <div>
          <h1>Instances</h1>
          <p class="muted sub">Unified view of process executions and cases across the engine. Filterable by state, type, and variables.</p>
        </div>
        <span class="spacer"></span>
        <div class="col-picker-wrap">
          <button class="btn" (click)="toggleColPicker($event)" title="Customize visible table columns">
            <app-icon name="columns" [size]="14" /> Columns
          </button>
          @if (colPickerOpen()) {
            <div class="col-picker-menu" (click)="$event.stopPropagation()">
              <div class="col-picker-h">
                <span>Customize Columns</span>
                <button class="col-reset-btn" (click)="resetColumns()">Reset</button>
              </div>
              <div class="col-picker-list">
                @for (col of columns(); track col.key) {
                  <label class="col-picker-item" [class.disabled]="col.mandatory">
                    <input type="checkbox" [checked]="col.visible" [disabled]="col.mandatory" (change)="toggleCol(col.key)" />
                    <span>{{ col.label }}</span>
                    @if (col.mandatory) {
                      <span class="col-lock-tag">(Required)</span>
                    }
                  </label>
                }
              </div>
            </div>
          }
        </div>
        <button class="btn" (click)="reload()"><app-icon name="refresh" [size]="14" /> Refresh</button>
        @if (canCreateCase()) {
          <button class="btn" (click)="openStartCase()"><app-icon name="plus" [size]="13" /> New Case</button>
        }
        @if (canCreateProcess()) {
          <a class="btn primary" [routerLink]="['/instances/start']" [queryParams]="projectFilter() ? { workflowId: projectFilter() } : null"><app-icon name="play" [size]="14" /> New Process</a>
        }
      </header>

      <div class="layout">
        <!-- FILTER RAIL (ux_design/mockups/instances-list.html) — persistent, not a flyout. -->
        <button class="btn filter-toggle" (click)="railOpen.set(!railOpen())" [attr.aria-expanded]="railOpen()"><app-icon name="list" [size]="14" /> {{ railOpen() ? 'Hide filters' : 'Filters' }}</button>
        <aside class="rail card" [class.shown]="railOpen()">
          <div class="rail-h">
            <span class="section-title">Filters</span>
            <span class="spacer"></span>
            <button class="btn ghost sm" (click)="resetFilters()">Reset</button>
          </div>

          <div class="section-title">Instance Type</div>
          <div class="type-pills">
            <button class="tpill" [class.active]="typeFilter() === 'all'" (click)="setTypeFilter('all')">All ({{ instances().length }})</button>
            <button class="tpill" [class.active]="typeFilter() === 'cases'" (click)="setTypeFilter('cases')">Cases ({{ caseCount() }})</button>
            <button class="tpill" [class.active]="typeFilter() === 'process'" (click)="setTypeFilter('process')">Processes ({{ standaloneCount() }})</button>
          </div>

          <div class="section-title">State</div>
          @for (st of statuses; track st) {
            <label class="ck">
              <input type="checkbox" [checked]="stateSet().has(st)" (change)="toggleState(st)" />
              <span class="dot" [style.background]="statusColor(st)"></span>{{ st }}
              <span class="spacer"></span><span class="ct">{{ countByStatus()[st] || 0 }}</span>
            </label>
          }
          <label class="ck errs">
            <input type="checkbox" [checked]="errorsOnly()" (change)="errorsOnly.set(!errorsOnly()); reload()" />
            Has errors only
          </label>

          <div class="section-title">Filter by</div>
          <input class="rail-in" placeholder="PIID / Case ID / Key" [ngModel]="q()" (ngModelChange)="onSearchInput($event)" aria-label="Filter by id, case id or key" />
          <input class="rail-in" placeholder="Initiator" [ngModel]="qBy()" (ngModelChange)="onInitiatorInput($event)" aria-label="Filter by initiator" />

          <div class="section-title">Project</div>
          <select class="rail-in" [ngModel]="projectFilter()" (ngModelChange)="setProjectFilter($event)" aria-label="Filter by project">
            <option value="">All projects</option>
            @for (w of workflows(); track w.id) { <option [value]="w.id">{{ w.name }}</option> }
          </select>

          <div class="section-title">Saved filters</div>
          @if (savedFilters().length) {
            <div class="savedlist">
              @for (sf of savedFilters(); track sf.name) {
                <div class="savedrow">
                  <button class="lnkbtn" (click)="applySaved(sf)"><app-icon [name]="sf.isDefault ? 'success' : 'file'" [size]="12" /> {{ sf.name }}</button>
                  <button class="btn ghost sm" (click)="deleteSaved(sf.name)" title="Delete"><app-icon name="close" [size]="11" /></button>
                </div>
              }
            </div>
          } @else { <p class="muted sm">None yet.</p> }
          <button class="btn sm" style="width:100%; margin-top:6px;" (click)="saveCurrentFilter()">+ Save current filters</button>
        </aside>

        <!-- LIST -->
        <div class="listcol">
          @if (selectedIds().size) {
            <div class="bulkbar">
              <span><b>{{ selectedIds().size }}</b> selected</span>
              <button class="btn sm" (click)="bulkSuspend()">Suspend</button>
              <button class="btn sm" (click)="bulkResume()">Resume</button>
              <button class="btn sm danger" (click)="bulkAbort()">Abort</button>
              <span class="spacer"></span>
            </div>
          }
          <div class="list card" (scroll)="onTableScroll($event)">
            <table>
              <thead><tr>
                @if (isColVisible('select')) { <th style="width:36px;"></th> }
                @if (isColVisible('piid')) { <th style="width:120px;">PIID</th> }
                @if (isColVisible('caseId')) { <th style="width:130px;">Case ID</th> }
                @if (isColVisible('process')) { <th>Process &amp; Project</th> }
                @if (isColVisible('status')) { <th style="width:100px;">Status</th> }
                @if (isColVisible('initiator')) { <th style="width:120px;">Initiator</th> }
                @if (isColVisible('started')) { <th class="sortable" style="width:110px;" (click)="sortDesc.set(!sortDesc())">Started <span class="sort-ic">{{ sortDesc() ? '▼' : '▲' }}</span></th> }
                @if (isColVisible('duration')) { <th style="width:90px;">Duration</th> }
                @if (isColVisible('errors')) { <th style="width:60px;">Errors</th> }
                @if (isColVisible('actions')) { <th style="width:40px;"></th> }
              </tr></thead>
              <tbody>
                @for (i of paged(); track i.id) {
                  <tr [class.sel]="selectedIds().has(i.id)">
                    @if (isColVisible('select')) {
                      <td (click)="$event.stopPropagation()"><input type="checkbox" [checked]="selectedIds().has(i.id)" (change)="toggleSelect(i.id)" /></td>
                    }
                    @if (isColVisible('piid')) {
                      <td class="mono piid">
                        <a [routerLink]="['/instances', i.id]" [title]="i.id">{{ shortId(i.id) }}</a>
                      </td>
                    }
                    @if (isColVisible('caseId')) {
                      <td>
                        @if (i.caseInstanceId) {
                          <a class="case-chip" [routerLink]="['/instances', i.id]" [queryParams]="{tab: 'case'}" [title]="'Case ID: ' + i.caseInstanceId">
                            <app-icon name="inbox" [size]="11" /> {{ shortId(i.caseInstanceId) }}
                          </a>
                        } @else {
                          <span class="muted">—</span>
                        }
                      </td>
                    }
                    @if (isColVisible('process')) {
                      <td>
                        <a class="plain" [routerLink]="['/instances', i.id]">{{ procName(i) }}</a>
                        <div class="proj muted">
                          {{ projectName(i.workflowId) }}
                          @if (i.caseWorkflowName) {
                            · <span class="case-tag">{{ i.caseWorkflowName }}</span>
                          }
                        </div>
                      </td>
                    }
                    @if (isColVisible('status')) {
                      <td><span class="badge" [style.color]="statusColor(i.status)">{{ i.status }}</span></td>
                    }
                    @if (isColVisible('initiator')) {
                      <td>{{ i.startedBy || '—' }}</td>
                    }
                    @if (isColVisible('started')) {
                      <td class="muted">{{ ago(i.startedAt) }}</td>
                    }
                    @if (isColVisible('duration')) {
                      <td class="muted">{{ duration(i) }}</td>
                    }
                    @if (isColVisible('errors')) {
                      <td><span class="err-badge" [class.has]="i.status === 'failed'">{{ i.status === 'failed' ? 1 : 0 }}</span></td>
                    }
                    @if (isColVisible('actions')) {
                      <td class="menucell" (click)="$event.stopPropagation()">
                        <button class="kebab" (click)="openMenu($event, i.id)" aria-label="Row actions" aria-haspopup="menu"><app-icon name="more" [size]="15" /></button>
                      </td>
                    }
                  </tr>
                }
                @if (filtered().length === 0) {
                  <tr><td [attr.colspan]="visibleColumnCount()">
                    @if (hasFilters()) {
                      <div class="empty-state">
                        <div class="es-icon"><app-icon name="search" [size]="24" /></div>
                        <h3>No instances match these filters</h3>
                        <p>Loosen the state checkboxes or clear the text filters on the left.</p>
                        <button class="btn" (click)="resetFilters()">Reset filters</button>
                      </div>
                    } @else {
                      <div class="empty-state">
                        <div class="es-icon"><app-icon name="instances" [size]="24" /></div>
                        <h3>No instances yet</h3>
                        <p>Start a process or case instance to see it here.</p>
                        @if (canCreateCase()) { <button class="btn primary" (click)="openStartCase()">Start a Case</button> }
                      </div>
                    }
                  </td></tr>
                }
              </tbody>
            </table>

            <!-- Infinite scroll sentinel / loading bar -->
            @if (instances().length > 0) {
              <div class="infinite-bar">
                @if (loadingMore()) {
                  <span class="spinner-dot"></span>
                  <span class="muted">Loading more instances (showing {{ instances().length }} of {{ totalCount() }})…</span>
                } @else if (hasMore()) {
                  <button class="btn ghost sm" (click)="loadMore()">Load more (showing {{ instances().length }} of {{ totalCount() }})</button>
                } @else {
                  <span class="muted">Showing all {{ instances().length }} of {{ totalCount() }} instances</span>
                }
              </div>
            }
          </div>
        </div>
      </div>

      <!-- Kebab context menu -->
      @if (menuInstance(); as i) {
        <div class="rowmenu card" [style.top.px]="menuPos().top" [style.left.px]="menuPos().left" (click)="$event.stopPropagation()">
          <a class="mrow" [routerLink]="['/instances', i.id]" (click)="menuFor.set(null)"><app-icon name="instances" [size]="13" /> View details</a>
          @if (i.caseInstanceId) {
            <a class="mrow" [routerLink]="['/instances', i.id]" [queryParams]="{tab: 'case'}" (click)="menuFor.set(null)"><app-icon name="inbox" [size]="13" /> View case data</a>
          }
          <a class="mrow" [routerLink]="['/tasks']" [queryParams]="{instanceId: i.id}" (click)="menuFor.set(null)"><app-icon name="tasks" [size]="13" /> View tasks</a>
          <a class="mrow" [routerLink]="['/errors']" [queryParams]="{instanceId: i.id}" (click)="menuFor.set(null)"><app-icon name="warning" [size]="13" /> View errors</a>
          @if (i.status === 'running' || i.status === 'waiting' || i.status === 'suspended') {
            <button class="mrow" (click)="suspendResume(i); menuFor.set(null)">{{ i.status === 'suspended' ? 'Resume' : 'Suspend' }}</button>
          }
          @if (i.status !== 'completed' && i.status !== 'aborted') {
            <button class="mrow danger" (click)="abort(i); menuFor.set(null)">Abort</button>
          }
        </div>
      }

      <!-- Start Case Modal -->
      @if (startingCase(); as sc) {
        <div class="modal-bg" (click)="closeStartCase()">
          <div class="modal" (click)="$event.stopPropagation()">
            <div class="modal-h">
              <span>Start Case Instance</span>
              <span class="spacer"></span>
              <button class="x" (click)="closeStartCase()"><app-icon name="close" [size]="15" /></button>
            </div>
            <div class="modal-body">
              <label class="fld">
                <span>Workflow Definition (Case Type)</span>
                <select [(ngModel)]="sc.workflowName">
                  <option value="" disabled>Select a workflow definition...</option>
                  @for (wd of workflowDefinitions(); track wd.id) {
                    <option [value]="wd.name">{{ wd.name }}</option>
                  }
                </select>
              </label>
              <label class="fld">
                <span>Case Business Data (JSON)</span>
                <textarea rows="4" [(ngModel)]="sc.workflowData" placeholder='{"claimNumber": "CLM-9001", "claimant": "Jane Doe", "amount": 1500}'></textarea>
              </label>
              <label class="fld">
                <span>Process Variables (JSON, optional)</span>
                <textarea rows="3" [(ngModel)]="sc.variables" placeholder='{"priority": "high"}'></textarea>
              </label>
              @if (startCaseError()) { <p class="err">{{ startCaseError() }}</p> }
              <button class="btn primary full" [disabled]="startingCaseLoading()" (click)="submitStartCase()">
                {{ startingCaseLoading() ? 'Starting...' : 'Start Case Instance' }}
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .page { padding: 20px 24px; }
    .crumbwrap { margin-bottom: 10px; }
    .pagehead { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 4px; }
    h1 { font-size: 19px; margin: 0; }
    .sub { margin: 2px 0 14px; font-size: 13px; }
    .layout { display: grid; grid-template-columns: 260px 1fr; gap: 16px; align-items: start; }
    .rail { padding: 16px; position: sticky; top: 16px; }
    .rail-h { display: flex; align-items: center; margin-bottom: 2px; }
    .section-title { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 700; margin: 12px 0 6px; display: block; }
    
    .type-pills { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
    .tpill { text-align: left; background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; font-size: 12.5px; cursor: pointer; color: var(--text); }
    .tpill:hover { background: var(--surface-3); }
    .tpill.active { background: var(--primary); color: #fff; border-color: var(--primary); font-weight: 600; }

    .ck { display: flex; align-items: center; gap: 8px; font-size: 13px; padding: 4px 2px; cursor: pointer; text-transform: capitalize; }
    .ck .ct { font-size: var(--text-xs); color: var(--muted); font-variant-numeric: tabular-nums; }
    .ck.errs { margin-top: 6px; text-transform: none; }
    .rail-in { width: 100%; margin-bottom: 8px; }
    .savedlist { display: flex; flex-direction: column; gap: 2px; }
    .savedrow { display: flex; align-items: center; justify-content: space-between; gap: 4px; }
    .lnkbtn { border: none; background: none; text-align: left; cursor: pointer; font: inherit; color: var(--text-secondary); font-size: 12.5px; padding: 4px 0; flex: 1; display: flex; align-items: center; gap: 6px; }
    .lnkbtn:hover { color: var(--primary); }
    .listcol { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    .bulkbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--primary-50); border-radius: var(--radius-sm); font-size: 12.5px; }
    .btn.sm.danger { color: var(--red); border-color: var(--border-strong); } .btn.sm.danger:hover { background: var(--red-bg); }
    
    .list { overflow-x: auto; padding: 0; max-height: calc(100vh - 180px); overflow-y: auto; }
    .list table { width: 100%; border-collapse: collapse; min-width: 860px; }
    .list th, .list td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
    tbody tr:hover { background: var(--surface-2); } tr.sel td { background: var(--primary-50); }
    .filter-toggle { display: none; }
    @media (max-width: 900px) { .filter-toggle { display: inline-flex; align-items: center; gap: 6px; justify-self: start; } .rail:not(.shown) { display: none; } }
    .piid { white-space: nowrap; }
    .piid a, .plain { color: var(--primary); font-weight: 600; text-decoration: none; }
    .piid a:hover, .plain:hover { text-decoration: underline; }
    .case-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 12px; background: rgba(59,130,246,0.12); color: #2563eb; font-weight: 600; font-size: 11.5px; font-family: var(--font-mono); text-decoration: none; border: 1px solid rgba(59,130,246,0.25); }
    .case-chip:hover { background: rgba(59,130,246,0.2); }
    .case-tag { font-weight: 600; color: #2563eb; }
    .proj { font-size: 11.5px; margin-top: 2px; }
    .sortable { cursor: pointer; user-select: none; } .sortable:hover { color: var(--text); }
    .sort-ic { font-size: 9px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .mono { font-family: var(--font-mono); font-size: 12px; }
    .badge { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
    .err-badge { display: inline-grid; place-items: center; min-width: 22px; height: 20px; border-radius: 5px; background: var(--surface-2); color: var(--muted); font-size: 12px; }
    .err-badge.has { background: var(--red-bg); color: var(--red); font-weight: 700; }
    .menucell { position: relative; text-align: right; }
    .kebab { border: none; background: transparent; cursor: pointer; color: var(--muted); padding: 6px 8px; border-radius: var(--radius-xs); }
    .kebab:hover { background: var(--surface-3); }
    .rowmenu { position: fixed; width: 200px; z-index: 30; padding: 4px; box-shadow: var(--shadow-pop); }
    .mrow { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: none; background: none; padding: 8px 10px; font-size: 12.5px; cursor: pointer; border-radius: var(--radius-xs); color: inherit; text-decoration: none; font: inherit; }
    .mrow:hover { background: var(--surface-2); }
    .mrow.danger { color: var(--red); }
    
    .infinite-bar { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px; font-size: 12.5px; border-top: 1px solid var(--border); }
    .spinner-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); animation: pulse 1s infinite alternate; }
    @keyframes pulse { from { opacity: 0.3; transform: scale(0.8); } to { opacity: 1; transform: scale(1.2); } }
    
    .modal-bg { position: fixed; inset: 0; background: rgba(16,24,40,.4); display: grid; place-items: center; z-index: 50; }
    .modal { background: var(--surface); border-radius: 14px; width: 480px; max-width: 92vw; max-height: 86vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: var(--shadow-pop); }
    .modal-h { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--border); font-weight: 700; }
    .modal-h .x { border: none; background: transparent; font-size: 16px; cursor: pointer; color: var(--muted); }
    .modal-body { padding: 16px 18px; overflow: auto; }
    .fld { display: block; margin-bottom: 12px; } .fld span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; font-weight: 600; }
    .fld select, .fld input, .fld textarea { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 13px; font-family: inherit; background: var(--surface); color: inherit; }
    .fld textarea { font-family: var(--font-mono); font-size: 12px; }
    .btn.full { width: 100%; justify-content: center; margin-top: 6px; }
    .err { color: var(--red); font-size: 12px; margin: -4px 0 8px; }
    .empty-state { padding: 40px; text-align: center; }

    .col-picker-wrap { position: relative; }
    .col-picker-menu {
      position: absolute; top: calc(100% + 6px); right: 0; width: 240px;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 10px; box-shadow: var(--shadow-pop); z-index: 40;
      padding: 10px; display: flex; flex-direction: column; gap: 8px;
    }
    .col-picker-h {
      display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1px solid var(--border); padding-bottom: 6px;
      font-size: 12px; font-weight: 700;
    }
    .col-reset-btn {
      background: none; border: none; font-size: 11px; color: var(--primary);
      cursor: pointer; padding: 0;
    }
    .col-reset-btn:hover { text-decoration: underline; }
    .col-picker-list { display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow-y: auto; }
    .col-picker-item {
      display: flex; align-items: center; gap: 8px; font-size: 12px; cursor: pointer; user-select: none;
    }
    .col-picker-item.disabled { opacity: 0.6; cursor: not-allowed; }
    .col-lock-tag { font-size: 10px; color: var(--muted); margin-left: auto; }

    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
      .rail { position: static; width: 100%; }
      .page { padding: 12px 14px; }
      .pagehead { flex-direction: column; align-items: stretch; gap: 10px; }
      .pagehead .btn, .pagehead a.btn { align-self: flex-start; }
      .list { max-height: none; }
    }
  `],
})
export class InstancesComponent {
  private api = inject(InstanceApiService);
  private deploymentApi = inject(DeploymentApiService);
  private wfApi = inject(WorkflowApiService);
  private wfDefApi = inject(WorkflowDefinitionApiService);
  private wfInstApi = inject(WorkflowInstanceApiService);
  private systemApi = inject(SystemApiService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  systemSettings = signal<SystemSettings | null>(null);
  workflows = signal<Workflow[]>([]);
  workflowDefinitions = signal<WorkflowDefinition[]>([]);
  projectFilter = signal<string>(this.route.snapshot.queryParamMap.get('workflowId') || '');
  private wfNames = computed(() => new Map(this.workflows().map((w) => [w.id, w.name])));
  projectName(id: string) { return this.wfNames().get(id) || id; }

  selectedProject = computed(() => this.workflows().find((w) => w.id === this.projectFilter()));
  creationMode = computed(() => {
    const pMode = this.selectedProject()?.instanceCreationMode;
    if (pMode) return pMode;
    return this.systemSettings()?.instanceCreationMode || 'both';
  });
  canCreateProcess = computed(() => this.creationMode() === 'both' || this.creationMode() === 'process-only');
  canCreateCase = computed(() => this.creationMode() === 'both' || this.creationMode() === 'case-only');

  instances = signal<Instance[]>([]);
  totalCount = signal(0);
  loading = signal(true);
  loadingMore = signal(false);
  hasMore = signal(false);
  deployments = signal<Record<string, Deployment>>({});
  statuses = STATUSES;
  stateSet = signal<Set<string>>(new Set(STATUSES));
  typeFilter = signal<'all' | 'cases' | 'process'>('all');
  q = signal(''); qBy = signal('');
  errorsOnly = signal(false);
  sortDesc = signal(true);
  selectedIds = signal<Set<string>>(new Set());
  menuFor = signal<string | null>(null);
  menuPos = signal<{ top: number; left: number }>({ top: 0, left: 0 });
  menuInstance = computed(() => this.instances().find((i) => i.id === this.menuFor()));
  savedFilters = signal<SavedFilter[]>(this.loadSaved());

  startingCase = signal<{ workflowName: string; variables: string; workflowData: string } | null>(null);
  startCaseError = signal('');
  startingCaseLoading = signal(false);

  columns = signal<TableColumnDef[]>(this.loadColumns());
  colPickerOpen = signal(false);

  private loadColumns(): TableColumnDef[] {
    try {
      const raw = localStorage.getItem('instances.columns.v1');
      if (raw) {
        const saved: Record<string, boolean> = JSON.parse(raw);
        return DEFAULT_COLUMNS.map((col) => {
          if (col.mandatory) return { ...col, visible: true };
          return { ...col, visible: saved[col.key] !== undefined ? !!saved[col.key] : col.visible };
        });
      }
    } catch {
      // ignore
    }
    return DEFAULT_COLUMNS.map((c) => ({ ...c }));
  }

  private saveColumns(cols: TableColumnDef[]) {
    try {
      const record = Object.fromEntries(cols.map((c) => [c.key, c.visible]));
      localStorage.setItem('instances.columns.v1', JSON.stringify(record));
    } catch {
      // ignore
    }
  }

  isColVisible(key: string): boolean {
    const col = this.columns().find((c) => c.key === key);
    return col ? col.visible : true;
  }

  visibleColumnCount = computed(() => this.columns().filter((c) => c.visible).length);

  toggleColPicker(event: Event) {
    event.stopPropagation();
    this.colPickerOpen.set(!this.colPickerOpen());
  }

  toggleCol(key: string) {
    const next = this.columns().map((c) => {
      if (c.key === key && !c.mandatory) {
        return { ...c, visible: !c.visible };
      }
      return c;
    });
    this.columns.set(next);
    this.saveColumns(next);
  }

  resetColumns() {
    const reset = DEFAULT_COLUMNS.map((c) => ({ ...c }));
    this.columns.set(reset);
    this.saveColumns(reset);
  }

  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  @HostListener('document:click') closeMenu() {
    this.menuFor.set(null);
    this.colPickerOpen.set(false);
  }
  @HostListener('window:scroll') onWindowScroll() {
    const threshold = 250;
    const pos = window.innerHeight + window.scrollY;
    const max = document.documentElement.scrollHeight;
    if (pos >= max - threshold && this.hasMore() && !this.loading() && !this.loadingMore()) {
      this.loadMore();
    }
  }

  onTableScroll(e: Event) {
    const el = e.target as HTMLElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200 && this.hasMore() && !this.loading() && !this.loadingMore()) {
      this.loadMore();
    }
  }

  onSearchInput(val: string) {
    this.q.set(val);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.reload(), 300);
  }

  onInitiatorInput(val: string) {
    this.qBy.set(val);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.reload(), 300);
  }

  loadMore() {
    if (this.loadingMore() || !this.hasMore()) return;
    this.loadingMore.set(true);
    const workflowId = this.projectFilter() || undefined;
    const q = this.q().trim();
    const type = this.typeFilter();
    const status = this.stateSet().size === STATUSES.length ? undefined : [...this.stateSet()].join(',');
    const offset = this.instances().length;

    this.api.listInstancesPaged({
      workflowId,
      q,
      type: type !== 'all' ? type : undefined,
      status,
      limit: 25,
      offset,
    }).subscribe({
      next: (res) => {
        this.instances.update((current) => [...current, ...res.items]);
        this.totalCount.set(res.total);
        this.hasMore.set(res.hasMore);
        this.loadingMore.set(false);
      },
      error: () => this.loadingMore.set(false),
    });
  }

  openMenu(ev: Event, id: string) {
    const btn = ev.currentTarget as HTMLElement;
    const r = btn.getBoundingClientRect();
    this.menuPos.set({ top: r.bottom + 4, left: Math.max(8, r.right - 200) });
    this.menuFor.set(this.menuFor() === id ? null : id);
  }

  caseCount = computed(() => this.instances().filter((i) => !!i.caseInstanceId).length);
  standaloneCount = computed(() => this.instances().filter((i) => !i.caseInstanceId).length);

  filtered = computed(() => {
    const states = this.stateSet();
    const q = this.q().toLowerCase().trim();
    const by = this.qBy().toLowerCase().trim();
    const tf = this.typeFilter();
    const proj = this.projectFilter();

    const list = this.instances().filter((i) => {
      if (!states.has(i.status)) return false;
      if (this.errorsOnly() && i.status !== 'failed' && !i.error) return false;
      if (tf === 'cases' && !i.caseInstanceId) return false;
      if (tf === 'process' && !!i.caseInstanceId) return false;
      if (proj && i.workflowId !== proj && i.caseWorkflowName !== proj) return false;
      if (q) {
        const matchPiid = i.id.toLowerCase().includes(q);
        const matchKey = (i.correlationKey || '').toLowerCase().includes(q);
        const matchCaseId = (i.caseInstanceId || '').toLowerCase().includes(q);
        const matchCaseWf = (i.caseWorkflowName || '').toLowerCase().includes(q);
        const matchProc = (i.processId || '').toLowerCase().includes(q);
        if (!matchPiid && !matchKey && !matchCaseId && !matchCaseWf && !matchProc) return false;
      }
      if (by && !(i.startedBy || '').toLowerCase().includes(by)) return false;
      return true;
    });

    const dir = this.sortDesc() ? -1 : 1;
    return [...list].sort((a, b) => ((a.endedAt || a.startedAt) < (b.endedAt || b.startedAt) ? -dir : dir));
  });

  hasFilters = computed(() => this.stateSet().size < STATUSES.length || this.typeFilter() !== 'all' || this.errorsOnly() || !!this.q() || !!this.qBy());
  countByStatus = computed(() => {
    const out: Record<string, number> = {};
    for (const i of this.instances()) out[i.status] = (out[i.status] || 0) + 1;
    return out;
  });

  paged = computed(() => this.filtered());

  constructor() {
    this.systemApi.getSystemSettings().subscribe({ next: (s) => this.systemSettings.set(s), error: () => {} });
    this.wfApi.listWorkflows().subscribe((ws) => this.workflows.set(ws));
    this.wfDefApi.list().subscribe((defs) => this.workflowDefinitions.set(defs));
    this.reload();
    const def = this.savedFilters().find((sf) => sf.isDefault);
    if (def) this.applySaved(def);
  }

  railOpen = signal(false);

  reload() {
    this.loading.set(true);
    const workflowId = this.projectFilter() || undefined;
    const q = this.q().trim();
    const type = this.typeFilter();
    const status = this.stateSet().size === STATUSES.length ? undefined : [...this.stateSet()].join(',');

    this.api.listInstancesPaged({
      workflowId,
      q,
      type: type !== 'all' ? type : undefined,
      status,
      limit: 25,
      offset: 0,
    }).subscribe({
      next: (res) => {
        this.instances.set(res.items);
        this.totalCount.set(res.total);
        this.hasMore.set(res.hasMore);
        this.loading.set(false);
      },
      error: (e) => { this.loading.set(false); this.toast.error(e?.error?.error?.message || 'Could not load instances'); },
    });

    this.deploymentApi.listDeploymentsGlobal({ workflowId }).subscribe((ds) => this.deployments.set(Object.fromEntries(ds.map((d) => [d.id, d]))));
    this.wfDefApi.list().subscribe((defs) => this.workflowDefinitions.set(defs));
  }

  setProjectFilter(id: string) {
    this.projectFilter.set(id);
    this.reload();
  }

  setTypeFilter(type: 'all' | 'cases' | 'process') {
    this.typeFilter.set(type);
    this.reload();
  }

  toggleState(st: string) {
    const next = new Set(this.stateSet());
    next.has(st) ? next.delete(st) : next.add(st);
    this.stateSet.set(next);
    this.reload();
  }

  resetFilters() {
    this.stateSet.set(new Set(STATUSES));
    this.typeFilter.set('all');
    this.q.set(''); this.qBy.set(''); this.errorsOnly.set(false);
    this.reload();
  }

  toggleSelect(id: string) {
    const s = new Set(this.selectedIds());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.selectedIds.set(s);
  }
  private selectedInstances(): Instance[] { const ids = this.selectedIds(); return this.instances().filter((i) => ids.has(i.id)); }

  private onActionError(e: any) { this.toast.error(e?.error?.error?.message || 'That action could not be completed'); }

  suspendResume(i: Instance) {
    const resuming = i.status === 'suspended';
    (resuming ? this.api.resumeInstance(i.id) : this.api.suspendInstance(i.id)).subscribe({
      next: () => { this.toast.success(resuming ? 'Instance resumed' : 'Instance suspended'); this.reload(); },
      error: (e) => this.onActionError(e),
    });
  }

  async abort(i: Instance) {
    const ok = await this.modal.confirm({ title: 'Abort instance', message: `Abort instance #${this.shortId(i.id)}? This also aborts any active sub-process instances.`, confirmLabel: 'Abort', danger: true });
    if (!ok) return;
    this.api.abort(i.id).subscribe({ next: () => this.reload(), error: (e) => this.onActionError(e) });
  }

  private bulkResult(label: string, results: { ok: boolean }[]) {
    const ok = results.filter((r) => r.ok).length;
    this.toast[ok === results.length ? 'success' : 'error'](`${label}: ${ok} of ${results.length} succeeded`);
    this.selectedIds.set(new Set());
    this.reload();
  }

  bulkSuspend() {
    const items = this.selectedInstances().filter((i) => i.status === 'running' || i.status === 'waiting');
    Promise.all(items.map((i) => new Promise<{ ok: boolean }>((res) => this.api.suspendInstance(i.id).subscribe({ next: () => res({ ok: true }), error: () => res({ ok: false }) }))))
      .then((r) => this.bulkResult('Suspend', r));
  }

  bulkResume() {
    const items = this.selectedInstances().filter((i) => i.status === 'suspended');
    Promise.all(items.map((i) => new Promise<{ ok: boolean }>((res) => this.api.resumeInstance(i.id).subscribe({ next: () => res({ ok: true }), error: () => res({ ok: false }) }))))
      .then((r) => this.bulkResult('Resume', r));
  }

  async bulkAbort() {
    const items = this.selectedInstances().filter((i) => i.status !== 'completed' && i.status !== 'aborted');
    if (!items.length) { this.toast.error('None of the selected instances can be aborted (already completed/aborted).'); return; }
    const ok = await this.modal.confirm({ title: 'Abort instances', message: `Abort ${items.length} selected instance(s)? This cannot be undone.`, confirmLabel: 'Abort all', danger: true });
    if (!ok) return;
    Promise.all(items.map((i) => new Promise<{ ok: boolean }>((res) => this.api.abort(i.id).subscribe({ next: () => res({ ok: true }), error: () => res({ ok: false }) }))))
      .then((r) => this.bulkResult('Abort', r));
  }

  openStartCase() {
    this.startCaseError.set('');
    const firstDef = this.workflowDefinitions()[0]?.name || '';
    this.startingCase.set({ workflowName: firstDef, variables: '{}', workflowData: '{}' });
  }
  closeStartCase() { this.startingCase.set(null); }
  submitStartCase() {
    const s = this.startingCase(); if (!s) return;
    if (!s.workflowName.trim()) { this.startCaseError.set('Workflow Definition is required'); return; }
    let variables: Record<string, unknown>, workflowData: Record<string, unknown>;
    try { variables = s.variables.trim() ? JSON.parse(s.variables) : {}; }
    catch { this.startCaseError.set('Variables must be valid JSON'); return; }
    try { workflowData = s.workflowData.trim() ? JSON.parse(s.workflowData) : {}; }
    catch { this.startCaseError.set('Case business data must be valid JSON'); return; }

    this.startingCaseLoading.set(true);
    this.wfInstApi.create({ workflowName: s.workflowName.trim(), variables, workflowData }).subscribe({
      next: (w) => {
        this.startingCaseLoading.set(false);
        this.toast.success('Case started successfully');
        this.closeStartCase();
        this.reload();
        if (w.piid) {
          this.router.navigate(['/instances', w.piid]);
        }
      },
      error: (e) => {
        this.startingCaseLoading.set(false);
        this.startCaseError.set(e?.error?.error?.message || 'Failed to start case');
      },
    });
  }

  private loadSaved(): SavedFilter[] {
    try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch { return []; }
  }
  private persistSaved() { localStorage.setItem(SAVED_KEY, JSON.stringify(this.savedFilters())); }
  async saveCurrentFilter() {
    const name = await this.modal.prompt({ title: 'Save filter', message: 'Name this filter set:', placeholder: 'e.g. My cases, active' });
    if (!name) return;
    const sf: SavedFilter = { name, stateSet: [...this.stateSet()], typeFilter: this.typeFilter(), errorsOnly: this.errorsOnly(), q: this.q(), qBy: this.qBy(), projectFilter: this.projectFilter() };
    this.savedFilters.update((list) => [...list.filter((x) => x.name !== name), sf]);
    this.persistSaved();
  }
  applySaved(sf: SavedFilter) {
    this.stateSet.set(new Set(sf.stateSet));
    if (sf.typeFilter) this.typeFilter.set(sf.typeFilter as any);
    this.errorsOnly.set(sf.errorsOnly);
    this.q.set(sf.q); this.qBy.set(sf.qBy); this.projectFilter.set(sf.projectFilter);
    this.reload();
  }
  deleteSaved(name: string) {
    this.savedFilters.update((list) => list.filter((x) => x.name !== name));
    this.persistSaved();
  }

  statusColor(s: string) { return ({ running: '#2563eb', waiting: '#f59e0b', completed: '#16a34a', failed: '#dc2626', aborted: '#6b7280', suspended: '#7c3aed' } as any)[s] || '#6b7280'; }
  procName(i: Instance) { return processLabel(i.processId, i.workflowId); }
  /** Tail of a ULID: the first 8 chars are the ms timestamp, so same-batch ids front-slice
   *  identically (three rows all reading "01KZBZ4N" on the live list). The random part is the END. */
  shortId(id: string) { return id.length > 10 ? '…' + id.slice(-7) : id; }
  ago(iso: string): string {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86_400)}d ago`;
  }
  duration(i: Instance): string {
    const end = i.endedAt ? Date.parse(i.endedAt) : Date.now();
    const ms = Math.max(0, end - Date.parse(i.startedAt));
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `${d}d ${h % 24}h`;
  }
}
