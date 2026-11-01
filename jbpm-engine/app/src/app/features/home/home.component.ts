import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { DecimalPipe, JsonPipe, SlicePipe } from '@angular/common';
import { forkJoin } from 'rxjs';
import { QueryApiService } from '../../core/api/query-api.service';
import { InstanceApiService } from '../../core/api/instance-api.service';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { WorkflowDefinitionApiService } from '../../core/api/workflow-definition-api.service';
import { WorkflowInstanceApiService } from '../../core/api/workflow-instance-api.service';
import { WorkflowAnalyticsApiService, type WorkflowInstanceSummary } from '../../core/api/workflow-analytics-api.service';
import { AuthService } from '../../core/auth/auth.service';
import { processLabel } from '../../core/process-label';
import { ToastService } from '../../shared/toast.service';
import { IconComponent } from '../../shared/icon.component';
import type {
  Instance,
  ProcessAnalytics,
  QueryDefinition,
  QueryFilter,
  QueryOp,
  QueryRunResult,
  QueryableEntity,
  SavedQuery,
  Summary,
  Task,
  TaskAnalytics,
  Workflow,
  WorkflowDefinition,
  WorkflowTat,
} from '../../core/models';

type HomeTab = 'overview' | 'processes' | 'tasks' | 'cases' | 'queries';
type TimeWindow = 'all' | '1d' | '7d' | '30d' | '90d' | 'custom';

interface StatusRow {
  key: string;
  label: string;
  color: string;
  count: number;
  pctOfMax: number;
  share: number;
}

const ENTITIES: QueryableEntity[] = ['workflowInstance', 'workflowInstanceAudit', 'workflowInstanceComment', 'instance', 'task'];
const OPS: QueryOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'];

