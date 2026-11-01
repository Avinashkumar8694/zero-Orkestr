import { Component, HostListener, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, ActivatedRoute, RouterLink } from '@angular/router';
import { IconComponent } from '../../shared/icon.component';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { ToastService } from '../../shared/toast.service';
import { InstanceApiService } from '../../core/api/instance-api.service';
import { TaskApiService } from '../../core/api/task-api.service';
import { WorkflowInstanceApiService } from '../../core/api/workflow-instance-api.service';
import { OpsApiService } from '../../core/api/ops-api.service';
import { QueryApiService } from '../../core/api/query-api.service';
import { AuthService } from '../../core/auth/auth.service';
import type { Instance, Task, WorkflowInstance, AuditEvent, ProcessDef } from '../../core/models';

type ReportTab = 'executions' | 'sla' | 'cases' | 'audit' | 'adhoc';
type TimeWindow = '1d' | '7d' | '30d' | '90d' | 'all' | 'custom';

function humanMs(ms: number): string {
  if (ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, IconComponent, BreadcrumbComponent],
  template: `
    <div class="page">
      <header class="pagehead">
        <div>
          <app-breadcrumb [crumbs]="[{ label: 'Operational Reports & Exports' }, { label: tabLabel() }]" />
          <h1>Operational Reports &amp; Exports</h1>
          <p class="muted head-sub">Generate, filter, audit, and export operational execution records, task SLA breaches, case histories, and custom query reports.</p>
        </div>
        <div class="head-actions">
          <button class="btn sm" (click)="refreshCurrentTab()" [disabled]="loading()">
            <app-icon name="refresh" [size]="14" /> Refresh
          </button>
          <button class="btn sm" (click)="exportJson()" [disabled]="loading() || isCurrentEmpty()">
            <app-icon name="code" [size]="14" /> Export JSON
          </button>
          <button class="btn sm primary" (click)="exportCsv()" [disabled]="loading() || isCurrentEmpty()">
            <app-icon name="download" [size]="14" /> Export CSV
          </button>
        </div>
      </header>

      <!-- Global Filter Bar -->
      <div class="filter-bar card">
        <div class="filter-row">
          <div class="filter-group">
            <span class="f-label">Time Window:</span>
            <div class="pills">
              <button class="pill" [class.active]="timeWindow() === 'all'" (click)="setTimeWindow('all')">All Time</button>
              <button class="pill" [class.active]="timeWindow() === '1d'" (click)="setTimeWindow('1d')">Today (24h)</button>
              <button class="pill" [class.active]="timeWindow() === '7d'" (click)="setTimeWindow('7d')">Last 7D</button>
              <button class="pill" [class.active]="timeWindow() === '30d'" (click)="setTimeWindow('30d')">Last 30D</button>
              <button class="pill" [class.active]="timeWindow() === '90d'" (click)="setTimeWindow('90d')">Last 90D</button>
              <button class="pill" [class.active]="timeWindow() === 'custom'" (click)="timeWindow.set('custom')">Custom</button>
            </div>
          </div>

          <div class="filter-group date-range-group">
            <span class="f-label"><app-icon name="calendar" [size]="13" /> Date Range:</span>
            <div class="date-inputs">
              <input type="date" [ngModel]="customFrom()" (ngModelChange)="onFromChange($event)" placeholder="Start Date" />
              <span class="to-sep">→</span>
              <input type="date" [ngModel]="customTo()" (ngModelChange)="onToChange($event)" placeholder="End Date" />
              <button class="btn sm primary" (click)="applyCustomDateRange()" [disabled]="!customFrom() && !customTo()">Apply</button>
              @if (customFrom() || customTo()) {
                <button class="btn sm ghost" (click)="clearCustomDateRange()" title="Reset to All Time">✕</button>
              }
            </div>
            @if (isDateFiltered()) {
              <span class="range-badge"><app-icon name="calendar" [size]="11" /> {{ dateRangeLabel() }}</span>
            }
          </div>
        </div>

        <div class="filter-row sub-filter-row">
          <div class="filter-group">
            <span class="f-label">Search:</span>
            <div class="searchbox">
              <app-icon name="search" [size]="13" />
              <input type="text" [(ngModel)]="searchQuery" placeholder="Filter by ID, name, initiator, or keyword..." />
              @if (searchQuery) {
                <button class="clear-search" (click)="searchQuery = ''">✕</button>
              }
            </div>
          </div>

          @if (tab() === 'executions' || tab() === 'cases') {
            <div class="filter-group">
              <span class="f-label">Process Scope:</span>
              <select [(ngModel)]="selectedProcess" (change)="onFilterChange()">
                <option value="">All Process Definitions</option>
                @for (p of availableProcesses(); track p) {
                  <option [value]="p">{{ p }}</option>
                }
              </select>
            </div>

            <div class="filter-group">
              <span class="f-label">Status:</span>
              <select [(ngModel)]="statusFilter" (change)="onFilterChange()">
                <option value="all">All Statuses</option>
                <option value="running">Running</option>
                <option value="waiting">Waiting (User Task / Timer)</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed / Error</option>
                <option value="aborted">Aborted</option>
                <option value="suspended">Suspended</option>
              </select>
            </div>
          }

          @if (tab() === 'sla') {
            <div class="filter-group">
              <span class="f-label">SLA Scope:</span>
              <div class="pills">
                <button class="pill" [class.active]="slaFilter === 'all'" (click)="slaFilter = 'all'">All Open ({{ filteredSlaTasks().length }})</button>
                <button class="pill red" [class.active]="slaFilter === 'overdue'" (click)="slaFilter = 'overdue'">Overdue Only ({{ countOverdue() }})</button>
                <button class="pill amber" [class.active]="slaFilter === 'at-risk'" (click)="slaFilter = 'at-risk'">At Risk (&gt;80% SLA)</button>
              </div>
            </div>
          }
        </div>
      </div>

      <!-- Navigation Tabs -->
      <nav class="tabs" role="tablist">
        <button role="tab" [class.active]="tab() === 'executions'" (click)="setTab('executions')">
          <app-icon name="instances" [size]="14" /> Process Executions
          <span class="tab-count">{{ filteredExecutions().length }}</span>
        </button>
        <button role="tab" [class.active]="tab() === 'sla'" (click)="setTab('sla')">
          <app-icon name="clock" [size]="14" /> Task SLA Breaches
          <span class="tab-count" [class.red-badge]="countOverdue() > 0">{{ countOverdue() }}</span>
        </button>
        <button role="tab" [class.active]="tab() === 'cases'" (click)="setTab('cases')">
          <app-icon name="inbox" [size]="14" /> Case Resolutions
          <span class="tab-count">{{ filteredCases().length }}</span>
        </button>
        <button role="tab" [class.active]="tab() === 'audit'" (click)="setTab('audit')">
          <app-icon name="shield" [size]="14" /> System Audit Trail
          <span class="tab-count">{{ filteredAudits().length }}</span>
        </button>
        <button role="tab" [class.active]="tab() === 'adhoc'" (click)="setTab('adhoc')">
          <app-icon name="search" [size]="14" /> Ad-Hoc Report Builder
        </button>
      </nav>

      <!-- Content Area -->
      @if (loading()) {
        <div class="card pad skeleton-card">
          <div class="skeleton-line" style="width: 40%; height: 20px; margin-bottom: 12px;"></div>
          <div class="skeleton-line" style="width: 100%; height: 350px;"></div>
        </div>
      } @else {
        <!-- ======================= Tab 1: Process Executions ======================= -->
        @if (tab() === 'executions') {
          <section class="card tablecard">
            <div class="card-head">
              <div class="card-title">
                <span>Process Instance Executions Report</span>
                <span class="badge">{{ filteredExecutions().length }} records</span>
              </div>
              <span class="muted sm">Showing process runs within selected date range and filters</span>
            </div>

            @if (filteredExecutions().length) {
              <div class="table-wrap" (scroll)="onExecScroll($event)">
                <table class="report-table">
                  <thead>
                    <tr>
                      <th>Instance ID</th>
                      <th>Process Definition</th>
                      <th>Status</th>
                      <th>Initiator</th>
                      <th>Started At</th>
                      <th>Ended At</th>
                      <th>Duration</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (row of pagedExecutions(); track row.id) {
                      <tr>
                        <td class="mono">
                          <a class="lnk" [routerLink]="['/instances', row.id]">#{{ shortId(row.id) }}</a>
                        </td>
                        <td>
                          <div class="proc-cell">
                            <span class="bold">{{ procName(row) }}</span>
                            @if (row.correlationKey) {
                              <span class="sub-meta mono">Key: {{ row.correlationKey }}</span>
                            }
                          </div>
                        </td>
                        <td>
                          <span class="status-pill sm" [style.color]="statusColor(row.status)" [style.background]="statusColor(row.status) + '18'">
                            ● {{ row.status }}
                          </span>
                        </td>
                        <td>{{ row.startedBy || 'system' }}</td>
                        <td class="mono sm">{{ row.startedAt | slice:0:19 }}</td>
                        <td class="mono sm">{{ row.endedAt ? (row.endedAt | slice:0:19) : '—' }}</td>
                        <td class="mono sm bold">{{ calcDuration(row.startedAt, row.endedAt) }}</td>
                        <td>
                          <a class="btn sm" [routerLink]="['/instances', row.id]">Open</a>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>

              <!-- Pagination Footer -->
              <div class="table-footer">
                <span class="muted sm">Showing {{ (page() - 1) * pageSize + 1 }} - {{ minVal(page() * pageSize, filteredExecutions().length) }} of {{ filteredExecutions().length }}</span>
                <div class="page-btns">
                  <button class="btn sm" [disabled]="page() <= 1" (click)="page.set(page() - 1)">Previous</button>
                  <span class="page-indicator">{{ page() }} / {{ maxPages(filteredExecutions().length) }}</span>
                  <button class="btn sm" [disabled]="page() >= maxPages(filteredExecutions().length)" (click)="page.set(page() + 1)">Next</button>
                </div>
              </div>
            } @else {
              <div class="empty-state">
                <app-icon name="instances" [size]="24" />
                <h3>No process executions found</h3>
                <p>No instances match the active time window, process definition, or search filters.</p>
              </div>
            }
          </section>
        }

        <!-- ======================= Tab 2: Task SLA Breaches ======================= -->
        @if (tab() === 'sla') {
          <section class="card tablecard">
            <div class="card-head">
              <div class="card-title">
                <span>Task SLA Breaches &amp; Overdue Report</span>
                <span class="badge" [class.red]="countOverdue() > 0">{{ countOverdue() }} Overdue</span>
              </div>
              <span class="muted sm">Audit open human tasks for compliance, SLA breaches, and delays</span>
            </div>

            @if (filteredSlaTasks().length) {
              <div class="table-wrap" (scroll)="onSlaScroll($event)">
                <table class="report-table">
                  <thead>
                    <tr>
                      <th>Task Name</th>
                      <th>Process / Instance</th>
                      <th>Priority</th>
                      <th>Assignee</th>
                      <th>Candidate Groups</th>
                      <th>Created At</th>
                      <th>Due Date</th>
                      <th>SLA Status / Delay</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (t of pagedSlaTasks(); track t.id) {
                      <tr [class.breached-row]="isOverdue(t)">
                        <td>
                          <div class="proc-cell">
                            <span class="bold">{{ t.name }}</span>
                            <span class="sub-meta mono">#{{ shortId(t.id) }}</span>
                          </div>
                        </td>
                        <td>
                          <a class="lnk mono" [routerLink]="['/instances', t.instanceId]">#{{ shortId(t.instanceId) }}</a>
                        </td>
                        <td>
                          <span class="prio-pill" [class.urgent]="(t.priority ?? 50) < 30" [class.high]="(t.priority ?? 50) < 50">
                            P{{ t.priority ?? 50 }}
                          </span>
                        </td>
                        <td>{{ t.assignee || 'Unassigned' }}</td>
                        <td class="muted sm">{{ t.group || '—' }}</td>
                        <td class="mono sm">{{ t.createdAt | slice:0:19 }}</td>
                        <td class="mono sm">{{ t.dueAt ? (t.dueAt | slice:0:19) : 'No SLA set' }}</td>
                        <td>
                          @if (isOverdue(t)) {
                            <span class="sla-badge breached">
                              <app-icon name="warning" [size]="12" /> Overdue {{ overdueDelay(t.dueAt!) }}
                            </span>
                          } @else if (t.dueAt) {
                            <span class="sla-badge on-track">
                              <app-icon name="clock" [size]="12" /> Due in {{ remainingTime(t.dueAt) }}
                            </span>
                          } @else {
                            <span class="muted sm">None</span>
                          }
                        </td>
                        <td>
                          <a class="btn sm" [routerLink]="['/tasks', t.id]">Open</a>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>

              <div class="table-footer">
                <span class="muted sm">Showing {{ (slaPage() - 1) * pageSize + 1 }} - {{ minVal(slaPage() * pageSize, filteredSlaTasks().length) }} of {{ filteredSlaTasks().length }}</span>
                <div class="page-btns">
                  <button class="btn sm" [disabled]="slaPage() <= 1" (click)="slaPage.set(slaPage() - 1)">Previous</button>
                  <span class="page-indicator">{{ slaPage() }} / {{ maxPages(filteredSlaTasks().length) }}</span>
                  <button class="btn sm" [disabled]="slaPage() >= maxPages(filteredSlaTasks().length)" (click)="slaPage.set(slaPage() + 1)">Next</button>
                </div>
              </div>
            } @else {
              <div class="empty-state">
                <app-icon name="check" [size]="24" />
                <h3>No task SLA breaches found</h3>
                <p>All open tasks are currently within their SLA thresholds.</p>
              </div>
            }
          </section>
        }

        <!-- ======================= Tab 3: Case Resolutions ======================= -->
        @if (tab() === 'cases') {
          <section class="card tablecard">
            <div class="card-head">
              <div class="card-title">
                <span>Case Resolutions &amp; Turnaround Report</span>
                <span class="badge">{{ filteredCases().length }} cases</span>
              </div>
              <span class="muted sm">Detailed resolution lifecycle and duration audit per case instance</span>
            </div>

            @if (filteredCases().length) {
              <div class="table-wrap" (scroll)="onCaseScroll($event)">
                <table class="report-table">
                  <thead>
                    <tr>
                      <th>Case ID</th>
                      <th>Case Workflow</th>
                      <th>Status</th>
                      <th>Initiator</th>
                      <th>Started At</th>
                      <th>Completed At</th>
                      <th>Resolution Time</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (c of pagedCases(); track c.id) {
                      <tr>
                        <td class="mono">
                          <a class="lnk" [routerLink]="['/instances', c.piid || c.id]">#{{ shortId(c.id) }}</a>
                        </td>
                        <td>
                          <div class="proc-cell">
                            <span class="bold">{{ c.workflowName || c.workflowDefinitionId }}</span>
                            @if (c.piid) {
                              <span class="sub-meta mono">Process: #{{ shortId(c.piid) }}</span>
                            }
                          </div>
                        </td>
                        <td>
                          <span class="status-pill sm" [style.color]="statusColor(c.status)" [style.background]="statusColor(c.status) + '18'">
                            ● {{ c.status }}
                          </span>
                        </td>
                        <td>{{ c.createdBy || 'system' }}</td>
                        <td class="mono sm">{{ c.createdAt | slice:0:19 }}</td>
                        <td class="mono sm">{{ c.status === 'completed' ? (c.updatedAt | slice:0:19) : '—' }}</td>
                        <td class="mono sm bold">{{ calcDuration(c.createdAt, c.status === 'completed' ? c.updatedAt : undefined) }}</td>
                        <td>
                          <a class="btn sm" [routerLink]="['/instances', c.piid || c.id]">View</a>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>

              <div class="table-footer">
                <span class="muted sm">Showing {{ (casePage() - 1) * pageSize + 1 }} - {{ minVal(casePage() * pageSize, filteredCases().length) }} of {{ filteredCases().length }}</span>
                <div class="page-btns">
                  <button class="btn sm" [disabled]="casePage() <= 1" (click)="casePage.set(casePage() - 1)">Previous</button>
                  <span class="page-indicator">{{ casePage() }} / {{ maxPages(filteredCases().length) }}</span>
                  <button class="btn sm" [disabled]="casePage() >= maxPages(filteredCases().length)" (click)="casePage.set(casePage() + 1)">Next</button>
                </div>
              </div>
            } @else {
              <div class="empty-state">
                <app-icon name="inbox" [size]="24" />
                <h3>No case records found</h3>
                <p>No cases match the selected filter criteria.</p>
              </div>
            }
          </section>
        }

        <!-- ======================= Tab 4: System Audit Trail ======================= -->
        @if (tab() === 'audit') {
          <section class="card tablecard">
            <div class="card-head">
              <div class="card-title">
                <span>Compliance &amp; System Audit Trail</span>
                <span class="badge">{{ filteredAudits().length }} audit logs</span>
              </div>
              <span class="muted sm">Immutable security and operational event trail</span>
            </div>

            @if (filteredAudits().length) {
              <div class="table-wrap" (scroll)="onAuditScroll($event)">
                <table class="report-table">
                  <thead>
                    <tr>
                      <th>Timestamp</th>
                      <th>Actor</th>
                      <th>Action Kind</th>
                      <th>Entity ID</th>
                      <th>Payload Summary</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (a of pagedAudits(); track a.id) {
                      <tr>
                        <td class="mono sm">{{ a.at | slice:0:19 }}</td>
                        <td><b>{{ a.actor }}</b></td>
                        <td>
                          <span class="badge action-badge">{{ a.kind }}</span>
                        </td>
                        <td class="mono sm">{{ (a.instanceId || a.taskId || a.workflowId) ? '#' + shortId((a.instanceId || a.taskId || a.workflowId)!) : '—' }}</td>
                        <td class="mono sm muted audit-payload">{{ formatAuditData(a.data) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>

              <div class="table-footer">
                <span class="muted sm">Showing {{ (auditPage() - 1) * pageSize + 1 }} - {{ minVal(auditPage() * pageSize, filteredAudits().length) }} of {{ filteredAudits().length }}</span>
                <div class="page-btns">
                  <button class="btn sm" [disabled]="auditPage() <= 1" (click)="auditPage.set(auditPage() - 1)">Previous</button>
                  <span class="page-indicator">{{ auditPage() }} / {{ maxPages(filteredAudits().length) }}</span>
                  <button class="btn sm" [disabled]="auditPage() >= maxPages(filteredAudits().length)" (click)="auditPage.set(auditPage() + 1)">Next</button>
                </div>
              </div>
            } @else {
              <div class="empty-state">
                <app-icon name="shield" [size]="24" />
                <h3>No audit events found</h3>
                <p>No audit trail records match the search or date criteria.</p>
              </div>
            }
          </section>
        }

        <!-- ======================= Tab 5: Ad-Hoc Report Builder ======================= -->
        @if (tab() === 'adhoc') {
          <section class="card pad query-builder-card">
            <div class="card-head">
              <div class="card-title">
                <span>Ad-Hoc Report Engine &amp; Query Builder</span>
              </div>
              <span class="muted sm">Build custom operational reports with multidimensional grouping and aggregation</span>
            </div>

            <div class="adhoc-controls">
              <div class="control-box">
                <label>1. Select Primary Entity:</label>
                <select [(ngModel)]="adhocEntity" (change)="runAdhocQuery()">
                  <option value="instances">Process Instances</option>
                  <option value="tasks">Human Tasks</option>
                  <option value="cases">Case Instances</option>
                  <option value="audit">Audit Log Events</option>
                </select>
              </div>

              <div class="control-box">
                <label>2. Group Results By:</label>
                <select [(ngModel)]="adhocGroupBy" (change)="runAdhocQuery()">
                  <option value="status">Status</option>
                  <option value="name">Process / Definition Name</option>
                  <option value="actor">Initiator / Assignee</option>
                  <option value="day">Day (YYYY-MM-DD)</option>
                </select>
              </div>

              <div class="control-box">
                <label>3. Metric Aggregation:</label>
                <select [(ngModel)]="adhocMetric" (change)="runAdhocQuery()">
                  <option value="count">Record Count</option>
                  <option value="duration">Average Duration (ms)</option>
                  <option value="failure">Failure Rate (%)</option>
                </select>
              </div>

              <div class="control-box run-box">
                <button class="btn primary" (click)="runAdhocQuery()">
                  <app-icon name="play" [size]="14" /> Execute Query
                </button>
              </div>
            </div>

            @if (adhocResults.length) {
              <div class="adhoc-results">
                <div class="card-title" style="margin: 16px 0 8px;">
                  <span>Aggregated Query Output</span>
                  <span class="badge">{{ adhocResults.length }} groups</span>
                </div>

                <div class="table-wrap">
                  <table class="report-table">
                    <thead>
                      <tr>
                        <th>Group Key ({{ adhocGroupBy | uppercase }})</th>
                        <th>Total Volume</th>
                        <th>Percentage Share</th>
                        <th>Calculated Metric</th>
                      </tr>
                    </thead>
                    <tbody>
                      @for (row of adhocResults; track row.group) {
                        <tr>
                          <td><b>{{ row.group }}</b></td>
                          <td class="bold">{{ row.count }}</td>
                          <td>
                            <div class="share-cell">
                              <div class="share-bar-wrap">
                                <div class="share-bar" [style.width.%]="row.share"></div>
                              </div>
                              <span class="mono sm">{{ row.share }}%</span>
                            </div>
                          </td>
                          <td class="mono bold text-primary">{{ row.metricDisplay }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                </div>
              </div>
            } @else {
              <div class="empty-state" style="margin-top: 20px;">
                <app-icon name="search" [size]="24" />
                <h3>Ready to execute ad-hoc report</h3>
                <p>Select your desired entity and grouping criteria above and click Execute Query.</p>
              </div>
            }
          </section>
        }
      }
    </div>
  `,
  styles: [`
    :host { display: block; }
    .page { padding: 12px 14px; max-width: 1400px; margin: 0 auto; }
    .pagehead { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px; flex-wrap: wrap; }
    h1 { font-size: 22px; margin: 4px 0 6px; font-weight: 700; }
    .head-sub { margin: 0; font-size: 13.5px; max-width: 680px; }
    .head-actions { display: flex; gap: 8px; align-items: center; }

    /* Filter Bar */
    .filter-bar { padding: 14px 18px; margin-bottom: 18px; display: flex; flex-direction: column; gap: 12px; }
    .filter-row { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
    .sub-filter-row { padding-top: 10px; border-top: 1px dashed var(--border); }
    .filter-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .f-label { font-size: 12px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }

    .pills { display: flex; gap: 4px; background: var(--surface-2); padding: 3px; border-radius: var(--radius-pill); }
    .pill { border: none; background: transparent; padding: 5px 12px; font-size: 12px; font-weight: 600; color: var(--text-secondary); border-radius: var(--radius-pill); cursor: pointer; transition: all 0.15s; }
    .pill:hover { color: var(--text); background: var(--surface-3); }
    .pill.active { background: var(--surface); color: var(--primary); box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
    .pill.red.active { color: var(--red); }
    .pill.amber.active { color: var(--amber); }

    .date-inputs { display: flex; align-items: center; gap: 6px; }
    .date-inputs input[type="date"] { padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; font-size: 12px; background: var(--surface); color: var(--text); }
    .to-sep { font-size: 12px; color: var(--muted); }
    .range-badge { font-size: 11.5px; font-weight: 600; padding: 3px 8px; border-radius: 999px; background: var(--blue-bg); color: var(--primary); display: inline-flex; align-items: center; gap: 5px; }

    .searchbox { display: flex; align-items: center; gap: 6px; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; min-width: 260px; }
    .searchbox input { border: none; background: transparent; outline: none; font-size: 12.5px; color: var(--text); width: 100%; }
    .clear-search { border: none; background: none; cursor: pointer; color: var(--muted); font-size: 12px; padding: 0 2px; }

    select { padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; font-size: 12.5px; background: var(--surface); color: var(--text); outline: none; }

    /* Tabs */
    .tab-count { font-size: 11px; padding: 1px 6px; border-radius: 999px; background: var(--surface-3); color: var(--text-secondary); }
    .tab-count.red-badge { background: var(--red-bg); color: var(--red); font-weight: 700; }

    /* Table & Cards */
    .tablecard { padding: 0; overflow: hidden; }
    .card-head { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; }
    .card-title { font-size: 14px; font-weight: 700; display: flex; align-items: center; gap: 10px; }
    .table-wrap { overflow-x: auto; }
    .report-table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    .report-table th { padding: 10px 16px; background: var(--surface-2); border-bottom: 1px solid var(--border); font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
    .report-table td { padding: 12px 16px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    .report-table tbody tr:hover { background: var(--surface-2); }
    .report-table tbody tr.breached-row { background: rgba(239, 68, 68, 0.04); }

    .proc-cell { display: flex; flex-direction: column; gap: 2px; }
    .sub-meta { font-size: 11px; color: var(--muted); }
    .status-pill { padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: capitalize; display: inline-block; }
    .prio-pill { padding: 2px 7px; border-radius: 4px; font-size: 11px; font-weight: 700; background: var(--surface-3); color: var(--muted); }
    .prio-pill.urgent { background: var(--red-bg); color: var(--red); }
    .prio-pill.high { background: var(--amber-bg); color: var(--amber); }

    .sla-badge { font-size: 11.5px; font-weight: 700; display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 6px; }
    .sla-badge.breached { background: var(--red-bg); color: var(--red); }
    .sla-badge.on-track { background: var(--green-bg); color: var(--green); }

    .action-badge { font-size: 11px; text-transform: lowercase; font-family: monospace; background: var(--surface-3); color: var(--text-secondary); }
    .audit-payload { max-width: 420px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .table-footer { padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border); background: var(--surface); }
    .page-btns { display: flex; align-items: center; gap: 8px; }
    .page-indicator { font-size: 12px; font-weight: 600; color: var(--muted); }

    .empty-state { padding: 48px 24px; text-align: center; color: var(--muted); display: flex; flex-direction: column; align-items: center; gap: 8px; }
    .empty-state h3 { margin: 6px 0 2px; color: var(--text); font-size: 15px; }

    /* Ad-Hoc Report Builder */
    .adhoc-controls { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin: 16px 0 20px; padding: 16px; background: var(--surface-2); border-radius: 8px; border: 1px solid var(--border); }
    .control-box { display: flex; flex-direction: column; gap: 6px; }
    .control-box label { font-size: 12px; font-weight: 700; color: var(--text); }
    .run-box { justify-content: flex-end; }
    .share-cell { display: flex; align-items: center; gap: 8px; }
    .share-bar-wrap { width: 100px; height: 8px; background: var(--surface-3); border-radius: 4px; overflow: hidden; }
    .share-bar { height: 100%; background: var(--primary); border-radius: 4px; }
    .text-primary { color: var(--primary); }

    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .sm { font-size: 12px; }
    .bold { font-weight: 600; }
    .muted { color: var(--muted); }
    .lnk { color: var(--primary); text-decoration: none; }
    .lnk:hover { text-decoration: underline; }
    .btn.ghost { border: none; background: transparent; color: var(--muted); }
    .pad { padding: 20px; }
    .skeleton-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); }
    .skeleton-line { background: var(--surface-3); border-radius: 4px; animation: pulse 1.5s infinite; }

    @media (max-width: 768px) {
      .page { padding: 12px 14px; }
      .pagehead { flex-direction: column; align-items: stretch; gap: 12px; }
      .head-actions { width: 100%; display: flex; flex-wrap: wrap; gap: 6px; }
      .head-actions .btn { flex: 1 1 auto; justify-content: center; }

      .filter-bar { padding: 12px; }
      .filter-row { flex-direction: column; align-items: stretch; gap: 12px; }
      .sub-filter-row { padding-top: 12px; }
      .filter-group { flex-direction: column; align-items: stretch; gap: 6px; width: 100%; }
      .filter-group select { width: 100%; }

      .pills { flex-wrap: wrap; width: 100%; }
      .pill { flex: 1 1 auto; text-align: center; padding: 6px 8px; font-size: 11.5px; }

      .date-inputs { flex-wrap: wrap; width: 100%; }
      .date-inputs input[type="date"] { flex: 1 1 120px; min-width: 0; width: auto; }
      .date-inputs .btn { flex: 0 0 auto; }

      .searchbox { min-width: 0; width: 100%; }


      .card-head { flex-direction: column; align-items: flex-start; gap: 6px; padding: 12px 14px; }
      .report-table th, .report-table td { padding: 8px 10px; font-size: 12px; }
      .table-footer { flex-direction: column; align-items: flex-start; gap: 10px; padding: 10px 14px; }
      .page-btns { width: 100%; justify-content: space-between; }

      .adhoc-controls { grid-template-columns: 1fr; padding: 12px; gap: 12px; }
    }
  `],
})
export class ReportsComponent implements OnInit {
  private instanceApi = inject(InstanceApiService);
  private taskApi = inject(TaskApiService);
  private wfInstApi = inject(WorkflowInstanceApiService);
  private opsApi = inject(OpsApiService);
  private queryApi = inject(QueryApiService);
  private toast = inject(ToastService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  tab = signal<ReportTab>('executions');
  loading = signal(false);

  // Time Window & Filtering
  timeWindow = signal<TimeWindow>('30d');
  customFrom = signal('');
  customTo = signal('');
  searchQuery = '';
  selectedProcess = '';
  statusFilter = 'all';
  slaFilter = 'all';

  // Data sets
  executions = signal<Instance[]>([]);
  slaTasks = signal<Task[]>([]);
  cases = signal<WorkflowInstance[]>([]);
  audits = signal<AuditEvent[]>([]);
  availableProcesses = signal<string[]>([]);

  // Pagination states
  pageSize = 15;
  page = signal(1);
  slaPage = signal(1);
  casePage = signal(1);
  auditPage = signal(1);

  // Ad-Hoc Report builder state
  adhocEntity: 'instances' | 'tasks' | 'cases' | 'audit' = 'instances';
  adhocGroupBy: 'status' | 'name' | 'actor' | 'day' = 'status';
  adhocMetric: 'count' | 'duration' | 'failure' = 'count';
  adhocResults: { group: string; count: number; share: number; metricDisplay: string }[] = [];

  private loadedTabs = new Set<string>();

  ngOnInit() {
    const qTab = this.route.snapshot.queryParamMap.get('tab') as ReportTab;
    if (qTab && ['executions', 'sla', 'cases', 'audit', 'adhoc'].includes(qTab)) {
      this.tab.set(qTab);
    }
    this.initProcessList();
    this.setTimeWindow('30d');
  }

  initProcessList() {
    this.queryApi.processDefinitions().subscribe({
      next: (defs) => this.availableProcesses.set(defs.map((d) => d.processId).sort()),
      error: () => {},
    });
  }

  tabLabel(): string {
    switch (this.tab()) {
      case 'executions': return 'Process Executions';
      case 'sla': return 'Task SLA Breaches';
      case 'cases': return 'Case Resolutions';
      case 'audit': return 'System Audit Trail';
      case 'adhoc': return 'Ad-Hoc Report Engine';
    }
  }

  setTab(t: ReportTab) {
    this.tab.set(t);
    this.router.navigate([], { relativeTo: this.route, queryParams: { tab: t }, queryParamsHandling: 'merge' });
    this.ensureTabData(t);
  }

  ensureTabData(t: ReportTab, force = false) {
    if (!force && this.loadedTabs.has(t)) return;
    this.loadedTabs.add(t);
    this.loading.set(true);

    if (t === 'executions') {
      this.instanceApi.listInstances({}).subscribe({
        next: (items) => { this.executions.set(items); this.loading.set(false); },
        error: () => this.loading.set(false),
      });
    } else if (t === 'sla') {
      this.taskApi.listTasks().subscribe({
        next: (tasks) => {
          this.slaTasks.set(tasks.filter((x) => x.status !== 'completed' && x.status !== 'skipped'));
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
    } else if (t === 'cases') {
      this.wfInstApi.list({}).subscribe({
        next: (items) => { this.cases.set(items); this.loading.set(false); },
        error: () => this.loading.set(false),
      });
    } else if (t === 'audit') {
      this.opsApi.listAudit({ limit: 200 }).subscribe({
        next: (res) => { this.audits.set(res.items); this.loading.set(false); },
        error: () => this.loading.set(false),
      });
    } else if (t === 'adhoc') {
      this.loading.set(false);
      this.runAdhocQuery();
    }
  }

  refreshCurrentTab() {
    this.ensureTabData(this.tab(), true);
  }

  onFilterChange() {
    this.page.set(1);
    this.slaPage.set(1);
    this.casePage.set(1);
    this.auditPage.set(1);
  }

  setTimeWindow(w: TimeWindow) {
    this.timeWindow.set(w);
    const now = new Date();
    const toStr = (d: Date) => d.toISOString().slice(0, 10);
    if (w === '1d') {
      this.customFrom.set(toStr(now));
      this.customTo.set(toStr(now));
    } else if (w === '7d') {
      this.customFrom.set(toStr(new Date(now.getTime() - 6 * 86400000)));
      this.customTo.set(toStr(now));
    } else if (w === '30d') {
      this.customFrom.set(toStr(new Date(now.getTime() - 29 * 86400000)));
      this.customTo.set(toStr(now));
    } else if (w === '90d') {
      this.customFrom.set(toStr(new Date(now.getTime() - 89 * 86400000)));
      this.customTo.set(toStr(now));
    } else if (w === 'all') {
      this.customFrom.set('');
      this.customTo.set('');
    }
    this.loadedTabs.clear();
    this.ensureTabData(this.tab(), true);
  }

  onFromChange(val: string) { this.customFrom.set(val); this.timeWindow.set('custom'); }
  onToChange(val: string) { this.customTo.set(val); this.timeWindow.set('custom'); }

  applyCustomDateRange() {
    if (this.customFrom() && this.customTo() && this.customFrom() > this.customTo()) {
      this.toast.error('Start date cannot be after end date.');
      return;
    }
    this.timeWindow.set('custom');
    this.loadedTabs.clear();
    this.ensureTabData(this.tab(), true);
  }

  clearCustomDateRange() {
    this.customFrom.set('');
    this.customTo.set('');
    this.timeWindow.set('all');
    this.loadedTabs.clear();
    this.ensureTabData(this.tab(), true);
  }

  isDateFiltered(): boolean { return Boolean(this.customFrom() || this.customTo()); }
  dateRangeLabel(): string {
    if (this.customFrom() && this.customTo()) return `${this.customFrom()} → ${this.customTo()}`;
    if (this.customFrom()) return `Since ${this.customFrom()}`;
    if (this.customTo()) return `Until ${this.customTo()}`;
    return 'All Time';
  }

  private filterByDate(dateStr?: string): boolean {
    if (!this.isDateFiltered()) return true;
    if (!dateStr) return false;
    const d = dateStr.slice(0, 10);
    if (this.customFrom() && d < this.customFrom()) return false;
    if (this.customTo() && d > this.customTo()) return false;
    return true;
  }

  // ---- Filtered Lists ----
  filteredExecutions = computed(() => {
    const q = this.searchQuery.toLowerCase().trim();
    const proc = this.selectedProcess;
    const stat = this.statusFilter;

    return this.executions().filter((i) => {
      if (!this.filterByDate(i.startedAt)) return false;
      if (proc && (i.processId !== proc && i.workflowId !== proc)) return false;
      if (stat !== 'all' && i.status !== stat) return false;
      if (q) {
        const matches = i.id.toLowerCase().includes(q)
          || (i.processId || '').toLowerCase().includes(q)
          || (i.workflowId || '').toLowerCase().includes(q)
          || (i.startedBy || '').toLowerCase().includes(q)
          || (i.correlationKey || '').toLowerCase().includes(q);
        if (!matches) return false;
      }
      return true;
    });
  });

  filteredSlaTasks = computed(() => {
    const q = this.searchQuery.toLowerCase().trim();
    const filter = this.slaFilter;

    return this.slaTasks().filter((t) => {
      if (!this.filterByDate(t.createdAt)) return false;
      if (filter === 'overdue' && !this.isOverdue(t)) return false;
      if (filter === 'at-risk' && !this.isAtRisk(t)) return false;
      if (q) {
        const matches = t.id.toLowerCase().includes(q)
          || t.name.toLowerCase().includes(q)
          || (t.assignee || '').toLowerCase().includes(q)
          || (t.instanceId || '').toLowerCase().includes(q);
        if (!matches) return false;
      }
      return true;
    });
  });

  filteredCases = computed(() => {
    const q = this.searchQuery.toLowerCase().trim();
    const proc = this.selectedProcess;
    const stat = this.statusFilter;

    return this.cases().filter((c) => {
      if (!this.filterByDate(c.createdAt)) return false;
      if (proc && c.workflowDefinitionId !== proc) return false;
      if (stat !== 'all' && c.status !== stat) return false;
      if (q) {
        const matches = c.id.toLowerCase().includes(q)
          || (c.workflowName || '').toLowerCase().includes(q)
          || (c.createdBy || '').toLowerCase().includes(q);
        if (!matches) return false;
      }
      return true;
    });
  });

  filteredAudits = computed(() => {
    const q = this.searchQuery.toLowerCase().trim();

    return this.audits().filter((a) => {
      if (!this.filterByDate(a.at)) return false;
      if (q) {
        const ent = a.instanceId || a.taskId || a.workflowId || '';
        const matches = a.id.toLowerCase().includes(q)
          || a.actor.toLowerCase().includes(q)
          || a.kind.toLowerCase().includes(q)
          || ent.toLowerCase().includes(q)
          || JSON.stringify(a.data || {}).toLowerCase().includes(q);
        if (!matches) return false;
      }
      return true;
    });
  });

  // Auto-pagination display counts
  displayedExecutionsCount = signal(25);
  displayedSlaCount = signal(25);
  displayedCasesCount = signal(25);
  displayedAuditsCount = signal(25);

  @HostListener('window:scroll') onWindowScroll() {
    const threshold = 250;
    const pos = window.innerHeight + window.scrollY;
    const max = document.documentElement.scrollHeight;
    if (pos >= max - threshold) {
      if (this.tab() === 'executions') this.displayedExecutionsCount.update((c) => Math.min(c + 25, this.filteredExecutions().length));
      else if (this.tab() === 'sla') this.displayedSlaCount.update((c) => Math.min(c + 25, this.filteredSlaTasks().length));
      else if (this.tab() === 'cases') this.displayedCasesCount.update((c) => Math.min(c + 25, this.filteredCases().length));
      else if (this.tab() === 'audit') this.displayedAuditsCount.update((c) => Math.min(c + 25, this.filteredAudits().length));
    }
  }

  onExecScroll(e: Event) {
    const el = e.target as HTMLElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
      this.displayedExecutionsCount.update((c) => Math.min(c + 25, this.filteredExecutions().length));
    }
  }

  onSlaScroll(e: Event) {
    const el = e.target as HTMLElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
      this.displayedSlaCount.update((c) => Math.min(c + 25, this.filteredSlaTasks().length));
    }
  }

  onCaseScroll(e: Event) {
    const el = e.target as HTMLElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
      this.displayedCasesCount.update((c) => Math.min(c + 25, this.filteredCases().length));
    }
  }

  onAuditScroll(e: Event) {
    const el = e.target as HTMLElement;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 150) {
      this.displayedAuditsCount.update((c) => Math.min(c + 25, this.filteredAudits().length));
    }
  }

