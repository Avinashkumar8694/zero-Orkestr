import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { JsonPipe, SlicePipe } from '@angular/common';
import { WorkflowInstanceApiService } from '../../core/api/workflow-instance-api.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { ModalService } from '../../shared/modal.service';
import { ToastService } from '../../shared/toast.service';
import { IconComponent } from '../../shared/icon.component';
import type { Task, WorkflowInstanceAggregate, WorkflowInstanceAudit, WorkflowInstanceComment } from '../../core/models';

type Tab = 'data' | 'tasks' | 'comments' | 'audit' | 'signals';
const TABS: { key: Tab; label: string }[] = [
  { key: 'data', label: 'Data' }, { key: 'tasks', label: 'Tasks' }, { key: 'comments', label: 'Comments' },
  { key: 'audit', label: 'Audit' }, { key: 'signals', label: 'Signals' },
];

/** Workflow Instance detail — the case-centric view: business data, every task at any depth
 *  (including inside a sub-process or call activity), comments, audit trail, and the underlying
 *  process's signals. Acting on a task here (decision/delegate) goes through the workflow-instance
 *  APIs, scoped by case — see docs/usage_docs/14-workflow-instance-management.md. */
@Component({
  selector: 'app-workflow-instance-detail',
  standalone: true,
  imports: [FormsModule, RouterLink, SlicePipe, JsonPipe, BreadcrumbComponent, IconComponent],
  template: `
    <div class="page">
      @if (agg(); as a) {
        <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Workflow Instances', link: ['/workflow-instances'] }, { label: a.workflowInstance.workflowName }]" /></div>
        <header class="pagehead">
          <div>
            <h1>{{ a.workflowInstance.workflowName }} <span class="badge" [class.active]="a.workflowInstance.status !== 'failed'" [class.inactive]="a.workflowInstance.status === 'failed'">{{ a.workflowInstance.status }}</span></h1>
            <p class="muted mono sm">id {{ a.workflowInstance.id }} @if (a.workflowInstance.piid) { · piid <a [routerLink]="['/instances', a.workflowInstance.piid]">{{ a.workflowInstance.piid }}</a> }</p>
            @if (a.workflowInstance.startError) { <p class="err sm">{{ a.workflowInstance.startError }}</p> }
          </div>
          <span class="spacer"></span>
          <button class="btn sm" (click)="updateStatus()">Update status</button>
          <button class="btn sm" [disabled]="!a.workflowInstance.piid" (click)="sendSignal()">Send signal</button>
        </header>

        <nav class="tabs">
          @for (t of tabDefs; track t.key) { <button [class.active]="tab() === t.key" (click)="tab.set(t.key)">{{ t.label }}</button> }
        </nav>

        @switch (tab()) {
          @case ('data') {
            <div class="card">
              <textarea rows="12" [(ngModel)]="dataText"></textarea>
              @if (dataError()) { <p class="err">{{ dataError() }}</p> }
              <button class="btn primary sm" (click)="saveData()">Save data</button>
            </div>
          }
          @case ('tasks') {
            @if (a.tasks.length === 0) { <p class="muted">No tasks on this case (at any depth) yet.</p> }
            @for (t of a.tasks; track t.id) {
              <div class="card taskrow">
                <div class="tr-top"><span class="tname">{{ t.name }}</span><span class="badge">{{ t.status }}</span></div>
                <p class="muted sm">group {{ t.group || '—' }} · assignee {{ t.assignee || '—' }}</p>
                @if (t.status !== 'completed' && t.status !== 'skipped') {
                  <div class="row actionrow">
                    <button class="btn sm primary" (click)="decide(t)">Decision</button>
                    <button class="btn sm" (click)="delegate(t)">Delegate</button>
                  </div>
                }
              </div>
            }
          }
          @case ('comments') {
            <div class="card">
              <div class="fieldrow"><input [(ngModel)]="newComment" placeholder="Add a comment…" (keyup.enter)="addComment()" /><button class="btn sm" (click)="addComment()">Post</button></div>
              @for (c of comments(); track c.id) {
                <div class="crow"><div class="crow-h"><strong>{{ c.author }}</strong><span class="muted sm">{{ c.at | slice:0:19 }}</span><button class="btn sm danger" (click)="deleteComment(c)" title="Delete" aria-label="Delete"><app-icon name="trash" [size]="12" /></button></div><p>{{ c.body }}</p></div>
              }
            </div>
          }
          @case ('audit') {
            <div class="card">
              <div class="fieldrow"><input [(ngModel)]="newAuditKind" placeholder="kind, e.g. workflowInstance.note" /><input [(ngModel)]="newAuditData" placeholder="data (JSON, optional)" /><button class="btn sm" (click)="addAudit()">Add</button></div>
              @for (au of audits(); track au.id) {
                <div class="crow"><div class="crow-h"><strong class="mono">{{ au.kind }}</strong><span class="muted sm">{{ au.actor }} · {{ au.at | slice:0:19 }}</span><button class="btn sm danger" (click)="deleteAudit(au)" title="Delete" aria-label="Delete"><app-icon name="trash" [size]="12" /></button></div>
                @if (au.data) { <pre class="mono sm">{{ au.data | json }}</pre> }</div>
              }
            </div>
          }
          @case ('signals') {
            <div class="card">
              @if (a.signals) {
                <p><strong>Listens for:</strong> {{ a.signals.listensFor.join(', ') || '—' }}</p>
                <p><strong>Throws:</strong> {{ a.signals.throws.join(', ') || '—' }}</p>
              } @else {
                <p class="muted">No BPM instance to inspect yet.</p>
              }
            </div>
          }
        }
      } @else if (loading()) {
        <div class="card"><div class="skeleton skeleton-line" style="width:60%"></div></div>
      }
    </div>
  `,
  styles: [`
    .page { padding: 20px 24px; max-width: 900px; }
    .crumbwrap { margin-bottom: 10px; }
    .pagehead { display: flex; align-items: flex-start; gap: 10px; margin-bottom: 4px; }
    .pagehead h1 { font-size: 19px; margin: 0; display: flex; align-items: center; gap: 8px; }
    .spacer { flex: 1; }
    .muted { color: var(--muted); } .mono { font-family: ui-monospace, monospace; } .sm { font-size: 12px; }
    .err { color: var(--red); }

    .card { padding: 16px; margin-bottom: 10px; }
    textarea { width: 100%; font-family: ui-monospace, monospace; font-size: 12.5px; border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 8px; }
    .taskrow { display: flex; flex-direction: column; gap: 4px; }
    .tr-top { display: flex; justify-content: space-between; align-items: center; }
    .tname { font-weight: 600; }
    .actionrow { gap: 8px; margin-top: 4px; }
    .fieldrow { display: flex; gap: 8px; margin-bottom: 12px; }
    .fieldrow input { flex: 1; border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; font-size: 13px; }
    .crow { padding: 10px 0; border-top: 1px solid var(--border); }
    .crow:first-of-type { border-top: none; }
    .crow-h { display: flex; align-items: center; gap: 8px; }
    .crow-h .spacer { flex: 1; }
    .badge.active { background: var(--green-bg); color: var(--green); } .badge.inactive { background: var(--red-bg); color: var(--red); }
    .btn.danger { color: var(--red); }
  `],
})
export class WorkflowInstanceDetailComponent {
  private api = inject(WorkflowInstanceApiService);
  private route = inject(ActivatedRoute);
  private modal = inject(ModalService);
  private toast = inject(ToastService);

