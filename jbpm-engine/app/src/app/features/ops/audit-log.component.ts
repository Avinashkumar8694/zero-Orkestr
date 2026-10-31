import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { OpsApiService } from '../../core/api/ops-api.service';
import { ToastService } from '../../shared/toast.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import type { AuditEvent } from '../../core/models';

/** Audit Log (ux_design/mockups/audit-log.html): admin-only read of the trail every service writes
 *  via ctx.audit() server-side. Full-width list; clicking any event opens /audit/:id. */
@Component({
  selector: 'app-audit-log',
  standalone: true,
  imports: [IconComponent, RouterLink, FormsModule, BreadcrumbComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Admin', link: ['/admin'] }, { label: 'Audit Log' }]" /></div>
      <header class="pagehead">
        <div>
          <h1>Audit Log</h1>
          <p class="muted">Every action recorded by the engine — who did what, when, to what. Click any event to inspect full details, diff, and entity context.</p>
        </div>
        <span class="spacer"></span>
        <button class="btn" (click)="reload()"><app-icon name="refresh" [size]="14" /> Refresh</button>
      </header>

      <div class="filterbar card">
        <select [(ngModel)]="actorFilter" (ngModelChange)="reload()">
          <option value="">Actor: all</option>
          @for (a of facets()?.actors || []; track a) { <option [value]="a">{{ a }}</option> }
        </select>
        <select [(ngModel)]="kindFilter" (ngModelChange)="reload()">
          <option value="">Action: all</option>
          @for (k of kindOptions(); track k) { <option [value]="k">{{ k }}</option> }
        </select>
        <input placeholder="Filter by Instance ID" [(ngModel)]="instanceIdFilter" (ngModelChange)="reload()" style="width:180px;" />
        <input placeholder="Filter by Task ID" [(ngModel)]="taskIdFilter" (ngModelChange)="reload()" style="width:160px;" />
        <span class="spacer"></span>
        <button class="btn ghost sm" (click)="resetFilters()">Reset Filters</button>
      </div>

      <div class="card listcard">
        @if (loading()) {
          <div class="pad"><div class="skeleton skeleton-line" style="width:60%"></div><div class="skeleton skeleton-line" style="width:80%"></div></div>
        } @else if (items().length === 0) {
          <div class="empty-state">
            <div class="es-icon"><app-icon name="list" [size]="22" /></div>
            <h3>No audit events match</h3>
            <p>Try widening the filters above.</p>
          </div>
        } @else {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style="width:130px;">When</th>
                  <th style="width:140px;">Actor</th>
                  <th style="width:180px;">Action</th>
                  <th>Target Entity</th>
                  <th style="width:140px;">PIID</th>
                  <th class="ta-r" style="width:90px;"></th>
                </tr>
              </thead>
              <tbody>
                @for (e of items(); track e.id) {
                  <tr class="audit-row" (click)="openEvent(e)">
                    <td class="muted">{{ ago(e.at) }}</td>
                    <td><b>{{ e.actor }}</b></td>
                    <td><span class="badge kind-badge">{{ e.kind }}</span></td>
                    <td>{{ entityLabel(e) }}</td>
                    <td>
                      @if (e.instanceId) {
                        <a class="ident" [routerLink]="['/instances', e.instanceId]" (click)="$event.stopPropagation()">
                          {{ shortId(e.instanceId) }}
                        </a>
                      } @else {
                        <span class="muted">—</span>
                      }
                    </td>
                    <td class="ta-r" (click)="$event.stopPropagation()">
                      <button class="btn sm" (click)="openEvent(e)" title="View Audit Event Details">
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
                <span class="muted">Loading more audit events (showing {{ items().length }} of {{ total() }})…</span>
              } @else {
                <span class="muted">Showing all {{ total() }} events</span>
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
          <option [ngValue]="100">100</option>
        </select>
        <button class="btn sm" [disabled]="offset() === 0" (click)="prevPage()">‹ Prev</button>
        <button class="btn sm" [disabled]="offset() + items().length >= total()" (click)="nextPage()">Next ›</button>
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

    .filterbar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 18px;
      flex-wrap: wrap;
    }

    .listcard { padding: 0; overflow: hidden; }
    .infinite-status { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 12px; font-size: 12.5px; border-top: 1px solid var(--border); }
    .spinner-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); animation: pulse 1s infinite alternate; }
    @keyframes pulse { from { opacity: 0.3; transform: scale(0.8); } to { opacity: 1; transform: scale(1.2); } }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th {
      padding: 11px 16px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .05em;
      color: var(--muted);
      border-bottom: 1px solid var(--border);
      text-align: left;
    }
    td {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    .audit-row {
      cursor: pointer;
      transition: background .12s;
    }
    .audit-row:hover { background: var(--surface-hover); }

    .kind-badge {
      font-size: 12px;
      font-weight: 600;
      background: rgba(91, 61, 245, 0.08);
      color: var(--primary);
      border: 1px solid rgba(91, 61, 245, 0.2);
    }
    .ident {
      font-family: var(--font-mono);
      font-weight: 600;
      color: var(--primary);
      text-decoration: none;
    }
    .ident:hover { text-decoration: underline; }

    .pager {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 12.5px;
      padding: 4px 0;
    }
    .ta-r { text-align: right; }
    .pad { padding: 20px; }
  `],
})
export class AuditLogComponent {
  private api = inject(OpsApiService);
  private toast = inject(ToastService);
  private router = inject(Router);

  actorFilter = '';
  kindFilter = '';
  instanceIdFilter = '';
  taskIdFilter = '';
  limit = 20;
  offset = signal(0);

  items = signal<AuditEvent[]>([]);
  total = signal(0);
  loading = signal(true);
  loadingMore = signal(false);
  hasMore = computed(() => this.items().length < this.total());
  facets = signal<{ kinds: string[]; actors: string[] } | null>(null);

  @HostListener('window:scroll')
  onWindowScroll() {
    const threshold = 200;
    const pos = window.innerHeight + window.scrollY;
    const max = document.documentElement.scrollHeight;
    if (pos >= max - threshold && this.hasMore() && !this.loading() && !this.loadingMore()) {
      this.loadNextPage();
    }
  }

  kindOptions = computed(() => {
    const kinds = this.facets()?.kinds || [];
    const prefixes = new Set(kinds.map((k) => k.split('.')[0] + '.').filter((p) => p !== '.'));
    return [...new Set([...prefixes, ...kinds])].sort();
  });

  constructor() {
    this.api.auditFacets().subscribe((f) => this.facets.set(f));
    this.reload();
  }

  resetFilters() {
    this.actorFilter = '';
    this.kindFilter = '';
    this.instanceIdFilter = '';
    this.taskIdFilter = '';
    this.offset.set(0);
    this.reload();
  }

  reload() {
    this.loading.set(true);
    this.api.listAudit({
      actor: this.actorFilter || undefined,
      kind: this.kindFilter || undefined,
      instanceId: this.instanceIdFilter || undefined,
      taskId: this.taskIdFilter || undefined,
      limit: this.limit,
      offset: this.offset(),
    }).subscribe({
      next: (r) => {
        this.items.set(r.items);
        this.total.set(r.total);
        this.loading.set(false);
      },
      error: (e) => {
        this.loading.set(false);
        this.toast.error(e?.error?.error?.message || 'Could not load audit log');
      },
    });
  }

  openEvent(e: AuditEvent) {
    this.router.navigate(['/audit', e.id]);
  }

  nextPage() { this.offset.update((o) => o + this.limit); this.reload(); }
  prevPage() { this.offset.update((o) => Math.max(0, o - this.limit)); this.reload(); }

  loadNextPage() {
    this.loadingMore.set(true);
    const nextOffset = this.items().length;
    this.api.listAudit({
      actor: this.actorFilter || undefined,
      kind: this.kindFilter || undefined,
      instanceId: this.instanceIdFilter || undefined,
      taskId: this.taskIdFilter || undefined,
      limit: this.limit,
      offset: nextOffset,
    }).subscribe({
      next: (r) => {
        this.items.update((prev) => [...prev, ...r.items]);
        this.total.set(r.total);
        this.loadingMore.set(false);
      },
      error: () => this.loadingMore.set(false),
    });
  }

  entityLabel(e: AuditEvent): string {
    if (e.taskId) return `Task ${this.shortId(e.taskId)}`;
    if (e.instanceId) return `Instance ${this.shortId(e.instanceId)}`;
    if (e.deploymentId) return `Deployment ${this.shortId(e.deploymentId)}`;
    if (e.workflowId) return `Project ${this.shortId(e.workflowId)}`;
    const name = (e.data as any)?.name || (e.data as any)?.username;
    return name ? String(name) : '—';
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