function humanMs(ms: number): string {
  if (!ms || ms <= 0) return '0s';
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

const INSTANCE_STATUSES = [
  { key: 'running', label: 'Running', color: 'var(--blue)' },
  { key: 'waiting', label: 'Waiting', color: 'var(--amber)' },
  { key: 'completed', label: 'Completed', color: 'var(--green)' },
  { key: 'suspended', label: 'Suspended', color: 'var(--purple)' },
  { key: 'failed', label: 'Failed', color: 'var(--red)' },
  { key: 'aborted', label: 'Aborted', color: 'var(--muted)' },
];

const TASK_STATUSES = [
  { key: 'created', label: 'Created', color: 'var(--amber)' },
  { key: 'reserved', label: 'Reserved', color: 'var(--purple)' },
  { key: 'inprogress', label: 'In progress', color: 'var(--blue)' },
  { key: 'error', label: 'Error', color: 'var(--red)' },
];

@Component({
  selector: 'app-home',
  standalone: true,
  imports: [FormsModule, RouterLink, SlicePipe, DecimalPipe, JsonPipe, IconComponent],
  template: `
    <div class="page">
      <!-- Header -->
      <header class="head">
        <div>
          <h1>{{ greeting() }}, <span class="grad">{{ auth.user()?.username }}</span></h1>
          <p class="sub">Centralized intelligence: real-time process performance, human workloads, case metrics, and reports.</p>
        </div>
        <span class="spacer"></span>
        <button class="btn sm" (click)="load()"><app-icon name="refresh" [size]="14" /> Refresh</button>
        <button class="btn sm" (click)="exportCsv()" [disabled]="loading()">
          <app-icon name="download" [size]="14" /> Export CSV
        </button>
        @if (canBuild()) {
          <button class="btn sm" (click)="openStartCase()"><app-icon name="plus" [size]="13" /> New Case</button>
          <a class="btn primary sm" routerLink="/instances/start"><app-icon name="play" [size]="13" /> New Process</a>
        }
      </header>

      <!-- Global Filter Bar: Presets, Date Range Filter & Process Scope -->
      <div class="filter-bar card">
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
            <input type="date" [ngModel]="customFrom()" (ngModelChange)="onFromChange($event)" (keyup.enter)="applyCustomDateRange()" placeholder="YYYY-MM-DD" title="Start Date" />
            <span class="to-sep">→</span>
            <input type="date" [ngModel]="customTo()" (ngModelChange)="onToChange($event)" (keyup.enter)="applyCustomDateRange()" placeholder="YYYY-MM-DD" title="End Date" />
            <button class="btn sm primary" (click)="applyCustomDateRange()" [disabled]="!customFrom() && !customTo()">Apply</button>
            @if (customFrom() || customTo()) {
              <button class="btn sm ghost" (click)="clearCustomDateRange()" title="Reset to All Time">✕</button>
            }
          </div>
          @if (isDateFiltered()) {
            <span class="range-badge" title="Active filtered range">
              <app-icon name="calendar" [size]="11" /> {{ dateRangeLabel() }}
            </span>
          }
        </div>

        <div class="filter-group right">
          <span class="f-label">Process Scope:</span>
          <select [(ngModel)]="selectedProcess" (change)="onProcessChange()">
            <option value="">All Process Definitions</option>
            @for (p of availableProcesses(); track p) {
              <option [value]="p">{{ p }}</option>
            }
          </select>
        </div>
      </div>

      <!-- Navigation Tabs -->
      <nav class="tabs" role="tablist">
        <button role="tab" [class.active]="tab() === 'overview'" (click)="setTab('overview')">
          <app-icon name="home" [size]="14" /> Overview
        </button>
        <button role="tab" [class.active]="tab() === 'processes'" (click)="setTab('processes')">
          <app-icon name="instances" [size]="14" /> Processes
        </button>
        <button role="tab" [class.active]="tab() === 'tasks'" (click)="setTab('tasks')">
          <app-icon name="tasks" [size]="14" /> Tasks &amp; SLAs
        </button>
        <button role="tab" [class.active]="tab() === 'cases'" (click)="setTab('cases')">
          <app-icon name="inbox" [size]="14" /> Cases &amp; Workflows
        </button>
        <button role="tab" [class.active]="tab() === 'queries'" (click)="setTab('queries')">
          <app-icon name="search" [size]="14" /> Ad-Hoc Query Engine
        </button>
      </nav>

      @if (failed() && !loading()) {
        <div class="loadfail" role="alert">Some of your dashboard could not be loaded, so the numbers below may be incomplete. <button class="btn sm" (click)="retry()">Retry</button></div>
      }

      @if (loading()) {
        <div class="kpis">
          @for (_ of [1,2,3,4,5,6]; track $index) { <div class="card kpi skeleton" style="height:90px"></div> }
        </div>
        <div class="chartgrid"><div class="skeleton skeleton-card tall"></div><div class="skeleton skeleton-card tall"></div></div>
      } @else {
        <!-- Global Executive KPIs -->
        <div class="kpis">
          @if (canView()) {
            <a class="card kpi" routerLink="/instances" [queryParams]="{status: 'running'}">
              <span class="n" style="color: var(--blue);">{{ activeInstances() }}</span>
              <span class="l">Active Instances</span>
            </a>
            <a class="card kpi" routerLink="/instances" [queryParams]="{status: 'completed'}">
              <span class="n" style="color: var(--green);">{{ completedInstances() }}</span>
              <span class="l">Completed Instances</span>
            </a>
            <a class="card kpi" routerLink="/errors">
              <span class="n" [class.red]="failedInstances() > 0">{{ failedInstances() }}</span>
              <span class="l">Failed / Errors</span>
            </a>
            <div class="card kpi">
              <span class="n" [style.color]="failureRateColor()">{{ failureRate() }}%</span>
              <span class="l">Failure Rate</span>
            </div>
          }
          @if (canTasks()) {
            <a class="card kpi" routerLink="/tasks">
              <span class="n amber">{{ openTasks() }}</span>
              <span class="l">Open Tasks</span>
            </a>
            <div class="card kpi">
              <span class="n" [style.color]="slaColor()">{{ slaRate() }}%</span>
              <span class="l">SLA Compliance</span>
            </div>
          }
          @if (canView()) {
            <a class="card kpi" routerLink="/deployments">
              <span class="n" style="color: var(--purple);">{{ summary()?.deployments?.active ?? 0 }}</span>
              <span class="l">Active Deployments</span>
            </a>
            <a class="card kpi" routerLink="/instances" [queryParams]="{type: 'cases'}">
              <span class="n">{{ caseSummary()?.total ?? 0 }}</span>
              <span class="l">Total Cases</span>
            </a>
            <div class="card kpi" title="Durable timers currently scheduled">
              <span class="n" style="color: #0284c7;">{{ activeTimers() }}</span>
              <span class="l">Active Timers</span>
            </div>
          }
        </div>

        <!-- ==================== TAB 1: OVERVIEW ==================== -->
        @if (tab() === 'overview') {
          <!-- Throughput timeline trend chart -->
          @if (dailyThroughput().length > 0) {
            <section class="card chart full-width">
              <div class="row charthead">
                <div>
                  <h3>Execution Throughput Over Time</h3>
                  <p class="chartsub">Daily instance starts vs. completions over the selected period</p>
                </div>
                <div class="spacer"></div>
                <!-- View Mode Filter -->
                <div class="view-mode-toggle" title="Filter days shown on timeline">
                  <button type="button" class="vm-btn" [class.active]="throughputViewMode() === 'all'" (click)="throughputViewMode.set('all')">
                    All Days ({{ dailyThroughput().length }})
                  </button>
                  <button type="button" class="vm-btn" [class.active]="throughputViewMode() === 'active'" (click)="throughputViewMode.set('active')">
                    Active Days ({{ throughputTotals().activeDays }})
                  </button>
                </div>
                <!-- Legend -->
                <div class="chart-legend-inline">
                  <span class="leg-item"><span class="dot-sw" style="background: var(--blue);"></span> Started</span>
                  <span class="leg-item"><span class="dot-sw" style="background: var(--green);"></span> Completed</span>
                  <span class="leg-item"><span class="dot-sw" style="background: var(--red);"></span> Failed</span>
                </div>
              </div>

              <!-- High-density Throughput Summary Metric Strip -->
              <div class="tp-summary-strip">
                <div class="tp-stat">
                  <span class="tp-stat-val" style="color: var(--blue);">{{ throughputTotals().started }}</span>
                  <span class="tp-stat-lbl">Total Started</span>
                </div>
                <div class="tp-stat-sep"></div>
                <div class="tp-stat">
                  <span class="tp-stat-val" style="color: var(--green);">{{ throughputTotals().completed }}</span>
                  <span class="tp-stat-lbl">Completed</span>
                </div>
                <div class="tp-stat-sep"></div>
                <div class="tp-stat">
                  <span class="tp-stat-val" [class.red]="throughputTotals().failed > 0">{{ throughputTotals().failed }}</span>
                  <span class="tp-stat-lbl">Failed</span>
                </div>
                <div class="tp-stat-sep"></div>
                <div class="tp-stat">
                  <span class="tp-stat-val">{{ throughputTotals().totalVolume }}</span>
                  <span class="tp-stat-lbl">Total Volume</span>
                </div>
                <div class="tp-stat-sep"></div>
                <div class="tp-stat">
                  <span class="tp-stat-val" [style.color]="throughputTotals().successRate >= 90 ? 'var(--green)' : throughputTotals().successRate >= 75 ? 'var(--amber)' : 'var(--red)'">
                    {{ throughputTotals().successRate }}%
                  </span>
                  <span class="tp-stat-lbl">Success Rate</span>
                </div>
                @if (throughputTotals().peakDay) {
                  <div class="tp-stat-sep"></div>
                  <div class="tp-stat">
                    <span class="tp-stat-val">{{ throughputTotals().peakVal }}</span>
                    <span class="tp-stat-lbl">Peak ({{ formatDayLabel(throughputTotals().peakDay) }})</span>
                  </div>
                }
              </div>

              <div class="tp-chart-container">
                <!-- Y-Axis Numeric Scale -->
                <div class="tp-y-axis">
                  @for (tick of throughputYScale().ticks; track $index) {
                    <span class="tp-y-tick">{{ tick }}</span>
                  }
                </div>

                <!-- Plot Area with horizontal gridlines and bar columns -->
                <div class="tp-plot-area">
                  <div class="tp-gridlines">
                    @for (tick of throughputYScale().ticks; track $index) {
                      <div class="tp-gridline" [style.top.%]="$index * 25"></div>
                    }
                  </div>

                  <div class="tp-columns" [class.active-view]="throughputViewMode() === 'active'">
                    @for (d of displayedThroughput(); track d.date) {
                      <div class="tp-col"
                           [class.active-day]="(d.started + d.completed + d.failed) > 0"
                           [class.is-hovered]="hoveredDay()?.date === d.date"
                           (mouseenter)="onHoverDay(d, $event)"
                           (mouseleave)="onLeaveDay()">
                        <!-- Day Total Count Badge -->
                        <div class="tp-col-header">
                          @if ((d.started + d.completed + d.failed) > 0) {
                            <span class="col-count-badge" title="Total instances on this date">
                              {{ d.started + d.completed + d.failed }}
                            </span>
                          } @else {
                            <span class="col-count-empty">·</span>
                          }
                        </div>

                        <!-- Bar cluster with value labels -->
                        <div class="tp-bars">
                          <div class="tp-bar-wrapper">
                            @if (d.started > 0) {
                              <span class="tp-bar-val blue">{{ d.started }}</span>
                              <div class="tp-bar blue" [style.height.%]="pctOfThroughput(d.started)"></div>
                            } @else {
                              <div class="tp-bar-zero"></div>
                            }
                          </div>
                          <div class="tp-bar-wrapper">
                            @if (d.completed > 0) {
                              <span class="tp-bar-val green">{{ d.completed }}</span>
                              <div class="tp-bar green" [style.height.%]="pctOfThroughput(d.completed)"></div>
                            } @else {
                              <div class="tp-bar-zero"></div>
                            }
                          </div>
                          <div class="tp-bar-wrapper">
                            @if (d.failed > 0) {
                              <span class="tp-bar-val red">{{ d.failed }}</span>
                              <div class="tp-bar red" [style.height.%]="pctOfThroughput(d.failed)"></div>
                            } @else {
                              <div class="tp-bar-zero"></div>
                            }
                          </div>
                        </div>

                        <span class="tp-label">{{ formatDayLabel(d.date) }}</span>
                      </div>
                    }
                  </div>

                  <!-- Floating Tooltip on Hover -->
                  @if (hoveredDay()) {
                    <div class="tp-floating-tooltip" [style.left.px]="tooltipX()" [style.top.px]="tooltipY()">
                      <div class="tp-tt-head">
                        <span class="tp-tt-date">{{ formatFullDate(hoveredDay()!.date) }}</span>
                        <span class="tp-tt-total-pill">{{ hoveredDay()!.started + hoveredDay()!.completed + hoveredDay()!.failed }} Total</span>
                      </div>
                      <div class="tp-tt-body">
                        <div class="tp-tt-row">
                          <span class="dot-sw" style="background: var(--blue);"></span>
                          <span class="tp-tt-name">Started Instances:</span>
                          <span class="tp-tt-num blue">{{ hoveredDay()!.started }}</span>
                        </div>
                        <div class="tp-tt-row">
                          <span class="dot-sw" style="background: var(--green);"></span>
                          <span class="tp-tt-name">Completed:</span>
                          <span class="tp-tt-num green">{{ hoveredDay()!.completed }}</span>
                        </div>
                        <div class="tp-tt-row">
                          <span class="dot-sw" style="background: var(--red);"></span>
                          <span class="tp-tt-name">Failed / Errors:</span>
                          <span class="tp-tt-num red">{{ hoveredDay()!.failed }}</span>
                        </div>
                        @if (hoveredDay()!.completed + hoveredDay()!.failed > 0) {
                          <div class="tp-tt-divider"></div>
                          <div class="tp-tt-row small muted">
                            <span>Success Rate:</span>
                            <span class="tp-tt-num">{{ calcDaySuccessRate(hoveredDay()!) }}%</span>
                          </div>
                        }
                      </div>
                    </div>
                  }
                </div>
              </div>
            </section>
          }

          <div class="chartgrid">
            <section class="card chart">
              <div class="row charthead">
                <h3>Process Instances Status Mix</h3>
                <div class="spacer"></div>
                <span class="muted small tnum">{{ instTotal() }} total</span>
              </div>
              <p class="chartsub">Distribution across all running, waiting, and completed executions</p>
              @if (instTotal() > 0) {
                <div class="barlist">
                  @for (r of instStatusRows(); track r.key) {
                    <div class="barrow">
                      <div class="row lab">
                        <span class="dot" [style.background]="r.color"></span>
                        <span>{{ r.label }}</span>
                        <div class="spacer"></div>
                        <span class="tnum muted">{{ r.count }}</span>
                      </div>
                      <div class="track"><span [style.width.%]="r.pctOfMax" [style.background]="r.color"></span></div>
                    </div>
                  }
                </div>
              } @else {
                <p class="nodata">No instances found for this filter scope.</p>
              }
            </section>

            <section class="card chart donutcard">
              <div class="row charthead">
                <h3>Execution State Ratio</h3>
              </div>
              @if (instTotal() > 0) {
                <div class="donutwrap">
                  <div class="donut" [style.background]="instDonut()" role="img" aria-label="Instance status distribution">
                    <div class="hole"><span class="tnum">{{ instTotal() }}</span></div>
                  </div>
                  <div class="legend">
                    @for (r of nonZero(instStatusRows()); track r.key) {
                      <div class="li"><span class="sw" [style.background]="r.color"></span> {{ r.label }} · {{ r.share }}%</div>
                    }
                  </div>
                </div>
              } @else {
                <p class="nodata">Nothing to chart yet.</p>
              }
            </section>
          </div>

          <div class="cols">
            @if (canTasks()) {
              <section class="card panel">
                <div class="p-head">
                  <h2>My Open Tasks</h2>
                  <span class="spacer"></span>
                  <a class="link" routerLink="/tasks">View all <app-icon name="arrowRight" [size]="13" /></a>
                </div>
                @if (myTasks().length === 0) {
                  <div class="empty-state sm">
                    <div class="es-icon"><app-icon name="success" [size]="22" /></div>
                    <h3>Inbox zero</h3>
                    <p>You have no tasks assigned right now.</p>
                  </div>
                } @else {
                  <ul class="rows">
                    @for (t of myTasks(); track t.id) {
                      <li><a [routerLink]="['/tasks', t.id]">
                        <span class="tname">{{ t.name }}</span>
                        <span class="spacer"></span>
                        @if (t.dueAt) { <span class="due" [class.over]="isOverdue(t)">{{ dueLabel(t) }}</span> }
                        @else { <span class="badge">no due date</span> }
                      </a></li>
                    }
                  </ul>
                }
              </section>
            }

            <section class="card panel">
              <div class="p-head">
                <h2>Recent Executions</h2>
                <span class="spacer"></span>
                <a class="link" routerLink="/instances">View all <app-icon name="arrowRight" [size]="13" /></a>
              </div>
              @if (recent().length === 0) {
                <div class="empty-state sm">
                  <div class="es-icon"><app-icon name="clock" [size]="22" /></div>
                  <h3>Nothing yet</h3>
                  <p>Process activity will appear here once instances start running.</p>
                </div>
              } @else {
                <ul class="rows">
                  @for (i of recent(); track i.id) {
                    <li><a [routerLink]="['/instances', i.id]">
                      <span class="dot" [style.background]="statusColor(i.status)"></span>
                      <span class="tname">{{ procName(i) }} <span class="mono muted" [title]="i.id">{{ shortId(i.id) }}</span></span>
                      <span class="spacer"></span>
                      @if (i.caseInstanceId) {
                        <span class="case-chip-sm"><app-icon name="inbox" [size]="10" /> {{ shortId(i.caseInstanceId) }}</span>
                      }
                      <span class="muted when">{{ i.status }}</span>
                    </a></li>
                  }
                </ul>
              }
            </section>
          </div>
        }

        <!-- ==================== TAB 2: PROCESSES ==================== -->
        @if (tab() === 'processes') {
          @if (dailyThroughput().length > 0) {
            <section class="card chart full-width" style="margin-bottom: 16px;">
              <div class="row charthead">
                <div>
                  <h3>Process Volume &amp; Daily Throughput</h3>
                  <p class="chartsub">Instance completions, starts, and execution outcomes over time</p>
                </div>
                <div class="spacer"></div>
                <!-- View Mode Filter -->
                <div class="view-mode-toggle" title="Filter days shown on timeline">
                  <button type="button" class="vm-btn" [class.active]="throughputViewMode() === 'all'" (click)="throughputViewMode.set('all')">
                    All Days ({{ dailyThroughput().length }})
                  </button>
                  <button type="button" class="vm-btn" [class.active]="throughputViewMode() === 'active'" (click)="throughputViewMode.set('active')">
                    Active Days ({{ throughputTotals().activeDays }})
                  </button>
                </div>
                <!-- Legend -->
                <div class="chart-legend-inline">
                  <span class="leg-item"><span class="dot-sw" style="background: var(--blue);"></span> Started</span>
                  <span class="leg-item"><span class="dot-sw" style="background: var(--green);"></span> Completed</span>
                  <span class="leg-item"><span class="dot-sw" style="background: var(--red);"></span> Failed</span>
                </div>
              </div>

              <!-- High-density Throughput Summary Metric Strip -->
              <div class="tp-summary-strip">
                <div class="tp-stat">
                  <span class="tp-stat-val" style="color: var(--blue);">{{ throughputTotals().started }}</span>
                  <span class="tp-stat-lbl">Total Started</span>
                </div>
                <div class="tp-stat-sep"></div>
                <div class="tp-stat">
                  <span class="tp-stat-val" style="color: var(--green);">{{ throughputTotals().completed }}</span>
                  <span class="tp-stat-lbl">Completed</span>
                </div>
                <div class="tp-stat-sep"></div>
                <div class="tp-stat">
                  <span class="tp-stat-val" [class.red]="throughputTotals().failed > 0">{{ throughputTotals().failed }}</span>
                  <span class="tp-stat-lbl">Failed</span>
                </div>
                <div class="tp-stat-sep"></div>
                <div class="tp-stat">
                  <span class="tp-stat-val">{{ throughputTotals().totalVolume }}</span>
                  <span class="tp-stat-lbl">Total Volume</span>
                </div>
                <div class="tp-stat-sep"></div>
                <div class="tp-stat">
                  <span class="tp-stat-val" [style.color]="throughputTotals().successRate >= 90 ? 'var(--green)' : throughputTotals().successRate >= 75 ? 'var(--amber)' : 'var(--red)'">
                    {{ throughputTotals().successRate }}%
                  </span>
                  <span class="tp-stat-lbl">Success Rate</span>
                </div>
                @if (throughputTotals().peakDay) {
                  <div class="tp-stat-sep"></div>
                  <div class="tp-stat">
                    <span class="tp-stat-val">{{ throughputTotals().peakVal }}</span>
                    <span class="tp-stat-lbl">Peak ({{ formatDayLabel(throughputTotals().peakDay) }})</span>
                  </div>
                }
              </div>

              <div class="tp-chart-container">
                <!-- Y-Axis Numeric Scale -->
                <div class="tp-y-axis">
                  @for (tick of throughputYScale().ticks; track $index) {
                    <span class="tp-y-tick">{{ tick }}</span>
                  }
                </div>

                <!-- Plot Area with horizontal gridlines and bar columns -->
                <div class="tp-plot-area">
                  <div class="tp-gridlines">
                    @for (tick of throughputYScale().ticks; track $index) {
                      <div class="tp-gridline" [style.top.%]="$index * 25"></div>
                    }
                  </div>

                  <div class="tp-columns" [class.active-view]="throughputViewMode() === 'active'">
                    @for (d of displayedThroughput(); track d.date) {
                      <div class="tp-col"
                           [class.active-day]="(d.started + d.completed + d.failed) > 0"
                           [class.is-hovered]="hoveredDay()?.date === d.date"
                           (mouseenter)="onHoverDay(d, $event)"
                           (mouseleave)="onLeaveDay()">
                        <!-- Day Total Count Badge -->
                        <div class="tp-col-header">
                          @if ((d.started + d.completed + d.failed) > 0) {
                            <span class="col-count-badge" title="Total instances on this date">
                              {{ d.started + d.completed + d.failed }}
                            </span>
                          } @else {
                            <span class="col-count-empty">·</span>
                          }
                        </div>

                        <!-- Bar cluster with value labels -->
                        <div class="tp-bars">
                          <div class="tp-bar-wrapper">
                            @if (d.started > 0) {
                              <span class="tp-bar-val blue">{{ d.started }}</span>
                              <div class="tp-bar blue" [style.height.%]="pctOfThroughput(d.started)"></div>
                            } @else {
                              <div class="tp-bar-zero"></div>
                            }
                          </div>
                          <div class="tp-bar-wrapper">
                            @if (d.completed > 0) {
                              <span class="tp-bar-val green">{{ d.completed }}</span>
                              <div class="tp-bar green" [style.height.%]="pctOfThroughput(d.completed)"></div>
                            } @else {
                              <div class="tp-bar-zero"></div>
                            }
                          </div>
                          <div class="tp-bar-wrapper">
                            @if (d.failed > 0) {
                              <span class="tp-bar-val red">{{ d.failed }}</span>
                              <div class="tp-bar red" [style.height.%]="pctOfThroughput(d.failed)"></div>
                            } @else {
                              <div class="tp-bar-zero"></div>
                            }
                          </div>
                        </div>

                        <span class="tp-label">{{ formatDayLabel(d.date) }}</span>
                      </div>
                    }
                  </div>

                  <!-- Floating Tooltip on Hover -->
                  @if (hoveredDay()) {
                    <div class="tp-floating-tooltip" [style.left.px]="tooltipX()" [style.top.px]="tooltipY()">
                      <div class="tp-tt-head">
                        <span class="tp-tt-date">{{ formatFullDate(hoveredDay()!.date) }}</span>
                        <span class="tp-tt-total-pill">{{ hoveredDay()!.started + hoveredDay()!.completed + hoveredDay()!.failed }} Total</span>
                      </div>
                      <div class="tp-tt-body">
                        <div class="tp-tt-row">
                          <span class="dot-sw" style="background: var(--blue);"></span>
                          <span class="tp-tt-name">Started Instances:</span>
                          <span class="tp-tt-num blue">{{ hoveredDay()!.started }}</span>
                        </div>
                        <div class="tp-tt-row">
                          <span class="dot-sw" style="background: var(--green);"></span>
                          <span class="tp-tt-name">Completed:</span>
                          <span class="tp-tt-num green">{{ hoveredDay()!.completed }}</span>
                        </div>
                        <div class="tp-tt-row">
                          <span class="dot-sw" style="background: var(--red);"></span>
                          <span class="tp-tt-name">Failed / Errors:</span>
                          <span class="tp-tt-num red">{{ hoveredDay()!.failed }}</span>
                        </div>
                        @if (hoveredDay()!.completed + hoveredDay()!.failed > 0) {
                          <div class="tp-tt-divider"></div>
                          <div class="tp-tt-row small muted">
                            <span>Success Rate:</span>
                            <span class="tp-tt-num">{{ calcDaySuccessRate(hoveredDay()!) }}%</span>
                          </div>
                        }
                      </div>
                    </div>
                  }
                </div>
              </div>
            </section>
          }

          <div class="chartgrid">
            <section class="card chart">
              <div class="row charthead">
                <h3>Instances by Status</h3>
                <div class="spacer"></div>
                <span class="muted small tnum">{{ instTotal() }} total</span>
              </div>
              <p class="chartsub">Every process instance recorded by the execution engine</p>
              @if (instTotal() > 0) {
                <div class="barlist">
                  @for (r of instStatusRows(); track r.key) {
                    <div class="barrow">
                      <div class="row lab">
                        <span class="dot" [style.background]="r.color"></span>
                        <span>{{ r.label }}</span>
                        <div class="spacer"></div>
                        <span class="tnum muted">{{ r.count }}</span>
                      </div>
                      <div class="track"><span [style.width.%]="r.pctOfMax" [style.background]="r.color"></span></div>
                    </div>
                  }
                </div>
              } @else {
                <p class="nodata">No instances yet.</p>
              }
            </section>

            <section class="card chart donutcard">
              <div class="row charthead"><h3>Status Distribution</h3></div>
              @if (instTotal() > 0) {
                <div class="donutwrap">
                  <div class="donut" [style.background]="instDonut()" role="img" aria-label="Instance status distribution">
                    <div class="hole"><span class="tnum">{{ instTotal() }}</span></div>
                  </div>
                  <div class="legend">
                    @for (r of nonZero(instStatusRows()); track r.key) {
                      <div class="li"><span class="sw" [style.background]="r.color"></span> {{ r.label }} · {{ r.share }}%</div>
                    }
                  </div>
                </div>
              } @else {
                <p class="nodata">Nothing to chart yet.</p>
              }
            </section>
          </div>

          <section class="card tablecard">
            <div class="row cardhead">
              <h3>Duration by Process Definition</h3>
              <div class="spacer"></div>
              <input class="search-input" [(ngModel)]="procSearch" placeholder="Search processes…" />
            </div>
            @if (filteredProcesses().length) {
              <table>
                <thead>
                  <tr>
                    <th>Process Definition</th>
                    <th class="num">Executions</th>
                    <th class="num">Avg Turnaround</th>
                    <th class="num">Min</th>
                    <th class="num">Max</th>
                    <th class="num">Action</th>
                  </tr>
                </thead>
                <tbody>
                  @for (p of filteredProcesses(); track p.processId) {
                    <tr>
                      <td>
                        <span class="font-bold">{{ p.processId }}</span>
                      </td>
                      <td class="num tnum">{{ p.count }}</td>
                      <td class="num">
                        <span class="avgcell">
                          <span class="avgbar"><span [style.width.%]="pctOf(p.avgMs, maxProcAvg())"></span></span>
                          <span class="tnum">{{ ms(p.avgMs) }}</span>
                        </span>
                      </td>
                      <td class="num tnum muted">{{ ms(p.minMs) }}</td>
                      <td class="num tnum muted">{{ ms(p.maxMs) }}</td>
                      <td class="num">
                        <a class="btn sm" [routerLink]="['/instances']" [queryParams]="{processId: p.processId}">
                          View Instances →
                        </a>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            } @else {
              <p class="nodata pad">No completed instances match the current filters.</p>
            }
          </section>
        }

        <!-- ==================== TAB 3: TASKS & SLAS ==================== -->
        @if (tab() === 'tasks') {
          <!-- SLA Metrics Row -->
          <div class="sla-grid">
            <div class="card sla-card">
              <span class="sla-title">SLA Compliance Rate</span>
              <span class="sla-val" [style.color]="slaColor()">{{ slaRate() }}%</span>
              <span class="sla-sub">{{ tasks()?.sla?.onTime ?? 0 }} of {{ tasks()?.sla?.totalWithDue ?? 0 }} tasks met SLA</span>
            </div>
            <div class="card sla-card">
              <span class="sla-title">Overdue Tasks</span>
              <span class="sla-val" [class.red]="(tasks()?.sla?.overdue ?? 0) > 0">{{ tasks()?.sla?.overdue ?? 0 }}</span>
              <span class="sla-sub">Open tasks past due deadline</span>
            </div>
            <div class="card sla-card">
              <span class="sla-title">Total Open Queue</span>
              <span class="sla-val amber">{{ openTotal() }}</span>
              <span class="sla-sub">Tasks currently waiting on humans</span>
            </div>
            <div class="card sla-card">
              <span class="sla-title">Active Queues</span>
              <span class="sla-val" style="color: var(--purple);">{{ taskGroups().length }}</span>
              <span class="sla-sub">Distinct candidate group queues</span>
            </div>
          </div>

          <div class="chartgrid">
            <section class="card chart">
              <div class="row charthead">
                <h3>Open Tasks by Status</h3>
                <div class="spacer"></div>
                <span class="muted small tnum">{{ openTotal() }} open</span>
              </div>
              <p class="chartsub">Current human queue across all groups and assignees</p>
              @if (openTotal() > 0) {
                <div class="barlist">
                  @for (r of taskStatusRows(); track r.key) {
                    <div class="barrow">
                      <div class="row lab">
                        <span class="dot" [style.background]="r.color"></span>
                        <span>{{ r.label }}</span>
                        <div class="spacer"></div>
                        <span class="tnum muted">{{ r.count }}</span>
                      </div>
                      <div class="track"><span [style.width.%]="r.pctOfMax" [style.background]="r.color"></span></div>
                    </div>
                  }
                </div>
              } @else {
                <p class="nodata">No open tasks right now — all work is completed.</p>
              }
            </section>

            <section class="card chart donutcard">
              <div class="row charthead"><h3>Task State Mix</h3></div>
              @if (openTotal() > 0) {
                <div class="donutwrap">
                  <div class="donut" [style.background]="taskDonut()" role="img" aria-label="Open task status distribution">
                    <div class="hole"><span class="tnum">{{ openTotal() }}</span></div>
                  </div>
                  <div class="legend">
                    @for (r of nonZero(taskStatusRows()); track r.key) {
                      <div class="li"><span class="sw" [style.background]="r.color"></span> {{ r.label }} · {{ r.share }}%</div>
                    }
                  </div>
                </div>
              } @else {
                <p class="nodata">Nothing to chart yet.</p>
              }
            </section>
          </div>

          <!-- Group Queues Breakdown -->
          @if (taskGroups().length > 0) {
            <section class="card pad" style="margin-bottom: 16px;">
              <div class="row charthead">
                <h3>Open Workload by Group Queue</h3>
                <div class="spacer"></div>
                <span class="muted small">Team responsibility queues</span>
              </div>
              <div class="group-chips">
                @for (g of taskGroups(); track g.group) {
                  <div class="group-chip">
                    <span class="g-name"><app-icon name="user" [size]="12" /> {{ g.group }}</span>
                    <span class="g-count">{{ g.count }}</span>
                  </div>
                }
              </div>
            </section>
          }

          <div class="two-col">
            <section class="card tablecard">
              <div class="row cardhead"><h3>Open Tasks by Assignee</h3></div>
              @if (byAssignee().length) {
                <table>
                  <thead><tr><th>Assignee</th><th class="num">Open Tasks</th><th style="width: 120px;">Load Ratio</th></tr></thead>
                  <tbody>
                    @for (a of byAssignee(); track a.user) {
                      <tr>
                        <td><b>{{ a.user || '(unassigned)' }}</b></td>
                        <td class="num tnum">{{ a.count }}</td>
                        <td>
                          <span class="avgcell">
                            <span class="avgbar"><span [style.width.%]="loadRatio(a.count) * 100" [style.background]="loadColor(a.count)"></span></span>
                          </span>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p class="nodata pad">No assigned tasks right now.</p>
              }
            </section>

            <section class="card tablecard">
              <div class="row cardhead">
                <h3>Duration by User Task</h3>
                <div class="spacer"></div>
                <input class="search-input sm" [(ngModel)]="taskSearch" placeholder="Filter tasks…" />
              </div>
              @if (filteredTasks().length) {
                <table>
                  <thead><tr><th>Task Name</th><th class="num">Completed</th><th class="num">Avg Turnaround</th></tr></thead>
                  <tbody>
                    @for (t of filteredTasks(); track t.name) {
                      <tr>
                        <td><b>{{ t.name }}</b></td>
                        <td class="num tnum">{{ t.count }}</td>
                        <td class="num">
                          <span class="avgcell">
                            <span class="avgbar"><span [style.width.%]="pctOf(t.avgMs, maxTaskAvg())"></span></span>
                            <span class="tnum">{{ ms(t.avgMs) }}</span>
                          </span>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p class="nodata pad">No completed human tasks match the search.</p>
              }
            </section>
          </div>
        }

        <!-- ==================== TAB 4: CASES & WORKFLOWS ==================== -->
        @if (tab() === 'cases') {
          <div class="grid" style="margin-bottom: 20px;">
            <div class="card pad">
              <div class="row charthead">
                <h3>Cases by Status</h3>
                <div class="spacer"></div>
                <span class="muted small">{{ caseSummary()?.total ?? 0 }} total</span>
              </div>
              <p class="big">{{ caseSummary()?.total ?? 0 }}</p>
              @if (caseSummary(); as s) {
                <div class="barlist" style="margin-top: 12px;">
                  @for (kv of statusEntries(s.byStatus); track kv[0]) {
                    <div class="barrow">
                      <div class="row lab">
                        <span>{{ kv[0] }}</span>
                        <div class="spacer"></div>
                        <span class="tnum font-bold">{{ kv[1] }}</span>
                      </div>
                      <div class="track"><span [style.width.%]="caseStatusPct(kv[1])" style="background: var(--blue);"></span></div>
                    </div>
                  }
                </div>
                @if (s.withoutPiid) {
                  <p class="muted sm" style="margin-top: 12px;"><app-icon name="warning" [size]="12" /> {{ s.withoutPiid }} cases initiated without BPM execution binding</p>
                }
              } @else {
                <p class="muted">Loading case summary…</p>
              }
            </div>

            <div class="card pad">
              <div class="row charthead">
                <h3>Case Lifecycle Ratio</h3>
              </div>
              <div class="lifecycle-stats" style="margin-top: 16px;">
                <div class="lc-item">
                  <span class="lc-val" style="color: var(--blue);">{{ caseSummary()?.activeCases ?? 0 }}</span>
                  <span class="lc-lbl">In-Flight / Active</span>
                </div>
                <div class="lc-item">
                  <span class="lc-val" style="color: var(--green);">{{ caseSummary()?.closedCases ?? 0 }}</span>
                  <span class="lc-lbl">Resolved / Closed</span>
                </div>
              </div>
              <div class="track" style="margin-top: 14px; height: 10px;">
                <span [style.width.%]="activeCaseRatio()" style="background: var(--blue); border-radius: 4px;"></span>
              </div>
              <p class="muted sm" style="margin-top: 8px;">{{ activeCaseRatio() }}% of total cases are currently active</p>
            </div>

            <div class="card pad">
              <div class="row charthead">
                <h3>Cases by Workflow Definition</h3>
              </div>
              <div class="barlist" style="margin-top: 12px;">
                @for (kv of statusEntries(caseSummary()?.byWorkflowName || {}); track kv[0]) {
                  <div class="barrow">
                    <div class="row lab">
                      <span class="font-bold">{{ kv[0] }}</span>
                      <div class="spacer"></div>
                      <span class="tnum">{{ kv[1] }}</span>
                    </div>
                    <div class="track"><span [style.width.%]="caseWorkflowPct(kv[1])" style="background: var(--purple);"></span></div>
                  </div>
                }
                @if (!statusEntries(caseSummary()?.byWorkflowName || {}).length) {
                  <p class="nodata">No cases recorded yet.</p>
                }
              </div>
            </div>
          </div>

          <div class="two-col">
            <section class="card tablecard">
              <div class="row cardhead">
                <h3>Turnaround Time (TAT) by Workflow Definition</h3>
                <div class="spacer"></div>
                <input class="search-input sm" [(ngModel)]="caseSearch" placeholder="Filter workflows…" />
              </div>
              @if (filteredTatWorkflows().length) {
                <table>
                  <thead><tr><th>Workflow Definition</th><th class="num">Completed</th><th class="num">Avg TAT</th><th class="num">Max</th></tr></thead>
                  <tbody>
                    @for (r of filteredTatWorkflows(); track r.workflowName) {
                      <tr>
                        <td><b>{{ r.workflowName }}</b></td>
                        <td class="num tnum">{{ r.count }}</td>
                        <td class="num">
                          <span class="avgcell">
                            <span class="avgbar"><span [style.width.%]="pctOf(r.avgMs, maxCaseAvg())"></span></span>
                            <span class="tnum">{{ ms(r.avgMs) }}</span>
                          </span>
                        </td>
                        <td class="num tnum muted">{{ ms(r.maxMs) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p class="nodata pad">No completed cases recorded yet.</p>
              }
            </section>

            <section class="card tablecard">
              <div class="row cardhead">
                <h3>Human Execution TAT by User</h3>
                <div class="spacer"></div>
                <span class="muted small">Assigned user turnaround speed</span>
              </div>
              @if (tat()?.byUser?.length) {
                <table>
                  <thead><tr><th>User / Assignee</th><th class="num">Tasks</th><th class="num">Avg Speed</th></tr></thead>
                  <tbody>
                    @for (u of tat()?.byUser || []; track u.user) {
                      <tr>
                        <td><b>{{ u.user || '(unassigned)' }}</b></td>
                        <td class="num tnum">{{ u.count }}</td>
                        <td class="num"><span class="tnum font-bold">{{ ms(u.avgMs) }}</span></td>
                      </tr>
                    }
                  </tbody>
                </table>
              } @else {
                <p class="nodata pad">No completed user tasks recorded yet.</p>
              }
            </section>
          </div>
        }

        <!-- ==================== TAB 5: AD-HOC QUERIES ==================== -->
        @if (tab() === 'queries') {
          <div class="query-builder-wrap">
            <div class="row charthead" style="margin-bottom: 12px;">
              <div>
                <h2>Enterprise Ad-Hoc Query Engine</h2>
                <p class="chartsub">Query process executions, human tasks, cases, audit trails, and comments with tenant isolation.</p>
              </div>
              <div class="spacer"></div>
              <div class="presets">
                <span class="muted sm">Quick Presets:</span>
                <button class="btn sm" (click)="loadPreset('overdueTasks')">Overdue Tasks</button>
                <button class="btn sm" (click)="loadPreset('activeCases')">Active Cases</button>
                <button class="btn sm" (click)="loadPreset('failedInst')">Failed Instances</button>
              </div>
            </div>

            <div class="card pad" style="margin-bottom: 20px;">
              <div class="row" style="flex-wrap: wrap; gap: 12px; margin-bottom: 12px;">
                <label class="fld"><span>Entity</span>
                  <select [(ngModel)]="entity">@for (e of entities; track e) { <option [value]="e">{{ e }}</option> }</select>
                </label>
                <label class="fld"><span>Group by (optional)</span>
                  <input [(ngModel)]="groupBy" placeholder="e.g. status, data.amount" />
                </label>
                <label class="fld"><span>Metric</span>
                  <select [(ngModel)]="metric">
                    <option value="">(none — list rows)</option>
                    <option value="count">count</option>
                    <option value="avgDurationMs">avgDurationMs</option>
                  </select>
                </label>
                @if (metric === 'avgDurationMs') {
                  <label class="fld"><span>Duration from field</span><input [(ngModel)]="durationFrom" placeholder="createdAt" /></label>
                  <label class="fld"><span>Duration to field</span><input [(ngModel)]="durationTo" placeholder="updatedAt" /></label>
                }
              </div>

              <div class="section-title">Filters</div>
              @for (f of filters; track f) {
                <div class="fieldrow">
                  <input class="fkey" [(ngModel)]="f.field" placeholder="field, e.g. status or data.amount" />
                  <select [(ngModel)]="f.op">@for (o of ops; track o) { <option [value]="o">{{ o }}</option> }</select>
                  <input [(ngModel)]="f.value" placeholder="value" />
                  <button class="btn sm danger" (click)="removeFilter(f)"><app-icon name="trash" [size]="12" /></button>
                </div>
              }
              <div style="margin-bottom: 14px;">
                <button class="btn sm" (click)="addFilter()"><app-icon name="plus" [size]="12" /> Add filter</button>
              </div>

              <div class="row actionrow">
                <button class="btn primary sm" (click)="runQuery()" [disabled]="runningQuery()">
                  <app-icon name="play" [size]="12" /> {{ runningQuery() ? 'Running...' : 'Run Query' }}
                </button>
                <input class="save-name" [(ngModel)]="saveName" placeholder="Save as…" style="max-width: 200px;" />
                <label class="reqlbl"><input type="checkbox" [(ngModel)]="saveShared" /> Shared</label>
                <button class="btn sm" (click)="saveQuery()">Save Query</button>
              </div>
              @if (queryError()) { <p class="err">{{ queryError() }}</p> }

              <!-- Query Results -->
              @if (queryResult(); as r) {
                <div style="margin-top: 20px; border-top: 1px solid var(--border); padding-top: 16px;">
                  <div class="row" style="margin-bottom: 10px;">
                    <div class="section-title" style="margin: 0;">Query Results</div>
                    <span class="spacer"></span>
                    @if (r.rows) {
                      <div class="btn-group sm">
                        <button class="btn sm" [class.primary]="queryViewMode() === 'table'" (click)="queryViewMode.set('table')">Table</button>
                        <button class="btn sm" [class.primary]="queryViewMode() === 'json'" (click)="queryViewMode.set('json')">JSON</button>
                      </div>
                    }
                    <button class="btn sm" (click)="exportQueryResults()">
                      <app-icon name="download" [size]="12" /> Export Results
                    </button>
                  </div>

                  @if (r.groups) {
                    <table class="restbl">
                      <thead><tr><th>Key</th><th class="num">Count</th>@if (metric==='avgDurationMs') { <th class="num">Avg ms</th> }</tr></thead>
                      <tbody>
                        @for (g of r.groups; track g.key) {
                          <tr>
                            <td><b>{{ g.key }}</b></td>
                            <td class="num tnum font-bold">{{ g.count }}</td>
                            @if (metric==='avgDurationMs') { <td class="num tnum">{{ g.avgDurationMs }} ms</td> }
                          </tr>
                        }
                      </tbody>
                    </table>
                  } @else if (r.rows) {
                    @if (queryViewMode() === 'table') {
                      <div class="query-table-wrap">
                        <table class="restbl">
                          <thead>
                            <tr>
                              @for (col of queryColumns(); track col) {
                                <th>{{ col }}</th>
                              }
                            </tr>
                          </thead>
                          <tbody>
                            @for (row of r.rows; track row['id'] || $index) {
                              <tr>
                                @for (col of queryColumns(); track col) {
                                  <td>
                                    @if (col === 'id') {
                                      <span class="mono tnum font-bold">{{ formatColVal(row[col]) }}</span>
                                    } @else if (col === 'status') {
                                      <span class="badge" [style.color]="statusColor(formatColVal(row[col]))">{{ formatColVal(row[col]) }}</span>
                                    } @else {
                                      <span>{{ formatColVal(row[col]) }}</span>
                                    }
                                  </td>
                                }
                              </tr>
                            }
                          </tbody>
                        </table>
                      </div>
                      <p class="muted sm" style="margin-top: 8px;">Showing {{ r.rows.length }} result rows</p>
                    } @else {
                      <pre class="mono sm restext">{{ r.rows | json }}</pre>
                    }
                  }
                </div>
              }
            </div>

            <h2 class="section-h">Saved Queries</h2>
            <div class="card pad">
              @if (savedQueries().length === 0) {
                <p class="muted sm">No saved queries yet. Configure a query above and save it to access it anytime.</p>
              } @else {
                @for (sq of savedQueries(); track sq.id) {
                  <div class="sqrow">
                    <div>
                      <strong>{{ sq.name }}</strong>
                      <span class="muted sm"> · {{ sq.definition.entity }} · by {{ sq.createdBy }}</span>
                    </div>
                    <div class="row" style="gap: 6px;">
                      <button class="btn sm" (click)="loadSavedQuery(sq)">Load</button>
                      <button class="btn sm danger" (click)="deleteSavedQuery(sq)"><app-icon name="trash" [size]="12" /></button>
                    </div>
                  </div>
                }
              }
            </div>
          </div>
        }
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
                <textarea rows="4" [(ngModel)]="sc.workflowData" placeholder='{"claimNumber": "CLM-1001", "amount": 1500}'></textarea>
              </label>
              <label class="fld">
                <span>Process Variables (JSON, optional)</span>
                <textarea rows="3" [(ngModel)]="sc.variables" placeholder='{"priority": "high"}'></textarea>
              </label>
              @if (startCaseError()) { <p class="err">{{ startCaseError() }}</p> }
              <button class="btn primary full" [disabled]="startingCaseLoading()" (click)="submitStartCase()">
                {{ startingCaseLoading() ? 'Starting...' : 'Start Case' }}
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .page { padding: 14px 16px 24px; display: flex; flex-direction: column; gap: 16px; max-width: 1400px; margin: 0 auto; }
    .head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
    h1 { font-size: var(--text-xl); letter-spacing: -.03em; font-weight: 650; margin: 0 0 4px; }
    .sub { margin: 0; color: var(--text-secondary); font-size: 13.5px; }
    .spacer { flex: 1; }

    /* Filter Bar */
    .filter-bar { display: flex; align-items: center; justify-content: space-between; padding: 10px 16px; gap: 14px; flex-wrap: wrap; background: var(--surface); }
    .filter-group { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .f-label { font-size: 11.5px; font-weight: 700; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; display: inline-flex; align-items: center; gap: 4px; }
    .pills { display: flex; gap: 4px; background: var(--surface-2); padding: 3px; border-radius: var(--radius-pill); flex-wrap: wrap; }
    .pill { border: none; background: transparent; padding: 5px 12px; font-size: 12px; font-weight: 600; color: var(--text-secondary); border-radius: var(--radius-pill); cursor: pointer; transition: all .15s ease; }
    .pill.active { background: var(--surface); color: var(--text); font-weight: 700; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
    .date-range-group { display: flex; align-items: center; gap: 6px; }
    .date-inputs { display: inline-flex; align-items: center; gap: 6px; }
    .date-inputs input[type="date"] { border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 12px; background: var(--surface); color: inherit; font-family: inherit; }
    .to-sep { font-size: 12px; color: var(--muted); }
    .range-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; background: var(--primary-50); color: var(--primary); padding: 3px 8px; border-radius: var(--radius-pill); border: 1px solid rgba(99,102,241,0.2); }
    .filter-group select { border: 1px solid var(--border); border-radius: 6px; padding: 5px 10px; font-size: 12.5px; background: var(--surface); color: inherit; }

    /* KPIs */
    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
    .kpi { position: relative; overflow: hidden; padding: 16px 18px 14px; display: flex; flex-direction: column-reverse; gap: 6px; text-decoration: none; color: inherit; }
    .grad { background: var(--grad-brand); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .kpi .n { font-size: var(--text-2xl); line-height: 1.1; font-weight: 650; letter-spacing: -.035em; font-variant-numeric: tabular-nums; }
    .kpi .n.amber { color: var(--amber); } .kpi .n.red { color: var(--red); }
    .kpi .l { font-size: 13px; font-weight: 500; color: var(--text-secondary); }
    .loadfail { display: flex; align-items: center; gap: 12px; margin: 0 0 14px; padding: 10px 14px; border-radius: 10px; font-size: 13px; background: var(--red-bg, #fdecea); color: var(--red, #b3261e); }

    /* SLAs */
    .sla-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin-bottom: 14px; }
    .sla-card { padding: 14px 16px; display: flex; flex-direction: column; gap: 2px; }
    .sla-title { font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); }
    .sla-val { font-size: 24px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .sla-sub { font-size: 11.5px; color: var(--muted); }

    /* Throughput Timeline Chart & Detailed Metrics */
    .full-width { grid-column: 1 / -1; }
    .chart-legend-inline { display: flex; align-items: center; gap: 14px; font-size: 12px; color: var(--text-secondary); }
    .leg-item { display: inline-flex; align-items: center; gap: 5px; }
    .dot-sw { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }

    /* View mode button group */
    .view-mode-toggle { display: inline-flex; align-items: center; background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 2px; gap: 2px; }
    .vm-btn { border: none; background: transparent; font-size: 11px; font-weight: 500; color: var(--text-secondary); padding: 3px 10px; border-radius: 4px; cursor: pointer; transition: all .15s ease; }
    .vm-btn:hover { color: var(--text-primary); }
    .vm-btn.active { background: var(--surface); color: var(--text-primary); font-weight: 700; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); }

    /* High-density summary strip */
    .tp-summary-strip { display: flex; align-items: center; gap: 18px; padding: 10px 16px; margin: 6px 0 14px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; flex-wrap: wrap; }
    .tp-stat { display: flex; flex-direction: column; gap: 2px; }
    .tp-stat-val { font-size: 15px; font-weight: 800; font-variant-numeric: tabular-nums; line-height: 1.1; color: var(--text-primary); }
    .tp-stat-val.red { color: var(--red); }
    .tp-stat-lbl { font-size: 10.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); }
    .tp-stat-sep { width: 1px; height: 22px; background: var(--border); }

    /* Chart Container with Y-Axis and Plot Area */
    .tp-chart-container { display: flex; position: relative; height: 235px; padding: 4px 12px 6px 0; border-bottom: 1px solid var(--border); }
    .tp-y-axis { display: flex; flex-direction: column; justify-content: space-between; width: 44px; height: 160px; margin-top: 28px; padding-right: 8px; text-align: right; flex-shrink: 0; user-select: none; }
    .tp-y-tick { font-size: 10.5px; font-weight: 600; color: var(--muted); line-height: 1; font-variant-numeric: tabular-nums; }
    .tp-plot-area { position: relative; flex: 1; height: 100%; display: flex; flex-direction: column; overflow-x: auto; }
    .tp-gridlines { position: absolute; top: 28px; left: 0; right: 0; height: 160px; pointer-events: none; }
    .tp-gridline { position: absolute; left: 0; right: 0; border-bottom: 1px dashed var(--border); opacity: .7; }

    /* Columns and Bars */
    .tp-columns { position: relative; display: flex; align-items: flex-end; gap: 8px; height: 100%; width: 100%; z-index: 2; }
    .tp-col { flex: 1; min-width: 32px; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; cursor: pointer; border-radius: 6px; padding: 0 4px; transition: background-color .15s ease; }
    .tp-col:hover, .tp-col.is-hovered { background: rgba(59, 130, 246, 0.08); }
    .tp-col-header { height: 28px; display: flex; align-items: center; justify-content: center; }
    .col-count-badge { font-size: 10px; font-weight: 700; color: var(--text-primary); background: var(--surface-3); padding: 1px 6px; border-radius: 10px; letter-spacing: -.02em; white-space: nowrap; }
    .col-count-empty { color: var(--border); font-size: 14px; line-height: 1; }

    .tp-bars { display: flex; align-items: flex-end; gap: 3px; height: 160px; width: 100%; justify-content: center; }
    .tp-bar-wrapper { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; flex: 1; max-width: 22px; }
    .tp-bar-val { font-size: 9px; font-weight: 700; margin-bottom: 2px; white-space: nowrap; font-variant-numeric: tabular-nums; opacity: 0; transition: opacity .15s ease; }
    .tp-col:hover .tp-bar-val, .tp-col.is-hovered .tp-bar-val, .tp-columns.active-view .tp-bar-val { opacity: 1; }
    .tp-bar-val.blue { color: var(--blue); }
    .tp-bar-val.green { color: var(--green); }
    .tp-bar-val.red { color: var(--red); }

    .tp-bar { width: 100%; border-radius: 3px 3px 0 0; min-height: 2px; transition: height .25s cubic-bezier(0.4, 0, 0.2, 1); }
    .tp-bar.blue { background: var(--blue); }
    .tp-bar.green { background: var(--green); }
    .tp-bar.red { background: var(--red); }
    .tp-bar-zero { width: 100%; height: 2px; background: var(--border); opacity: .35; border-radius: 1px; }
    .tp-label { font-size: 10.5px; color: var(--muted); margin-top: 6px; height: 18px; white-space: nowrap; font-weight: 500; }
    .tp-col:hover .tp-label, .tp-col.is-hovered .tp-label { color: var(--text-primary); font-weight: 700; }

    /* Interactive Floating Tooltip */
    .tp-floating-tooltip { position: absolute; top: 6px; transform: translateX(-50%); z-index: 30; pointer-events: none; background: var(--surface); border: 1px solid var(--border); box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.15), 0 8px 10px -6px rgba(0, 0, 0, 0.1); border-radius: 8px; padding: 10px 14px; min-width: 210px; font-size: 12px; animation: tpFadeIn .12s ease-out; }
    @keyframes tpFadeIn { from { opacity: 0; transform: translate(-50%, -4px); } to { opacity: 1; transform: translate(-50%, 0); } }
    .tp-tt-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 6px; margin-bottom: 6px; border-bottom: 1px solid var(--border); }
    .tp-tt-date { font-weight: 700; font-size: 12px; color: var(--text-primary); }
    .tp-tt-total-pill { font-size: 10px; font-weight: 700; background: var(--surface-3); color: var(--text-primary); padding: 1px 7px; border-radius: 10px; }
    .tp-tt-body { display: flex; flex-direction: column; gap: 4px; }
    .tp-tt-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; }
    .tp-tt-name { color: var(--text-secondary); flex: 1; }
    .tp-tt-num { font-weight: 700; font-variant-numeric: tabular-nums; }
    .tp-tt-num.blue { color: var(--blue); }
    .tp-tt-num.green { color: var(--green); }
    .tp-tt-num.red { color: var(--red); }
    .tp-tt-divider { height: 1px; background: var(--border); margin: 3px 0; }

    /* Charts */
    .chartgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 900px) { .chartgrid { grid-template-columns: 1fr; } }
    .chart { padding: 18px; }
    .charthead { display: flex; align-items: center; margin-bottom: 2px; }
    .charthead h3 { font-size: 14px; margin: 0; }
    .chartsub { font-size: 12px; color: var(--muted); margin: 0 0 12px; }
    .barlist { display: flex; flex-direction: column; gap: 10px; }
    .lab { font-size: 12.5px; margin-bottom: 3px; display: flex; align-items: center; gap: 6px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .track { width: 100%; height: 6px; background: var(--surface-3); border-radius: var(--radius-pill); overflow: hidden; }
    .track span { display: block; height: 100%; border-radius: var(--radius-pill); transition: width .3s ease; }
    .nodata { color: var(--muted); font-size: 12.5px; padding: 20px 0; text-align: center; }

    /* Donut */
    .donutcard .donutwrap { display: flex; align-items: center; gap: 24px; padding: 10px 0; }
    .donut { width: 120px; height: 120px; border-radius: 50%; display: grid; place-items: center; flex-shrink: 0; }
    .hole { width: 76px; height: 76px; border-radius: 50%; background: var(--surface); display: grid; place-items: center; font-weight: 650; font-size: 18px; }
    .legend { display: flex; flex-direction: column; gap: 8px; font-size: 12.5px; color: var(--text-secondary); }
    .legend .li { display: flex; align-items: center; gap: 7px; }
    .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex-shrink: 0; }

    /* Panels & Lists */
    .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; align-items: start; }
    .panel { padding: 18px 20px; }
    .p-head { display: flex; align-items: center; margin-bottom: 10px; }
    h2 { font-size: var(--text-lg); margin: 0; }
    .link { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-xs); color: var(--primary); font-weight: 600; text-decoration: none; }
    .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
    .rows a { display: flex; align-items: center; gap: 9px; padding: 9px 10px; border-radius: var(--radius-sm); font-size: var(--text-sm); color: var(--text); text-decoration: none; }
    .rows a:hover { background: var(--surface-3); }
    .tname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .when { font-size: var(--text-xs); text-transform: capitalize; }
    .due { font-size: var(--text-xs); font-weight: 600; padding: 3px 9px; border-radius: var(--radius-pill); background: var(--green-bg); color: var(--green); white-space: nowrap; }
    .due.over { background: var(--red-bg); color: var(--red); }
    .case-chip-sm { display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; border-radius: 10px; background: rgba(59,130,246,0.12); color: #2563eb; font-size: 11px; font-family: var(--font-mono); font-weight: 600; }
    .empty-state.sm { padding: 26px 12px; text-align: center; }

    /* Tables */
    .tablecard { overflow: hidden; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    @media (max-width: 900px) { .two-col { grid-template-columns: 1fr; } }
    .cardhead { padding: 14px 16px 10px; display: flex; align-items: center; }
    .cardhead h3 { font-size: 14px; margin: 0; }
    .search-input { border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; font-size: 12px; background: var(--surface); color: inherit; width: 180px; }
    .search-input.sm { width: 130px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 9px 14px; font-size: 12.5px; border-bottom: 1px solid var(--border); }
    th.num, td.num { text-align: right; }
    .avgcell { display: inline-flex; align-items: center; gap: 8px; }
    .avgbar { width: 64px; height: 6px; background: var(--surface-3); border-radius: var(--radius-pill); overflow: hidden; flex-shrink: 0; }
    .avgbar span { display: block; height: 100%; border-radius: var(--radius-pill); background: var(--grad-brand); }
    .pad { padding: 16px; }
    .small { font-size: 11.5px; }

    /* Groups */
    .group-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .group-chip { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; font-size: 12px; }
    .g-name { font-weight: 500; display: inline-flex; align-items: center; gap: 4px; }
    .g-count { font-weight: 700; background: var(--primary-50); color: var(--primary); padding: 2px 6px; border-radius: 10px; font-size: 11px; }

    /* Case metrics */
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 14px; }
    .big { font-size: 32px; font-weight: 700; margin: 4px 0 12px; }
    .lifecycle-stats { display: flex; gap: 24px; }
    .lc-item { display: flex; flex-direction: column; gap: 2px; }
    .lc-val { font-size: 24px; font-weight: 700; }
    .lc-lbl { font-size: 11.5px; color: var(--muted); }

    /* Query builder */
    .section-h { font-size: 15px; margin: 20px 0 10px; }
    .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; margin: 12px 0 6px; }
    .presets { display: flex; align-items: center; gap: 6px; }
    .fld { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
    .fld input, .fld select { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; background: var(--surface); color: inherit; }
    .fieldrow { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
    .fieldrow input, .fieldrow select { border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; font-size: 13px; background: var(--surface); color: inherit; }
    .fieldrow .fkey { width: 180px; }
    .actionrow { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
    .reqlbl { font-size: 12.5px; display: inline-flex; align-items: center; gap: 4px; }
    .restbl { width: 100%; margin-top: 8px; }
    .query-table-wrap { max-height: 380px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; margin-top: 8px; }
    .restext { background: var(--surface-2); padding: 12px; border-radius: 8px; max-height: 280px; overflow: auto; font-family: var(--font-mono); font-size: 12px; }
    .btn-group { display: inline-flex; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
    .btn-group .btn { border-radius: 0; border: none; }
    .sqrow { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border); }
    .sqrow:last-child { border-bottom: none; }
    .err { color: var(--red); font-size: 12px; margin-top: 6px; }
    .btn.danger { color: var(--red); }
    .font-bold { font-weight: 700; }
    .tnum { font-variant-numeric: tabular-nums; }
    .mono { font-family: var(--font-mono); font-size: 12px; }

    /* Modal */
    .modal-bg { position: fixed; inset: 0; background: rgba(16,24,40,.4); display: grid; place-items: center; z-index: 50; }
    .modal { background: var(--surface); border-radius: 14px; width: 480px; max-width: 92vw; max-height: 86vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: var(--shadow-pop); }
    .modal-h { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--border); font-weight: 700; }
    .modal-h .x { border: none; background: transparent; font-size: 16px; cursor: pointer; color: var(--muted); }
    .modal-body { padding: 16px 18px; overflow: auto; }
    .modal-body .fld { margin-bottom: 12px; }
    .modal-body textarea { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12px; font-family: var(--font-mono); background: var(--surface); color: inherit; }
    .modal-body select { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 13px; background: var(--surface); color: inherit; }
    .btn.full { width: 100%; justify-content: center; margin-top: 6px; }

    @media (max-width: 768px) {
      .page { padding: 12px 14px; }
      .head { flex-direction: column; align-items: stretch; gap: 12px; }
      .head .btn, .head a.btn { justify-content: center; }
      .filter-bar { flex-direction: column; align-items: stretch; gap: 10px; padding: 12px; }
      .filter-group { flex-direction: column; align-items: stretch; gap: 6px; width: 100%; }
      .filter-group select { width: 100%; }
      .pills { flex-wrap: wrap; width: 100%; }
      .pill { flex: 1 1 auto; text-align: center; }
      .date-inputs { flex-wrap: wrap; width: 100%; }
      .date-inputs input[type="date"] { flex: 1 1 110px; min-width: 0; width: auto; }
      .kpis { grid-template-columns: repeat(2, 1fr); gap: 8px; }
      .kpi { padding: 10px 12px; }
      .kpi .n { font-size: 20px; }
      .sla-grid { grid-template-columns: 1fr; }
      .cols { grid-template-columns: 1fr; }
      .donutcard .donutwrap { flex-direction: column; text-align: center; gap: 14px; }
      .tp-summary-strip { flex-direction: column; align-items: stretch; gap: 10px; }
      .tp-stat-sep { display: none; }
      .view-mode-toggle { width: 100%; justify-content: center; }
      .chart-legend-inline { flex-wrap: wrap; }
      .lifecycle-stats { flex-direction: column; gap: 10px; }
      .fieldrow { flex-direction: column; align-items: stretch; }
      .fieldrow .fkey { width: 100%; }
      .presets { flex-wrap: wrap; }
    }
      .vm-btn { white-space: nowrap; }
  `],
})
export class HomeComponent {
  auth = inject(AuthService);
  private q = inject(QueryApiService);
  private instApi = inject(InstanceApiService);
  private wfApi = inject(WorkflowApiService);
  private wfDefApi = inject(WorkflowDefinitionApiService);
  private wfInstApi = inject(WorkflowInstanceApiService);
  private analyticsApi = inject(WorkflowAnalyticsApiService);
  private toast = inject(ToastService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  tab = signal<HomeTab>('overview');
  timeWindow = signal<TimeWindow>('all');
  customFrom = signal<string>('');
  customTo = signal<string>('');
  selectedProcess = '';
  loading = signal(true);
  failed = signal(false);
  runningQuery = signal(false);

  // Search filter terms
  procSearch = '';
  taskSearch = '';
  caseSearch = '';
  queryViewMode = signal<'table' | 'json'>('table');

  summary = signal<Summary | null>(null);
  procs = signal<ProcessAnalytics | null>(null);
  tasks = signal<TaskAnalytics | null>(null);
  caseSummary = signal<WorkflowInstanceSummary | null>(null);
  tat = signal<WorkflowTat | null>(null);

  myTasks = signal<Task[]>([]);
  recent = signal<Instance[]>([]);
  workflows = signal<Workflow[]>([]);
  workflowDefinitions = signal<WorkflowDefinition[]>([]);

  // Ad-hoc query signals
  entities = ENTITIES;
  ops = OPS;
  entity: QueryableEntity = 'workflowInstance';
  groupBy = '';
  metric: 'count' | 'avgDurationMs' | '' = '';
  durationFrom = '';
  durationTo = '';
  filters: QueryFilter[] = [];
  queryResult = signal<QueryRunResult | null>(null);
  queryError = signal('');
  saveName = '';
  saveShared = false;
  savedQueries = signal<SavedQuery[]>([]);

  // Start case modal
  startingCase = signal<{ workflowName: string; variables: string; workflowData: string } | null>(null);
  startCaseError = signal('');
  startingCaseLoading = signal(false);

  // Throughput timeline chart state
  throughputViewMode = signal<'all' | 'active'>('all');
  hoveredDay = signal<{ date: string; started: number; completed: number; failed: number } | null>(null);
  tooltipX = signal<number>(0);
  tooltipY = signal<number>(0);

  canView = computed(() => this.auth.hasPermission('workflow:view'));
  canTasks = computed(() => this.auth.hasPermission('task:manage'));
  canBuild = computed(() => this.auth.hasPermission('workflow:edit'));

  // Filter parameter helpers
  private filterParams = computed(() => {
    const tw = this.timeWindow();
    let since: string | undefined;
    let from: string | undefined;
    let to: string | undefined;
    let days: number | undefined;
    const now = Date.now();

    if (tw === 'custom' || (this.customFrom() && this.customTo())) {
      from = this.customFrom().trim() || undefined;
      to = this.customTo().trim() || undefined;
    } else if (tw === '1d') {
      since = new Date(now - 86400000).toISOString();
      days = 1;
    } else if (tw === '7d') {
      since = new Date(now - 7 * 86400000).toISOString();
      days = 7;
    } else if (tw === '30d') {
      since = new Date(now - 30 * 86400000).toISOString();
      days = 30;
    } else if (tw === '90d') {
      since = new Date(now - 90 * 86400000).toISOString();
      days = 90;
    }

    return {
      since,
      from,
      to,
      days,
      processId: this.selectedProcess.trim() || undefined,
    };
  });

  isDateFiltered = computed(() => {
    return this.timeWindow() !== 'all' || !!this.customFrom() || !!this.customTo();
  });

  dateRangeLabel = computed(() => {
    if (this.customFrom() && this.customTo()) return `${this.customFrom()} to ${this.customTo()}`;
    if (this.customFrom()) return `Since ${this.customFrom()}`;
    if (this.customTo()) return `Until ${this.customTo()}`;
    const tw = this.timeWindow();
    if (tw === '1d') return 'Past 24 hours';
    if (tw === '7d') return 'Past 7 days';
    if (tw === '30d') return 'Past 30 days';
    if (tw === '90d') return 'Past 90 days';
    return 'All time';
  });

  availableProcesses = computed(() => {
    const set = new Set<string>();
    for (const w of this.workflows()) if (w.id) set.add(w.id);
    for (const p of this.procs()?.byProcess || []) if (p.processId) set.add(p.processId);
    return [...set].sort();
  });

  activeInstances = computed(() => {
    const s = this.summary()?.instances.byStatus ?? {};
    return (s['running'] ?? 0) + (s['waiting'] ?? 0);
  });
  completedInstances = computed(() => this.summary()?.instances.byStatus?.['completed'] ?? 0);
  failedInstances = computed(() => this.summary()?.instances.byStatus?.['failed'] ?? 0);
  failureRate = computed(() => this.procs()?.failureRate ?? 0);
  failureRateColor = computed(() => {
    const r = this.failureRate();
    return r > 5 ? 'var(--red)' : r > 0 ? 'var(--amber)' : 'var(--green)';
  });

  openTasks = computed(() => {
    const s = this.summary()?.tasks.byStatus ?? {};
    return Object.entries(s).filter(([k]) => k !== 'completed' && k !== 'skipped')
      .reduce((a, [, v]) => a + v, 0);
  });

  slaRate = computed(() => this.tasks()?.sla?.complianceRate ?? 100);
  slaColor = computed(() => {
    const rate = this.slaRate();
    return rate >= 95 ? 'var(--green)' : rate >= 80 ? 'var(--amber)' : 'var(--red)';
  });

  taskGroups = computed(() => this.tasks()?.byGroup ?? []);
  activeTimers = computed(() => this.summary()?.jobs?.scheduled ?? 0);

  instStatusRows = computed<StatusRow[]>(() => this.statusRows(this.procs()?.byStatus, INSTANCE_STATUSES));
  instTotal = computed(() => this.instStatusRows().reduce((a, r) => a + r.count, 0));
  instDonut = computed(() => this.donutGradient(this.instStatusRows()));
  dailyThroughput = computed(() => this.procs()?.dailyThroughput ?? []);

  displayedThroughput = computed(() => {
    const list = this.dailyThroughput();
    if (this.throughputViewMode() === 'active') {
      const active = list.filter((d) => (d.started + d.completed + d.failed) > 0);
      return active.length > 0 ? active : list;
    }
    return list;
  });

  throughputTotals = computed(() => {
    const list = this.dailyThroughput();
    let started = 0;
    let completed = 0;
    let failed = 0;
    let peakDay = '';
    let peakVal = 0;
    let activeDays = 0;

    for (const d of list) {
      started += d.started;
      completed += d.completed;
      failed += d.failed;
      const dayTotal = d.started + d.completed + d.failed;
      if (dayTotal > 0) activeDays++;
      if (dayTotal > peakVal) {
        peakVal = dayTotal;
        peakDay = d.date;
      }
    }

    const terminal = completed + failed;
    const successRate = terminal > 0 ? Math.round((completed / terminal) * 100) : (started > 0 ? 100 : 0);
    const avgDaily = activeDays > 0 ? Math.round((started + completed + failed) / activeDays) : 0;

    return {
      started,
      completed,
      failed,
      totalVolume: started + completed + failed,
      peakDay,
      peakVal,
      activeDays,
      totalDays: list.length,
      successRate,
      avgDaily,
    };
  });

  throughputYScale = computed(() => {
    const list = this.displayedThroughput();
    let rawMax = 1;
    for (const d of list) {
      if (d.started > rawMax) rawMax = d.started;
      if (d.completed > rawMax) rawMax = d.completed;
      if (d.failed > rawMax) rawMax = d.failed;
    }

    const targetSteps = 4;
    const roughStep = Math.max(1, rawMax / targetSteps);
    const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
    const rem = roughStep / mag;
    let niceMultiplier = 1;
    if (rem > 5) niceMultiplier = 10;
    else if (rem > 2.5) niceMultiplier = 5;
    else if (rem > 2) niceMultiplier = 2.5;
    else if (rem > 1) niceMultiplier = 2;

    const step = Math.max(1, Math.round(niceMultiplier * mag));
    let ceiling = step * targetSteps;
    while (ceiling < rawMax) ceiling += step;

    const ticks = [ceiling, Math.round(ceiling * 0.75), Math.round(ceiling * 0.5), Math.round(ceiling * 0.25), 0];
    return { ceiling, step, ticks };
  });

  maxThroughputVal = computed(() => this.throughputYScale().ceiling);

  byProcess = computed(() => [...(this.procs()?.byProcess ?? [])].sort((a, b) => b.count - a.count));
  filteredProcesses = computed(() => {
    const q = this.procSearch.trim().toLowerCase();
    if (!q) return this.byProcess();
    return this.byProcess().filter((p) => p.processId.toLowerCase().includes(q));
  });
  maxProcAvg = computed(() => Math.max(...this.byProcess().map((p) => p.avgMs), 1));

  taskStatusRows = computed<StatusRow[]>(() => this.statusRows(this.tasks()?.openByStatus, TASK_STATUSES));
  openTotal = computed(() => this.taskStatusRows().reduce((a, r) => a + r.count, 0));
  taskDonut = computed(() => this.donutGradient(this.taskStatusRows()));
  byAssignee = computed(() => [...(this.tasks()?.byAssignee ?? [])].sort((a, b) => b.count - a.count));
  maxAssigneeCount = computed(() => Math.max(...this.byAssignee().map((w) => w.count), 1));
  byTask = computed(() => [...(this.tasks()?.byTask ?? [])].sort((a, b) => b.count - a.count));
  filteredTasks = computed(() => {
    const q = this.taskSearch.trim().toLowerCase();
    if (!q) return this.byTask();
    return this.byTask().filter((t) => t.name.toLowerCase().includes(q));
  });
  maxTaskAvg = computed(() => Math.max(...this.byTask().map((t) => t.avgMs), 1));

  filteredTatWorkflows = computed(() => {
    const list = this.tat()?.byWorkflowName || [];
    const q = this.caseSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((w) => w.workflowName.toLowerCase().includes(q));
  });
  maxCaseAvg = computed(() => Math.max(...(this.tat()?.byWorkflowName || []).map((w) => w.avgMs), 1));

  queryColumns = computed(() => {
    const rows = this.queryResult()?.rows;
    if (!rows || rows.length === 0) return [];
    const keySet = new Set<string>();
    const priority = ['id', 'workflowName', 'name', 'status', 'createdAt', 'assignee', 'group'];
    for (const p of priority) {
      if (rows.some((r) => r[p] !== undefined)) keySet.add(p);
    }
    for (const r of rows.slice(0, 5)) {
      for (const k of Object.keys(r)) {
        if (!k.startsWith('_') && keySet.size < 8) keySet.add(k);
      }
    }
    return [...keySet];
  });

  constructor() {
    this.route.queryParamMap.subscribe((m) => {
      const t = m.get('tab') as HomeTab;
      if (t && ['overview', 'processes', 'tasks', 'cases', 'queries'].includes(t)) {
        this.tab.set(t);
      }
    });
    this.auth.ready.then(() => {
      this.load();
    });
  }

  private loadedTabs = new Set<string>();

  setTab(t: HomeTab) {
    this.tab.set(t);
    this.router.navigate([], { relativeTo: this.route, queryParams: { tab: t }, queryParamsHandling: 'merge' });
    this.ensureTabData(t);
  }

  ensureTabData(t: HomeTab) {
    if (this.loadedTabs.has(t)) return;
    this.loadedTabs.add(t);

    const user = this.auth.user()?.username;
    const params = this.filterParams();

    if (t === 'overview') {
      if (this.canView()) {
        this.instApi.listInstances({ limit: 6 }).subscribe((list) => {
          this.recent.set([...list].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 6));
        });
      }
      if (this.canTasks() && user) {
        this.q.userTasks(user).subscribe((ts) => {
          this.myTasks.set(ts.filter((x) => x.status !== 'completed' && x.status !== 'skipped').slice(0, 6));
        });
      }
    } else if (t === 'processes') {
      this.q.analyticsProcesses(params).subscribe({
        next: (procs) => this.procs.set(procs),
        error: () => {},
      });
    } else if (t === 'tasks') {
      this.q.analyticsTasks(params).subscribe({
        next: (tasks) => this.tasks.set(tasks),
        error: () => {},
      });
    } else if (t === 'cases') {
      const caseParams = { since: params.since, from: params.from, to: params.to };
      this.analyticsApi.summary(caseParams).subscribe({ next: (s) => this.caseSummary.set(s), error: () => {} });
      this.analyticsApi.tat(caseParams).subscribe({ next: (t) => this.tat.set(t), error: () => {} });
      this.wfApi.listWorkflows().subscribe((ws) => this.workflows.set(ws));
      this.wfDefApi.list().subscribe((defs) => this.workflowDefinitions.set(defs));
    } else if (t === 'queries') {
      this.analyticsApi.listSavedQueries().subscribe({ next: (qs: SavedQuery[]) => this.savedQueries.set(qs), error: () => {} });
    }
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
    this.load();
  }

