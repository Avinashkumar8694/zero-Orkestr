import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { SlicePipe } from '@angular/common';
import { DeploymentApiService } from '../../core/api/deployment-api.service';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
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
        <div class="card"><div class="empty-state"><div class="es-icon"><app-icon name="search" [size]="24" /></div><h3>Nothing matches these filters</h3><p>Try another environment or status.</p><button class="btn" (click)="env.set(''); status.set('')">Clear filters</button></div></div>
      } @else {
        @for (grp of grouped(); track grp.env) {
          <section class="card envcard">
            <div class="env-h"><span class="envname">{{ grp.env }}</span><span class="count">{{ grp.items.length }}</span></div>
            <table>
              <thead><tr><th>Status</th><th>Project</th><th>Version</th><th>Deployed</th><th>By</th><th>Tags</th><th></th></tr></thead>
              <tbody>
                @for (d of grp.items; track d.id) {
                  <tr class="clickable" tabindex="0" (click)="open(d)" (keydown.enter)="open(d)">
                    <td><span class="badge" [class.active]="d.status==='active'" [class.inactive]="d.status==='inactive'" [class.archived]="d.status==='archived'">{{ d.status }}</span></td>
                    <td><a class="proj" [routerLink]="['/deployments', d.id]" (click)="$event.stopPropagation()">{{ projectName(d.workflowId) }}</a></td>
                    <td class="muted">{{ d.versionLabel || ('v' + (d.versionNumber ?? '?')) }}</td>
                    <td class="muted mono">{{ d.deployedAt | slice:0:10 }}</td>
                    <td class="muted">{{ d.deployedBy }}</td>
                    <td>@for (t of d.tags; track t) { <span class="badge">{{ t }}</span> } @if (!d.tags.length) { <span class="muted">—</span> }</td>
                    <td class="go"><app-icon name="chevronRight" [size]="16" /></td>
                  </tr>
                }
              </tbody>
            </table>
          </section>
        }
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
    .go { width: 40px; text-align: right; color: var(--muted); } tr.clickable:hover .go { color: var(--primary); }
    .badge + .badge { margin-left: 4px; }
    .mono { font-family: var(--font-mono); font-size: 12.5px; }
    .pad { padding: 18px 20px; }
    @media (max-width: 900px) { .page { padding: 4px 12px 24px; } .chips { border-radius: var(--radius); } .proj-filter { max-width: 100%; width: 100%; } }
  `],
})
export class DeploymentsComponent {
  private api = inject(DeploymentApiService);
  private wfApi = inject(WorkflowApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  statuses = [{ key: '', label: 'Any status' }, { key: 'active', label: 'Active' }, { key: 'inactive', label: 'Inactive' }, { key: 'archived', label: 'Archived' }];
  workflows = signal<Workflow[]>([]);
  deployments = signal<Deployment[]>([]);
  loading = signal(true);
  error = signal('');
  env = signal('');
  status = signal('');
  projectFilter = signal<string>(this.route.snapshot.queryParamMap.get('workflowId') || '');

  private wfNames = computed(() => new Map(this.workflows().map((w) => [w.id, w.name])));
  projectName(id: string) { return this.wfNames().get(id) || id; }
  envs = computed(() => [...new Set(this.deployments().map((d) => d.environment))].sort());
  count(status: string) { return this.deployments().filter((d) => d.status === status).length; }
  grouped = computed(() => {
    const byEnv = new Map<string, Deployment[]>();
    for (const d of this.deployments()) {
      if (this.env() && d.environment !== this.env()) continue;
      if (this.status() && d.status !== this.status()) continue;
      (byEnv.get(d.environment) || byEnv.set(d.environment, []).get(d.environment)!).push(d);
    }
    return [...byEnv.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([env, items]) => ({ env, items }));
  });

  constructor() {
    this.wfApi.listWorkflows().subscribe((ws) => this.workflows.set(ws));
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
}
