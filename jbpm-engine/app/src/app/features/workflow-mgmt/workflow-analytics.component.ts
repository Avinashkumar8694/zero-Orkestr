import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe, JsonPipe } from '@angular/common';
import { WorkflowAnalyticsApiService } from '../../core/api/workflow-analytics-api.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { ModalService } from '../../shared/modal.service';
import { ToastService } from '../../shared/toast.service';
import { IconComponent } from '../../shared/icon.component';
import type { QueryDefinition, QueryFilter, QueryOp, QueryRunResult, QueryableEntity, SavedQuery, WorkflowTat } from '../../core/models';
import type { WorkflowInstanceSummary } from '../../core/api/workflow-analytics-api.service';

const ENTITIES: QueryableEntity[] = ['workflowInstance', 'workflowInstanceAudit', 'workflowInstanceComment', 'instance', 'task'];
const OPS: QueryOp[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'contains'];

/** Workflow Analytics — default dashboards (case totals, TAT by case type and by user) plus a fully
 *  generic ad-hoc query builder over an allowlisted set of entities, tenant-scoped and permission-
 *  gated server-side (see query-engine-service.ts). Delegation-aware ownership timelines live on the
 *  Workflow Instance detail page's Tasks tab, not here — see
 *  docs/usage_docs/14-workflow-instance-management.md. */
