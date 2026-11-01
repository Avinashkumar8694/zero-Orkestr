import { Component, HostListener, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { OpsApiService } from '../../core/api/ops-api.service';
import { ToastService } from '../../shared/toast.service';
import { ModalService } from '../../shared/modal.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import type { TimerJob } from '../../core/models';

const KIND_LABEL: Record<TimerJob['kind'], string> = {
  duration: 'Timer (duration)', cycle: 'Timer (cycle)', date: 'Timer (date)', start: 'Start-timer', async: 'Background run',
};

/** Jobs & Timers (ux_design/mockups/jobs-timers.html): every scheduled TimerJob with a live
 *  countdown to next fire, trigger-now / cancel / reschedule actions. */
@Component({
  selector: 'app-jobs-timers',
  standalone: true,
  imports: [IconComponent, RouterLink, FormsModule, BreadcrumbComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Jobs & Timers' }]" /></div>
      <header class="pagehead">
        <h1>Jobs & Timers</h1>
        <p class="muted">Every scheduled timer and job the engine is holding, with a live countdown to next fire.</p>
      </header>

      <div class="filterbar">
        <select [(ngModel)]="statusFilter" (ngModelChange)="reload()"><option value="">Status: all</option><option value="scheduled">Scheduled</option><option value="fired">Fired</option><option value="cancelled">Cancelled</option></select>
        <select [(ngModel)]="kindFilter" (ngModelChange)="reload()"><option value="">Kind: all</option><option value="duration">Duration</option><option value="cycle">Cycle</option><option value="date">Date</option><option value="start">Start-timer</option></select>
        <input placeholder="Filter by PIID" [(ngModel)]="instanceIdFilter" (ngModelChange)="reload()" style="width:180px;" />
        <span class="spacer"></span>
        <button class="btn sm" (click)="reload()"><app-icon name="refresh" [size]="13" /> Refresh</button>
      </div>

      <div class="card listcard">
        @if (loading()) {
          <div class="pad"><div class="skeleton skeleton-line" style="width:60%"></div><div class="skeleton skeleton-line" style="width:80%"></div></div>
        } @else if (paged().length === 0) {
          <div class="empty-state">
            <div class="es-icon"><app-icon name="timer" [size]="22" /></div>
            <h3>{{ hasFilters() ? 'No jobs match your filters' : 'No jobs scheduled' }}</h3>
            <p>{{ hasFilters() ? 'Try widening the filters above.' : 'Timer events and scheduled starts will appear here.' }}</p>
          </div>
        } @else {
          <table>
            <thead><tr><th>Job ID</th><th>PIID</th><th>Process/Node</th><th>Kind</th><th>Next fire</th><th>Retries</th><th>Status</th><th></th></tr></thead>
            <tbody>
              @for (j of paged(); track j.id) {
                <tr>
                  <td class="mono">{{ shortId(j.id) }}</td>
                  <td>@if (j.instanceId) { <a class="ident" [routerLink]="['/instances', j.instanceId]">{{ shortId(j.instanceId) }}</a> } @else { <span class="muted">—</span> }</td>
                  <td>{{ j.processId || j.nodeId || '—' }} @if (j.kind === 'start') { <span class="muted small">(starts a new instance)</span> }
                    @if (j.kind === 'async' && j.attempts) { <span class="muted small" [title]="j.lastError || ''">attempt {{ j.attempts }}/{{ j.maxAttempts }}{{ j.lastError ? ' — ' + j.lastError : '' }}</span> }</td>
                  <td><span class="badge">{{ kindLabel(j.kind) }}</span></td>
                  <td>
                    @if (j.status === 'scheduled') { <b class="countdown">{{ countdown(j.dueAt) }}</b> }
                    @else if (j.status === 'fired') { <b class="fired">{{ ago(j.dueAt) }}</b> }
                    @else { <span class="muted">cancelled</span> }
                  </td>
                  <td class="muted">{{ j.fired }}</td>
                  <td><span class="badge" [class.running]="j.status==='scheduled'" [class.active]="j.status==='fired'" [class.inactive]="j.status==='cancelled'">{{ j.status }}</span></td>
                  <td class="ta-r">
                    @if (j.status === 'scheduled') {
                      <button class="btn sm" (click)="trigger(j)">Trigger now</button>
                      <button class="btn sm" (click)="cancel(j)">Cancel</button>
                    } @else if (j.status === 'cancelled') {
                      <button class="btn sm" (click)="reschedule(j)">Reschedule</button>
                    } @else {
                      <span class="muted">—</span>
                    }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
      </div>
      <div class="row pager">
        <span class="muted">Showing {{ paged().length }} of {{ filtered().length }} jobs (scrolls to load more)</span>
        <span class="spacer"></span>
        <span class="muted">Rows</span>
        <select [(ngModel)]="limit" style="width:70px;"><option [ngValue]="10">10</option><option [ngValue]="20">20</option><option [ngValue]="50">50</option><option [ngValue]="100">100</option></select>
        <button class="btn sm" [disabled]="offset() === 0" (click)="prevPage()">‹ Prev</button>
        <button class="btn sm" [disabled]="offset() + limit >= filtered().length" (click)="nextPage()">Next ›</button>
      </div>
    </div>
  `,
  styles: [`
    .page { padding: 12px 14px; }
    .crumbwrap { margin-bottom: 8px; }
    .pagehead { margin-bottom: 14px; }
    h1 { font-size: 19px; margin: 0; }
    .pagehead p { margin: 4px 0 0; font-size: 13px; color: var(--muted); }
    .filterbar { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .listcard { padding: 0; overflow: auto; }
    .mono { font-family: var(--font-mono); font-size: 12px; }
    .ident { font-family: var(--font-mono); font-weight: 600; color: var(--primary); font-size: 12.5px; text-decoration: none; }
    .ident:hover { text-decoration: underline; }
    .small { font-size: 11px; }
    .countdown { color: var(--primary); }
    .fired { color: var(--red); }
    .ta-r { text-align: right; white-space: nowrap; }
    .pager { margin-top: 12px; font-size: 12.5px; }
    .pad { padding: 16px; }

    @media (max-width: 768px) {
      .page { padding: 12px 14px; }
      .filterbar { flex-direction: column; align-items: stretch; gap: 8px; }
      .filterbar select, .filterbar input { width: 100% !important; }
      .pager { flex-wrap: wrap; gap: 6px; }
    }
  `],
})
export class JobsTimersComponent implements OnInit, OnDestroy {
  private api = inject(OpsApiService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private route = inject(ActivatedRoute);

  statusFilter = 'scheduled';
  kindFilter = '';
  instanceIdFilter = this.route.snapshot.queryParamMap.get('instanceId') || '';
  limit = 25;
  offset = signal(0);
  displayedCount = signal(25);

  all = signal<TimerJob[]>([]);
  loading = signal(true);
  private tick = signal(Date.now());
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private clockTimer: ReturnType<typeof setInterval> | undefined;

  @HostListener('window:scroll') onWindowScroll() {
    const threshold = 250;
    const pos = window.innerHeight + window.scrollY;
    const max = document.documentElement.scrollHeight;
    if (pos >= max - threshold && this.displayedCount() < this.filtered().length) {
      this.displayedCount.update((c) => Math.min(c + 25, this.filtered().length));
    }
  }

  filtered = computed(() => this.all());
  paged = computed(() => { this.tick(); return this.filtered().slice(0, this.displayedCount()); });
  hasFilters = computed(() => !!this.statusFilter || !!this.kindFilter || !!this.instanceIdFilter);

  ngOnInit() {
    this.reload();
    this.refreshTimer = setInterval(() => this.reload(), 15_000);
    this.clockTimer = setInterval(() => this.tick.set(Date.now()), 1000);
  }
  ngOnDestroy() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    if (this.clockTimer) clearInterval(this.clockTimer);
  }

  reload() {
    this.loading.set(true);
    this.api.listJobs({
      status: this.statusFilter || undefined,
      kind: this.kindFilter || undefined,
      instanceId: this.instanceIdFilter || undefined,
    }).subscribe({
      next: (jobs) => { this.all.set(jobs); this.loading.set(false); },
      error: (e) => { this.loading.set(false); this.toast.error(e?.error?.error?.message || 'Could not load jobs'); },
    });
  }

  nextPage() { this.offset.update((o) => o + this.limit); }
  prevPage() { this.offset.update((o) => Math.max(0, o - this.limit)); }

  trigger(j: TimerJob) {
    this.api.triggerJob(j.id).subscribe({
      next: () => { this.toast.success(`Job ${this.shortId(j.id)} triggered`); this.reload(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not trigger job'),
    });
  }

  async cancel(j: TimerJob) {
    const ok = await this.modal.confirm({ title: 'Cancel job', message: `Cancel job ${this.shortId(j.id)}? It will not fire.`, confirmLabel: 'Cancel job', danger: true });
    if (!ok) return;
    this.api.cancelJob(j.id).subscribe({
      next: () => { this.toast.success('Job cancelled'); this.reload(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not cancel job'),
    });
  }

  async reschedule(j: TimerJob) {
    const value = await this.modal.prompt({ title: 'Reschedule job', message: 'New fire time (ISO date-time):', initialValue: new Date(Date.now() + 3_600_000).toISOString().slice(0, 16) });
    if (!value) return;
    this.api.rescheduleJob(j.id, value).subscribe({
      next: () => { this.toast.success('Job rescheduled'); this.reload(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not reschedule job'),
    });
  }

  kindLabel(k: TimerJob['kind']): string { return KIND_LABEL[k]; }
  shortId(id: string): string { return id.length > 8 ? `…${id.slice(-7)}` : id; }

  countdown(dueAt: string): string {
    const ms = Date.parse(dueAt) - Date.now();
    if (ms <= 0) return 'due now';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `in ${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `in ${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    if (h < 24) return `in ${h}h ${m % 60}m`;
    const d = Math.floor(h / 24);
    return `in ${d}d ${h % 24}h`;
  }
  ago(iso: string): string {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86_400)}d ago`;
  }
}
