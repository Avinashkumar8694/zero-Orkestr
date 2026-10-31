import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SlicePipe } from '@angular/common';
import { AuthService } from '../../core/auth/auth.service';
import { TaskApiService } from '../../core/api/task-api.service';
import { ToastService } from '../../shared/toast.service';
import { ModalService } from '../../shared/modal.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import { KeyValueListComponent, KVPair, pairsToRecord } from '../../shared/key-value-list.component';
import type { AuditEvent, Task, TaskComment } from '../../core/models';

type Tab = 'work' | 'details' | 'assignments' | 'comments' | 'admin' | 'logs';
const TABS: { key: Tab; label: string }[] = [
  { key: 'work', label: 'Work' }, { key: 'details', label: 'Details' }, { key: 'assignments', label: 'Assignments' },
  { key: 'comments', label: 'Comments' }, { key: 'admin', label: 'Admin' }, { key: 'logs', label: 'Logs' },
];

/** Dedicated Task page (ux_design/mockups/task-detail*.html): header + lifecycle actions, six tabs.
 *  Every action calls TaskService's own group/assignee/exclusion checks server-side — this page never
 *  re-implements that logic, just surfaces whatever the server allows or rejects. */
@Component({
  selector: 'app-task-detail',
  standalone: true,
  imports: [IconComponent, RouterLink, FormsModule, SlicePipe, BreadcrumbComponent, KeyValueListComponent],
  template: `
    @if (loading()) {
      <div class="page"><div class="card pad"><div class="skeleton skeleton-line" style="width:40%"></div><div class="skeleton skeleton-card"></div></div></div>
    } @else if (!task()) {
      <div class="page"><div class="empty-state"><div class="es-icon"><app-icon name="search" [size]="24" /></div><h3>Task not found</h3><p>It may have been removed, or the id is wrong.</p><a class="btn" [routerLink]="['/tasks']">Back to Tasks</a></div></div>
    } @else {
      <div class="page">
        <div class="topbar">
          <a class="btn ghost sm" [routerLink]="['/tasks']"><app-icon name="chevronLeft" [size]="13" /> Tasks</a>
          <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: task()!.name }]" /></div>
          <span class="spacer"></span>
          <a class="btn sm" [routerLink]="['/instances', task()!.instanceId]">View instance <app-icon name="arrowRight" [size]="12" /></a>
        </div>

        <div class="row" style="margin-bottom:2px;">
          <h1>{{ task()!.name }}</h1>
          @if (task()!.dueAt) { <span class="badge" [class.failed]="isOverdue()">{{ isOverdue() ? 'overdue' : 'due' }} {{ ago(task()!.dueAt!) }}</span> }
        </div>
        <p class="muted meta">Instance <a class="lnk" [routerLink]="['/instances', task()!.instanceId]">{{ shortId(task()!.instanceId) }}</a> · Priority {{ task()!.priority ?? '—' }} · Owner {{ task()!.assignee || 'unclaimed' }}</p>

        <nav class="tabs">
          @for (t of tabDefs; track t.key) { <button [class.active]="tab() === t.key" (click)="setTab(t.key)">{{ t.label }}</button> }
        </nav>

        <div class="row actionrow">
          @if (canClaim()) { <button class="btn sm" (click)="claim()">Claim</button> }
          @if (canRelease()) { <button class="btn sm" (click)="release()">Release</button> }
          @if (canStart()) { <button class="btn sm" (click)="start()">Start</button> }
          @if (canStop()) { <button class="btn sm" (click)="stop()">Stop</button> }
          @if (canAct()) { <button class="btn primary sm" (click)="complete()">Complete</button> }
          @if (canSkip()) { <button class="btn sm" (click)="skip()">Skip</button> }
        </div>

        @switch (tab()) {
          @case ('work') {
            <div class="card pad wrap">
              <div class="section-title first">Inputs</div>
              @if (inputRows().length) {
                <table class="kv"><tbody>@for (kv of inputRows(); track kv[0]) { <tr><td class="k">{{ kv[0] }}</td><td class="v mono">{{ kv[1] }}</td></tr> }</tbody></table>
              } @else { <p class="muted sm">No inputs.</p> }

              @if (canAct()) {
                <div class="section-title">Outputs</div>
                <p class="hint">Enter output values (JSON parsed automatically; plain text otherwise). Save keeps them without completing; Complete finishes the task.</p>
                <app-key-value-list [(pairs)]="outputPairs" />
                <div class="row" style="margin-top:8px;">
                  <button class="btn sm" (click)="save()">Save</button>
                  <button class="btn primary sm" (click)="complete()">Complete</button>
                </div>
              } @else if (task()!.status === 'completed' || task()!.status === 'skipped') {
                <div class="section-title">Outputs</div>
                @if (outputRows().length) {
                  <table class="kv"><tbody>@for (kv of outputRows(); track kv[0]) { <tr><td class="k">{{ kv[0] }}</td><td class="v mono">{{ kv[1] }}</td></tr> }</tbody></table>
                } @else { <p class="muted sm">No outputs recorded.</p> }
              } @else {
                <p class="muted sm">Claim and start this task to enter outputs.</p>
              }
            </div>
          }
          @case ('details') {
            <div class="card pad wrap">
              <div class="field"><label>Id</label><p class="mono">{{ task()!.id }}</p></div>
              <div class="field"><label>Form</label><p>{{ task()!.formName || '—' }}</p></div>
              <div class="field"><label>Status</label><p><span class="badge">{{ task()!.status }}</span></p></div>
              <div class="field"><label>Node</label><p class="mono">{{ task()!.nodeId }}</p></div>
              <div class="field"><label>Created</label><p class="mono">{{ task()!.createdAt | slice:0:19 }}</p></div>
              <div class="field"><label>Due</label><p class="mono">{{ task()!.dueAt ? (task()!.dueAt! | slice:0:19) : '—' }}</p></div>
              @if (task()!.completedAt) { <div class="field"><label>Completed</label><p class="mono">{{ task()!.completedAt! | slice:0:19 }} by {{ task()!.completedBy }}</p></div> }
            </div>
          }
          @case ('assignments') {
            <div class="card pad wrap">
              <div class="section-title first">Potential owners</div>
              <div class="row" style="flex-wrap:wrap; gap:8px; margin-bottom:16px;">
                @if (task()!.group) { <span class="badge active">Group: {{ task()!.group }}</span> } @else { <span class="muted sm">No group — assigned directly.</span> }
              </div>
              <div class="section-title">Current owner</div>
              <p class="muted sm" style="margin-bottom:14px;">{{ task()!.assignee ? task()!.assignee : 'Unclaimed — first potential owner to claim becomes the actual owner.' }}</p>

              <div class="section-title">Delegate to a user</div>
              <div class="row">
                <input placeholder="username" [(ngModel)]="delegateTo" style="flex:1;" />
                <button class="btn sm" [disabled]="!delegateTo.trim()" (click)="delegate()">Delegate</button>
              </div>
            </div>
          }
          @case ('comments') {
            <div class="card pad wrap">
              @if (comments().length) {
                <div class="clist">
                  @for (c of comments(); track c.id) {
                    <div class="crow">
                      <div class="avatar">{{ c.author.slice(0,1).toUpperCase() }}</div>
                      <div class="cbody">
                        <div class="ctext">{{ c.body }}</div>
                        <div class="muted sm">{{ c.author }} · {{ ago(c.at) }} @if (c.author === me()) { · <button class="lnkbtn" (click)="deleteComment(c)">delete</button> }</div>
                      </div>
                    </div>
                  }
                </div>
              } @else { <p class="muted sm" style="margin-bottom:12px;">No comments yet.</p> }
              <div class="row">
                <input placeholder="Add a comment…" [(ngModel)]="newComment" (keyup.enter)="postComment()" style="flex:1;" />
                <button class="btn sm" [disabled]="!newComment.trim()" (click)="postComment()">Post</button>
              </div>
            </div>
          }
          @case ('admin') {
            <div class="card pad wrap">
              <div class="row" style="margin-bottom:14px;"><span class="badge purple">Business-admin actions</span></div>

              <div class="section-title first">Priority & due date</div>
              <div class="grid2">
                <div class="field"><label>Priority</label><input type="number" min="0" max="10" [(ngModel)]="editPriority" /></div>
                <div class="field"><label>Due date</label><input type="datetime-local" [(ngModel)]="editDueAt" /></div>
              </div>
              <button class="btn sm" (click)="saveAdmin()">Update</button>

              <div class="section-title">Forward to a user or group</div>
              <div class="row" style="margin-bottom:16px;">
                <input placeholder="username" [(ngModel)]="forwardUser" style="flex:1;" />
                <input placeholder="or group" [(ngModel)]="forwardGroup" style="flex:1;" />
                <button class="btn sm" [disabled]="!forwardUser.trim() && !forwardGroup.trim()" (click)="forward()">Forward</button>
              </div>

              <div class="section-title">Reminders</div>
              <div class="row"><span class="muted sm">Send a reminder to the actual owner</span><span class="spacer"></span><button class="btn sm" [disabled]="!task()!.assignee" (click)="remind()">Send now</button></div>
            </div>
          }
          @case ('logs') {
            <div class="card pad wrap logs">
              @if (events().length) {
                @for (e of events(); track e.id) {
                  <div class="lrow"><span class="muted lts">{{ e.at | slice:0:19 }}</span><span>{{ e.kind }} @if (e.actor) { <span class="muted">· {{ e.actor }}</span> }</span></div>
                }
              } @else { <p class="muted sm">No log entries.</p> }
            </div>
          }
        }
      </div>
    }
  `,
  styles: [`
    .page { padding: 20px 24px; }
    .topbar { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .crumbwrap { margin-left: 4px; }
    h1 { font-size: 18px; margin: 0; }
    .meta { margin: 4px 0 12px; font-size: 12.5px; }
    .lnk { color: var(--primary); text-decoration: none; } .lnk:hover { text-decoration: underline; }
    .mono { font-family: var(--font-mono); font-size: 12.5px; }
    .badge { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; }
    .badge.purple { background: var(--purple-bg); color: var(--purple); border-color: transparent; }

    .actionrow { gap: 8px; margin-bottom: 14px; }
    .wrap { max-width: 640px; }
    .pad { padding: 20px; }
    .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; margin: 16px 0 8px; }
    .section-title.first { margin-top: 0; }
    .kv { width: 100%; } .kv td { padding: 6px 4px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: top; } .kv td:first-child { color: var(--muted); width: 34%; }
    .sm { font-size: 12.5px; }
    .hint { color: var(--muted); font-size: 12px; margin: 0 0 10px; }
    .field { margin-bottom: 14px; }
    .field label { display: block; font-size: 12px; color: var(--muted); font-weight: 600; margin-bottom: 4px; }
    .field p { margin: 0; font-size: 13px; }
    .field input { width: 100%; }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
    .clist { display: flex; flex-direction: column; gap: 12px; margin-bottom: 14px; }
    .crow { display: flex; gap: 10px; align-items: flex-start; }
    .avatar { flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%; background: var(--grad-brand); color: #fff; display: grid; place-items: center; font-size: 11px; font-weight: 700; }
    .ctext { font-size: 13px; margin-bottom: 2px; }
    .lnkbtn { border: none; background: none; color: var(--red); cursor: pointer; font: inherit; padding: 0; }
    .logs { font-family: var(--font-mono); font-size: 12px; display: flex; flex-direction: column; gap: 2px; max-width: none; }
    .lrow { padding: 6px 8px; border-radius: 6px; display: flex; gap: 12px; } .lrow:nth-child(even) { background: var(--surface-2); }
    .lts { width: 150px; flex-shrink: 0; }
    .empty-state .btn { margin-top: 10px; }
  `],
})
export class TaskDetailComponent {
  private api = inject(TaskApiService);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  id = signal(this.route.snapshot.paramMap.get('id')!);
  task = signal<Task | null>(null);
  loading = signal(true);
  tab = signal<Tab>((this.route.snapshot.queryParamMap.get('tab') as Tab) || 'work');
  tabDefs = TABS;

