import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ProjectContextService } from './project-context.service';
import { IconComponent } from '../../shared/icon.component';
import type { AuditEvent } from '../../core/models';

@Component({
  selector: 'app-project-audit',
  standalone: true,
  imports: [CommonModule, FormsModule, IconComponent],
  template: `
    <div class="audit-wrap">
      <header class="audit-header">
        <div>
          <h3>Workspace Audit Trail</h3>
          <p class="muted sm">
            All auditable actions within <strong>{{ ctx.wf()?.name || 'this workspace' }}</strong> — including asset modifications, process revisions, and deployment triggers.
          </p>
        </div>
        <span class="spacer"></span>
        <button class="btn sm" (click)="reload()"><app-icon name="refresh" [size]="13" /> Refresh</button>
      </header>

      <div class="filterbar card">
        <select [(ngModel)]="actorFilter" (ngModelChange)="reload()">
          <option value="">Actor: All</option>
          @for (a of facets()?.actors || []; track a) { <option [value]="a">{{ a }}</option> }
        </select>
        <select [(ngModel)]="kindFilter" (ngModelChange)="reload()">
          <option value="">Action: All</option>
          @for (k of kindOptions(); track k) { <option [value]="k">{{ k }}</option> }
        </select>
        <span class="spacer"></span>
        <button class="btn ghost sm" (click)="resetFilters()">Reset Filters</button>
      </div>

      <div class="card listcard">
        @if (loading()) {
          <div class="pad"><div class="skeleton skeleton-line" style="width:60%"></div><div class="skeleton skeleton-line" style="width:80%"></div></div>
        } @else if (items().length === 0) {
          <div class="empty-state">
            <div class="es-icon"><app-icon name="list" [size]="22" /></div>
            <h4>No audit events match</h4>
            <p class="muted sm">No recorded actions match your current workspace filter criteria.</p>
          </div>
        } @else {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style="width:140px;">Timestamp</th>
                  <th style="width:130px;">Actor</th>
                  <th style="width:180px;">Action</th>
                  <th>Target Entity / Summary</th>
                  <th style="width:60px;"></th>
                </tr>
              </thead>
              <tbody>
                @for (e of items(); track e.id) {
                  <tr class="audit-row" (click)="selectEvent(e)">
                    <td class="muted-mono">{{ formatTime(e.at) }}</td>
                    <td><strong>{{ e.actor }}</strong></td>
                    <td>
                      <span class="kind-badge" [class]="kindClass(e.kind)">{{ e.kind }}</span>
                    </td>
                    <td>
                      <span class="entity-desc">{{ describeEvent(e) }}</span>
                    </td>
                    <td class="ta-r">
                      <button class="icon-btn sm" (click)="selectEvent(e); $event.stopPropagation()" title="View Event Payload">
                        <app-icon name="info" [size]="13" />
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>

          @if (hasMore()) {
            <div class="more-row">
              <button class="btn ghost sm" [disabled]="loadingMore()" (click)="loadNextPage()">
                {{ loadingMore() ? 'Loading…' : 'Load More (' + items().length + ' of ' + total() + ')' }}
              </button>
            </div>
          }
        }
      </div>

      @if (selectedEvent(); as sel) {
        <div class="modal-bg" (click)="selectedEvent.set(null)">
          <div class="modal detail-modal" (click)="$event.stopPropagation()">
            <div class="modal-h">
              <span>Audit Event Details: <code>{{ sel.id }}</code></span>
              <span class="spacer"></span>
              <button class="x" (click)="selectedEvent.set(null)" aria-label="Close"><app-icon name="close" [size]="15" /></button>
            </div>
            <div class="modal-body">
              <div class="detail-grid">
                <div><span class="lbl">Action:</span> <span class="kind-badge" [class]="kindClass(sel.kind)">{{ sel.kind }}</span></div>
                <div><span class="lbl">Actor:</span> <strong>{{ sel.actor }}</strong></div>
                <div><span class="lbl">Timestamp:</span> <code>{{ sel.at }}</code></div>
                <div><span class="lbl">Workspace ID:</span> <code>{{ sel.workflowId }}</code></div>
                @if (sel.deploymentId) { <div><span class="lbl">Deployment:</span> <code>{{ sel.deploymentId }}</code></div> }
                @if (sel.instanceId) { <div><span class="lbl">Instance:</span> <code>{{ sel.instanceId }}</code></div> }
                @if (sel.taskId) { <div><span class="lbl">Task:</span> <code>{{ sel.taskId }}</code></div> }
              </div>

              <div class="payload-header">Event Payload (JSON):</div>
              <pre class="json-code"><code>{{ jsonStr(sel.data || {}) }}</code></pre>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .audit-wrap { display: flex; flex-direction: column; gap: 14px; }
    .audit-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
    .audit-header h3 { margin: 0 0 4px; font-size: 16px; font-weight: 700; }
    .filterbar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; flex-wrap: wrap; }
    .listcard { padding: 0; overflow: hidden; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { padding: 9px 14px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); border-bottom: 1px solid var(--border); text-align: left; }
    td { padding: 10px 14px; border-bottom: 1px solid var(--border); vertical-align: middle; }
    .audit-row { cursor: pointer; transition: background .12s; }
    .audit-row:hover { background: var(--surface-2); }
    .muted-mono { font-family: monospace; font-size: 12px; color: var(--muted); white-space: nowrap; }
    .kind-badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11.5px; font-weight: 600; font-family: monospace; }
    .kind-asset { background: rgba(59,130,246,0.12); color: #2563eb; }
    .kind-process { background: rgba(147,51,234,0.12); color: #7c3aed; }
    .kind-deploy { background: rgba(16,185,129,0.12); color: #059669; }
    .kind-instance { background: rgba(245,158,11,0.12); color: #d97706; }
    .kind-other { background: var(--surface-3); color: var(--text-secondary); }
    .entity-desc { font-size: 12.5px; color: var(--text); }
    .more-row { padding: 12px; display: grid; place-items: center; border-top: 1px solid var(--border); }
    .empty-state { padding: 48px 24px; text-align: center; }
    .es-icon { margin-bottom: 10px; color: var(--muted); }
    .ta-r { text-align: right; }
    .detail-modal { width: 620px; max-width: 95vw; }
    .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 16px; margin-bottom: 16px; font-size: 13px; }
    .lbl { color: var(--muted); font-size: 12px; margin-right: 6px; }
    .payload-header { font-size: 12px; font-weight: 700; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
    .json-code { background: var(--surface-2); padding: 12px; border-radius: 6px; border: 1px solid var(--border); font-size: 12px; max-height: 280px; overflow-y: auto; }
  `],
})
export class ProjectAuditComponent {
  ctx = inject(ProjectContextService);