  id = this.route.snapshot.paramMap.get('id')!;
  loading = signal(true);
  agg = signal<WorkflowInstanceAggregate | null>(null);
  tab = signal<Tab>('data');
  tabDefs = TABS;

  dataText = '';
  dataError = signal('');
  comments = signal<WorkflowInstanceComment[]>([]);
  audits = signal<WorkflowInstanceAudit[]>([]);
  newComment = '';
  newAuditKind = '';
  newAuditData = '';

  constructor() { this.load(); }

  load() {
    this.loading.set(true);
    this.api.aggregate(this.id).subscribe({
      next: (a) => {
        this.agg.set(a); this.loading.set(false);
        this.dataText = JSON.stringify(a.workflowInstance.data, null, 2);
      },
      error: (e) => { this.loading.set(false); this.toast.error(e?.error?.error?.message || 'Could not load workflow instance'); },
    });
    this.api.listComments(this.id).subscribe((c) => this.comments.set(c));
    this.api.listAudits(this.id).subscribe((a) => this.audits.set(a));
  }

  saveData() {
    let data: Record<string, unknown>;
    try { data = JSON.parse(this.dataText); } catch { this.dataError.set('Must be valid JSON'); return; }
    this.dataError.set('');
    this.api.updateData(this.id, data).subscribe({
      next: () => { this.toast.success('Data saved'); this.load(); },
      error: (e) => this.dataError.set(e?.error?.error?.message || 'Save failed'),
    });
  }