  onFromChange(val: string) {
    this.customFrom.set(val);
    this.timeWindow.set('custom');
  }

  onToChange(val: string) {
    this.customTo.set(val);
    this.timeWindow.set('custom');
  }

  applyCustomDateRange() {
    const from = this.customFrom();
    const to = this.customTo();
    if (from && to && from > to) {
      this.toast.error('Start date cannot be after end date.');
      return;
    }
    this.timeWindow.set('custom');
    this.loadedTabs.clear();
    this.load();
  }

  clearCustomDateRange() {
    this.customFrom.set('');
    this.customTo.set('');
    this.timeWindow.set('all');
    this.loadedTabs.clear();
    this.load();
  }

  onProcessChange() {
    this.loadedTabs.clear();
    this.load();
  }

  retry() { this.load(); }

  load() {
    this.loading.set(true);
    this.failed.set(false);
    const params = this.filterParams();

    // Parallel aggregate fetch for top KPI cards & overview charts
    forkJoin({
      summary: this.q.analyticsSummary(params),
      procs: this.q.analyticsProcesses(params),
      tasks: this.q.analyticsTasks(params),
    }).subscribe({
      next: ({ summary, procs, tasks }) => {
        this.summary.set(summary);
        this.procs.set(procs);
        this.tasks.set(tasks);
        this.loading.set(false);
      },
      error: () => { this.failed.set(true); this.loading.set(false); },
    });

    // On-demand fetch strictly for the currently active tab
    this.ensureTabData(this.tab());
  }

  greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }
  procName(i: Instance) { return processLabel(i.processId, i.workflowId); }
  /** Tail of a ULID: the first 8 chars are the ms timestamp, so same-batch ids front-slice identically. The random part is the END. */
  shortId(id: string) { return id.length > 10 ? '\u2026' + id.slice(-7) : id; }

  statusColor(s: string) {
    const low = (s || '').toLowerCase();
    return low === 'failed' || low === 'error' ? 'var(--red)'
      : low === 'completed' || low === 'resolved' || low === 'closed' || low === 'approved' ? 'var(--green)'
      : low === 'aborted' || low === 'cancelled' ? 'var(--muted)'
      : low === 'suspended' ? 'var(--purple)'
      : low === 'waiting' || low === 'created' || low === 'reserved' ? 'var(--amber)'
      : 'var(--blue)';
  }
  isOverdue(t: Task) { return !!t.dueAt && Date.parse(t.dueAt) < Date.now(); }
  dueLabel(t: Task) {
    if (!t.dueAt) return '';
    const ms = Date.parse(t.dueAt) - Date.now();
    const abs = Math.abs(ms), m = Math.round(abs / 60000), h = Math.round(abs / 3600000);
    const rel = m < 60 ? `${m}m` : h < 48 ? `${h}h` : `${Math.round(abs / 86400000)}d`;
    return ms < 0 ? `${rel} overdue` : `due in ${rel}`;
  }

  formatDayLabel(d: string): string {
    const parts = d.split('-');
    return parts.length === 3 ? `${parts[1]}/${parts[2]}` : d;
  }

  formatFullDate(d: string): string {
    try {
      const parts = d.split('-').map(Number);
      if (parts.length === 3) {
        const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2], 12, 0, 0));
        return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
      }
      return d;
    } catch {
      return d;
    }
  }

  calcDaySuccessRate(d: { started: number; completed: number; failed: number }): number {
    const terminal = d.completed + d.failed;
    return terminal > 0 ? Math.round((d.completed / terminal) * 100) : (d.started > 0 ? 100 : 0);
  }

  throughputTooltip(d: { date: string; started: number; completed: number; failed: number }): string {
    return `${d.date}: ${d.started} started, ${d.completed} completed, ${d.failed} failed`;
  }

  pctOfThroughput(val: number): number {
    if (!val || val <= 0) return 0;
    const ceil = this.throughputYScale().ceiling;
    if (ceil <= 0) return 0;
    const pct = (val / ceil) * 100;
    return Math.min(100, Math.max(2, Math.round(pct * 10) / 10));
  }

  onHoverDay(d: { date: string; started: number; completed: number; failed: number }, event: MouseEvent) {
    this.hoveredDay.set(d);
    const target = event.currentTarget as HTMLElement;
    const plotArea = target?.closest('.tp-plot-area') as HTMLElement;
    if (target && plotArea) {
      const colRect = target.getBoundingClientRect();
      const plotRect = plotArea.getBoundingClientRect();
      const rawX = (colRect.left + colRect.width / 2) - plotRect.left;
      const clampedX = Math.max(110, Math.min(plotRect.width - 110, rawX));
      this.tooltipX.set(clampedX);
      this.tooltipY.set(6);
    }
  }

  onLeaveDay() {
    this.hoveredDay.set(null);
  }

  statusEntries(byStatus: Record<string, number>): [string, number][] {
    return Object.entries(byStatus || {});
  }

  caseStatusPct(count: number): number {
    const total = this.caseSummary()?.total ?? 0;
    return total > 0 ? (count / total) * 100 : 0;
  }

  caseWorkflowPct(count: number): number {
    const total = this.caseSummary()?.total ?? 0;
    return total > 0 ? (count / total) * 100 : 0;
  }

  activeCaseRatio(): number {
    const total = this.caseSummary()?.total ?? 0;
    const active = this.caseSummary()?.activeCases ?? 0;
    return total > 0 ? Math.round((active / total) * 100) : 0;
  }

  // ---- Query builder ----
  addFilter() { this.filters.push({ field: '', op: 'eq', value: '' }); }
  removeFilter(f: QueryFilter) { this.filters = this.filters.filter((x) => x !== f); }

  private buildDef(): QueryDefinition {
    const d: QueryDefinition = { entity: this.entity };
    const validFilters = this.filters.filter((f) => f.field.trim());
    if (validFilters.length) d.filters = validFilters;
    if (this.groupBy.trim()) d.groupBy = this.groupBy.trim();
    if (this.metric) {
      d.metric = this.metric;
      if (this.metric === 'avgDurationMs') {
        d.durationFrom = this.durationFrom.trim() || undefined;
        d.durationTo = this.durationTo.trim() || undefined;
      }
    }
    return d;
  }

  runQuery() {
    this.queryError.set('');
    this.runningQuery.set(true);
    this.analyticsApi.runQuery(this.buildDef()).subscribe({
      next: (res) => {
        this.queryResult.set(res);
        this.runningQuery.set(false);
      },
      error: (e) => {
        this.runningQuery.set(false);
        this.queryError.set(e?.error?.error?.message || 'Query failed');
      },
    });
  }

  saveQuery() {
    if (!this.saveName.trim()) { this.queryError.set('Name is required to save'); return; }
    this.analyticsApi.saveQuery(this.saveName.trim(), this.buildDef(), this.saveShared).subscribe({
      next: () => {
        this.toast.success('Query saved');
        this.saveName = '';
        this.analyticsApi.listSavedQueries().subscribe({ next: (qs: SavedQuery[]) => this.savedQueries.set(qs), error: () => {} });
      },
      error: (e) => this.queryError.set(e?.error?.error?.message || 'Failed to save query'),
    });
  }

  loadSavedQuery(sq: SavedQuery) {
    this.entity = sq.definition.entity;
    this.groupBy = sq.definition.groupBy || '';
    this.metric = sq.definition.metric || '';
    this.durationFrom = sq.definition.durationFrom || '';
    this.durationTo = sq.definition.durationTo || '';
    this.filters = sq.definition.filters ? [...sq.definition.filters] : [];
    this.runQuery();
  }

  deleteSavedQuery(sq: SavedQuery) {
    this.analyticsApi.deleteSavedQuery(sq.id).subscribe({
      next: () => {
        this.toast.success('Query deleted');
        this.savedQueries.update((l) => l.filter((x) => x.id !== sq.id));
      },
      error: (e: any) => this.toast.error(e?.error?.error?.message || 'Delete failed'),
    });
  }

  loadPreset(preset: 'overdueTasks' | 'activeCases' | 'failedInst') {
    if (preset === 'overdueTasks') {
      this.entity = 'task';
      this.groupBy = 'group';
      this.metric = 'count';
      this.filters = [{ field: 'status', op: 'ne', value: 'completed' }];
    } else if (preset === 'activeCases') {
      this.entity = 'workflowInstance';
      this.groupBy = 'workflowName';
      this.metric = 'count';
      this.filters = [{ field: 'status', op: 'ne', value: 'closed' }];
    } else if (preset === 'failedInst') {
      this.entity = 'instance';
      this.groupBy = 'processId';
      this.metric = 'count';
      this.filters = [{ field: 'status', op: 'eq', value: 'failed' }];
    }
    this.runQuery();
  }

  formatColVal(val: unknown): string {
    if (val === undefined || val === null) return '—';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  }

  // ---- Start Case Modal ----
  openStartCase() {
    this.startCaseError.set('');
    const firstDef = this.workflowDefinitions()[0]?.name || '';
    this.startingCase.set({ workflowName: firstDef, variables: '{}', workflowData: '{}' });
  }
  closeStartCase() { this.startingCase.set(null); }
  submitStartCase() {
    const s = this.startingCase(); if (!s) return;
    if (!s.workflowName.trim()) { this.startCaseError.set('Workflow definition is required'); return; }
    let variables: Record<string, unknown>, workflowData: Record<string, unknown>;
    try { variables = s.variables.trim() ? JSON.parse(s.variables) : {}; }
    catch { this.startCaseError.set('Variables must be valid JSON'); return; }
    try { workflowData = s.workflowData.trim() ? JSON.parse(s.workflowData) : {}; }
    catch { this.startCaseError.set('Business data must be valid JSON'); return; }

    this.startingCaseLoading.set(true);
    this.wfInstApi.create({ workflowName: s.workflowName.trim(), variables, workflowData }).subscribe({
      next: (w) => {
        this.startingCaseLoading.set(false);
        this.toast.success('Case started successfully');
        this.closeStartCase();
        this.load();
        if (w.piid) this.router.navigate(['/instances', w.piid]);
      },
      error: (e) => {
        this.startingCaseLoading.set(false);
        this.startCaseError.set(e?.error?.error?.message || 'Start case failed');
      },
    });
  }

  // ---- Helpers ----
  ms = humanMs;
  pctOf(v: number, max: number): number { return max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0; }
  nonZero(rows: StatusRow[]): StatusRow[] { return rows.filter((r) => r.count > 0); }
  loadRatio(count: number): number { return count / this.maxAssigneeCount(); }
  loadColor(count: number): string {
    const r = this.loadRatio(count);
    return r > 0.75 ? 'var(--red)' : r > 0.4 ? 'var(--amber)' : 'var(--green)';
  }

  private statusRows(byStatus: Record<string, number> | undefined, meta: { key: string; label: string; color: string }[]): StatusRow[] {
    if (!byStatus) return [];
    const known = meta.map((m) => ({ ...m, count: byStatus[m.key] ?? 0 }));
    const extra = Object.keys(byStatus)
      .filter((k) => !meta.some((m) => m.key === k) && byStatus[k] > 0)
      .map((k) => ({ key: k, label: k, color: 'var(--muted)', count: byStatus[k] }));
    const rows = [...known, ...extra];
    const total = rows.reduce((a, r) => a + r.count, 0);
    const max = Math.max(...rows.map((r) => r.count), 1);
    return rows.map((r) => ({
      ...r,
      pctOfMax: (r.count / max) * 100,
      share: total ? Math.round((r.count / total) * 100) : 0,
    }));
  }

  private donutGradient(rows: StatusRow[]): string {
    const active = rows.filter((r) => r.count > 0);
    const total = active.reduce((a, r) => a + r.count, 0);
    if (!total) return 'var(--surface-3)';
    let acc = 0;
    const stops = active.map((r) => {
      const from = (acc / total) * 100;
      acc += r.count;
      const to = (acc / total) * 100;
      return `${r.color} ${from.toFixed(2)}% ${to.toFixed(2)}%`;
    });
    return `conic-gradient(${stops.join(', ')})`;
  }

  exportQueryResults() {
    const res = this.queryResult();
    if (!res) return;
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    let header: string[]; let rows: unknown[][];
    if (res.groups) {
      header = ['Key', 'Count', ...(this.metric === 'avgDurationMs' ? ['Avg Duration (ms)'] : [])];
      rows = res.groups.map((g) => [g.key, g.count, ...(this.metric === 'avgDurationMs' ? [g.avgDurationMs ?? ''] : [])]);
    } else if (res.rows && res.rows.length > 0) {
      header = this.queryColumns();
      rows = res.rows.map((r) => header.map((col) => this.formatColVal(r[col])));
    } else {
      return;
    }
    const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = `query-${this.entity}-results.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  exportCsv() {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    let header: string[]; let rows: unknown[][]; let name: string;
    if (this.tab() === 'overview') {
      header = ['Metric', 'Value'];
      rows = [
        ['Active Instances', this.activeInstances()],
        ['Completed Instances', this.completedInstances()],
        ['Failed Instances', this.failedInstances()],
        ['Failure Rate (%)', this.failureRate()],
        ['Open Tasks', this.openTasks()],
        ['SLA Compliance (%)', this.slaRate()],
        ['Active Deployments', this.summary()?.deployments?.active ?? 0],
        ['Total Cases', this.caseSummary()?.total ?? 0],
        ['Active Timers', this.activeTimers()],
        ['Process Scope', this.selectedProcess || 'All Processes'],
        ['Date Range', this.dateRangeLabel()],
      ];
      name = 'executive-overview-summary.csv';
    } else if (this.tab() === 'tasks') {
      header = ['Task Name', 'Completed Count', 'Avg Turnaround (ms)', 'Min (ms)', 'Max (ms)'];
      rows = this.byTask().map((t) => [t.name, t.count, t.avgMs, t.minMs, t.maxMs]);
      name = 'tasks-analytics.csv';
    } else if (this.tab() === 'cases') {
      header = ['Workflow Definition', 'Completed Cases', 'Avg TAT (ms)', 'Min (ms)', 'Max (ms)'];
      rows = (this.tat()?.byWorkflowName || []).map((w) => [w.workflowName, w.count, w.avgMs, w.minMs, w.maxMs]);
      name = 'cases-analytics.csv';
    } else if (this.tab() === 'queries') {
      this.exportQueryResults();
      return;
    } else {
      header = ['Process Definition', 'Executions', 'Avg Turnaround (ms)', 'Min (ms)', 'Max (ms)'];
      rows = this.byProcess().map((p) => [p.processId, p.count, p.avgMs, p.minMs, p.maxMs]);
      name = 'processes-analytics.csv';
    }
    const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }
}