  // ---- Paging Helpers (supports both auto-infinite scroll & page slicing) ----
  pagedExecutions = computed(() => {
    return this.filteredExecutions().slice(0, this.displayedExecutionsCount());
  });

  pagedSlaTasks = computed(() => {
    return this.filteredSlaTasks().slice(0, this.displayedSlaCount());
  });

  pagedCases = computed(() => {
    return this.filteredCases().slice(0, this.displayedCasesCount());
  });

  pagedAudits = computed(() => {
    return this.filteredAudits().slice(0, this.displayedAuditsCount());
  });

  maxPages(count: number): number { return Math.max(1, Math.ceil(count / this.pageSize)); }
  minVal(a: number, b: number): number { return Math.min(a, b); }

  countOverdue(): number {
    return this.slaTasks().filter((t) => this.isOverdue(t)).length;
  }

  isOverdue(t: Task): boolean {
    return Boolean(t.dueAt && Date.parse(t.dueAt) < Date.now());
  }

  isAtRisk(t: Task): boolean {
    if (!t.dueAt) return false;
    const due = Date.parse(t.dueAt);
    const now = Date.now();
    const created = t.createdAt ? Date.parse(t.createdAt) : now - 86400000;
    const total = due - created;
    if (total <= 0) return true;
    const elapsed = now - created;
    return (elapsed / total) >= 0.8 && !this.isOverdue(t);
  }

