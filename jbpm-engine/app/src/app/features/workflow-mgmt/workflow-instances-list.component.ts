import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SlicePipe } from '@angular/common';
import { WorkflowInstanceApiService } from '../../core/api/workflow-instance-api.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { ToastService } from '../../shared/toast.service';
import { IconComponent } from '../../shared/icon.component';
import type { WorkflowInstance } from '../../core/models';

/** Workflow Instances (cases) — the business-facing layer over BPM instances (docs/usage_docs/
 *  14-workflow-instance-management.md). "Start Case" takes raw JSON for variables/workflowData since
 *  there's no per-definition dynamic form yet — the definition's own dataSchema still validates it
 *  server-side if that definition has validation enabled. */
@Component({
  selector: 'app-workflow-instances-list',
  standalone: true,
  imports: [FormsModule, RouterLink, SlicePipe, BreadcrumbComponent, IconComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Workflow Instances' }]" /></div>
      <header class="pagehead">
        <h1>Workflow Instances</h1>
        <span class="spacer"></span>
        <button class="btn" (click)="load()"><app-icon name="refresh" [size]="14" /> Refresh</button>
        <button class="btn primary" (click)="openStart()"><app-icon name="plus" [size]="13" /> Start Case</button>
      </header>

      <div class="toolbar">
        <input class="search" placeholder="Filter by workflow name…" [(ngModel)]="workflowName" (keyup.enter)="load()" />
        <input class="search" placeholder="Filter by status…" [(ngModel)]="status" (keyup.enter)="load()" />
        <button class="btn sm" (click)="load()">Apply</button>
      </div>

      @if (loading()) {
        <div class="card"><div class="skeleton skeleton-line" style="width:60%"></div></div>
      } @else if (rows().length === 0) {
        <div class="empty-state">
          <div class="es-icon"><app-icon name="instances" [size]="24" /></div>
          <h3>No workflow instances yet</h3>
          <p>Start one, or check your filters.</p>
        </div>
      } @else {
        <div class="card listcard">
          <table>
            <thead><tr><th>Workflow</th><th>Status</th><th>piid</th><th>Created</th><th></th></tr></thead>
            <tbody>
              @for (w of rows(); track w.id) {
                <tr (click)="open(w)">
                  <td class="mono">{{ w.workflowName }}</td>
                  <td><span class="badge" [class.active]="w.status !== 'failed'" [class.inactive]="w.status === 'failed'">{{ w.status }}</span></td>
                  <td class="muted mono trunc">{{ w.piid || '—' }}</td>
                  <td class="muted">{{ w.createdAt | slice:0:10 }}</td>
                  <td class="right"><button class="btn sm" (click)="$event.stopPropagation(); open(w)">Open</button></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    @if (starting(); as s) {
      <div class="modal-bg" (click)="closeStart()">
        <div class="modal" (click)="$event.stopPropagation()">
          <div class="modal-h"><span>Start Case</span><span class="spacer"></span><button class="x" (click)="closeStart()" title="Remove" aria-label="Remove"><app-icon name="close" [size]="15" /></button></div>
          <div class="modal-body">
            <label class="fld"><span>Workflow name</span><input [(ngModel)]="s.workflowName" placeholder="claim-review-v1" /></label>
            <label class="fld"><span>Variables (JSON, for the BPM process)</span><textarea rows="3" [(ngModel)]="s.variables" placeholder="{}"></textarea></label>
            <label class="fld"><span>Workflow data (JSON, business data for this case)</span><textarea rows="3" [(ngModel)]="s.workflowData" placeholder="{}"></textarea></label>
            @if (startError()) { <p class="err">{{ startError() }}</p> }
            <button class="btn primary full" (click)="submitStart()">Start</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .page { padding: 20px 24px; max-width: 1080px; }
    .crumbwrap { margin-bottom: 10px; }
    .pagehead { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
    .pagehead h1 { font-size: 19px; margin: 0; }
    .spacer { flex: 1; }
    .toolbar { display: flex; gap: 10px; margin-bottom: 14px; }
    .search { width: 220px; }
    .muted { color: var(--muted); }
    .mono { font-family: ui-monospace, monospace; }
    .trunc { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
    .listcard { padding: 0; }
    table { width: 100%; }
    th, td { text-align: left; padding: 10px 14px; font-size: 13px; border-bottom: 1px solid var(--border); }
    tbody tr { cursor: pointer; } tbody tr:hover { background: var(--surface-2); }
    td.right { text-align: right; }
    .empty-state { padding: 40px; text-align: center; }
    .badge.active { background: var(--green-bg); color: var(--green); } .badge.inactive { background: var(--red-bg); color: var(--red); }

    .modal-bg { position: fixed; inset: 0; background: rgba(16,24,40,.4); display: grid; place-items: center; z-index: 50; }
    .modal { background: var(--surface); border-radius: 14px; width: 440px; max-width: 92vw; max-height: 86vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: var(--shadow-pop); }
    .modal-h { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--border); font-weight: 700; }
    .modal-h .x { border: none; background: transparent; font-size: 16px; cursor: pointer; color: var(--muted); }
    .modal-body { padding: 16px 18px; overflow: auto; }
    .fld { display: block; margin-bottom: 12px; } .fld span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
    .fld input, .fld textarea { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13px; font-family: inherit; }
    .fld textarea { font-family: ui-monospace, monospace; font-size: 12px; }
    .btn.full { width: 100%; justify-content: center; margin-top: 4px; }
    .err { color: var(--red); font-size: 12px; margin: -4px 0 8px; }
  `],
})
export class WorkflowInstancesListComponent {
  private api = inject(WorkflowInstanceApiService);
  private toast = inject(ToastService);
  private router = inject(Router);

  loading = signal(true);
  rows = signal<WorkflowInstance[]>([]);
  workflowName = '';
  status = '';

  starting = signal<{ workflowName: string; variables: string; workflowData: string } | null>(null);
  startError = signal('');

  constructor() { this.load(); }

  load() {
    this.loading.set(true);
    this.api.list({ workflowName: this.workflowName || undefined, status: this.status || undefined }).subscribe({
      next: (r) => { this.rows.set(r); this.loading.set(false); },
      error: (e) => { this.loading.set(false); this.toast.error(e?.error?.error?.message || 'Could not load workflow instances'); },
    });
  }

  open(w: WorkflowInstance) { this.router.navigate(['/workflow-instances', w.id]); }

  openStart() { this.startError.set(''); this.starting.set({ workflowName: '', variables: '{}', workflowData: '{}' }); }
  closeStart() { this.starting.set(null); }
  submitStart() {
    const s = this.starting(); if (!s) return;
    if (!s.workflowName.trim()) { this.startError.set('Workflow name is required'); return; }
    let variables: Record<string, unknown>, workflowData: Record<string, unknown>;
    try { variables = s.variables.trim() ? JSON.parse(s.variables) : {}; }
    catch { this.startError.set('Variables must be valid JSON'); return; }
    try { workflowData = s.workflowData.trim() ? JSON.parse(s.workflowData) : {}; }
    catch { this.startError.set('Workflow data must be valid JSON'); return; }
    this.api.create({ workflowName: s.workflowName.trim(), variables, workflowData }).subscribe({
      next: (w) => { this.toast.success('Case started'); this.closeStart(); this.router.navigate(['/workflow-instances', w.id]); },
      error: (e) => this.startError.set(e?.error?.error?.message || 'Start failed'),
    });
  }
}
