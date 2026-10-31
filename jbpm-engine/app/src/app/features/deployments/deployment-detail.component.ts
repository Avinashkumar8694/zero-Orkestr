import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { SlicePipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs/operators';
import { DeploymentApiService } from '../../core/api/deployment-api.service';
import { InstanceApiService } from '../../core/api/instance-api.service';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import { ModalService } from '../../shared/modal.service';
import { ToastService } from '../../shared/toast.service';
import type { Deployment, DeploymentProcessDef } from '../../core/models';

type Tab = 'overview' | 'processes' | 'history';

// Page 2 of 2. One deployment, on its own screen, in three steps: Overview (what it is + what to do next), Processes
// (the definitions it contains, each startable) and Release history (a timeline of this project's releases in the same
// environment, with one-click rollback). Lifecycle actions live in the header so they are reachable from every tab.
@Component({
  selector: 'app-deployment-detail',
  standalone: true,
  imports: [IconComponent, SlicePipe, RouterLink, BreadcrumbComponent],
  template: `
    <div class="page">
      @if (dep(); as d) {
        <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Deployments', link: ['/deployments'] }, { label: projectName() + ' · ' + version(d) }]" /></div>

        <header class="card head">
          <a class="back" routerLink="/deployments" title="All deployments" aria-label="Back to all deployments"><app-icon name="chevronLeft" [size]="16" /></a>
          <div class="titles">
            <h1>{{ projectName() }}</h1>
            <div class="meta">
              <span class="badge env">{{ d.environment }}</span>
              <span class="badge">{{ version(d) }}</span>
              <span class="badge" [class.active]="d.status==='active'" [class.inactive]="d.status==='inactive'" [class.archived]="d.status==='archived'">{{ d.status }}</span>
              <span class="muted when">Deployed {{ d.deployedAt | slice:0:16 }} by {{ d.deployedBy }}</span>
            </div>
          </div>
          <span class="spacer"></span>
          <div class="actions">
            @if (d.status !== 'active' && d.status !== 'archived') { <button class="btn primary" [disabled]="busy()" (click)="activate(d)">Activate</button> }
            @if (d.status === 'active') { <button class="btn" [disabled]="busy()" (click)="undeploy(d)">Undeploy</button> }
            @if (d.status !== 'archived') { <button class="btn danger" [disabled]="busy()" (click)="archive(d)">Archive</button> }
          </div>
        </header>

        <nav class="tabs" role="tablist" aria-label="Deployment sections">
          <button role="tab" [attr.aria-selected]="tab() === 'overview'" [class.active]="tab() === 'overview'" (click)="setTab('overview')">Overview</button>
          <button role="tab" [attr.aria-selected]="tab() === 'processes'" [class.active]="tab() === 'processes'" (click)="setTab('processes')">Processes @if (defs().length) { <span class="tc">{{ defs().length }}</span> }</button>
          <button role="tab" [attr.aria-selected]="tab() === 'history'" [class.active]="tab() === 'history'" (click)="setTab('history')">Release history @if (history().length) { <span class="tc">{{ history().length }}</span> }</button>
        </nav>

        @switch (tab()) {
          @case ('overview') {
            <div class="grid2">
              <section class="card block">
                <h3>Details</h3>
                <dl class="facts">
                  <div><dt>Project</dt><dd><a class="lnk" [routerLink]="['/projects', d.workflowId]">{{ projectName() }}</a></dd></div>
                  <div><dt>Environment</dt><dd>{{ d.environment }}</dd></div>
                  <div><dt>Version</dt><dd>{{ version(d) }}</dd></div>
                  <div><dt>Status</dt><dd><span class="badge" [class.active]="d.status==='active'" [class.inactive]="d.status==='inactive'" [class.archived]="d.status==='archived'">{{ d.status }}</span></dd></div>
                  <div><dt>Deployed</dt><dd class="mono">{{ d.deployedAt | slice:0:19 }}</dd></div>
                  <div><dt>Deployed by</dt><dd>{{ d.deployedBy }}</dd></div>
                  <div><dt>Tags</dt><dd>@for (t of d.tags; track t) { <span class="badge">{{ t }}</span> } @if (!d.tags.length) { <span class="muted">—</span> }</dd></div>
                  <div><dt>Deployment id</dt><dd class="mono">{{ d.id }}</dd></div>
                </dl>
              </section>
              <section class="card block next">
                <h3>What next?</h3>
                <button class="step" (click)="setTab('processes')">
                  <span class="si"><app-icon name="play" [size]="16" /></span>
                  <span class="st"><b>Start a process</b><small>{{ defs().length ? defs().length + ' definition' + (defs().length === 1 ? '' : 's') + ' in this deployment' : 'See the definitions in this deployment' }}</small></span>
                  <app-icon name="chevronRight" [size]="16" />
                </button>
                <a class="step" [routerLink]="['/instances']" [queryParams]="{ workflowId: d.workflowId }">
                  <span class="si"><app-icon name="instances" [size]="16" /></span>
                  <span class="st"><b>See running instances</b><small>Everything started from {{ projectName() }}</small></span>
                  <app-icon name="chevronRight" [size]="16" />
                </a>
                <button class="step" (click)="setTab('history')">
                  <span class="si"><app-icon name="clock" [size]="16" /></span>
                  <span class="st"><b>Release history</b><small>{{ history().length > 1 ? 'Compare or roll back to an earlier release' : 'This is the only release in ' + d.environment }}</small></span>
                  <app-icon name="chevronRight" [size]="16" />
                </button>
                <a class="step" [routerLink]="['/projects', d.workflowId]">
                  <span class="si"><app-icon name="projects" [size]="16" /></span>
                  <span class="st"><b>Open the project</b><small>Edit processes and publish a new version</small></span>
                  <app-icon name="chevronRight" [size]="16" />
                </a>
              </section>
            </div>
          }
          @case ('processes') {
            <section class="card">
              <div class="block-h"><h3>Process definitions in this deployment</h3></div>
              @if (defsLoading()) {
                <div class="pad"><div class="skeleton skeleton-line" style="width:100%"></div><div class="skeleton skeleton-line" style="width:70%"></div></div>
              } @else if (defs().length === 0) {
                <div class="empty-state"><div class="es-icon"><app-icon name="code" [size]="24" /></div><h3>No process definitions</h3><p>This deployment contains no process definitions.</p></div>
              } @else {
                <table>
                  <thead><tr><th>Id</th><th>Name</th><th>Nodes</th><th></th></tr></thead>
                  <tbody>
                    @for (pd of defs(); track pd.id) {
                      <tr>
                        <td class="mono">{{ pd.id }}</td><td>{{ pd.name }}</td><td class="muted">{{ pd.nodes }}</td>
                        <td class="ta-r">
                          @if (pd.startable && d.status === 'active') {
                            <button class="btn sm primary" (click)="startInstance(d, pd)" title="Start a new instance of this process"><app-icon name="play" [size]="12" /> Start</button>
                          } @else {
                            <span class="muted sm">{{ pd.startable ? 'activate the deployment to start' : 'not startable' }}</span>
                          }
                        </td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
            </section>
          }
          @case ('history') {
            <section class="card block">
              <h3>Release history · {{ projectName() }} · {{ d.environment }}</h3>
              <p class="muted sub">Newest first. Rolling back activates an earlier release and deactivates the current one — running instances keep running on the release they started on.</p>
              <ol class="timeline">
                @for (h of history(); track h.id) {
                  <li [class.current]="h.id === d.id">
                    <span class="dot" [class.on]="h.status === 'active'"></span>
                    <div class="item">
                      <div class="row1">
                        <b>{{ version(h) }}</b>
                        <span class="badge" [class.active]="h.status==='active'" [class.inactive]="h.status==='inactive'" [class.archived]="h.status==='archived'">{{ h.status }}</span>
                        @if (h.id === d.id) { <span class="badge you">You are here</span> }
                        <span class="spacer"></span>
                        @if (h.id !== d.id) {
                          <a class="btn sm ghost" [routerLink]="['/deployments', h.id]">Open</a>
                          @if (h.status !== 'archived') { <button class="btn sm" [disabled]="busy()" (click)="rollback(d, h)">Roll back to this</button> }
                        }
                      </div>
                      <div class="muted small">{{ h.deployedAt | slice:0:16 }} · {{ h.deployedBy }}@if (h.tags.length) { · {{ h.tags.join(', ') }} }</div>
                    </div>
                  </li>
                }
              </ol>
            </section>
          }
        }
      } @else if (loading()) {
        <div class="card pad"><div class="skeleton skeleton-line" style="width:40%"></div><div class="skeleton skeleton-line" style="width:70%"></div><div class="skeleton skeleton-line" style="width:55%"></div></div>
      } @else {
        <div class="card"><div class="empty-state">
          <div class="es-icon"><app-icon name="search" [size]="24" /></div>
          <h3>Deployment not found</h3><p>It may have been archived and pruned, or the link is wrong.</p>
          <a class="btn" routerLink="/deployments">Back to deployments</a>
        </div></div>
      }
    </div>
  `,
  styles: [`
    .page { padding: 8px 22px 28px; }
    .crumbwrap { margin-bottom: 8px; }
    .head { display: flex; align-items: center; gap: 14px; padding: 16px 20px; margin-bottom: 16px; flex-wrap: wrap; }
    .back { width: 38px; height: 38px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 50%; background: var(--surface-3); color: var(--muted); }
    .back:hover { background: var(--primary-50); color: var(--primary); }
    .titles { min-width: 0; }
    .meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; margin-top: 6px; }
    .badge.env { background: var(--primary-50); color: var(--primary); text-transform: uppercase; letter-spacing: .05em; font-size: 11px; }
    .badge.you { background: var(--primary-50); color: var(--primary); }
    .when { font-size: 13px; margin-left: 4px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .tc { margin-left: 6px; font-size: 11px; font-weight: 700; padding: 0 7px; border-radius: var(--radius-pill); background: var(--primary-50); color: var(--primary); }
    .tabs button.active .tc { background: rgba(255, 255, 255, .25); color: #fff; }
    .grid2 { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr); gap: 16px; align-items: start; }
    .block { padding: 20px 22px; } .block h3 { margin-bottom: 14px; }
    .block-h { padding: 18px 22px 6px; }
    .facts { margin: 0; display: grid; gap: 0; }
    .facts > div { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 12px; padding: 11px 0; border-bottom: 1px solid var(--border); align-items: center; }
    .facts > div:last-child { border-bottom: 0; }
    .facts dt { color: var(--muted); font-size: 13px; font-weight: 600; } .facts dd { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
    .lnk { color: var(--primary); font-weight: 650; } .lnk:hover { text-decoration: underline; }
    .next { display: flex; flex-direction: column; gap: 10px; } .next h3 { margin-bottom: 4px; }
    .step { display: flex; align-items: center; gap: 14px; width: 100%; text-align: left; padding: 12px 14px; border: 0; border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); cursor: pointer; font: inherit; }
    .step:hover { background: var(--primary-50); }
    .si { width: 38px; height: 38px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 12px; background: var(--grad-brand); color: #fff; }
    .st { flex: 1; min-width: 0; display: flex; flex-direction: column; } .st b { font-size: 14px; } .st small { color: var(--muted); font-size: 12.5px; margin-top: 2px; }
    .step > app-icon:last-child { color: var(--muted); }
    .ta-r { text-align: right; } .mono { font-family: var(--font-mono); font-size: 12.5px; } .small { font-size: 12.5px; } .sm { font-size: 12.5px; }
    .sub { margin: -6px 0 18px; font-size: 13.5px; max-width: 70ch; }
    .timeline { list-style: none; margin: 0; padding: 0; position: relative; }
    .timeline::before { content: ''; position: absolute; left: 9px; top: 12px; bottom: 12px; width: 2px; background: var(--border); }
    .timeline li { position: relative; padding: 0 0 18px 34px; } .timeline li:last-child { padding-bottom: 0; }
    .dot { position: absolute; left: 0; top: 4px; width: 20px; height: 20px; border-radius: 50%; background: var(--surface); border: 3px solid var(--border-strong); }
    .dot.on { border-color: var(--green); background: var(--green-bg); }
    li.current .dot { border-color: var(--primary); box-shadow: 0 0 0 5px var(--primary-50); }
    .item { padding: 12px 16px; border-radius: var(--radius-sm); background: var(--surface-2); }
    li.current .item { background: var(--primary-50); }
    .row1 { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 4px; }
    .pad { padding: 18px 20px; }
    @media (max-width: 900px) {
      .page { padding: 4px 12px 24px; }
      .grid2 { grid-template-columns: minmax(0, 1fr); }
      .facts > div { grid-template-columns: 110px minmax(0, 1fr); }
      .head { padding: 14px; } .actions { width: 100%; } .actions .btn { flex: 1; }
      .tabs { display: flex; overflow-x: auto; flex-wrap: nowrap; }
    }
  `],
})
export class DeploymentDetailComponent {
  private api = inject(DeploymentApiService);
  private wfApi = inject(WorkflowApiService);
  private instApi = inject(InstanceApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private toast = inject(ToastService);
  private modal = inject(ModalService);

  id = toSignal(this.route.paramMap.pipe(map((m) => m.get('id') || '')), { initialValue: this.route.snapshot.paramMap.get('id') || '' });
  tab = signal<Tab>((['overview', 'processes', 'history'] as const).find((t) => t === this.route.snapshot.queryParamMap.get('tab')) ?? 'overview');
  loading = signal(true);
  busy = signal(false);
  dep = signal<Deployment | null>(null);
  defs = signal<DeploymentProcessDef[]>([]);
  defsLoading = signal(false);
  history = signal<Deployment[]>([]);
  projectName = signal('');

  version(d: Deployment) { return d.versionLabel || ('v' + (d.versionNumber ?? '?')); }

  constructor() {
    this.route.paramMap.subscribe(() => this.load());
  }

  setTab(t: Tab) {
    this.tab.set(t);
    this.router.navigate([], { queryParams: { tab: t === 'overview' ? null : t }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  private load() {
    const id = this.route.snapshot.paramMap.get('id') || '';
    this.loading.set(true);
    this.api.getDeployment(id).subscribe({
      next: (d) => {
        this.dep.set(d); this.loading.set(false);
        this.wfApi.listWorkflows().subscribe((ws) => this.projectName.set(ws.find((w) => w.id === d.workflowId)?.name || d.workflowId));
        this.defsLoading.set(true);
        this.api.definitions(d.id).subscribe({ next: (x) => { this.defs.set(x); this.defsLoading.set(false); }, error: () => this.defsLoading.set(false) });
        this.api.listDeploymentsGlobal({ workflowId: d.workflowId }).subscribe((all) =>
          this.history.set(all.filter((x) => x.environment === d.environment).sort((a, b) => b.deployedAt.localeCompare(a.deployedAt))));
      },
      error: () => { this.dep.set(null); this.loading.set(false); },
    });
  }

  private onError(e: any) { this.busy.set(false); this.toast.error(e?.error?.error?.message || 'That action could not be completed'); }
  private done(msg: string) { this.busy.set(false); this.toast.success(msg); this.load(); }

  activate(d: Deployment) { this.busy.set(true); this.api.activate(d.id).subscribe({ next: () => this.done('Deployment activated'), error: (e) => this.onError(e) }); }
  async undeploy(d: Deployment) {
    if (!(await this.modal.confirm({ title: 'Undeploy', message: `Stop serving ${this.projectName()} ${this.version(d)} in ${d.environment}? New instances can't be started from it until you activate it again.`, confirmLabel: 'Undeploy', danger: true }))) return;
    this.busy.set(true); this.api.undeploy(d.id).subscribe({ next: () => this.done('Deployment undeployed'), error: (e) => this.onError(e) });
  }
  async archive(d: Deployment) {
    if (!(await this.modal.confirm({ title: 'Archive deployment', message: `Archive ${this.projectName()} ${this.version(d)}? It disappears from active use and can't be activated again.`, confirmLabel: 'Archive', danger: true }))) return;
    this.busy.set(true); this.api.archive(d.id).subscribe({ next: () => this.done('Deployment archived'), error: (e) => this.onError(e) });
  }
  async rollback(d: Deployment, target: Deployment) {
    if (!(await this.modal.confirm({ title: 'Roll back', message: `Roll ${d.environment} back to ${this.version(target)}? It becomes the active release.`, confirmLabel: 'Roll back', danger: true }))) return;
    this.busy.set(true);
    this.api.rollback(d.id, { environment: d.environment, toDeploymentId: target.id }).subscribe({ next: () => { this.busy.set(false); this.toast.success(`Rolled back to ${this.version(target)}`); this.router.navigate(['/deployments', target.id], { queryParams: { tab: 'history' } }); }, error: (e) => this.onError(e) });
  }
  /** jBPM's "New Process Instance": start from a deployed definition, then jump to the instances list. */
  startInstance(d: Deployment, pd: DeploymentProcessDef) {
    this.instApi.startInstance({ workflowId: d.workflowId, processId: pd.id, deploymentId: d.id }).subscribe({
      next: (inst) => { this.toast.success(`Instance started: …${inst.id.slice(-7)}`); this.router.navigate(['/instances', inst.id]); },
      error: (e) => this.onError(e),
    });
  }
}
