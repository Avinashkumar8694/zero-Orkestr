import { Component, computed, inject, signal } from '@angular/core';
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
 *  left filter rail + list + detail pane, same three-column shape as Instances/Audit. */
@Component({
  selector: 'app-execution-errors',
  standalone: true,
  imports: [IconComponent, RouterLink, FormsModule, BreadcrumbComponent, TitleCasePipe],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Execution Errors' }]" /></div>
      <header class="pagehead">
        <h1>Execution Errors</h1>
        <p class="muted">Every failure the engine recorded. Errors start unacknowledged and stay listed until someone owns them.</p>
      </header>

      @if (summary(); as s) {
        <div class="kpirow">
          <div class="kpi"><span class="kn">{{ s.total }}</span><span class="kl">total</span></div>
          <div class="kpi bad"><span class="kn">{{ s.unacknowledged }}</span><span class="kl">unacknowledged</span></div>
          <div class="kpi"><span class="kn">{{ s.last24h }}</span><span class="kl">last 24h</span></div>
        </div>
      }

      <div class="grid3">
        <!-- Filters -->
        <div class="card railcard">
          <div class="row railhead"><span class="section-title">Filters</span><span class="spacer"></span><button class="btn ghost sm" (click)="resetFilters()">Reset</button></div>

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
        </div>

        <!-- List -->
        <div class="col listcol">
          @if (selectedIds().size) {
            <div class="bulkbar">
              <span>{{ selectedIds().size }} selected</span>
              <button class="btn sm" (click)="ackSelected()">Acknowledge</button>
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
              <table>
                <thead><tr><th></th><th>ID</th><th>Type</th><th>PIID</th><th>Node</th><th>When</th><th>Ack</th></tr></thead>
                <tbody>
                  @for (e of items(); track e.id) {
                    <tr [class.sel]="selected()?.id === e.id" (click)="select(e)">
                      <td (click)="$event.stopPropagation()"><input type="checkbox" [checked]="selectedIds().has(e.id)" (change)="toggleSelect(e.id)" /></td>
                      <td class="mono">{{ e.id.slice(-6) }}</td>
                      <td><span class="badge" [class.failed]="e.type==='process'||e.type==='task'" [class.waiting]="e.type==='job'">{{ e.type | titlecase }}</span></td>
                      <td>@if (e.instanceId) { <a class="ident" [routerLink]="['/instances', e.instanceId]" (click)="$event.stopPropagation()">{{ shortId(e.instanceId) }}</a> } @else { <span class="muted">—</span> }</td>
                      <td>{{ e.nodeName || '—' }}</td>
                      <td class="muted">{{ ago(e.at) }}</td>
                      <td>@if (e.acknowledged) { <span class="badge active">✓ {{ e.acknowledgedBy }}</span> } @else { <span class="badge failed">no</span> }</td>
                    </tr>
                  }
                </tbody>
              </table>
            }
          </div>
          <div class="row pager">
            <span class="muted">Showing {{ items().length ? offset() + 1 : 0 }}–{{ offset() + items().length }} of {{ total() }}</span>
            <span class="spacer"></span>
            <span class="muted">Rows</span>
            <select [(ngModel)]="limit" (ngModelChange)="reload()" style="width:70px;"><option [ngValue]="10">10</option><option [ngValue]="20">20</option><option [ngValue]="50">50</option></select>
            <button class="btn sm" [disabled]="offset() === 0" (click)="prevPage()">‹ Prev</button>
            <button class="btn sm" [disabled]="offset() + items().length >= total()" (click)="nextPage()">Next ›</button>
          </div>
        </div>

        <!-- Detail -->
        <div class="card detailcard">
          @if (selected(); as e) {
            <div class="row" style="margin-bottom:4px;">
              <h2>Error {{ e.id.slice(-6) }}</h2>
              <span class="badge" [class.failed]="!e.acknowledged" [class.active]="e.acknowledged">{{ e.acknowledged ? 'acknowledged' : 'unacknowledged' }}</span>
            </div>
            <p class="muted small">{{ e.type | titlecase }} error · {{ ago(e.at) }}</p>

            <div class="row actionrow">
              @if (!e.acknowledged) { <button class="btn primary sm" (click)="acknowledge(e)"><app-icon name="check" [size]="12" /> Acknowledge</button> }
              @if (e.instanceId) { <button class="btn sm" (click)="retryNode(e)"><app-icon name="refresh" [size]="12" /> Retry node</button> }
            </div>

            <div class="section-title" style="margin-top:0;">Context</div>
            <table class="kv">
              <tbody>
                <tr><td class="muted">PIID</td><td>@if (e.instanceId) { <a class="ident" [routerLink]="['/instances', e.instanceId]">{{ shortId(e.instanceId) }}</a> } @else { <span class="muted">—</span> }</td></tr>
                <tr><td class="muted">Process</td><td>{{ e.processId || '—' }}</td></tr>
                <tr><td class="muted">Node</td><td>{{ e.nodeId || '—' }} @if (e.nodeName) { · "{{ e.nodeName }}" }</td></tr>
                <tr><td class="muted">Node type</td><td>{{ e.nodeType || '—' }}</td></tr>
                <tr><td class="muted">Deployment</td><td>@if (e.deploymentId) { <a class="ident" [routerLink]=\"['/deployments', e.deploymentId]\">{{ shortId(e.deploymentId) }}</a> } @else { <span class="muted">—</span> }</td></tr>
                <tr><td class="muted">Occurrences</td><td>{{ e.occurrences }}</td></tr>
              </tbody>
            </table>

            <div class="section-title">Message</div>
            <pre class="msgbox">{{ e.stack || e.message }}</pre>

            <div class="section-title">Go to</div>
            <div class="col" style="gap:6px;">
              @if (e.instanceId) { <a class="btn sm goto" [routerLink]="['/instances', e.instanceId]" [queryParams]="{tab:'diagram'}"><app-icon name="arrowRight" [size]="12" /> Instance diagram</a> }
              @if (e.taskId) { <a class="btn sm goto" [routerLink]="['/tasks', e.taskId]"><app-icon name="tasks" [size]="12" /> Related task</a> }
              @if (e.instanceId) { <a class="btn sm goto" [routerLink]="['/instances', e.instanceId]" [queryParams]="{tab:'logs'}"><app-icon name="file" [size]="12" /> Instance logs</a> }
            </div>

            @if (e.acknowledged) {
              <div class="section-title">Acknowledgement</div>
              <p class="muted small">Acknowledged by {{ e.acknowledgedBy }} · {{ ago(e.acknowledgedAt!) }}</p>
            } @else {
              <div class="section-title">Acknowledgement</div>
              <p class="muted small">Acknowledging records who took ownership and when, so the unacked list stays a real work queue rather than noise.</p>
            }
          } @else {
            <div class="empty-state">
              <div class="es-icon"><app-icon name="search" [size]="22" /></div>
              <h3>No error selected</h3>
              <p>Select a row on the left to see its full message, context and quick actions.</p>
            </div>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    .page { padding: 20px 24px; height: 100%; display: flex; flex-direction: column; min-height: 0; }
    .crumbwrap { margin-bottom: 8px; }
    .pagehead { margin-bottom: 12px; }
    h1 { font-size: 19px; margin: 0; }
    .pagehead p { margin: 4px 0 0; font-size: 13px; color: var(--muted); }
    .kpirow { display: flex; gap: 12px; margin-bottom: 14px; }
    .kpi { display: flex; flex-direction: column; padding: 10px 16px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); }
    .kpi.bad .kn { color: var(--red); }
    .kn { font-size: 20px; font-weight: 700; }
    .kl { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .03em; }
    .grid3 { display: grid; grid-template-columns: 240px 1fr 380px; gap: 16px; flex: 1; min-height: 0; }
    .railcard { padding: 16px; overflow: auto; }
    .railhead { margin-bottom: 4px; }
    .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; margin: 10px 0 6px; }
    .col { display: flex; flex-direction: column; gap: 6px; min-height: 0; }
    .chk { font-size: 13px; gap: 8px; }
    .chips { flex-wrap: wrap; gap: 6px; }
    .chip { border: 1px solid var(--border); border-radius: var(--radius-pill); padding: 4px 11px; font-size: 12px; cursor: pointer; color: var(--text-secondary); }
    .chip.on { background: var(--primary-50); color: var(--primary); border-color: var(--primary); font-weight: 600; }
    .listcol { min-height: 0; }
    .listcard { flex: 1; overflow: auto; padding: 0; }
    .bulkbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--primary-50); border-radius: var(--radius-sm); font-size: 12.5px; }
    tbody tr { cursor: pointer; } tbody tr:hover { background: var(--surface-2); } tr.sel td { background: var(--primary-50); }
    .mono { font-family: var(--font-mono); font-size: 12px; }
    .ident { font-family: var(--font-mono); font-weight: 600; color: var(--primary); font-size: 12.5px; text-decoration: none; }
    .ident:hover { text-decoration: underline; }
    .pager { font-size: 12.5px; }
    .detailcard { padding: 18px; overflow: auto; }
    h2 { font-size: 15px; margin: 0; }
    .small { font-size: 12.5px; margin: 0 0 14px; }
    .actionrow { gap: 6px; margin-bottom: 16px; flex-wrap: wrap; }
    .kv { width: 100%; margin-bottom: 4px; } .kv td { padding: 6px 4px; border-bottom: 1px solid var(--border); font-size: 12.5px; vertical-align: top; } .kv td:first-child { width: 34%; }
    .msgbox { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; font-size: 11.5px; font-family: var(--font-mono); white-space: pre-wrap; margin: 0 0 4px; max-height: 220px; overflow: auto; }
    .goto { justify-content: flex-start; gap: 6px; text-decoration: none; }
    .pad { padding: 16px; }
    .empty-state .btn { margin-top: 10px; }
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
  selected = signal<ExecutionError | null>(null);
  selectedIds = signal<Set<string>>(new Set());
  summary = signal<{ total: number; unacknowledged: number; last24h: number } | null>(null);

  hasFilters = computed(() => this.typeFilter().size < TYPES.length || this.ack() !== 'no' || !!this.instanceIdFilter || !!this.jobIdFilter || !!this.nodeFilter);

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
    this.typeFilter.set(new Set(TYPES)); this.ack.set('no');
    this.instanceIdFilter = ''; this.jobIdFilter = ''; this.nodeFilter = '';
    this.offset.set(0); this.reload();
  }

  reload() {
    this.loading.set(true);
    this.api.listErrors({
      type: [...this.typeFilter()].join(','),
      acknowledged: this.ack() === 'any' ? undefined : this.ack() === 'yes',
      instanceId: this.instanceIdFilter || undefined,
      jobId: this.jobIdFilter || undefined,
      limit: this.limit, offset: this.offset(),
    }).subscribe({
      next: (r) => {
        const filtered = this.nodeFilter ? r.items.filter((e) => (e.nodeName || '').toLowerCase().includes(this.nodeFilter.toLowerCase())) : r.items;
        this.items.set(filtered); this.total.set(r.total); this.loading.set(false);
      },
      error: (e) => { this.loading.set(false); this.toast.error(e?.error?.error?.message || 'Could not load errors'); },
    });
  }

  nextPage() { this.offset.update((o) => o + this.limit); this.reload(); }
  prevPage() { this.offset.update((o) => Math.max(0, o - this.limit)); this.reload(); }

  select(e: ExecutionError) { this.selected.set(e); }
  toggleSelect(id: string) {
    const s = new Set(this.selectedIds());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.selectedIds.set(s);
  }

  acknowledge(e: ExecutionError) {
    this.api.acknowledgeError(e.id).subscribe({
      next: (updated) => { this.selected.set(updated); this.patchItem(updated); this.toast.success('Error acknowledged'); },
      error: (err) => this.toast.error(err?.error?.error?.message || 'Could not acknowledge'),
    });
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

  async retryNode(e: ExecutionError) {
    if (!e.instanceId || !e.nodeId) return;
    const ok = await this.modal.confirm({ title: 'Retry node', message: `Re-trigger node "${e.nodeName || e.nodeId}" on instance ${this.shortId(e.instanceId)}?`, confirmLabel: 'Retry' });
    if (!ok) return;
    this.router.navigate(['/instances', e.instanceId]);
  }

  private patchItem(updated: ExecutionError) {
    this.items.update((list) => list.map((x) => (x.id === updated.id ? updated : x)));
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