@Component({
  selector: 'app-workflow-analytics',
  standalone: true,
  imports: [FormsModule, JsonPipe, DecimalPipe, BreadcrumbComponent, IconComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Workflow Analytics' }]" /></div>
      <header class="pagehead"><h1>Workflow Analytics</h1><button class="btn sm" (click)="loadDefaults()"><app-icon name="refresh" [size]="14" /> Refresh</button></header>

      <div class="grid">
        <div class="card">
          <h3>Cases by status</h3>
          @if (summary(); as s) {
            <p class="big">{{ s.total }}</p>
            @for (kv of statusEntries(s.byStatus); track kv[0]) { <div class="kvrow"><span>{{ kv[0] }}</span><span>{{ kv[1] }}</span></div> }
            @if (s.withoutPiid) { <p class="muted sm">{{ s.withoutPiid }} never started a BPM instance</p> }
          } @else { <p class="muted">Loading…</p> }
        </div>
        <div class="card">
          <h3>TAT by workflow (BPM instance duration)</h3>
          @if (tat(); as t) {
            @for (r of t.byWorkflowName; track r.workflowName) { <div class="kvrow"><span>{{ r.workflowName }}</span><span>{{ r.avgMs | number }} ms avg ({{ r.count }})</span></div> }
            @if (!t.byWorkflowName.length) { <p class="muted sm">No completed cases yet.</p> }
          } @else { <p class="muted">Loading…</p> }
        </div>
        <div class="card">
          <h3>TAT by user (task-level)</h3>
          @if (tat(); as t) {
            @for (r of t.byUser; track r.user) { <div class="kvrow"><span>{{ r.user }}</span><span>{{ r.avgMs | number }} ms avg ({{ r.count }})</span></div> }
            @if (!t.byUser.length) { <p class="muted sm">No completed tasks yet.</p> }
          } @else { <p class="muted">Loading…</p> }
        </div>
      </div>

      <h2 class="section-h">Custom query</h2>
      <div class="card">
        <div class="row">
          <label class="fld"><span>Entity</span>
            <select [(ngModel)]="entity">@for (e of entities; track e) { <option [value]="e">{{ e }}</option> }</select>
          </label>
          <label class="fld"><span>Group by (optional)</span><input [(ngModel)]="groupBy" placeholder="e.g. status, data.claimType" /></label>
          <label class="fld"><span>Metric</span>
            <select [(ngModel)]="metric"><option value="">(none — list rows)</option><option value="count">count</option><option value="avgDurationMs">avgDurationMs</option></select>
          </label>
          @if (metric === 'avgDurationMs') {
            <label class="fld"><span>Duration from field</span><input [(ngModel)]="durationFrom" placeholder="createdAt" /></label>
            <label class="fld"><span>Duration to field</span><input [(ngModel)]="durationTo" placeholder="updatedAt" /></label>
          }
        </div>

        <div class="section-title">Filters</div>
        @for (f of filters; track f) {
          <div class="fieldrow">
            <input class="fkey" [(ngModel)]="f.field" placeholder="field, e.g. data.amount" />
            <select [(ngModel)]="f.op">@for (o of ops; track o) { <option [value]="o">{{ o }}</option> }</select>
            <input [(ngModel)]="f.value" placeholder="value" />
            <button class="btn sm danger" (click)="removeFilter(f)" title="Delete" aria-label="Delete"><app-icon name="trash" [size]="12" /></button>
          </div>
        }
        <button class="btn sm" (click)="addFilter()"><app-icon name="plus" [size]="12" /> Add filter</button>

        <div class="row actionrow">
          <button class="btn primary sm" (click)="run()">Run</button>
          <input class="save-name" [(ngModel)]="saveName" placeholder="Save as…" />
          <label class="reqlbl"><input type="checkbox" [(ngModel)]="saveShared" /> shared</label>
          <button class="btn sm" (click)="save()">Save query</button>
        </div>
        @if (queryError()) { <p class="err">{{ queryError() }}</p> }

        @if (result(); as r) {
          @if (r.groups) {
            <table class="restbl"><thead><tr><th>Key</th><th>Count</th>@if (metric==='avgDurationMs') { <th>Avg ms</th> }</tr></thead>
              <tbody>@for (g of r.groups; track g.key) { <tr><td>{{ g.key }}</td><td>{{ g.count }}</td>@if (metric==='avgDurationMs') { <td>{{ g.avgDurationMs }}</td> }</tr> }</tbody>
            </table>
          } @else {
            <pre class="mono sm restext">{{ r.rows | json }}</pre>
          }
        }
      </div>

      <h2 class="section-h">Saved queries</h2>
      <div class="card">
        @if (savedQueries().length === 0) { <p class="muted">None saved yet.</p> }
        @for (q of savedQueries(); track q.id) {
          <div class="crow"><span>{{ q.name }}</span><span class="muted sm">{{ q.definition.entity }}</span><span class="spacer"></span>
            <button class="btn sm" (click)="runSaved(q)">Run</button>
            <button class="btn sm danger" (click)="deleteSaved(q)" title="Delete" aria-label="Delete"><app-icon name="trash" [size]="12" /></button>
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    .page { padding: 20px 24px; max-width: 1080px; }
    .crumbwrap { margin-bottom: 10px; }
    .pagehead { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
    .pagehead h1 { font-size: 19px; margin: 0; flex: 1; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; margin-bottom: 20px; }
    .card { padding: 16px; }
    .card h3 { font-size: 13px; margin: 0 0 10px; text-transform: uppercase; letter-spacing: .03em; color: var(--muted); }
    .big { font-size: 26px; font-weight: 700; margin: 0 0 8px; }
    .kvrow { display: flex; justify-content: space-between; font-size: 13px; padding: 4px 0; border-top: 1px solid var(--border); }
    .kvrow:first-of-type { border-top: none; }
    .muted { color: var(--muted); } .sm { font-size: 12px; } .mono { font-family: ui-monospace, monospace; }
    .section-h { font-size: 15px; margin: 20px 0 10px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; }
    .fld { display: block; margin-bottom: 10px; min-width: 160px; } .fld span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
    .fld input, .fld select { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; font-size: 13px; }
    .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; margin: 10px 0 8px; }
    .fieldrow { display: flex; gap: 8px; margin-bottom: 8px; }
    .fkey { flex: 1; } .fieldrow input, .fieldrow select { border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; font-size: 13px; }
    .actionrow { align-items: center; gap: 10px; margin-top: 12px; }
    .save-name { border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; font-size: 13px; width: 160px; }
    .reqlbl { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); }
    .err { color: var(--red); font-size: 12px; margin-top: 8px; }
    .restbl { width: 100%; margin-top: 12px; } .restbl th, .restbl td { text-align: left; padding: 6px 10px; font-size: 12.5px; border-bottom: 1px solid var(--border); }
    .restext { margin-top: 12px; max-height: 260px; overflow: auto; background: var(--surface-2); padding: 10px; border-radius: 8px; }
    .crow { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--border); }
    .crow:first-of-type { border-top: none; }
    .btn.danger { color: var(--red); }
  `],
})
export class WorkflowAnalyticsComponent {
  private api = inject(WorkflowAnalyticsApiService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);

  entities = ENTITIES;
  ops = OPS;

  summary = signal<WorkflowInstanceSummary | null>(null);
  tat = signal<WorkflowTat | null>(null);
  savedQueries = signal<SavedQuery[]>([]);

  entity: QueryableEntity = 'workflowInstance';
  groupBy = '';
  metric: '' | 'count' | 'avgDurationMs' = '';
  durationFrom = '';
  durationTo = '';
  filters: QueryFilter[] = [];
  result = signal<QueryRunResult | null>(null);
  queryError = signal('');
  saveName = '';
  saveShared = false;

  constructor() { this.loadDefaults(); this.loadSaved(); }

  loadDefaults() {
    this.api.summary().subscribe({ next: (s) => this.summary.set(s), error: (e) => this.toast.error(e?.error?.error?.message || 'Could not load summary') });
    this.api.tat().subscribe({ next: (t) => this.tat.set(t), error: (e) => this.toast.error(e?.error?.error?.message || 'Could not load TAT') });
  }
  loadSaved() { this.api.listSavedQueries().subscribe((q) => this.savedQueries.set(q)); }

  statusEntries(byStatus: Record<string, number>): [string, number][] { return Object.entries(byStatus); }

  addFilter() { this.filters.push({ field: '', op: 'eq', value: '' }); }
  removeFilter(f: QueryFilter) { this.filters = this.filters.filter((x) => x !== f); }

  private buildDefinition(): QueryDefinition {
    return {
      entity: this.entity,
      filters: this.filters.filter((f) => f.field.trim()).map((f) => ({ ...f, value: this.coerce(f.value) })),
      groupBy: this.groupBy.trim() || undefined,
      metric: this.metric || undefined,
      durationFrom: this.metric === 'avgDurationMs' ? this.durationFrom.trim() || undefined : undefined,
      durationTo: this.metric === 'avgDurationMs' ? this.durationTo.trim() || undefined : undefined,
    };
  }
  private coerce(v: unknown): unknown {
    if (typeof v !== 'string') return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
    return v;
  }

  run() {
    this.queryError.set('');
    this.api.runQuery(this.buildDefinition()).subscribe({
      next: (r) => this.result.set(r),
      error: (e) => this.queryError.set(e?.error?.error?.message || 'Query failed'),
    });
  }
  save() {
    if (!this.saveName.trim()) { this.queryError.set('Name is required to save'); return; }
    this.api.saveQuery(this.saveName.trim(), this.buildDefinition(), this.saveShared).subscribe({
      next: () => { this.toast.success('Query saved'); this.saveName = ''; this.loadSaved(); },
      error: (e) => this.queryError.set(e?.error?.error?.message || 'Save failed'),
    });
  }
  runSaved(q: SavedQuery) {
    this.api.runSavedQuery(q.id).subscribe({
      next: (r) => { this.result.set(r); this.metric = q.definition.metric || ''; },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Run failed'),
    });
  }
  async deleteSaved(q: SavedQuery) {
    if (!(await this.modal.confirm({ title: 'Delete saved query', message: `Delete the saved query "${q.name}"?`, confirmLabel: 'Delete', danger: true }))) return;
    this.api.deleteSavedQuery(q.id).subscribe({
      next: () => { this.toast.success('Deleted'); this.loadSaved(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Delete failed'),
    });
  }
}
