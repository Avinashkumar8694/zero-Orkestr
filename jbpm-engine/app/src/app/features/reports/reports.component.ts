import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { forkJoin } from 'rxjs';
import { QueryApiService } from '../../core/api/query-api.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import type { ProcessAnalytics, Summary, TaskAnalytics } from '../../core/models';

type ReportsTab = 'processes' | 'tasks';

interface StatusRow { key: string; label: string; color: string; count: number; pctOfMax: number; share: number; }

/** Human duration: 823 → "<1s", 61000 → "1m 1s", 3.9e6 → "1h 05m", 2.0e8 → "2d 7h". */
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

// Reports & Analytics — mirrors ux_design/mockups/reports-analytics.html (Processes tab) and
// reports-tasks.html (Tasks tab). Charts are hand-rolled (CSS bars + conic-gradient donuts), no
// chart library. Tab state lives in ?tab= so both views are deep-linkable.
@Component({
  selector: 'app-reports',
  standalone: true,
  imports: [BreadcrumbComponent, IconComponent],
  template: `
    <div class="page">
      <div class="crumbwrap">
        <app-breadcrumb [crumbs]="[{ label: 'Reports & Analytics' }, { label: tab() === 'tasks' ? 'Tasks' : 'Processes' }]" />
      </div>

      <header class="pagehead">
        <div>
          <h1>Reports &amp; Analytics</h1>
          <p class="sub">Throughput, duration and workload across every deployed process.</p>
        </div>
        <div class="spacer"></div>
        <button class="btn sm" (click)="exportCsv()" [disabled]="loading() || !!error()">
          <app-icon name="download" [size]="14" /> Export CSV
        </button>
      </header>

      <nav class="tabs" role="tablist">
        <button role="tab" [attr.aria-selected]="tab() === 'processes'" [class.active]="tab() === 'processes'" (click)="setTab('processes')">Processes</button>
        <button role="tab" [attr.aria-selected]="tab() === 'tasks'" [class.active]="tab() === 'tasks'" (click)="setTab('tasks')">Tasks</button>
      </nav>

      @if (loading()) {
        <div class="kpis">@for (i of [1, 2, 3, 4, 5, 6]; track i) { <div class="skeleton kpi-skel"></div> }</div>
        <div class="chartgrid"><div class="skeleton skeleton-card tall"></div><div class="skeleton skeleton-card tall"></div></div>
        <div class="skeleton skeleton-card"></div>
      } @else if (error()) {
        <div class="card">
          <div class="empty-state">
            <div class="es-icon"><app-icon name="warning" [size]="24" /></div>
            <h3>Analytics unavailable</h3>
            <p>{{ error() }}</p>
            <button class="btn" (click)="load()"><app-icon name="refresh" [size]="14" /> Retry</button>
          </div>
        </div>
      } @else if (tab() === 'processes') {
        <!-- ============================== Processes tab ============================== -->
        <div class="kpis">
          @for (k of kpis(); track k.label) {
            <div class="card kpi">
              <div class="kv tnum" [style.color]="k.color || null">{{ k.value }}</div>
              <div class="kl">{{ k.label }}</div>
            </div>
          }
        </div>

        <div class="chartgrid">
          <section class="card chart">
            <div class="row charthead">
              <h3>Instances by status</h3>
              <div class="spacer"></div>
              <span class="muted small tnum">{{ instTotal() }} total</span>
            </div>
            <p class="chartsub">every instance ever started, grouped by its current state</p>
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
              <p class="nodata">No instances yet — start one from a deployment to populate analytics.</p>
            }
          </section>

          <section class="card chart donutcard">
            <div class="row charthead"><h3>Completed vs. running mix</h3></div>
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
            <h3>Duration by process</h3>
            <div class="spacer"></div>
            <span class="muted small">completed instances only</span>
          </div>
          @if (byProcess().length) {
            <table>
              <thead><tr><th>Process</th><th class="num">Count</th><th class="num">Avg duration</th><th class="num">Min</th><th class="num">Max</th></tr></thead>
              <tbody>
                @for (p of byProcess(); track p.processId) {
                  <tr>
                    <td><b>{{ p.processId }}</b></td>
                    <td class="num tnum">{{ p.count }}</td>
                    <td class="num">
                      <span class="avgcell">
                        <span class="avgbar"><span [style.width.%]="pctOf(p.avgMs, maxProcAvg())"></span></span>
                        <span class="tnum">{{ ms(p.avgMs) }}</span>
                      </span>
                    </td>
                    <td class="num muted tnum">{{ ms(p.minMs) }}</td>
                    <td class="num muted tnum">{{ ms(p.maxMs) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="empty-state">
              <div class="es-icon"><app-icon name="chart" [size]="24" /></div>
              <h3>No completed instances</h3>
              <p>Duration analytics appear once at least one process instance runs to completion.</p>
            </div>
          }
        </section>
      } @else {
        <!-- ================================ Tasks tab ================================ -->
        <div class="chartgrid">
          <section class="card chart">
            <div class="row charthead"><h3>Workload by assignee</h3></div>
            <p class="chartsub">tasks per assignee · answers "is anyone swamped?"</p>
            @if (byAssignee().length) {
              <div class="barlist">
                @for (w of byAssignee(); track w.user) {
                  <div class="barrow">
                    <div class="row lab">
                      <span>{{ w.user }}</span>
                      <div class="spacer"></div>
                      <span class="muted small">avg {{ ms(w.avgMs) }}</span>
                      <span class="badge" [class.failed]="loadRatio(w.count) > 0.75" [class.waiting]="loadRatio(w.count) > 0.4 && loadRatio(w.count) <= 0.75" [class.active]="w.count > 0 && loadRatio(w.count) <= 0.4" [class.inactive]="w.count === 0">{{ w.count }} {{ w.count === 1 ? 'task' : 'tasks' }}</span>
                    </div>
                    <div class="track"><span [style.width.%]="pctOf(w.count, maxAssigneeCount())" [style.background]="loadColor(w.count)"></span></div>
                  </div>
                }
              </div>
            } @else {
              <p class="nodata">No tasks have been assigned yet.</p>
            }
          </section>

          <section class="card chart donutcard">
            <div class="row charthead"><h3>Open tasks by status</h3></div>
            @if (openTotal() > 0) {
              <div class="donutwrap">
                <div class="donut" [style.background]="taskDonut()" role="img" aria-label="Open tasks by status">
                  <div class="hole"><span class="tnum">{{ openTotal() }}</span></div>
                </div>
                <div class="legend">
                  @for (r of nonZero(taskStatusRows()); track r.key) {
                    <div class="li"><span class="sw" [style.background]="r.color"></span> {{ r.label }} · {{ r.count }}</div>
                  }
                </div>
              </div>
            } @else {
              <p class="nodata">No open tasks right now.</p>
            }
          </section>
        </div>

        <section class="card tablecard">
          <div class="row cardhead">
            <h3>Duration by task</h3>
            <div class="spacer"></div>
            <span class="muted small">completed tasks only</span>
          </div>
          @if (byTask().length) {
            <table>
              <thead><tr><th>Task</th><th class="num">Count</th><th class="num">Avg duration</th><th class="num">Min</th><th class="num">Max</th></tr></thead>
              <tbody>
                @for (t of byTask(); track t.name) {
                  <tr>
                    <td><b>{{ t.name }}</b></td>
                    <td class="num tnum">{{ t.count }}</td>
                    <td class="num">
                      <span class="avgcell">
                        <span class="avgbar"><span [style.width.%]="pctOf(t.avgMs, maxTaskAvg())"></span></span>
                        <span class="tnum">{{ ms(t.avgMs) }}</span>
                      </span>
                    </td>
                    <td class="num muted tnum">{{ ms(t.minMs) }}</td>
                    <td class="num muted tnum">{{ ms(t.maxMs) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="empty-state">
              <div class="es-icon"><app-icon name="tasks" [size]="24" /></div>
              <h3>No completed tasks</h3>
              <p>Per-task duration analytics appear once at least one human task is completed.</p>
            </div>
          }
        </section>
      }
    </div>
  `,
  styles: [`
    .page { padding: 20px 24px; max-width: 1160px; }
    .crumbwrap { margin-bottom: 10px; }
    .pagehead { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 12px; }
    h1 { font-size: var(--text-xl); line-height: var(--lh-xl); margin: 0; }
    .sub { color: var(--muted); font-size: 13px; margin-top: 2px; }
    .small { font-size: 12px; }



    /* KPI tiles */
    .kpis { display: grid; grid-template-columns: repeat(6, 1fr); gap: 12px; margin-bottom: 16px; }
    .kpi { padding: 14px 16px; }
    .kpi .kv { font-size: var(--text-2xl); line-height: var(--lh-2xl); font-weight: 650; letter-spacing: -.02em; }
    .kpi .kl { font-size: var(--text-xs); color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; margin-top: 2px; white-space: nowrap; }
    .kpi-skel { height: 84px; border-radius: var(--radius); }
    /* Chart cards */
    .chartgrid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; margin-bottom: 16px; align-items: stretch; }
    .chart { padding: 18px; }
    .charthead { margin-bottom: 2px; }
    .chartsub { color: var(--muted); font-size: 11.5px; margin: 0 0 12px; }
    .tall { height: 260px; }
    .nodata { color: var(--muted); font-size: 13px; padding: 24px 0; text-align: center; }
    /* Horizontal bars */
    .barlist { display: flex; flex-direction: column; gap: 10px; }
    .barrow .lab { font-size: 12.5px; margin-bottom: 4px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
    .track { height: 8px; background: var(--surface-3); border-radius: var(--radius-pill); overflow: hidden; }
    .track span { display: block; height: 100%; border-radius: var(--radius-pill); transition: width .3s ease; }
    /* Donut */
    .donutcard { display: flex; flex-direction: column; }
    .donutwrap { display: flex; gap: 18px; align-items: center; flex: 1; padding-top: 8px; }
    .donut { width: 148px; height: 148px; border-radius: 50%; position: relative; flex-shrink: 0; }
    .hole {
      position: absolute; inset: 24px; border-radius: 50%; background: var(--surface);
      display: grid; place-items: center; font-weight: 650; font-size: 18px;
    }
    .legend { display: flex; flex-direction: column; gap: 8px; font-size: 12.5px; color: var(--text-secondary); }
    .legend .li { display: flex; align-items: center; gap: 7px; }
    .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; flex-shrink: 0; }
    /* Duration tables */
    .tablecard { overflow: hidden; }
    .cardhead { padding: 14px 16px 10px; }
    th.num, td.num { text-align: right; }
    .avgcell { display: inline-flex; align-items: center; gap: 8px; }
    .avgbar { width: 64px; height: 6px; background: var(--surface-3); border-radius: var(--radius-pill); overflow: hidden; flex-shrink: 0; }
    .avgbar span { display: block; height: 100%; border-radius: var(--radius-pill); background: var(--grad-brand); }
  `],
})
export class ReportsComponent {
  private api = inject(QueryApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  tab = signal<ReportsTab>('processes');
  loading = signal(true);
  error = signal<string | null>(null);

  summary = signal<Summary | null>(null);
  procs = signal<ProcessAnalytics | null>(null);
  tasks = signal<TaskAnalytics | null>(null);

  constructor() {
    this.route.queryParamMap.subscribe((m) => this.tab.set(m.get('tab') === 'tasks' ? 'tasks' : 'processes'));
    this.load();
  }

  load() {
    this.loading.set(true);
    this.error.set(null);
    forkJoin({
      summary: this.api.analyticsSummary(),
      procs: this.api.analyticsProcesses(),
      tasks: this.api.analyticsTasks(),
    }).subscribe({
      next: ({ summary, procs, tasks }) => {
        this.summary.set(summary); this.procs.set(procs); this.tasks.set(tasks);
        this.loading.set(false);
      },
      error: (e) => {
        this.error.set(e?.error?.error?.message || 'Could not load analytics from the server.');
        this.loading.set(false);
      },
    });
  }

  setTab(t: ReportsTab) {
    this.router.navigate([], { relativeTo: this.route, queryParams: { tab: t }, queryParamsHandling: 'merge' });
  }

  // ---- processes tab ----
  kpis = computed(() => {
    const s = this.summary();
    if (!s) return [];
    return [
      { label: 'Total instances', value: s.instances.total, color: '' },
      { label: 'Running', value: s.instances.byStatus['running'] ?? 0, color: 'var(--blue)' },
      { label: 'Completed', value: s.instances.byStatus['completed'] ?? 0, color: 'var(--green)' },
      { label: 'Failed', value: s.instances.byStatus['failed'] ?? 0, color: 'var(--red)' },
      { label: 'Active deployments', value: s.deployments.active, color: 'var(--purple)' },
      { label: 'Scheduled jobs', value: s.jobs.scheduled, color: 'var(--amber)' },
    ];
  });

  instStatusRows = computed<StatusRow[]>(() => this.statusRows(this.procs()?.byStatus, INSTANCE_STATUSES));
  instTotal = computed(() => this.instStatusRows().reduce((a, r) => a + r.count, 0));
  instDonut = computed(() => this.donutGradient(this.instStatusRows()));

  byProcess = computed(() => [...(this.procs()?.byProcess ?? [])].sort((a, b) => b.count - a.count));
  maxProcAvg = computed(() => Math.max(...this.byProcess().map((p) => p.avgMs), 1));

  // ---- tasks tab ----
  taskStatusRows = computed<StatusRow[]>(() => this.statusRows(this.tasks()?.openByStatus, TASK_STATUSES));
  openTotal = computed(() => this.taskStatusRows().reduce((a, r) => a + r.count, 0));
  taskDonut = computed(() => this.donutGradient(this.taskStatusRows()));

  byAssignee = computed(() => [...(this.tasks()?.byAssignee ?? [])].sort((a, b) => b.count - a.count));
  maxAssigneeCount = computed(() => Math.max(...this.byAssignee().map((w) => w.count), 1));

  byTask = computed(() => [...(this.tasks()?.byTask ?? [])].sort((a, b) => b.count - a.count));
  maxTaskAvg = computed(() => Math.max(...this.byTask().map((t) => t.avgMs), 1));

  // ---- helpers ----
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

  exportCsv() {
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    let header: string[]; let rows: unknown[][]; let name: string;
    if (this.tab() === 'processes') {
      header = ['Process', 'Count', 'Avg (ms)', 'Min (ms)', 'Max (ms)'];
      rows = this.byProcess().map((p) => [p.processId, p.count, p.avgMs, p.minMs, p.maxMs]);
      name = 'reports-processes.csv';
    } else {
      header = ['Task', 'Count', 'Avg (ms)', 'Min (ms)', 'Max (ms)'];
      rows = this.byTask().map((t) => [t.name, t.count, t.avgMs, t.minMs, t.maxMs]);
      name = 'reports-tasks.csv';
    }
    const csv = [header, ...rows].map((r) => r.map(esc).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  }
}