  overdueDelay(dueAt: string): string {
    const diff = Date.now() - Date.parse(dueAt);
    return humanMs(diff);
  }

  remainingTime(dueAt?: string): string {
    if (!dueAt) return '—';
    const diff = Date.parse(dueAt) - Date.now();
    return humanMs(diff);
  }

  calcDuration(start?: string, end?: string): string {
    if (!start) return '—';
    const s = Date.parse(start);
    const e = end ? Date.parse(end) : Date.now();
    return humanMs(e - s);
  }

  procName(i: Instance): string {
    return (i.processId || i.workflowId || '').split('.').pop() || i.workflowId;
  }

  shortId(id: string): string {
    return id.length > 10 ? id.slice(-7) : id;
  }

  statusColor(s: string): string {
    return ({
      running: '#2563eb',
      waiting: '#f59e0b',
      completed: '#16a34a',
      failed: '#dc2626',
      aborted: '#6b7280',
      suspended: '#7c3aed',
    } as any)[s] || '#6b7280';
  }

  formatAuditData(data?: Record<string, unknown>): string {
    if (!data || Object.keys(data).length === 0) return '—';
    return JSON.stringify(data);
  }

  isCurrentEmpty(): boolean {
    switch (this.tab()) {
      case 'executions': return this.filteredExecutions().length === 0;
      case 'sla': return this.filteredSlaTasks().length === 0;
      case 'cases': return this.filteredCases().length === 0;
      case 'audit': return this.filteredAudits().length === 0;
      case 'adhoc': return this.adhocResults.length === 0;
    }
  }