  actorFilter = '';
  kindFilter = '';
  limit = 25;
  offset = signal(0);

  items = signal<AuditEvent[]>([]);
  total = signal(0);
  loading = signal(true);
  loadingMore = signal(false);
  hasMore = computed(() => this.items().length < this.total());
  facets = signal<{ kinds: string[]; actors: string[] } | null>(null);

  selectedEvent = signal<AuditEvent | null>(null);

  kindOptions = computed(() => {
    const kinds = this.facets()?.kinds || [];
    const prefixes = new Set(kinds.map((k) => k.split('.')[0] + '.').filter((p) => p !== '.'));
    return [...new Set([...prefixes, ...kinds])].sort();
  });

  constructor() {
    this.ctx.getAuditFacets().subscribe((f) => this.facets.set(f));
    this.reload();
  }

  resetFilters() {
    this.actorFilter = '';
    this.kindFilter = '';
    this.offset.set(0);
    this.reload();
  }

  reload() {
    this.loading.set(true);
    this.offset.set(0);
    this.ctx.getAudit({
      actor: this.actorFilter || undefined,
      kind: this.kindFilter || undefined,
      limit: this.limit,
      offset: 0,
    }).subscribe({
      next: (res) => {
        this.items.set(res.items);
        this.total.set(res.total);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  loadNextPage() {
    if (this.loadingMore() || !this.hasMore()) return;
    this.loadingMore.set(true);
    const nextOffset = this.items().length;
    this.ctx.getAudit({
      actor: this.actorFilter || undefined,
      kind: this.kindFilter || undefined,
      limit: this.limit,
      offset: nextOffset,
    }).subscribe({
      next: (res) => {
        this.items.set([...this.items(), ...res.items]);
        this.total.set(res.total);
        this.loadingMore.set(false);
      },
      error: () => this.loadingMore.set(false),
    });
  }

  selectEvent(e: AuditEvent) {
    this.selectedEvent.set(e);
  }

  formatTime(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return iso;
    }
  }

  kindClass(kind: string): string {
    if (kind.startsWith('asset.')) return 'kind-asset';
    if (kind.startsWith('process.')) return 'kind-process';
    if (kind.startsWith('deployment.')) return 'kind-deploy';
    if (kind.startsWith('instance.')) return 'kind-instance';
    return 'kind-other';
  }

  describeEvent(e: AuditEvent): string {
    const d = e.data || {};
    if (e.kind === 'asset.added') return `Added ${d.kind || 'asset'}: "${d.name}"`;
    if (e.kind === 'asset.duplicated') return `Duplicated ${d.kind || 'asset'} from "${d.source}" as "${d.name}"`;
    if (e.kind === 'asset.updated') return `Updated ${d.kind || 'asset'}: "${d.name}" (${Array.isArray(d.patch) ? d.patch.join(', ') : 'modified'})`;
    if (e.kind === 'asset.removed') return `Removed ${d.kind || 'asset'}: "${d.name}"`;
    if (e.kind === 'process.added') return `Created process: "${d.name || d.processId}"`;
    if (e.kind === 'process.saved') return `Saved diagram for process: "${d.processId}"`;
    if (e.kind === 'process.renamed') return `Renamed process to "${d.name}"`;
    if (e.kind === 'deployment.created') return `Created deployment in environment "${d.environment}"`;
    if (e.kind === 'deployment.activated') return `Activated deployment in "${d.environment}"`;
    if (e.kind === 'instance.started') return `Started workflow instance: ${e.instanceId}`;
    if (e.kind === 'instance.aborted') return `Aborted workflow instance: ${e.instanceId}`;
    if (e.kind === 'branch.created') return `Created branch "${d.name}"`;
    if (e.kind === 'project.imported') return `Imported project (${d.processes || 0} processes)`;
    return Object.keys(d).length ? JSON.stringify(d) : '—';
  }

  jsonStr(obj: any): string {
    try {
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  }
}
