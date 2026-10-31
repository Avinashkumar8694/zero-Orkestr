import { processLabel } from '../../core/process-label';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SlicePipe } from '@angular/common';
import { QueryApiService } from '../../core/api/query-api.service';
import { InstanceApiService } from '../../core/api/instance-api.service';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { AuthService } from '../../core/auth/auth.service';
import { IconComponent } from '../../shared/icon.component';
import type { Instance, Summary, Task, Workflow } from '../../core/models';

/**
 * Landing dashboard (ux_design/08 — "home-dashboard").
 *
 * Exists because `QueryApiService.analyticsSummary()` and the per-user task queries were fully
 * implemented server-side and had *no* consumer in the UI at all — the app redirected straight to
 * the project grid, which is the builder's view, not the view an operator or process owner wants on
 * login. KPI tiles link through to the screen that explains each number rather than being decorative.
 *
 * Content is permission-aware: a user with only `task:manage` sees their work and nothing else.
 */
@Component({
  selector: 'app-home',
  standalone: true,
  imports: [IconComponent, RouterLink, SlicePipe],
  template: `
    <div class="page">
      <header class="head">
        <div>
          <h1>{{ greeting() }}, <span class="grad">{{ auth.user()?.username }}</span></h1>
          <p class="sub">Here's what's happening across your projects.</p>
        </div>
        <span class="spacer"></span>
        @if (canBuild()) { <a class="btn primary" routerLink="/projects"><app-icon name="plus" [size]="15" /> New project</a> }
      </header>

      @if (failed() && !loading()) {
        <div class="loadfail" role="alert">Some of your dashboard could not be loaded, so the numbers below may be incomplete. <button class="btn sm" (click)="retry()">Retry</button></div>
      }
      @if (loading()) {
        <div class="kpis">
          @for (_ of [1,2,3,4]; track $index) { <div class="card kpi skeleton" style="height:96px"></div> }
        </div>
      } @else {
        <div class="kpis">
          @if (canView()) {
            <a class="card kpi" routerLink="/instances">
              <span class="n">{{ activeInstances() }}</span>
              <span class="l">Active instances</span>
            </a>
          }
          @if (canTasks()) {
            <a class="card kpi" routerLink="/tasks">
              <span class="n amber">{{ openTasks() }}</span>
              <span class="l">Open tasks</span>
            </a>
          }
          @if (canView()) {
            <a class="card kpi" routerLink="/deployments">
              <span class="n">{{ summary()?.deployments?.active ?? 0 }}</span>
              <span class="l">Active deployments</span>
            </a>
            <a class="card kpi" routerLink="/instances">
              <span class="n" [class.red]="failedInstances() > 0">{{ failedInstances() }}</span>
              <span class="l">Failed instances</span>
            </a>
          }
        </div>

        <div class="cols">
          @if (canTasks()) {
            <section class="card panel">
              <div class="p-head">
                <h2>My open tasks</h2>
                <span class="spacer"></span>
                <a class="link" routerLink="/tasks">View all <app-icon name="arrowRight" [size]="13" /></a>
              </div>
              @if (myTasks().length === 0) {
                <div class="empty-state sm">
                  <div class="es-icon"><app-icon name="success" [size]="22" /></div>
                  <h3>Inbox zero</h3>
                  <p>You have no tasks assigned right now.</p>
                </div>
              } @else {
                <ul class="rows">
                  @for (t of myTasks(); track t.id) {
                    <li><a routerLink="/tasks">
                      <span class="tname">{{ t.name }}</span>
                      <span class="spacer"></span>
                      @if (t.dueAt) { <span class="due" [class.over]="isOverdue(t)">{{ dueLabel(t) }}</span> }
                      @else { <span class="badge">no due date</span> }
                    </a></li>
                  }
                </ul>
              }
            </section>
          }

          <section class="card panel">
            <div class="p-head"><h2>Recent activity</h2></div>
            @if (recent().length === 0) {
              <div class="empty-state sm">
                <div class="es-icon"><app-icon name="clock" [size]="22" /></div>
                <h3>Nothing yet</h3>
                <p>Process activity will appear here once instances start running.</p>
              </div>
            } @else {
              <ul class="rows">
                @for (i of recent(); track i.id) {
                  <li><a routerLink="/instances">
                    <span class="dot" [style.background]="statusColor(i.status)"></span>
                    <span class="tname">{{ procName(i) }} <span class="mono muted" [title]="i.id">{{ shortId(i.id) }}</span></span>
                    <span class="spacer"></span>
                    <span class="muted when">{{ i.status }}</span>
                  </a></li>
                }
              </ul>
            }
          </section>
        </div>
      }
    </div>
  `,
  styles: [`
    .page { padding: 28px 32px 32px; display: flex; flex-direction: column; gap: 22px; }
    .head { display: flex; align-items: flex-start; gap: 16px; }
    h1 { font-size: var(--text-xl); letter-spacing: -.03em; font-weight: 650; }
    .sub { margin-top: 4px; color: var(--text-secondary); }
    .spacer { flex: 1; }

    .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 16px; }
    /* Tinted top edge: the one place the brand gradient appears on an otherwise calm surface, so the
       numbers read as the page's focal point without shouting. */
    .kpi { position: relative; overflow: hidden; padding: 18px 20px 16px; display: flex; flex-direction: column-reverse; gap: 6px; }
    .grad { background: var(--grad-brand); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .kpis > .kpi:nth-child(1) .n { color: var(--primary); } .kpis > .kpi:nth-child(2) .n { color: var(--amber); } .kpis > .kpi:nth-child(3) .n { color: var(--green); } .kpis > .kpi:nth-child(4) .n { color: var(--red); }
    .kpi .n { font-size: var(--text-2xl); line-height: 1.1; font-weight: 650; letter-spacing: -.035em; font-variant-numeric: tabular-nums; }
    .kpi .n.amber { color: var(--amber); } .kpi .n.red { color: var(--red); }
    .kpi .l { font-size: 13px; font-weight: 500; color: var(--text-secondary); }

    .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; align-items: start; }
    .panel { padding: 18px 20px; }
    .p-head { display: flex; align-items: center; margin-bottom: 10px; }
    h2 { font-size: var(--text-lg); }
    .link { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-xs); color: var(--primary); font-weight: 600; }

    .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .rows a { display: flex; align-items: center; gap: 9px; padding: 9px 10px; border-radius: var(--radius-sm); font-size: var(--text-sm); color: var(--text); }
    .rows a:hover { background: var(--surface-3); }
    .tname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .when { font-size: var(--text-xs); text-transform: capitalize; }
    .due { font-size: var(--text-xs); font-weight: 600; padding: 3px 9px; border-radius: var(--radius-pill); background: var(--green-bg); color: var(--green); white-space: nowrap; }
    .due.over { background: var(--red-bg); color: var(--red); }
    .loadfail { display: flex; align-items: center; gap: 12px; margin: 0 0 14px; padding: 10px 14px; border-radius: 10px; font-size: 13px; background: var(--red-bg, #fdecea); color: var(--red, #b3261e); }
    .empty-state.sm { padding: 26px 12px; }
    .empty-state.sm .es-icon { width: 46px; height: 46px; border-radius: 15px; }
  `],
})
export class HomeComponent {
  auth = inject(AuthService);
  private q = inject(QueryApiService);
  private instApi = inject(InstanceApiService);
  private wfApi = inject(WorkflowApiService);