  // ---- Ad-Hoc Report Builder Engine ----
  runAdhocQuery() {
    let source: any[] = [];
    if (this.adhocEntity === 'instances') source = this.executions();
    else if (this.adhocEntity === 'tasks') source = this.slaTasks();
    else if (this.adhocEntity === 'cases') source = this.cases();
    else if (this.adhocEntity === 'audit') source = this.audits();

    if (!source.length) {
      // Lazy load entity if empty
      if (this.adhocEntity === 'instances') this.instanceApi.listInstances({}).subscribe((l) => { this.executions.set(l); this.runAdhocQuery(); });
      else if (this.adhocEntity === 'tasks') this.taskApi.listTasks().subscribe((l) => { this.slaTasks.set(l); this.runAdhocQuery(); });
      else if (this.adhocEntity === 'cases') this.wfInstApi.list({}).subscribe((l) => { this.cases.set(l); this.runAdhocQuery(); });
      else if (this.adhocEntity === 'audit') this.opsApi.listAudit({ limit: 200 }).subscribe((l) => { this.audits.set(l.items); this.runAdhocQuery(); });
      return;
    }

    const groups: Record<string, { count: number; totalMs: number; failCount: number }> = {};
    for (const item of source) {
      let g = 'Other';
      if (this.adhocGroupBy === 'status') g = item.status || 'unknown';
      else if (this.adhocGroupBy === 'name') g = item.processId || item.workflowName || item.workflowId || item.name || item.kind || 'unknown';
      else if (this.adhocGroupBy === 'actor') g = item.startedBy || item.assignee || item.actor || 'system';
      else if (this.adhocGroupBy === 'day') g = (item.startedAt || item.createdAt || item.at || '').slice(0, 10) || 'unknown';

      if (!groups[g]) groups[g] = { count: 0, totalMs: 0, failCount: 0 };
      groups[g].count++;
      if (item.status === 'failed' || item.status === 'error') groups[g].failCount++;

      const s = item.startedAt || item.createdAt || item.at;
      const e = item.endedAt || item.completedAt;
      if (s && e) {
        groups[g].totalMs += (Date.parse(e) - Date.parse(s));
      }
    }

    const total = source.length;
    this.adhocResults = Object.entries(groups).map(([group, val]) => {
      let metricDisplay = `${val.count} items`;
      if (this.adhocMetric === 'duration') {
        const avg = val.count > 0 ? Math.round(val.totalMs / val.count) : 0;
        metricDisplay = humanMs(avg);
      } else if (this.adhocMetric === 'failure') {
        const pct = val.count > 0 ? Math.round((val.failCount / val.count) * 100) : 0;
        metricDisplay = `${pct}% fail`;
      }
      return {
        group,
        count: val.count,
        share: total ? Math.round((val.count / total) * 100) : 0,
        metricDisplay,
      };
    }).sort((a, b) => b.count - a.count);
  }

