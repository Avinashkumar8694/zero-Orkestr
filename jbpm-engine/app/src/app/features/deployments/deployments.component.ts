import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SlicePipe } from '@angular/common';
import { DeploymentApiService } from '../../core/api/deployment-api.service';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import { ToastService } from '../../shared/toast.service';
import type { Deployment, Workflow } from '../../core/models';

// Page 1 of 2. A full-width, filterable overview of every deployment, grouped by environment; picking one opens its own
// page (deployment-detail.component.ts) — the lifecycle actions, process definitions and release history deserve a whole
// screen rather than a cramped panel beside the list. Arriving from a project's header link with ?workflowId=X pre-filters
// to that project.
@Component({
  selector: 'app-deployments',
  standalone: true,
  imports: [IconComponent, SlicePipe, RouterLink, FormsModule, BreadcrumbComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Deployments' }]" /></div>
      <header class="pagehead">
        <div>
          <h1>Deployments</h1>
          <p class="muted sub">Immutable releases of your projects, by environment. Open one to manage its lifecycle, start processes or roll back.</p>
        </div>
        <span class="spacer"></span>
        <button class="btn" (click)="openImportModal()"><app-icon name="upload" [size]="14" /> Import deployment</button>
        <button class="btn" (click)="reload()"><app-icon name="refresh" [size]="14" /> Refresh</button>
      </header>

      @if (!loading() && deployments().length) {
        <div class="stats">
          <div class="card stat"><span class="n ok">{{ count('active') }}</span><span class="l">Active</span></div>
          <div class="card stat"><span class="n">{{ count('inactive') }}</span><span class="l">Inactive</span></div>
          <div class="card stat"><span class="n">{{ count('archived') }}</span><span class="l">Archived</span></div>
          <div class="card stat"><span class="n">{{ envs().length }}</span><span class="l">Environments</span></div>
        </div>
      }

      <div class="filterbar">
        <input class="search-input" type="search" placeholder="Search deployments…" aria-label="Search deployments" [ngModel]="searchTerm()" (ngModelChange)="searchTerm.set($event)" />
        <select class="proj-filter" [ngModel]="projectFilter()" (ngModelChange)="setProjectFilter($event)" aria-label="Project">
          <option value="">All projects</option>
          @for (w of workflows(); track w.id) { <option [value]="w.id">{{ w.name }}</option> }
        </select>
        <div class="chips" role="group" aria-label="Environment">
          <button class="chip" [class.on]="env() === ''" (click)="env.set('')">All environments</button>
          @for (e of envs(); track e) { <button class="chip" [class.on]="env() === e" (click)="env.set(e)">{{ e }}</button> }
        </div>
        <div class="chips" role="group" aria-label="Status">
          @for (s of statuses; track s.key) { <button class="chip" [class.on]="status() === s.key" (click)="status.set(s.key)">{{ s.label }}</button> }
        </div>
      </div>

      @if (loading()) {
        <div class="card pad"><div class="skeleton skeleton-line" style="width:60%"></div><div class="skeleton skeleton-line" style="width:80%"></div><div class="skeleton skeleton-line" style="width:40%"></div></div>
      } @else if (error()) {
        <div class="card"><div class="empty-state"><div class="es-icon"><app-icon name="warning" [size]="24" /></div><h3>Could not load deployments</h3><p>{{ error() }}</p><button class="btn" (click)="reload()">Retry</button></div></div>
      } @else if (deployments().length === 0) {
        <div class="card"><div class="empty-state">
          <div class="es-icon"><app-icon name="deployments" [size]="24" /></div>
          <h3>No deployments yet</h3>
          <p>{{ projectFilter() ? 'This project has no deployments yet.' : "Publish a version and deploy it from a project's builder to see it here." }}</p>
        </div></div>
      } @else if (grouped().length === 0) {
        <div class="card"><div class="empty-state"><div class="es-icon"><app-icon name="search" [size]="24" /></div><h3>Nothing matches these filters</h3><p>Try another search, environment or status.</p><button class="btn" (click)="env.set(''); status.set(''); searchTerm.set('')">Clear filters</button></div></div>
      } @else {
        @for (grp of grouped(); track grp.env) {
          <section class="card envcard">
            <div class="env-h"><span class="envname">{{ grp.env }}</span><span class="count">{{ grp.items.length }}</span></div>
            <table>
              <thead><tr><th>Status</th><th>Project</th><th>Version</th><th>Deployed</th><th>By</th><th>Tags</th><th class="ta-r"></th></tr></thead>
              <tbody>
                @for (d of grp.items; track d.id) {
                  <tr class="clickable" tabindex="0" (click)="open(d)" (keydown.enter)="open(d)">
                    <td><span class="badge" [class.active]="d.status==='active'" [class.inactive]="d.status==='inactive'" [class.archived]="d.status==='archived'">{{ d.status }}</span></td>
                    <td><a class="proj" [routerLink]="['/deployments', d.id]" (click)="$event.stopPropagation()">{{ projectName(d.workflowId) }}</a>@if (d.snapshot?.frozen) { <span class="freeze-tag" title="Frozen snapshot"><app-icon name="lock" [size]="10" /> Frozen</span> }</td>
                    <td class="muted">{{ d.versionLabel || ('v' + (d.versionNumber ?? '?')) }}</td>
                    <td class="muted mono">{{ d.deployedAt | slice:0:10 }}</td>
                    <td class="muted">{{ d.deployedBy }}</td>
                    <td>@for (t of d.tags; track t) { <span class="badge">{{ t }}</span> } @if (!d.tags.length) { <span class="muted">—</span> }</td>
                    <td class="go" (click)="$event.stopPropagation()">
                      <button class="iconbtn" (click)="downloadSnapshot(d)" title="Download snapshot JSON" aria-label="Download snapshot JSON"><app-icon name="download" [size]="14" /></button>
                      <app-icon name="chevronRight" [size]="16" />
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
      }

      <!-- MODAL: IMPORT DEPLOYMENT SNAPSHOT -->
      @if (showImportModal()) {
        <div class="modal-backdrop" (click)="closeImportModal()">
          <div class="modal-card" (click)="$event.stopPropagation()">
            <div class="modal-header">
              <h3><app-icon name="upload" [size]="16" /> Import Deployment Snapshot</h3>
              <button class="modal-close" (click)="closeImportModal()" aria-label="Close">×</button>
            </div>
            <div class="modal-body">
              <p class="modal-hint">Import a previously exported deployment snapshot package (.json). This will create an immutable deployment unit in the target environment.</p>

              <div class="form-group">
                <label>Target Environment</label>
                <select [(ngModel)]="importEnvironment">
                  <option value="dev">dev</option>
                  <option value="stage">stage</option>
                  <option value="prod">prod</option>
                  <option value="production">production</option>
                </select>
              </div>

              <div class="form-group">
                <label class="row" style="gap:8px; cursor:pointer;">
                  <input type="checkbox" [(ngModel)]="importActivate" />
                  <span>Activate immediately upon import</span>
                </label>
              </div>

              <div class="form-group">
                <label>Snapshot File (.json)</label>
                <input type="file" accept=".json,application/json" (change)="onFileSelected($event)" />
                @if (importFile(); as f) {
                  <div class="file-info mono sm">Selected: {{ f.name }} ({{ (f.size / 1024).toFixed(1) }} KB)</div>
                }
              </div>
            </div>
            <div class="modal-footer">
              <button class="btn" (click)="closeImportModal()" [disabled]="importing()">Cancel</button>
              <button class="btn primary" (click)="submitImport()" [disabled]="!importFile() || importing()">
                {{ importing() ? 'Importing…' : 'Import Deployment' }}
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .page { padding: 8px 22px 28px; }
    .crumbwrap { margin-bottom: 8px; }
    .pagehead { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 18px; }
    .sub { margin-top: 4px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 14px; margin-bottom: 16px; }
    .stat { padding: 16px 20px; display: flex; flex-direction: column-reverse; gap: 4px; }
    .stat .n { font-size: var(--text-2xl); line-height: 1.1; font-weight: 700; letter-spacing: -.03em; color: var(--text); } .stat .n.ok { color: var(--green); }
    .stat .l { font-size: 13px; font-weight: 600; color: var(--text-secondary); }
    .filterbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 16px; }
    .proj-filter { max-width: 240px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px; background: var(--surface); border-radius: var(--radius-pill); box-shadow: var(--shadow-card); }
    .chip { border: 0; background: transparent; padding: 6px 14px; border-radius: var(--radius-pill); font-size: 13px; font-weight: 650; color: var(--text-secondary); cursor: pointer; text-transform: capitalize; }
    .chip:hover { color: var(--primary); background: var(--primary-50); }
    .chip.on { background: var(--grad-brand); color: #fff; }
    .envcard { margin-bottom: 16px; overflow: hidden; }
    .env-h { display: flex; align-items: center; gap: 10px; padding: 14px 20px; border-bottom: 1px solid var(--border); }
    .envname { font-weight: 800; letter-spacing: .06em; text-transform: uppercase; font-size: 12px; color: var(--primary); }
    .count { font-size: 12px; font-weight: 700; padding: 1px 9px; border-radius: var(--radius-pill); background: var(--primary-50); color: var(--primary); }
    tr.clickable { cursor: pointer; } tr.clickable:focus-visible { outline: 2px solid var(--primary); outline-offset: -2px; }
    .proj { color: var(--primary); font-weight: 650; } .proj:hover { text-decoration: underline; }
    .go { color: var(--muted); } tr.clickable:hover .go { color: var(--primary); }
    .badge + .badge { margin-left: 4px; }
    .mono { font-family: var(--font-mono); font-size: 12.5px; }
    .pad { padding: 18px 20px; }
    .search-input { width: 220px; max-width: 100%; }
    .freeze-tag { margin-left: 8px; font-size: 10.5px; font-weight: 600; color: var(--primary); background: var(--primary-50); border-radius: var(--radius-pill); padding: 1px 8px; display: inline-flex; align-items: center; gap: 4px; vertical-align: middle; }
    .go { width: 80px; text-align: right; white-space: nowrap; }
    .iconbtn { border: 0; background: transparent; color: var(--muted); cursor: pointer; padding: 6px; border-radius: 50%; vertical-align: middle; margin-right: 2px; }
    .iconbtn:hover { background: var(--primary-50); color: var(--primary); }
    /* MODAL */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(4px);
      z-index: 1000;
      display: grid;
      place-items: center;
      padding: 20px;
    }
    .modal-card {
      width: 480px;
      max-width: 100%;
      background: var(--surface);
      border-radius: var(--radius-shell);
      box-shadow: var(--shadow-pop);
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border);
    }
    .modal-header {
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .modal-header h3 {
      margin: 0;
      font-size: 15px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .modal-close {
      background: transparent;
      border: none;
      font-size: 20px;
      line-height: 1;
      color: var(--muted);
      cursor: pointer;
    }
    .modal-body {
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .modal-hint {
      margin: 0;
      font-size: 13px;
      color: var(--muted);
      line-height: 1.45;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .form-group label {
      font-size: 12.5px;
      font-weight: 600;
      color: var(--text-secondary);
    }
    .file-info {
      color: var(--primary);
      margin-top: 4px;
    }
    .modal-footer {
      padding: 14px 20px;
      border-top: 1px solid var(--border);
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }

    @media (max-width: 900px) { .page { padding: 4px 12px 24px; } .search-input { width: 100%; } .chips { border-radius: var(--radius); } .proj-filter { max-width: 100%; width: 100%; } }
  `],
})
export class DeploymentsComponent {
  private api = inject(DeploymentApiService);
  private wfApi = inject(WorkflowApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);

  statuses = [{ key: '', label: 'Any status' }, { key: 'active', label: 'Active' }, { key: 'inactive', label: 'Inactive' }, { key: 'archived', label: 'Archived' }];
  workflows = signal<Workflow[]>([]);
  deployments = signal<Deployment[]>([]);
  loading = signal(true);
  error = signal('');
  env = signal('');
  status = signal('');
  searchTerm = signal('');

  // import modal
  showImportModal = signal(false);
  importEnvironment = 'dev';
  importActivate = false;
  importFile = signal<File | null>(null);
  importing = signal(false);
  projectFilter = signal<string>(this.route.snapshot.queryParamMap.get('workflowId') || '');

  private wfNames = computed(() => new Map(this.workflows().map((w) => [w.id, w.name])));
  projectName(id: string) { return this.wfNames().get(id) || id; }
  envs = computed(() => [...new Set(this.deployments().map((d) => d.environment))].sort());
  count(status: string) { return this.deployments().filter((d) => d.status === status).length; }
  grouped = computed(() => {
    const byEnv = new Map<string, Deployment[]>();
    const q = this.searchTerm().trim().toLowerCase();
    for (const d of this.deployments()) {
      if (this.env() && d.environment !== this.env()) continue;
      if (this.status() && d.status !== this.status()) continue;
      if (q && !(this.projectName(d.workflowId).toLowerCase().includes(q) || d.id.toLowerCase().includes(q) || d.environment.toLowerCase().includes(q) || (d.versionLabel || '').toLowerCase().includes(q))) continue;
      (byEnv.get(d.environment) || byEnv.set(d.environment, []).get(d.environment)!).push(d);
    }
    return [...byEnv.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([env, items]) => ({ env, items }));
  });

  constructor() {
    this.wfApi.listWorkflows().subscribe((ws) => this.workflows.set(ws));
    // legacy deep link (?id=…) goes straight to that deployment's page
    const queryId = this.route.snapshot.queryParamMap.get('id');
    if (queryId) { this.router.navigate(['/deployments', queryId]); return; }
    this.reload();
  }
  reload() {
    this.loading.set(true); this.error.set('');
    this.api.listDeploymentsGlobal({ workflowId: this.projectFilter() || undefined }).subscribe({
      next: (d) => { this.deployments.set(d); this.loading.set(false); },
      error: (e) => { this.loading.set(false); this.error.set(e?.error?.error?.message || 'The server did not answer'); },
    });
  }
  setProjectFilter(id: string) { this.projectFilter.set(id); this.env.set(''); this.reload(); }
  open(d: Deployment) { this.router.navigate(['/deployments', d.id]); }

  downloadSnapshot(d: Deployment) {
    this.api.exportSnapshot(d.id).subscribe({
      next: (pkg) => {
        const json = JSON.stringify(pkg, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const env = d.environment.toLowerCase();
        const ver = d.versionLabel || ('v' + (d.versionNumber ?? '1'));
        a.href = url;
        a.download = `deployment-snapshot-${d.id}-${env}-${ver}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        this.toast.success(`Deployment snapshot exported (${(blob.size / 1024).toFixed(1)} KB)`);
      },
      error: (e) => this.toast.error('Failed to export snapshot: ' + (e?.error?.message || e.message)),
    });
  }

  // --- Modal Import ---
  openImportModal() {
    this.importEnvironment = 'dev';
    this.importActivate = false;
    this.importFile.set(null);
    this.showImportModal.set(true);
  }

  closeImportModal() {
    if (!this.importing()) this.showImportModal.set(false);
  }

  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files[0]) {
      this.importFile.set(input.files[0]);
    }
  }

  submitImport() {
    const file = this.importFile();
    if (!file) return;

    this.importing.set(true);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const pkg = JSON.parse(reader.result as string);
        this.api.importSnapshot({
          snapshot: pkg.snapshot,
          engine: pkg.engine,
          environment: this.importEnvironment,
          activate: this.importActivate,
        }).subscribe({
          next: (dep) => {
            this.importing.set(false);
            this.showImportModal.set(false);
            this.toast.success(`Deployment imported into "${this.importEnvironment}"!`);
            this.open(dep);
          },
          error: (err) => {
            this.importing.set(false);
            this.toast.error('Import failed: ' + (err?.error?.message || err.message));
          },
        });
      } catch (err: any) {
        this.importing.set(false);
        this.toast.error('Invalid JSON file: ' + err.message);
      }
    };
    reader.onerror = () => {
      this.importing.set(false);
      this.toast.error('Could not read file');
    };
    reader.readAsText(file);
  }
}