  outputPairs: KVPair[] = [];
  comments = signal<TaskComment[]>([]);
  events = signal<AuditEvent[]>([]);
  newComment = '';
  delegateTo = '';
  forwardUser = ''; forwardGroup = '';
  editPriority: number | null = null;
  editDueAt = '';

  me = computed(() => this.auth.user()?.username);

  inputRows = computed(() => Object.entries(this.task()?.inputs || {}).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)] as [string, string]));
  outputRows = computed(() => Object.entries(this.task()?.outputs || {}).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)] as [string, string]));

  constructor() { this.load(); }

  private load() {
    this.loading.set(true);
    this.api.getTask(this.id()).subscribe({
      next: (t) => {
        this.task.set(t); this.loading.set(false);
        this.editPriority = t.priority ?? null;
        this.editDueAt = t.dueAt ? t.dueAt.slice(0, 16) : '';
        this.outputPairs = Object.entries(t.outputs || {}).map(([key, v]) => ({ key, value: typeof v === 'object' ? JSON.stringify(v) : String(v) }));
      },
      error: () => { this.task.set(null); this.loading.set(false); },
    });
    this.api.listComments(this.id()).subscribe((c) => this.comments.set(c));
    this.api.taskEvents(this.id()).subscribe((e) => this.events.set(e));
  }
  private refresh() { this.load(); }
  private onError(e: any) { this.toast.error(e?.error?.error?.message || 'That action could not be completed'); }

  setTab(t: Tab) { this.tab.set(t); this.router.navigate([], { queryParams: { tab: t }, queryParamsHandling: 'merge', replaceUrl: true }); }

  isOverdue() { const t = this.task(); return !!t?.dueAt && t.dueAt < new Date().toISOString() && t.status !== 'completed' && t.status !== 'skipped'; }
  canClaim() { return this.task()?.status === 'created'; }
  canRelease() { const t = this.task(); return !!t && (t.status === 'reserved' || t.status === 'inprogress') && t.assignee === this.me(); }
  canStart() { const t = this.task(); return !!t && (t.status === 'created' || (t.status === 'reserved' && t.assignee === this.me())); }
  canStop() { const t = this.task(); return !!t && t.status === 'inprogress' && t.assignee === this.me(); }
  canAct() { const t = this.task(); return !!t && (t.status === 'reserved' || t.status === 'inprogress') && t.assignee === this.me(); }
  canSkip() { return this.canAct(); }

  claim() { this.api.claimTask(this.id()).subscribe({ next: () => this.refresh(), error: (e) => this.onError(e) }); }
  release() { this.api.releaseTask(this.id()).subscribe({ next: () => this.refresh(), error: (e) => this.onError(e) }); }
  start() { this.api.startTask(this.id()).subscribe({ next: () => this.refresh(), error: (e) => this.onError(e) }); }
  stop() { this.api.stopTask(this.id()).subscribe({ next: () => this.refresh(), error: (e) => this.onError(e) }); }
  skip() { this.api.skipTask(this.id()).subscribe({ next: () => { this.toast.success('Task skipped'); this.refresh(); }, error: (e) => this.onError(e) }); }
  save() { this.api.saveTask(this.id(), pairsToRecord(this.outputPairs)).subscribe({ next: () => { this.toast.success('Saved'); this.refresh(); }, error: (e) => this.onError(e) }); }
  complete() {
    this.api.completeTask(this.id(), pairsToRecord(this.outputPairs)).subscribe({
      next: () => { this.toast.success('Task completed'); this.refresh(); },
      error: (e) => this.onError(e),
    });
  }

  delegate() {
    this.api.delegateTask(this.id(), this.delegateTo.trim()).subscribe({
      next: () => { this.toast.success(`Delegated to ${this.delegateTo.trim()}`); this.delegateTo = ''; this.refresh(); },
      error: (e) => this.onError(e),
    });
  }
  forward() {
    this.api.forwardTask(this.id(), { user: this.forwardUser.trim() || undefined, group: this.forwardGroup.trim() || undefined }).subscribe({
      next: () => { this.toast.success('Forwarded'); this.forwardUser = ''; this.forwardGroup = ''; this.refresh(); },
      error: (e) => this.onError(e),
    });
  }
  remind() {
    this.api.remindTask(this.id()).subscribe({
      next: (r) => this.toast.success(`Reminder sent to ${r.notified}`),
      error: (e) => this.onError(e),
    });
  }
  saveAdmin() {
    this.api.updateTask(this.id(), { priority: this.editPriority ?? undefined, dueAt: this.editDueAt ? new Date(this.editDueAt).toISOString() : null }).subscribe({
      next: () => { this.toast.success('Task updated'); this.refresh(); },
      error: (e) => this.onError(e),
    });
  }

  postComment() {
    const body = this.newComment.trim(); if (!body) return;
    this.api.addComment(this.id(), body).subscribe({
      next: () => {
        this.newComment = '';
        this.api.listComments(this.id()).subscribe((c) => this.comments.set(c));
        this.api.taskEvents(this.id()).subscribe((e) => this.events.set(e));
      },
      error: (e) => this.onError(e),
    });
  }
  async deleteComment(c: TaskComment) {
    const ok = await this.modal.confirm({ title: 'Delete comment', message: 'Delete this comment?', danger: true, confirmLabel: 'Delete' });
    if (!ok) return;
    this.api.deleteComment(this.id(), c.id).subscribe({
      next: () => {
        this.comments.update((list) => list.filter((x) => x.id !== c.id));
        this.api.taskEvents(this.id()).subscribe((e) => this.events.set(e));
      },
      error: (e) => this.onError(e),
    });
  }

  shortId(id: string): string { return id.length > 10 ? '…' + id.slice(-7) : id; }
  ago(iso: string): string {
    const ms = Date.parse(iso) - Date.now();
    const past = ms < 0;
    const s = Math.abs(ms) / 1000;
    const unit = s < 60 ? `${Math.max(1, Math.floor(s))}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86_400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86_400)}d`;
    return past ? `${unit} ago` : `in ${unit}`;
  }
}