  async updateStatus() {
    const next = await this.modal.prompt({ title: 'Update status', message: 'New business status for this case', initialValue: this.agg()?.workflowInstance.status || '' });
    if (!next?.trim()) return;
    this.api.updateStatus(this.id, next.trim()).subscribe({
      next: () => { this.toast.success('Status updated'); this.load(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Update failed'),
    });
  }

  async sendSignal() {
    const name = await this.modal.prompt({ title: 'Send signal', message: 'Signal name', placeholder: 'DocumentsReceived' });
    if (!name?.trim()) return;
    this.api.signal(this.id, name.trim()).subscribe({
      next: () => { this.toast.success(`Signaled "${name}"`); this.load(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Signal failed'),
    });
  }

  async decide(t: Task) {
    const raw = await this.modal.prompt({ title: `Decision — ${t.name}`, message: 'Outputs (JSON)', initialValue: '{}' });
    if (raw == null) return;
    let outputs: Record<string, unknown>;
    try { outputs = raw.trim() ? JSON.parse(raw) : {}; } catch { this.toast.error('Outputs must be valid JSON'); return; }
    this.api.decision(this.id, t.id, outputs).subscribe({
      next: () => { this.toast.success('Decision recorded'); this.load(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Decision failed'),
    });
  }

  async delegate(t: Task) {
    const to = await this.modal.prompt({ title: `Delegate — ${t.name}`, message: 'Delegate to user' });
    if (!to?.trim()) return;
    this.api.delegate(this.id, to.trim(), t.id).subscribe({
      next: () => { this.toast.success(`Delegated to ${to}`); this.load(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Delegate failed'),
    });
  }

  addComment() {
    if (!this.newComment.trim()) return;
    this.api.addComment(this.id, this.newComment.trim()).subscribe({
      next: () => { this.newComment = ''; this.api.listComments(this.id).subscribe((c) => this.comments.set(c)); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Comment failed'),
    });
  }
  async deleteComment(c: WorkflowInstanceComment) {
    if (!(await this.modal.confirm({ title: 'Delete comment', message: 'Delete this comment?', danger: true, confirmLabel: 'Delete' }))) return;
    this.api.deleteComment(this.id, c.id).subscribe(() => this.api.listComments(this.id).subscribe((cs) => this.comments.set(cs)));
  }

  addAudit() {
    if (!this.newAuditKind.trim()) return;
    let data: Record<string, unknown> | undefined;
    if (this.newAuditData.trim()) { try { data = JSON.parse(this.newAuditData); } catch { this.toast.error('Audit data must be valid JSON'); return; } }
    this.api.addAudit(this.id, this.newAuditKind.trim(), data).subscribe({
      next: () => { this.newAuditKind = ''; this.newAuditData = ''; this.api.listAudits(this.id).subscribe((a) => this.audits.set(a)); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'Audit failed'),
    });
  }
  async deleteAudit(a: WorkflowInstanceAudit) {
    if (!(await this.modal.confirm({ title: 'Delete audit entry', message: 'Delete this audit entry?', danger: true, confirmLabel: 'Delete' }))) return;
    this.api.deleteAudit(this.id, a.id).subscribe(() => this.api.listAudits(this.id).subscribe((as) => this.audits.set(as)));
  }
}
