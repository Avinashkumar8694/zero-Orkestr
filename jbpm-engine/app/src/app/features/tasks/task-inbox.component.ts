import { RouterLink } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { Component, HostListener, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe, SlicePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth/auth.service';
import { TaskApiService } from '../../core/api/task-api.service';
import { IamApiService } from '../../core/api/iam-api.service';
import { AllocationApiService } from '../../core/api/allocation-api.service';
import { ToastService } from '../../shared/toast.service';
import { ModalService } from '../../shared/modal.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import type { Task } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';

type Scope = 'mine' | 'available' | 'all';
const SCOPES: { key: Scope; label: string }[] = [
  { key: 'mine', label: 'My Tasks' }, { key: 'available', label: 'Available' }, { key: 'all', label: 'All' },
];

export interface TaskColumnDef {
  key: string;
  label: string;
  visible: boolean;
  mandatory?: boolean;
}

const DEFAULT_TASK_COLUMNS: TaskColumnDef[] = [
  { key: 'select', label: 'Checkbox', visible: true, mandatory: true },
  { key: 'task', label: 'Task Name & ID', visible: true, mandatory: true },
  { key: 'piid', label: 'Process Instance ID', visible: true, mandatory: true },
  { key: 'owner', label: 'Group / Owner', visible: true, mandatory: false },
  { key: 'priority', label: 'Priority', visible: true, mandatory: false },
  { key: 'due', label: 'Due Date', visible: true, mandatory: false },
  { key: 'status', label: 'Status', visible: true, mandatory: true },
];

// Task Inbox — jBPM-style: scoped tabs (My Tasks / Available-to-claim / All), same list shape as
// Instances/Deployments. Detail lives at its own route (/tasks/:id, see task-detail.component.ts).
@Component({
  selector: 'app-task-inbox',
  standalone: true,
  imports: [RouterLink, IconComponent, SlicePipe, FormsModule, BreadcrumbComponent, DatePipe],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Tasks' }]" /></div>
      <header class="pagehead">
        <h1>Tasks</h1>
        <span class="spacer"></span>
        @if (avail(); as a) {
          @if (a.managed) {
            <div class="avail" title="While you are away you are not given new tasks automatically; tasks you have not started go back to the pool">
              @if (a.available) {
                <select class="avail-sel" (change)="goAway($any($event.target).value); $any($event.target).value = ''">
                  <option value="">● Available</option><option value="indef">Go away until I'm back</option><option value="4h">Away for 4 hours</option><option value="tomorrow">Away until tomorrow 08:00</option>
                </select>
              } @else {
                <span class="away-badge">Away@if (a.awayUntil) { until {{ a.awayUntil | date: 'MMM d, HH:mm' }} }</span>
                <button class="btn" (click)="back()">I'm back</button>
              }
            </div>
          }
        }
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
      </header>

      <div class="filters">
        @for (s of scopes; track s.key) {
          <button class="fchip" [class.on]="scope() === s.key" (click)="setScope(s.key)">{{ s.label }} <span class="ct">{{ countFor(s.key) }}</span></button>
        }
        <span class="spacer"></span>
        <select [(ngModel)]="statusFilter" (ngModelChange)="reload()"><option value="">Status: any</option><option value="created">Ready</option><option value="reserved">Reserved</option><option value="inprogress">In Progress</option><option value="completed">Completed</option><option value="skipped">Skipped</option></select>
        <label class="ovchk"><input type="checkbox" [(ngModel)]="overdueOnly" (ngModelChange)="reload()" /> Overdue only</label>
        <input placeholder="Search name / id" [ngModel]="search" (ngModelChange)="onSearchChange($event)" style="width:160px;" />
      </div>

      @if (selectedIds().size) {
        <div class="bulkbar">
          <span>{{ selectedIds().size }} selected</span>
          <button class="btn sm" [disabled]="!claimableCount()" (click)="bulkClaim()">
            Claim @if (claimableCount()) { ({{ claimableCount() }}) }
          </button>
          <button class="btn sm" [disabled]="!releasableCount()" (click)="bulkRelease()">
            Release @if (releasableCount()) { ({{ releasableCount() }}) }
          </button>
          <button class="btn sm" [disabled]="!reassignableCount()" (click)="bulkReassign()">
            Reassign @if (reassignableCount()) { ({{ reassignableCount() }}) }
          </button>
          <span class="spacer"></span>
          <button class="btn ghost sm" (click)="clearSelection()">Clear selection</button>
        </div>
      }

      <div class="card listcard">
        @if (loading()) {
          <div class="pad"><div class="skeleton skeleton-line" style="width:90%"></div><div class="skeleton skeleton-line" style="width:70%"></div><div class="skeleton skeleton-line" style="width:80%"></div></div>
        } @else if (visible().length === 0) {
          <div class="empty-state">
            <div class="es-icon"><app-icon name="success" [size]="24" /></div>
            <h3>{{ hasFilters() ? 'No tasks match your filters' : 'Nothing here' }}</h3>
            <p>{{ hasFilters() ? 'Try widening the filters above.' : (scope() === 'mine' ? "You don't have any tasks assigned." : scope() === 'available' ? 'No unclaimed tasks are waiting for your groups right now.' : 'No tasks exist yet.') }}</p>
            @if (!hasFilters() && scope() !== 'all' && countFor('all') > 0) {
              <button class="btn sm" (click)="setScope('all')">Show all {{ countFor('all') }} task{{ countFor('all') === 1 ? '' : 's' }} in this workspace</button>
            }
          </div>
        } @else {
          <table>
            <thead>
              <tr>
                @if (isColVisible('select')) {
                  <th style="width: 38px;">
                    @if (actionableVisibleCount() > 0) {
                      <input
                        type="checkbox"
                        [checked]="isAllActionableSelected()"
                        [indeterminate]="isSomeActionableSelected()"
                        (change)="toggleSelectAll()"
                        title="Select all actionable tasks"
                      />
                    }
                  </th>
                }
                @if (isColVisible('task')) { <th>Task</th> }
                @if (isColVisible('piid')) { <th>PIID</th> }
                @if (isColVisible('owner')) { <th>Group / Owner</th> }
                @if (isColVisible('priority')) { <th>Priority</th> }
                @if (isColVisible('due')) { <th>Due</th> }
                @if (isColVisible('status')) { <th>Status</th> }
              </tr>
            </thead>
            <tbody>
              @for (t of visible(); track t.id) {
                <tr [class.overdue]="isOverdue(t)">
                  @if (isColVisible('select')) {
                    <td (click)="$event.stopPropagation()">
                      @if (isActionable(t)) {
                        <input type="checkbox" [checked]="selectedIds().has(t.id)" (change)="toggleSelect(t.id)" />
                      } @else {
                        <input type="checkbox" disabled [title]="'Task is ' + t.status + ' and cannot be claimed, released, or reassigned'" style="opacity: 0.25; cursor: not-allowed;" />
                      }
                    </td>
                  }
                  @if (isColVisible('task')) {
                    <td><a class="tlink" [routerLink]="['/tasks', t.id]"><b>{{ t.name }}</b></a><div class="muted sm mono">{{ shortId(t.id) }}</div></td>
                  }
                  @if (isColVisible('piid')) {
                    <td><a class="ilink mono" [routerLink]="['/instances', t.instanceId]">{{ shortId(t.instanceId) }}</a></td>
                  }
                  @if (isColVisible('owner')) {
                    <td class="muted">{{ t.group || '—' }} @if (t.assignee) { <div class="sm">→ {{ t.assignee }}</div> }</td>
                  }
                  @if (isColVisible('priority')) {
                    <td class="muted">{{ t.priority ?? '—' }}</td>
                  }
                  @if (isColVisible('due')) {
                    <td class="muted mono">{{ t.dueAt ? (t.dueAt | slice:0:16) : '—' }} @if (isOverdue(t)) { <span class="badge archived">overdue</span> }</td>
                  }
                  @if (isColVisible('status')) {
                    <td>
                      <span class="badge" [class.active]="t.status==='completed'" [class.inactive]="t.status==='created' || t.status==='reserved' || t.status==='inprogress'">{{ t.status }}</span>
                      @if (scope() === 'available' && t.status === 'created') { <button class="btn sm" (click)="quickClaim(t)">Claim</button> }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>

          @if (visible().length > 0) {
            <div class="infinite-bar">
              @if (loadingMore()) {
                <span class="spinner-dot"></span>
                <span class="muted">Loading more tasks (showing {{ visible().length }} of {{ totalCount() }})…</span>
              } @else if (hasMore()) {
                <button class="btn ghost sm" (click)="loadMore()">Load more (showing {{ visible().length }} of {{ totalCount() }})</button>
              } @else {
                <span class="muted">Showing all {{ visible().length }} of {{ totalCount() }} tasks</span>
              }
            </div>
          }
        }
      </div>
    </div>
  `,
  styles: [`
    .avail { display: flex; align-items: center; gap: 8px; margin-right: 10px; }
    .avail-sel { border: 1px solid var(--border); border-radius: 999px; padding: 5px 12px; font-size: 12.5px; background: var(--surface); color: inherit; cursor: pointer; }
    .away-badge { background: var(--amber-bg, #fff4d6); border-radius: 999px; padding: 4px 12px; font-size: 12.5px; }
    .ilink, .tlink { color: var(--primary); font-weight: 600; text-decoration: none; } .ilink:hover, .tlink:hover { text-decoration: underline; }
    .page { padding: 12px 14px; }
    .crumbwrap { margin-bottom: 10px; }
    .pagehead { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    h1 { font-size: 19px; margin: 0; }
    .filters { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; flex-wrap: wrap; }
    .fchip { border: 1px solid var(--border); background: var(--surface); border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer; color: var(--muted); }
    .fchip.on { background: var(--primary); border-color: var(--primary); color: #fff; }
    .fchip .ct { opacity: .7; margin-left: 4px; }
    .ovchk { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-secondary); }
    .bulkbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--primary-50); border-radius: var(--radius-sm); font-size: 12.5px; margin-bottom: 10px; }
    .listcard { padding: 0; overflow-x: auto; }
    .listcard table { min-width: 720px; }
    tbody tr:hover { background: var(--surface-2); }
    tr.overdue td:nth-child(2) { border-left: 3px solid var(--red); }
    .mono { font-family: var(--font-mono); font-size: 12px; }
    .sm { font-size: 12px; }
    .pad { padding: 16px; }
    .infinite-bar { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 14px; font-size: 12.5px; border-top: 1px solid var(--border); background: var(--surface); }
    .spinner-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary); animation: pulse 1s infinite alternate; }
    @keyframes pulse { from { opacity: 0.3; transform: scale(0.8); } to { opacity: 1; transform: scale(1.2); } }

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

    @media (max-width: 768px) {
      .page { padding: 12px 14px; }
      .pagehead { flex-direction: column; align-items: stretch; gap: 10px; }
      .pagehead .btn { align-self: flex-start; }
      .filters { flex-direction: column; align-items: stretch; gap: 8px; }
      .filters .spacer { display: none; }
      .filters select, .filters input { width: 100% !important; }
      .bulkbar { flex-wrap: wrap; gap: 6px; }
    }
  `],
})
export class TaskInboxComponent {
  private api = inject(TaskApiService);
  private iamApi = inject(IamApiService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private route = inject(ActivatedRoute);
  private allocation = inject(AllocationApiService);

  /** my own availability for automatic task assignment (only accounts kept in this workspace have one) */
  avail = signal<{ available: boolean; awayUntil?: string; managed: boolean } | null>(null);
  private loadAvail() { this.allocation.myAvailability().subscribe({ next: (a) => this.avail.set(a), error: () => this.avail.set(null) }); }
  goAway(choice: string) {
    if (!choice) return;
    const now = new Date(); let until: string | undefined;
    if (choice === '4h') until = new Date(now.getTime() + 4 * 3600_000).toISOString();
    if (choice === 'tomorrow') { const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(8, 0, 0, 0); until = d.toISOString(); }
    this.allocation.setMyAvailability({ available: false, awayUntil: until }).subscribe({
      next: (r) => { this.avail.set({ available: r.available, awayUntil: r.awayUntil, managed: true }); this.toast.success(r.released ? `You are away. ${r.released} task${r.released === 1 ? '' : 's'} you had not started went back to the pool.` : 'You are away: no new tasks will be assigned to you.'); this.reload(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not change your availability'),
    });
  }
  back() {
    this.allocation.setMyAvailability({ available: true }).subscribe({
      next: (r) => { this.avail.set({ available: r.available, awayUntil: r.awayUntil, managed: true }); this.toast.success('You are available again.'); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Could not change your availability'),
    });
  }

  scopes = SCOPES;
  scope = signal<Scope>('mine');
  tasks = signal<Task[]>([]);
  totalCount = signal(0);
  loading = signal(true);
  loadingMore = signal(false);
  hasMore = signal(false);
  statusFilter = '';
  overdueOnly = false;
  search = '';
  selectedIds = signal<Set<string>>(new Set());
  columns = signal<TaskColumnDef[]>(this.loadColumns());
  colPickerOpen = signal(false);
  private instanceIdFilter = this.route.snapshot.queryParamMap.get('instanceId') || '';
  private searchTimer: ReturnType<typeof setTimeout> | undefined;

  private loadColumns(): TaskColumnDef[] {
    try {
      const raw = localStorage.getItem('tasks.columns.v1');
      if (raw) {
        const saved: Record<string, boolean> = JSON.parse(raw);
        return DEFAULT_TASK_COLUMNS.map((col) => {
          if (col.mandatory) return { ...col, visible: true };
          return { ...col, visible: saved[col.key] !== undefined ? !!saved[col.key] : col.visible };
        });
      }
    } catch {
      // ignore
    }
    return DEFAULT_TASK_COLUMNS.map((c) => ({ ...c }));
  }

  private saveColumns(cols: TaskColumnDef[]) {
    try {
      const record = Object.fromEntries(cols.map((c) => [c.key, c.visible]));
      localStorage.setItem('tasks.columns.v1', JSON.stringify(record));
    } catch {
      // ignore
    }
  }

  isColVisible(key: string): boolean {
    const col = this.columns().find((c) => c.key === key);
    return col ? col.visible : true;
  }

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
    const reset = DEFAULT_TASK_COLUMNS.map((c) => ({ ...c }));
    this.columns.set(reset);
    this.saveColumns(reset);
  }

  @HostListener('document:click') closeColPickerOnOutsideClick() {
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

  onSearchChange(val: string) {
    this.search = val;
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.reload(), 300);
  }

  private me = computed(() => this.auth.user()?.username);
  private myGroups = computed(() => this.auth.user()?.groups || []);

  scoped = computed(() => {
    const all = this.tasks();
    const me = this.me();
    const groups = this.myGroups();
    let list = all;
    if (this.instanceIdFilter) list = list.filter((t) => t.instanceId === this.instanceIdFilter);
    if (this.scope() === 'mine') return list.filter((t) => t.assignee === me);
    if (this.scope() === 'available') return list.filter((t) => t.status === 'created' && (!t.group || groups.includes(t.group)));
    return list;
  });
  visible = computed(() => {
    const search = this.search.toLowerCase();
    return this.scoped().filter((t) =>
      (!this.statusFilter || t.status === this.statusFilter)
      && (!this.overdueOnly || this.isOverdue(t))
      && (!search || t.name.toLowerCase().includes(search) || t.id.toLowerCase().includes(search)));
  });
  hasFilters = computed(() => !!this.statusFilter || this.overdueOnly || !!this.search);

  constructor() { this.reload(); this.loadAvail(); }
  reload() {
    this.loading.set(true);
    this.api.listTasksPaged({
      status: this.statusFilter || undefined,
      overdue: this.overdueOnly || undefined,
      search: this.search.trim() || undefined,
      limit: 25,
      offset: 0,
    }).subscribe({
      next: (res) => {
        this.tasks.set(res.items);
        this.totalCount.set(res.total);
        this.hasMore.set(res.hasMore);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  loadMore() {
    if (this.loadingMore() || !this.hasMore()) return;
    this.loadingMore.set(true);
    const offset = this.tasks().length;
    this.api.listTasksPaged({
      status: this.statusFilter || undefined,
      overdue: this.overdueOnly || undefined,
      search: this.search.trim() || undefined,
      limit: 25,
      offset,
    }).subscribe({
      next: (res) => {
        this.tasks.update((current) => [...current, ...res.items]);
        this.totalCount.set(res.total);
        this.hasMore.set(res.hasMore);
        this.loadingMore.set(false);
      },
      error: () => this.loadingMore.set(false),
    });
  }
  setScope(s: Scope) { this.scope.set(s); this.selectedIds.set(new Set()); }
  countFor(s: Scope) {
    const all = this.tasks(); const me = this.me(); const groups = this.myGroups();
    if (s === 'mine') return all.filter((t) => t.assignee === me).length;
    if (s === 'available') return all.filter((t) => t.status === 'created' && (!t.group || groups.includes(t.group))).length;
    return all.length;
  }

  isActionable(t: Task): boolean {
    return t.status === 'created' || t.status === 'reserved' || t.status === 'inprogress';
  }

  actionableVisible = computed(() => this.visible().filter((t) => this.isActionable(t)));
  actionableVisibleCount = computed(() => this.actionableVisible().length);

  isAllActionableSelected = computed(() => {
    const act = this.actionableVisible();
    if (!act.length) return false;
    const sel = this.selectedIds();
    return act.every((t) => sel.has(t.id));
  });

  isSomeActionableSelected = computed(() => {
    const act = this.actionableVisible();
    if (!act.length) return false;
    const sel = this.selectedIds();
    const count = act.filter((t) => sel.has(t.id)).length;
    return count > 0 && count < act.length;
  });

  toggleSelectAll() {
    const act = this.actionableVisible();
    if (!act.length) return;
    const s = new Set(this.selectedIds());
    if (this.isAllActionableSelected()) {
      for (const t of act) s.delete(t.id);
    } else {
      for (const t of act) s.add(t.id);
    }
    this.selectedIds.set(s);
  }

  clearSelection() {
    this.selectedIds.set(new Set());
  }

  claimableCount = computed(() => this.selectedTasks().filter((t) => t.status === 'created').length);
  releasableCount = computed(() => {
    const me = this.me();
    return this.selectedTasks().filter((t) => (t.status === 'reserved' || t.status === 'inprogress') && (!t.assignee || t.assignee === me)).length;
  });
  reassignableCount = computed(() => this.selectedTasks().filter((t) => this.isActionable(t)).length);

  isOverdue(t: Task) { return !!t.dueAt && t.dueAt < new Date().toISOString() && t.status !== 'completed' && t.status !== 'skipped'; }
  toggleSelect(id: string) {
    const task = this.tasks().find((t) => t.id === id);
    if (task && !this.isActionable(task)) return;
    const s = new Set(this.selectedIds());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.selectedIds.set(s);
  }
  private onError(e: any) { this.toast.error(e?.error?.error?.message || 'That action could not be completed'); }

  quickClaim(t: Task) {
    if (t.status === 'completed' || t.status === 'skipped') return;
    this.api.claimTask(t.id).subscribe({ next: () => this.reload(), error: (e) => this.onError(e) });
  }

  private bulkResult(label: string, results: { ok: boolean }[]) {
    const ok = results.filter((r) => r.ok).length;
    this.toast[ok === results.length ? 'success' : 'error'](`${label}: ${ok} of ${results.length} succeeded`);
    this.selectedIds.set(new Set());
    this.reload();
  }
  private selectedTasks(): Task[] { const ids = this.selectedIds(); return this.tasks().filter((t) => ids.has(t.id)); }
  bulkClaim() {
    const actionable = this.selectedTasks().filter((t) => t.status === 'created');
    if (!actionable.length) { this.toast.error('No claimable tasks selected'); return; }
    Promise.all(actionable.map((t) => new Promise<{ ok: boolean }>((res) => this.api.claimTask(t.id).subscribe({ next: () => res({ ok: true }), error: () => res({ ok: false }) }))))
      .then((r) => this.bulkResult('Claim', r));
  }
  bulkRelease() {
    const actionable = this.selectedTasks().filter((t) => t.status === 'reserved' || t.status === 'inprogress');
    if (!actionable.length) { this.toast.error('No releasable tasks selected'); return; }
    Promise.all(actionable.map((t) => new Promise<{ ok: boolean }>((res) => this.api.releaseTask(t.id).subscribe({ next: () => res({ ok: true }), error: () => res({ ok: false }) }))))
      .then((r) => this.bulkResult('Release', r));
  }
  async bulkReassign() {
    const actionable = this.selectedTasks().filter((t) => this.isActionable(t));
    if (!actionable.length) { this.toast.error('No reassignable tasks selected'); return; }
    const users = await firstValueFrom(this.iamApi.listUsers()).catch(() => []);
    const activeUsernames = (users || []).filter((u) => u.active !== false).map((u) => u.username);
    const to = await this.modal.prompt({
      title: 'Reassign Tasks',
      message: `Type or select a registered user to delegate ${actionable.length} selected task(s) to:`,
      options: activeUsernames.length ? activeUsernames : undefined,
      placeholder: 'Type or select username...',
    });
    if (!to || !to.trim()) return;
    const target = to.trim();
    if (activeUsernames.length && !activeUsernames.includes(target)) {
      this.toast.error(`User "${target}" is not a registered active user`);
      return;
    }
    Promise.all(actionable.map((t) => new Promise<{ ok: boolean }>((res) => this.api.delegateTask(t.id, target).subscribe({ next: () => res({ ok: true }), error: () => res({ ok: false }) }))))
      .then((r) => this.bulkResult('Reassign', r));
  }

  /** Tail of a ULID: the first 8 chars are the ms timestamp, so same-batch ids front-slice
   *  identically (three rows all reading "01KZBZ4N" on the live list). The random part is the END. */
  shortId(id: string) { return id.length > 10 ? '…' + id.slice(-7) : id; }
}