  // ---- CSV / JSON Export Engine ----
  exportCsv() {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    let headers: string[] = [];
    let rows: unknown[][] = [];
    let filename = 'report.csv';

    if (this.tab() === 'executions') {
      filename = `process-executions-report-${new Date().toISOString().slice(0, 10)}.csv`;
      headers = ['Instance ID', 'Process Definition', 'Status', 'Initiator', 'Started At', 'Ended At', 'Duration (ms)', 'Correlation Key'];
      rows = this.filteredExecutions().map((i) => [
        i.id,
        this.procName(i),
        i.status,
        i.startedBy,
        i.startedAt,
        i.endedAt || '',
        i.startedAt && i.endedAt ? Date.parse(i.endedAt) - Date.parse(i.startedAt) : '',
        i.correlationKey || '',
      ]);
    } else if (this.tab() === 'sla') {
      filename = `task-sla-breaches-report-${new Date().toISOString().slice(0, 10)}.csv`;
      headers = ['Task ID', 'Task Name', 'Process Instance ID', 'Priority', 'Assignee', 'Group', 'Created At', 'Due Date', 'Is Overdue'];
      rows = this.filteredSlaTasks().map((t) => [
        t.id,
        t.name,
        t.instanceId,
        t.priority ?? 50,
        t.assignee || '',
        t.group || '',
        t.createdAt,
        t.dueAt || '',
        this.isOverdue(t) ? 'YES' : 'NO',
      ]);
    } else if (this.tab() === 'cases') {
      filename = `case-resolutions-report-${new Date().toISOString().slice(0, 10)}.csv`;
      headers = ['Case ID', 'Workflow Name', 'Status', 'Initiator', 'Started At', 'Completed At', 'Process Instance ID'];
      rows = this.filteredCases().map((c) => [
        c.id,
        c.workflowName || c.workflowDefinitionId,
        c.status,
        c.createdBy || 'system',
        c.createdAt,
        c.status === 'completed' ? c.updatedAt : '',
        c.piid || '',
      ]);
    } else if (this.tab() === 'audit') {
      filename = `system-audit-trail-${new Date().toISOString().slice(0, 10)}.csv`;
      headers = ['Audit ID', 'Timestamp', 'Actor', 'Kind', 'Entity ID', 'Data'];
      rows = this.filteredAudits().map((a) => [
        a.id,
        a.at,
        a.actor,
        a.kind,
        a.instanceId || a.taskId || a.workflowId || '',
        JSON.stringify(a.data || {}),
      ]);
    } else if (this.tab() === 'adhoc') {
      filename = `ad-hoc-query-report-${new Date().toISOString().slice(0, 10)}.csv`;
      headers = ['Group', 'Count', 'Share (%)', 'Metric'];
      rows = this.adhocResults.map((r) => [r.group, r.count, r.share, r.metricDisplay]);
    }

    const csvContent = [headers.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
    downloadFile(csvContent, filename, 'text/csv;charset=utf-8;');
    this.toast.success(`Exported ${filename}`);
  }

  exportJson() {
    let data: unknown;
    let filename = 'report.json';

    if (this.tab() === 'executions') {
      filename = `process-executions-${new Date().toISOString().slice(0, 10)}.json`;
      data = this.filteredExecutions();
    } else if (this.tab() === 'sla') {
      filename = `task-sla-breaches-${new Date().toISOString().slice(0, 10)}.json`;
      data = this.filteredSlaTasks();
    } else if (this.tab() === 'cases') {
      filename = `case-resolutions-${new Date().toISOString().slice(0, 10)}.json`;
      data = this.filteredCases();
    } else if (this.tab() === 'audit') {
      filename = `system-audit-trail-${new Date().toISOString().slice(0, 10)}.json`;
      data = this.filteredAudits();
    } else if (this.tab() === 'adhoc') {
      filename = `ad-hoc-query-${new Date().toISOString().slice(0, 10)}.json`;
      data = this.adhocResults;
    }

    downloadFile(JSON.stringify(data, null, 2), filename, 'application/json;charset=utf-8;');
    this.toast.success(`Exported ${filename}`);
  }
}
