import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SlicePipe } from '@angular/common';
import { InstanceApiService } from '../../core/api/instance-api.service';
import { DeploymentApiService } from '../../core/api/deployment-api.service';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { ToastService } from '../../shared/toast.service';
import { ModalService } from '../../shared/modal.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import type { Deployment, Instance, Workflow } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';

const STATUSES = ['running', 'waiting', 'suspended', 'failed', 'completed', 'aborted'] as const;
interface SavedFilter { name: string; stateSet: string[]; errorsOnly: boolean; q: string; qBy: string; projectFilter: string; isDefault?: boolean; }
const SAVED_KEY = 'instances.savedFilters';

// Top-level page (like Tasks/Deployments) — a running instance always belongs to one project, but
// browsing/managing instances is a cross-project concern (jBPM's own Manage > Process Instances works
// the same way). Detail lives at its own route (/instances/:id, see instance-detail.component.ts) —
// this page is list + persistent filter rail only, matching ux_design/mockups/instances-list.html.
@Component({
  selector: 'app-instances',
  standalone: true,
  imports: [IconComponent, RouterLink, FormsModule, SlicePipe, BreadcrumbComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Instances' }]" /></div>
      <header class="pagehead">
        <h1>Process Instances</h1>
        <span class="spacer"></span>
        <button class="btn" (click)="reload()"><app-icon name="refresh" [size]="14" /> Refresh</button>
        <a class="btn primary" [routerLink]="['/instances/start']"><app-icon name="play" [size]="14" /> New Instance</a>
      </header>
      <p class="muted sub">Every process instance the engine is tracking, filterable by state and variables.</p>

      <div class="layout">
        <!-- FILTER RAIL (ux_design/mockups/instances-list.html) — persistent, not a flyout. -->
        <aside class="rail card">
          <div class="rail-h">
            <span class="section-title">Filters</span>
            <span class="spacer"></span>
            <button class="btn ghost sm" (click)="resetFilters()">Reset</button>
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
            <input type="checkbox" [checked]="errorsOnly()" (change)="errorsOnly.set(!errorsOnly())" />
            Has errors only
          </label>

          <div class="section-title">Filter by</div>
          <input class="rail-in" placeholder="PIID / correlation key" [ngModel]="q()" (ngModelChange)="q.set($event); page.set(1)" aria-label="Filter by id or correlation key" />
          <input class="rail-in" placeholder="Initiator" [ngModel]="qBy()" (ngModelChange)="qBy.set($event); page.set(1)" aria-label="Filter by initiator" />

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
              <span>{{ selectedIds().size }} selected</span>
              <button class="btn sm" (click)="bulkSuspend()">Suspend</button>
              <button class="btn sm" (click)="bulkResume()">Resume</button>
              <button class="btn sm danger" (click)="bulkAbort()">Abort</button>
              <span class="spacer"></span>
            </div>
          }
          <div class="list card">
            <table>
              <thead><tr>
                <th></th>
                <th>PIID</th><th>Process</th><th>Status</th><th>Initiator</th>
                <th class="sortable" (click)="sortDesc.set(!sortDesc())">Started <span class="sort-ic">{{ sortDesc() ? '▼' : '▲' }}</span></th>
                <th>Duration</th><th>Errors</th><th></th>
              </tr></thead>
              <tbody>
                @for (i of paged(); track i.id) {
                  <tr [class.sel]="selectedIds().has(i.id)">
                    <td (click)="$event.stopPropagation()"><input type="checkbox" [checked]="selectedIds().has(i.id)" (change)="toggleSelect(i.id)" /></td>
                    <td class="mono piid"><a [routerLink]="['/instances', i.id]" [title]="i.id">{{ shortId(i.id) }}</a></td>
                    <td><a class="plain" [routerLink]="['/instances', i.id]">{{ procName(i) }}</a><div class="proj muted">{{ projectName(i.workflowId) }}</div></td>
                    <td><span class="badge" [style.color]="statusColor(i.status)">{{ i.status }}</span></td>
                    <td>{{ i.startedBy }}</td>
                    <td class="muted">{{ ago(i.startedAt) }}</td>
                    <td class="muted">{{ duration(i) }}</td>
                    <td><span class="err-badge" [class.has]="i.status === 'failed'">{{ i.status === 'failed' ? 1 : 0 }}</span></td>
                    <td class="menucell" (click)="$event.stopPropagation()">
                      <button class="kebab" (click)="openMenu($event, i.id)" aria-label="Row actions" aria-haspopup="menu"><app-icon name="more" [size]="15" /></button>
                    </td>
                  </tr>
                }
                @if (filtered().length === 0) {
                  <tr><td colspan="9">
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
                        <p>Start one from a deployed process to see it here.</p>
                        <a class="btn" [routerLink]="['/instances/start']">Start an instance</a>
                      </div>
                    }
                  </td></tr>
                }
              </tbody>
            </table>
            @if (filtered().length > 0) {
              <div class="pager">
                <span class="muted">Showing {{ pageStart() + 1 }}–{{ pageEnd() }} of {{ filtered().length }}</span>
                <span class="spacer"></span>
                <span class="muted">Rows</span>
                <select class="rows-sel" [ngModel]="pageSize()" (ngModelChange)="pageSize.set(+$event); page.set(1)" aria-label="Rows per page">
                  <option [value]="10">10</option><option [value]="20">20</option><option [value]="50">50</option><option [value]="100">100</option>
                </select>
                <button class="btn sm" [disabled]="page() === 1" (click)="page.set(page() - 1)">‹ Prev</button>
                <button class="btn sm" [disabled]="pageEnd() >= filtered().length" (click)="page.set(page() + 1)">Next ›</button>
              </div>
            }
          </div>
        </div>
      </div>

      <!-- Rendered fixed + outside .list on purpose: .list scrolls horizontally (min-width: 720px
           table), and any scrolling ancestor also clips this menu's overflow-y, cutting it down to a
           sliver. Positioning it here at page level, placed via the kebab's own screen coordinates,
           sidesteps that entirely. -->
      @if (menuInstance(); as i) {
        <div class="rowmenu card" [style.top.px]="menuPos().top" [style.left.px]="menuPos().left" (click)="$event.stopPropagation()">
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
    </div>
  `,
  styles: [`
    .page { padding: 20px 24px; }
    .crumbwrap { margin-bottom: 10px; }
    .pagehead { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
    h1 { font-size: 19px; margin: 0; }
    .sub { margin: 0 0 14px; font-size: 13px; }
    .layout { display: grid; grid-template-columns: 260px 1fr; gap: 16px; align-items: start; }
    .rail { padding: 16px; position: sticky; top: 16px; }
    .rail-h { display: flex; align-items: center; margin-bottom: 2px; }
    .section-title { font-size: var(--text-xs); text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 700; margin: 12px 0 6px; display: block; }
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
    .list { overflow-x: auto; padding: 0; }
    .list table { width: 100%; border-collapse: collapse; min-width: 720px; }
    .list th, .list td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
    tbody tr:hover { background: var(--surface-2); } tr.sel td { background: var(--primary-50); }
    .piid a, .plain { color: var(--primary); font-weight: 600; text-decoration: none; }
    .piid a:hover, .plain:hover { text-decoration: underline; }
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
    .pager { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--border); font-size: var(--text-xs); }
    .rows-sel { width: 64px; padding: 4px 6px; }
    .empty-state .btn { margin-top: 12px; }
  `],
})
export class InstancesComponent {
  private api = inject(InstanceApiService);
  private deploymentApi = inject(DeploymentApiService);
  private wfApi = inject(WorkflowApiService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  workflows = signal<Workflow[]>([]);
  projectFilter = signal<string>(this.route.snapshot.queryParamMap.get('workflowId') || '');
  private wfNames = computed(() => new Map(this.workflows().map((w) => [w.id, w.name])));
  projectName(id: string) { return this.wfNames().get(id) || id; }

  instances = signal<Instance[]>([]);
  deployments = signal<Record<string, Deployment>>({});
  statuses = STATUSES;
  stateSet = signal<Set<string>>(new Set(STATUSES));
  q = signal(''); qBy = signal('');
  errorsOnly = signal(false);
  sortDesc = signal(true);
  page = signal(1); pageSize = signal(20);
  selectedIds = signal<Set<string>>(new Set());
  menuFor = signal<string | null>(null);
  menuPos = signal<{ top: number; left: number }>({ top: 0, left: 0 });
  menuInstance = computed(() => this.instances().find((i) => i.id === this.menuFor()));
  savedFilters = signal<SavedFilter[]>(this.loadSaved());

  // Clicks inside the menu/kebab stop propagation (see the template), so this only ever sees clicks
  // genuinely outside the menu — safe to unconditionally close on every document click.
  @HostListener('document:click') closeMenu() { this.menuFor.set(null); }
  openMenu(ev: Event, id: string) {
    const btn = ev.currentTarget as HTMLElement;
    const r = btn.getBoundingClientRect();
    this.menuPos.set({ top: r.bottom + 4, left: Math.max(8, r.right - 200) });
    this.menuFor.set(this.menuFor() === id ? null : id);
  }

  filtered = computed(() => {
    const states = this.stateSet(); const q = this.q().toLowerCase(); const by = this.qBy().toLowerCase();
    const list = this.instances().filter((i) =>
      states.has(i.status)
      && (!this.errorsOnly() || i.status === 'failed' || !!i.error)
      && (!q || i.id.toLowerCase().includes(q) || (i.correlationKey || '').toLowerCase().includes(q))
      && (!by || (i.startedBy || '').toLowerCase().includes(by)));
    const dir = this.sortDesc() ? -1 : 1;
    return [...list].sort((a, b) => ((a.endedAt || a.startedAt) < (b.endedAt || b.startedAt) ? -dir : dir));
  });
  hasFilters = computed(() => this.stateSet().size < STATUSES.length || this.errorsOnly() || !!this.q() || !!this.qBy());
  countByStatus = computed(() => {
    const out: Record<string, number> = {};
    for (const i of this.instances()) out[i.status] = (out[i.status] || 0) + 1;
    return out;
  });
  pageStart = computed(() => (this.page() - 1) * this.pageSize());
  pageEnd = computed(() => Math.min(this.pageStart() + this.pageSize(), this.filtered().length));
  paged = computed(() => this.filtered().slice(this.pageStart(), this.pageEnd()));

  constructor() {
    this.wfApi.listWorkflows().subscribe((ws) => this.workflows.set(ws));
    this.reload();
    const def = this.savedFilters().find((sf) => sf.isDefault);
    if (def) this.applySaved(def);
  }

  reload() {
    const workflowId = this.projectFilter() || undefined;
    this.api.listInstances({ workflowId }).subscribe({ next: (is) => this.instances.set(is), error: (e) => this.toast.error(e?.error?.error?.message || 'Could not load instances') });
    this.deploymentApi.listDeploymentsGlobal({ workflowId }).subscribe((ds) => this.deployments.set(Object.fromEntries(ds.map((d) => [d.id, d]))));
  }
  setProjectFilter(id: string) { this.projectFilter.set(id); this.reload(); }
  toggleState(st: string) {
    const next = new Set(this.stateSet());
    next.has(st) ? next.delete(st) : next.add(st);
    this.stateSet.set(next); this.page.set(1);
  }
  resetFilters() {
    this.stateSet.set(new Set(STATUSES));
    this.q.set(''); this.qBy.set(''); this.errorsOnly.set(false); this.page.set(1);
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
    // Terminal instances (completed/aborted) have nothing to abort — filter them out up front instead
    // of relying on the backend's silent no-op, so the confirm count and bulkResult tally both reflect
    // what actually happens (matches bulkSuspend/bulkResume's own pre-filtering below).
    const items = this.selectedInstances().filter((i) => i.status !== 'completed' && i.status !== 'aborted');
    if (!items.length) { this.toast.error('None of the selected instances can be aborted (already completed/aborted).'); return; }
    const ok = await this.modal.confirm({ title: 'Abort instances', message: `Abort ${items.length} selected instance(s)? This cannot be undone.`, confirmLabel: 'Abort all', danger: true });
    if (!ok) return;
    Promise.all(items.map((i) => new Promise<{ ok: boolean }>((res) => this.api.abort(i.id).subscribe({ next: () => res({ ok: true }), error: () => res({ ok: false }) }))))
      .then((r) => this.bulkResult('Abort', r));
  }

  private loadSaved(): SavedFilter[] {
    try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch { return []; }
  }
  private persistSaved() { localStorage.setItem(SAVED_KEY, JSON.stringify(this.savedFilters())); }
  async saveCurrentFilter() {
    const name = await this.modal.prompt({ title: 'Save filter', message: 'Name this filter set:', placeholder: 'e.g. My team, failed' });
    if (!name) return;
    const sf: SavedFilter = { name, stateSet: [...this.stateSet()], errorsOnly: this.errorsOnly(), q: this.q(), qBy: this.qBy(), projectFilter: this.projectFilter() };
    this.savedFilters.update((list) => [...list.filter((x) => x.name !== name), sf]);
    this.persistSaved();
  }
  applySaved(sf: SavedFilter) {
    this.stateSet.set(new Set(sf.stateSet)); this.errorsOnly.set(sf.errorsOnly);
    this.q.set(sf.q); this.qBy.set(sf.qBy); this.projectFilter.set(sf.projectFilter);
    this.page.set(1); this.reload();
  }
  deleteSaved(name: string) {
    this.savedFilters.update((list) => list.filter((x) => x.name !== name));
    this.persistSaved();
  }

  statusColor(s: string) { return ({ running: '#2563eb', waiting: '#f59e0b', completed: '#16a34a', failed: '#dc2626', aborted: '#6b7280', suspended: '#7c3aed' } as any)[s] || '#6b7280'; }
  procName(i: Instance) { return (i.processId || i.workflowId || '').split('.').pop() || i.workflowId; }
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
