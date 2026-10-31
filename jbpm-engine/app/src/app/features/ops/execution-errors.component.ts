import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { TitleCasePipe } from '@angular/common';
import { OpsApiService } from '../../core/api/ops-api.service';
import { ToastService } from '../../shared/toast.service';
import { ModalService } from '../../shared/modal.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import type { ExecutionError } from '../../core/models';

type AckFilter = 'no' | 'yes' | 'any';
const TYPES = ['process', 'task', 'job', 'integration'] as const;

/** Execution Errors — the operational failure queue (ux_design/mockups/execution-errors.html):
 *  persistent filter rail on the left + full-width errors list. Clicking any error opens its
 *  dedicated detail page at /errors/:id. */
@Component({
  selector: 'app-execution-errors',
  standalone: true,
  imports: [IconComponent, RouterLink, FormsModule, BreadcrumbComponent, TitleCasePipe],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Execution Errors' }]" /></div>
      <header class="pagehead">
        <div>
          <h1>Execution Errors</h1>
          <p class="muted">Every failure the engine recorded. Click any error row to open its full failure details, stack trace, context, and recovery actions.</p>
        </div>
        <span class="spacer"></span>
        <button class="btn" (click)="reload()"><app-icon name="refresh" [size]="14" /> Refresh</button>
      </header>

      @if (summary(); as s) {
        <div class="kpirow">
          <div class="kpi"><span class="kn">{{ s.total }}</span><span class="kl">total</span></div>
          <div class="kpi bad"><span class="kn">{{ s.unacknowledged }}</span><span class="kl">unacknowledged</span></div>
          <div class="kpi"><span class="kn">{{ s.last24h }}</span><span class="kl">last 24h</span></div>
        </div>
      }

      <div class="layout">
        <!-- Left Filter Rail -->
        <aside class="card railcard">
          <div class="row railhead">
            <span class="section-title">Filters</span>
            <span class="spacer"></span>
            <button class="btn ghost sm" (click)="resetFilters()">Reset</button>
          </div>

          <div class="section-title">Type</div>
          <div class="col" style="margin-bottom:14px;">
            @for (t of types; track t) {
              <label class="row chk"><input type="checkbox" [checked]="typeFilter().has(t)" (change)="toggleType(t)" /> {{ t | titlecase }}</label>
            }
          </div>

          <div class="section-title">Acknowledged</div>
          <div class="row chips" style="margin-bottom:14px;">
            <span class="chip" [class.on]="ack() === 'no'" (click)="ack.set('no')">No</span>
            <span class="chip" [class.on]="ack() === 'yes'" (click)="ack.set('yes')">Yes</span>
            <span class="chip" [class.on]="ack() === 'any'" (click)="ack.set('any')">Any</span>
          </div>

          <div class="section-title">Filter by</div>
          <input placeholder="PIID (e.g. PI-1091)" [(ngModel)]="instanceIdFilter" style="width:100%; margin-bottom:8px;" />
          <input placeholder="Job id" [(ngModel)]="jobIdFilter" style="width:100%; margin-bottom:8px;" />
          <input placeholder="Node name" [(ngModel)]="nodeFilter" style="width:100%; margin-bottom:14px;" />

          <button class="btn primary sm" style="width:100%;" (click)="reload()">Apply</button>
        </aside>

        <!-- Full-Width Error List -->
        <main class="col listcol">
          @if (selectedIds().size) {
            <div class="bulkbar">
              <span><b>{{ selectedIds().size }}</b> selected</span>
              <button class="btn sm" (click)="ackSelected()"><app-icon name="check" [size]="12" /> Acknowledge Selected</button>
              <span class="spacer"></span>
            </div>
          }

          <div class="card listcard">
            @if (loading()) {
              <div class="pad"><div class="skeleton skeleton-line" style="width:60%"></div><div class="skeleton skeleton-line" style="width:80%"></div></div>
            } @else if (items().length === 0) {
              <div class="empty-state">
                <div class="es-icon"><app-icon name="warning" [size]="22" /></div>
                <h3>{{ hasFilters() ? 'No errors match your filters' : 'No errors recorded' }}</h3>
                <p>{{ hasFilters() ? 'Try widening the filters on the left.' : 'The engine has not recorded any failures yet.' }}</p>
                @if (hasFilters()) { <button class="btn sm" (click)="resetFilters()">Reset filters</button> }
              </div>
            } @else {
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th style="width:36px;"></th>
                      <th style="width:110px;">ID</th>
                      <th style="width:110px;">Type</th>
                      <th style="width:130px;">PIID</th>
                      <th>Node / Failure Reason</th>
                      <th style="width:70px; text-align:center;">Occur</th>
                      <th style="width:110px;">When</th>
                      <th style="width:130px;">Ack</th>
                      <th class="ta-r" style="width:90px;"></th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (e of items(); track e.id) {
                      <tr class="err-row" (click)="openError(e)">
                        <td (click)="$event.stopPropagation()">
                          <input type="checkbox" [checked]="selectedIds().has(e.id)" (change)="toggleSelect(e.id)" />
                        </td>
                        <td class="mono">
                          <code class="err-id">{{ e.id.slice(-6) }}</code>
                        </td>
                        <td>
                          <span class="badge" [class.failed]="e.type==='process'||e.type==='task'" [class.waiting]="e.type==='job'">
                            {{ e.type | titlecase }}
                          </span>
                        </td>
                        <td>
                          @if (e.instanceId) {
                            <a class="ident" [routerLink]="['/instances', e.instanceId]" (click)="$event.stopPropagation()">
                              {{ shortId(e.instanceId) }}
                            </a>
                          } @else {
                            <span class="muted">—</span>
                          }
                        </td>
                        <td>
                          <div class="node-cell">
                            <span class="node-name">{{ e.nodeName || e.nodeId || 'Unknown Node' }}</span>
                            @if (e.message) {
                              <span class="msg-snippet" [title]="e.message">{{ e.message }}</span>
                            }
                          </div>
                        </td>
                        <td style="text-align:center;">
                          <span class="badge count-badge">{{ e.occurrences }}</span>
                        </td>
                        <td class="muted">{{ ago(e.at) }}</td>
                        <td>
                          @if (e.acknowledged) {
                            <span class="badge active" [title]="'Acknowledged by ' + e.acknowledgedBy">✓ {{ e.acknowledgedBy }}</span>
                          } @else {
                            <span class="badge failed">unacked</span>
                          }
                        </td>
                        <td class="ta-r" (click)="$event.stopPropagation()">
                          <button class="btn sm" (click)="openError(e)" title="View Error Details">
                            <span>View</span>
                            <app-icon name="arrowRight" [size]="12" />
                          </button>
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (items().length > 0) {
                <div class="infinite-status">
                  @if (hasMore()) {
                    <span class="spinner-dot"></span>
                    <span class="muted">Loading more errors (showing {{ items().length }} of {{ total() }})…</span>
                  } @else {
                    <span class="muted">Showing all {{ total() }} errors</span>
                  }
                </div>
              }
            }
          </div>

          <div class="row pager">
            <span class="muted">Showing {{ items().length ? offset() + 1 : 0 }}–{{ offset() + items().length }} of {{ total() }}</span>
            <span class="spacer"></span>
            <span class="muted">Rows</span>
            <select [(ngModel)]="limit" (ngModelChange)="reload()" style="width:70px;">
              <option [ngValue]="10">10</option>
              <option [ngValue]="20">20</option>
              <option [ngValue]="50">50</option>
            </select>
            <button class="btn sm" [disabled]="offset() === 0" (click)="prevPage()">‹ Prev</button>
            <button class="btn sm" [disabled]="offset() + items().length >= total()" (click)="nextPage()">Next ›</button>
          </div>
        </main>
      </div>
    </div>
  `,
  styles: [`
    .page { padding: 24px; max-width: 1600px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
    .crumbwrap { margin-bottom: 2px; }
    .pagehead {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .pagehead h1 { font-size: 24px; margin: 0 0 4px 0; font-weight: 700; }
    .pagehead p { margin: 0; font-size: 13.5px; color: var(--muted); }

    .kpirow { display: flex; gap: 12px; }
    .kpi { display: flex; flex-direction: column; padding: 10px 18px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); }
    .kpi.bad .kn { color: var(--red); }
    .kn { font-size: 22px; font-weight: 700; }
    .kl { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; font-weight: 600; }

    /* 2-COLUMN LAYOUT */
    .layout {
      display: grid;
      grid-template-columns: 240px 1fr;
      gap: 18px;
      align-items: start;
    }
    @media (max-width: 900px) {
      .layout { grid-template-columns: 1fr; }
    }

    .railcard { padding: 18px; }
    .railhead { margin-bottom: 8px; }
    .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 700; margin: 12px 0 6px; }
    .col { display: flex; flex-direction: column; gap: 6px; }
    .chk { font-size: 13px; gap: 8px; }
    .chips { flex-wrap: wrap; gap: 6px; }
    .chip { border: 1px solid var(--border); border-radius: var(--radius-pill); padding: 4px 11px; font-size: 12px; cursor: pointer; color: var(--text-secondary); }
    .chip.on { background: var(--primary-50); color: var(--primary); border-color: var(--primary); font-weight: 600; }

    .listcol { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .listcard { padding: 0; overflow: hidden; }
    .infinite-status { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; font-size: 12.5px; border-top: 1px solid var(--border); }
    .spinner-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); animation: pulse 1s infinite alternate; }
    @keyframes pulse { from { opacity: 0.3; transform: scale(0.8); } to { opacity: 1; transform: scale(1.2); } }
    .table-wrap { overflow-x: auto; }
    .bulkbar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 14px;
      background: var(--primary-50);
      border: 1px solid var(--primary-100, rgba(91,61,245,.2));
      border-radius: var(--radius-sm);
      font-size: 13px;
      color: var(--primary);
    }

    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th {
      padding: 11px 14px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      text-align: left;
    }
    td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    .err-row {
      cursor: pointer;
      transition: background .12s;
    }
    .err-row:hover { background: var(--surface-hover); }

    .err-id {
      font-size: 12px;
      font-family: var(--font-mono);
      background: var(--surface-soft);
      padding: 2px 6px;
      border-radius: 4px;
    }
    .ident {
      font-family: var(--font-mono);
      font-weight: 600;
      color: var(--primary);
      text-decoration: none;
    }
    .ident:hover { text-decoration: underline; }

    .node-cell {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .node-name {
      font-weight: 600;
      color: var(--text);
    }
    .msg-snippet {
      font-size: 12px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 480px;
    }
    .count-badge {
      font-size: 11px;
      background: var(--border);
      color: var(--text-secondary);
      padding: 1px 6px;
      border-radius: 999px;
    }
    .pager {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12.5px;
      padding: 4px 0;
    }
    .ta-r { text-align: right; }
    .pad { padding: 20px; }

    @media (max-width: 768px) {
      .page { padding: 12px 14px; }
      .pagehead { flex-direction: column; align-items: stretch; gap: 10px; }
      .kpirow { flex-wrap: wrap; }
      .kpi { flex: 1 1 auto; }
      .bulkbar { flex-wrap: wrap; gap: 6px; }
    }
  `],
})
export class ExecutionErrorsComponent {
  private api = inject(OpsApiService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  types = TYPES;
  typeFilter = signal<Set<string>>(new Set(TYPES));
  ack = signal<AckFilter>('no');
  instanceIdFilter = this.route.snapshot.queryParamMap.get('instanceId') || '';
  jobIdFilter = '';
  nodeFilter = '';
  limit = 20;
  offset = signal(0);

  items = signal<ExecutionError[]>([]);
  total = signal(0);
  loading = signal(true);
  loadingMore = signal(false);
  hasMore = computed(() => this.items().length < this.total());
  selectedIds = signal<Set<string>>(new Set());
  summary = signal<{ total: number; unacknowledged: number; last24h: number } | null>(null);

  hasFilters = computed(() => this.typeFilter().size < TYPES.length || this.ack() !== 'no' || !!this.instanceIdFilter || !!this.jobIdFilter || !!this.nodeFilter);

  @HostListener('window:scroll')
  onWindowScroll() {
    const threshold = 200;
    const pos = window.innerHeight + window.scrollY;
    const max = document.documentElement.scrollHeight;
    if (pos >= max - threshold && this.hasMore() && !this.loading() && !this.loadingMore()) {
      this.loadNextPage();
    }
  }

  constructor() {
    this.reload();
    this.api.errorSummary().subscribe((s) => this.summary.set(s));
  }

  toggleType(t: string) {
    const s = new Set(this.typeFilter());
    if (s.has(t)) s.delete(t); else s.add(t);
    this.typeFilter.set(s);
  }

  resetFilters() {
    this.typeFilter.set(new Set(TYPES));
    this.ack.set('no');
    this.instanceIdFilter = '';
    this.jobIdFilter = '';
    this.nodeFilter = '';
    this.offset.set(0);
    this.reload();
  }

  reload() {
    this.loading.set(true);
    this.api.listErrors({
      type: [...this.typeFilter()].join(','),
      acknowledged: this.ack() === 'any' ? undefined : this.ack() === 'yes',
      instanceId: this.instanceIdFilter || undefined,
      jobId: this.jobIdFilter || undefined,
      limit: this.limit,
      offset: this.offset(),
    }).subscribe({
      next: (r) => {
        const filtered = this.nodeFilter ? r.items.filter((e) => (e.nodeName || '').toLowerCase().includes(this.nodeFilter.toLowerCase())) : r.items;
        this.items.set(filtered);
        this.total.set(r.total);
        this.loading.set(false);
      },
      error: (e) => {
        this.loading.set(false);
        this.toast.error(e?.error?.error?.message || 'Could not load errors');
      },
    });
  }

  nextPage() { this.offset.update((o) => o + this.limit); this.reload(); }
  prevPage() { this.offset.update((o) => Math.max(0, o - this.limit)); this.reload(); }

  loadNextPage() {
    this.loadingMore.set(true);
    const nextOffset = this.items().length;
    this.api.listErrors({
      type: [...this.typeFilter()].join(','),
      acknowledged: this.ack() === 'any' ? undefined : this.ack() === 'yes',
      instanceId: this.instanceIdFilter || undefined,
      jobId: this.jobIdFilter || undefined,
      limit: this.limit,
      offset: nextOffset,
    }).subscribe({
      next: (r) => {
        const filtered = this.nodeFilter ? r.items.filter((e) => (e.nodeName || '').toLowerCase().includes(this.nodeFilter.toLowerCase())) : r.items;
        this.items.update((prev) => [...prev, ...filtered]);
        this.total.set(r.total);
        this.loadingMore.set(false);
      },
      error: () => this.loadingMore.set(false),
    });
  }

  openError(e: ExecutionError) {
    this.router.navigate(['/errors', e.id]);
  }

  toggleSelect(id: string) {
    const s = new Set(this.selectedIds());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.selectedIds.set(s);
  }

  ackSelected() {
    const ids = [...this.selectedIds()];
    this.api.acknowledgeErrors(ids).subscribe({
      next: (r) => {
        const ok = r.results.filter((x) => x.ok).length;
        this.toast.success(`Acknowledged ${ok} of ${ids.length}`);
        this.selectedIds.set(new Set());
        this.reload();
      },
      error: (err) => this.toast.error(err?.error?.error?.message || 'Bulk acknowledge failed'),
    });
  }

  shortId(id: string): string { return id.length > 8 ? `…${id.slice(-7)}` : id; }
  ago(iso: string): string {
    const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86_400)}d ago`;
  }
}
