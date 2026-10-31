import { RouterLink } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SlicePipe } from '@angular/common';
import { AuthService } from '../../core/auth/auth.service';
import { TaskApiService } from '../../core/api/task-api.service';
import { ToastService } from '../../shared/toast.service';
import { ModalService } from '../../shared/modal.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import type { Task } from '../../core/models';
import { IconComponent } from '../../shared/icon.component';

type Scope = 'mine' | 'available' | 'all';
const SCOPES: { key: Scope; label: string }[] = [
  { key: 'mine', label: 'My Tasks' }, { key: 'available', label: 'Available' }, { key: 'all', label: 'All' },
];

// Task Inbox — jBPM-style: scoped tabs (My Tasks / Available-to-claim / All), same list shape as
// Instances/Deployments. Detail lives at its own route (/tasks/:id, see task-detail.component.ts).
@Component({
  selector: 'app-task-inbox',
  standalone: true,
  imports: [RouterLink, IconComponent, SlicePipe, FormsModule, BreadcrumbComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Tasks' }]" /></div>
      <header class="pagehead">
        <h1>Tasks</h1>
        <span class="spacer"></span>
        <button class="btn" (click)="reload()"><app-icon name="refresh" [size]="14" /> Refresh</button>
      </header>

      <div class="filters">
        @for (s of scopes; track s.key) {
          <button class="fchip" [class.on]="scope() === s.key" (click)="setScope(s.key)">{{ s.label }} <span class="ct">{{ countFor(s.key) }}</span></button>
        }
        <span class="spacer"></span>
        <select [(ngModel)]="statusFilter"><option value="">Status: any</option><option value="created">Ready</option><option value="reserved">Reserved</option><option value="inprogress">In Progress</option><option value="completed">Completed</option><option value="skipped">Skipped</option></select>
        <label class="ovchk"><input type="checkbox" [(ngModel)]="overdueOnly" /> Overdue only</label>
        <input placeholder="Search name / id" [(ngModel)]="search" style="width:160px;" />
      </div>

      @if (selectedIds().size) {
        <div class="bulkbar">
          <span>{{ selectedIds().size }} selected</span>
          <button class="btn sm" (click)="bulkClaim()">Claim</button>
          <button class="btn sm" (click)="bulkRelease()">Release</button>
          <button class="btn sm" (click)="bulkReassign()">Reassign</button>
          <span class="spacer"></span>
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
            <thead><tr><th></th><th>Task</th><th>PIID</th><th>Group / Owner</th><th>Priority</th><th>Due</th><th>Status</th></tr></thead>
            <tbody>
              @for (t of visible(); track t.id) {
                <tr [class.overdue]="isOverdue(t)">
                  <td (click)="$event.stopPropagation()"><input type="checkbox" [checked]="selectedIds().has(t.id)" (change)="toggleSelect(t.id)" /></td>
                  <td><a class="tlink" [routerLink]="['/tasks', t.id]"><b>{{ t.name }}</b></a><div class="muted sm mono">{{ shortId(t.id) }}</div></td>
                  <td><a class="ilink mono" [routerLink]="['/instances', t.instanceId]">{{ shortId(t.instanceId) }}</a></td>
                  <td class="muted">{{ t.group || '—' }} @if (t.assignee) { <div class="sm">→ {{ t.assignee }}</div> }</td>
                  <td class="muted">{{ t.priority ?? '—' }}</td>
                  <td class="muted mono">{{ t.dueAt ? (t.dueAt | slice:0:16) : '—' }} @if (isOverdue(t)) { <span class="badge archived">overdue</span> }</td>
                  <td>
                    <span class="badge" [class.active]="t.status==='completed'" [class.inactive]="t.status==='created' || t.status==='reserved' || t.status==='inprogress'">{{ t.status }}</span>
                    @if (scope() === 'available' && t.status === 'created') { <button class="btn sm" (click)="quickClaim(t)">Claim</button> }
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }
      </div>
    </div>
  `,
  styles: [`
    .ilink, .tlink { color: var(--primary); font-weight: 600; text-decoration: none; } .ilink:hover, .tlink:hover { text-decoration: underline; }
    .page { padding: 20px 24px; }
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
  `],
})
export class TaskInboxComponent {
  private api = inject(TaskApiService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private route = inject(ActivatedRoute);

  scopes = SCOPES;
  scope = signal<Scope>('mine');
  tasks = signal<Task[]>([]);
  loading = signal(true);
  statusFilter = '';
  overdueOnly = false;
  search = '';
  selectedIds = signal<Set<string>>(new Set());
  private instanceIdFilter = this.route.snapshot.queryParamMap.get('instanceId') || '';

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

  constructor() { this.reload(); }
  reload() {
    this.loading.set(true);
    this.api.listTasks().subscribe({ next: (ts) => { this.tasks.set(ts); this.loading.set(false); }, error: () => this.loading.set(false) });
  }
  setScope(s: Scope) { this.scope.set(s); this.selectedIds.set(new Set()); }
  countFor(s: Scope) {
    const all = this.tasks(); const me = this.me(); const groups = this.myGroups();
    if (s === 'mine') return all.filter((t) => t.assignee === me).length;
    if (s === 'available') return all.filter((t) => t.status === 'created' && (!t.group || groups.includes(t.group))).length;
    return all.length;
  }

  isOverdue(t: Task) { return !!t.dueAt && t.dueAt < new Date().toISOString() && t.status !== 'completed' && t.status !== 'skipped'; }
  toggleSelect(id: string) {
    const s = new Set(this.selectedIds());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.selectedIds.set(s);
  }
  private onError(e: any) { this.toast.error(e?.error?.error?.message || 'That action could not be completed'); }

  quickClaim(t: Task) { this.api.claimTask(t.id).subscribe({ next: () => this.reload(), error: (e) => this.onError(e) }); }

  private bulkResult(label: string, results: { ok: boolean }[]) {
    const ok = results.filter((r) => r.ok).length;
    this.toast[ok === results.length ? 'success' : 'error'](`${label}: ${ok} of ${results.length} succeeded`);
    this.selectedIds.set(new Set());
    this.reload();
  }
  private selectedTasks(): Task[] { const ids = this.selectedIds(); return this.tasks().filter((t) => ids.has(t.id)); }
  bulkClaim() {
    Promise.all(this.selectedTasks().map((t) => new Promise<{ ok: boolean }>((res) => this.api.claimTask(t.id).subscribe({ next: () => res({ ok: true }), error: () => res({ ok: false }) }))))
      .then((r) => this.bulkResult('Claim', r));
  }
  bulkRelease() {
    Promise.all(this.selectedTasks().map((t) => new Promise<{ ok: boolean }>((res) => this.api.releaseTask(t.id).subscribe({ next: () => res({ ok: true }), error: () => res({ ok: false }) }))))
      .then((r) => this.bulkResult('Release', r));
  }
  async bulkReassign() {
    const to = await this.modal.prompt({ title: 'Reassign', message: 'Delegate the selected tasks to (username):' });
    if (!to) return;
    Promise.all(this.selectedTasks().map((t) => new Promise<{ ok: boolean }>((res) => this.api.delegateTask(t.id, to).subscribe({ next: () => res({ ok: true }), error: () => res({ ok: false }) }))))
      .then((r) => this.bulkResult('Reassign', r));
  }

  /** Tail of a ULID: the first 8 chars are the ms timestamp, so same-batch ids front-slice
   *  identically (three rows all reading "01KZBZ4N" on the live list). The random part is the END. */
  shortId(id: string) { return id.length > 10 ? '…' + id.slice(-7) : id; }
}