  loading = signal(true);
  failed = signal(false);
  summary = signal<Summary | null>(null);
  myTasks = signal<Task[]>([]);
  recent = signal<Instance[]>([]);
  private workflows = signal<Workflow[]>([]);

  canView = computed(() => this.auth.hasPermission('workflow:view'));
  canTasks = computed(() => this.auth.hasPermission('task:manage'));
  canBuild = computed(() => this.auth.hasPermission('workflow:edit'));

  activeInstances = computed(() => {
    const s = this.summary()?.instances.byStatus ?? {};
    return (s['running'] ?? 0) + (s['waiting'] ?? 0);
  });
  failedInstances = computed(() => this.summary()?.instances.byStatus?.['failed'] ?? 0);
  openTasks = computed(() => {
    const s = this.summary()?.tasks.byStatus ?? {};
    // "open" = anything not terminal, matching how the Tasks screen counts its inbox
    return Object.entries(s).filter(([k]) => k !== 'completed' && k !== 'skipped')
      .reduce((a, [, v]) => a + v, 0);
  });

  constructor() {
    // AuthService populates user/permissions ASYNCHRONOUSLY after boot (a queueMicrotask-deferred
    // /auth/me call). Reading hasPermission() synchronously here would return false on a hard
    // navigation, so every request would be skipped and the tiles would render a permanent zero —
    // which is exactly what happened. `ready` resolves once that first fetch settles.
    this.auth.ready.then(() => this.load());
  }

  /** Resolves when every request has settled (success OR failure) — the tiles must not show zeros while data is in flight,
   *  nor stay blank without a word when something failed. */
  private load() {
    const user = this.auth.user()?.username;
    this.loading.set(true); this.failed.set(false);
    let pending = 0; let bad = 0;
    const track = <T>(obs: import('rxjs').Observable<T>, next: (v: T) => void) => {
      pending++;
      obs.subscribe({
        next,
        error: () => { bad++; if (--pending === 0) this.finish(bad); },
        complete: () => { if (--pending === 0) this.finish(bad); },
      });
    };
    if (this.canView()) {
      track(this.q.analyticsSummary(), (s) => this.summary.set(s));
      track(this.instApi.listInstances({}), (list: Instance[]) => this.recent.set([...list].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)).slice(0, 5)));
      track(this.wfApi.listWorkflows(), (w: Workflow[]) => this.workflows.set(w));
    }
    if (this.canTasks() && user) track(this.q.userTasks(user), (t) => this.myTasks.set(t.filter((x) => x.status !== 'completed').slice(0, 5)));
    if (pending === 0) this.finish(0);
  }
  private finish(bad: number) { this.failed.set(bad > 0); this.loading.set(false); }
  retry() { this.load(); }

  greeting() {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }
  procName(i: Instance) { return processLabel(i.processId, i.workflowId); }
  /** Tail of a ULID: the first 8 chars are the ms timestamp, so same-batch ids front-slice
   *  identically (three rows all reading "01KZBZ4N" on the live list). The random part is the END. */
  shortId(id: string) { return id.length > 10 ? '\u2026' + id.slice(-7) : id; }

  statusColor(s: string) {
    return s === 'failed' ? 'var(--red)' : s === 'completed' ? 'var(--green)'
      : s === 'aborted' ? 'var(--muted)' : s === 'suspended' ? 'var(--purple)'
      : s === 'waiting' ? 'var(--amber)' : 'var(--blue)';
  }
  isOverdue(t: Task) { return !!t.dueAt && Date.parse(t.dueAt) < Date.now(); }
  dueLabel(t: Task) {
    if (!t.dueAt) return '';
    const ms = Date.parse(t.dueAt) - Date.now();
    const abs = Math.abs(ms), m = Math.round(abs / 60000), h = Math.round(abs / 3600000);
    const rel = m < 60 ? `${m}m` : h < 48 ? `${h}h` : `${Math.round(abs / 86400000)}d`;
    return ms < 0 ? `${rel} overdue` : `due in ${rel}`;
  }
}
