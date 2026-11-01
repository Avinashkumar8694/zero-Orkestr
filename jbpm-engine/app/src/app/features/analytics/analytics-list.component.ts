import { Component, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import { ModalService } from '../../shared/modal.service';
import { ToastService } from '../../shared/toast.service';
import { AnalyticsBuilderApiService, type AnalyticsApiDef } from '../../core/api/analytics-builder-api.service';

@Component({
  selector: 'app-analytics-list',
  standalone: true,
  imports: [RouterLink, BreadcrumbComponent, IconComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Analytics builder' }]" /></div>
      <header class="head">
        <div>
          <h1>Analytics builder</h1>
          <p class="muted">Build analytics over cases, processes, tasks, projects and your workspace, give each a slug, publish it, and call it as an API.</p>
        </div>
        <span class="spacer"></span>
        <a class="btn primary" routerLink="/analytics/new"><app-icon name="plus" [size]="14" /> New analytics</a>
      </header>
      @if (error()) { <p class="err" role="alert">{{ error() }}</p> }
      @if (loading()) { <p class="muted">Loading…</p> }
      @else if (!items().length) {
        <div class="card empty"><b>No analytics yet</b><p class="muted">Create one: pick a source, add filters, group and measure, preview it, then publish it under a slug.</p><a class="btn primary" routerLink="/analytics/new">Create your first analytics</a></div>
      } @else {
        <div class="card tbl">
          <table data-rt>
            <thead><tr><th>Name</th><th>Slug / call</th><th>Status</th><th>Access</th><th>Version</th><th>Updated</th><th></th></tr></thead>
            <tbody>
              @for (a of items(); track a.id) {
                <tr>
                  <td><a [routerLink]="['/analytics', a.id]"><b>{{ a.name }}</b></a><div class="muted small">{{ a.query.from }}{{ a.query.joins?.length ? ' + ' + a.query.joins!.length + ' join' + (a.query.joins!.length > 1 ? 's' : '') : '' }}</div></td>
                  <td><code>{{ a.slug }}</code> <button class="linklike" (click)="copy(a)" title="Copy the call URL">copy URL</button></td>
                  <td><span class="badge" [class.pub]="a.status === 'published'">{{ a.status === 'published' ? 'Published' : 'Draft' }}</span></td>
                  <td>{{ a.visibility === 'private' ? 'Private' : 'Workspace' }}@if (a.requires) { <span class="muted small"> · needs {{ a.requires }}</span> }@if (a.allowFlows) { <span class="muted small"> · flows</span> }</td>
                  <td>v{{ a.version }}</td>
                  <td class="muted small">{{ (a.updatedAt || '').slice(0, 10) }}</td>
                  <td class="acts"><a class="btn sm" [routerLink]="['/analytics', a.id]">Edit</a> <button class="btn sm danger" (click)="remove(a)">Delete</button></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
  styles: [`
    .page { padding: 24px; display: flex; flex-direction: column; gap: 16px; max-width: 1100px; }
    .head { display: flex; align-items: flex-start; gap: 12px; flex-wrap: wrap; } h1 { margin: 0 0 4px; font-size: var(--text-xl); } .head p { margin: 0; max-width: 62ch; }
    .tbl { padding: 4px 8px; overflow-x: auto; } table { width: 100%; border-collapse: collapse; } th { text-align: left; font-size: 12px; color: var(--muted); padding: 10px 8px; } td { padding: 10px 8px; border-top: 1px solid var(--border); vertical-align: top; }
    .badge.pub { background: var(--green-bg); color: var(--green); } .small { font-size: 12px; } .acts { white-space: nowrap; text-align: right; }
    .empty { padding: 28px; display: grid; gap: 8px; justify-items: start; } .err { color: var(--red); }
    .linklike { border: 0; background: none; color: var(--primary); cursor: pointer; font: inherit; font-size: 12px; padding: 0 0 0 6px; }
    code { background: var(--surface-3); padding: 1px 6px; border-radius: 4px; font-size: 12.5px; }
  `],
})
export class AnalyticsListComponent implements OnInit {
  private api = inject(AnalyticsBuilderApiService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private router = inject(Router);
  items = signal<AnalyticsApiDef[]>([]);
  loading = signal(true);
  error = signal('');
  ngOnInit() { this.load(); }
  load() {
    this.loading.set(true);
    this.api.list().subscribe({ next: (r) => { this.items.set(r); this.loading.set(false); }, error: (e) => { this.loading.set(false); this.error.set(e?.error?.error?.message || 'Could not load analytics'); } });
  }
  url(a: AnalyticsApiDef) { return `${location.origin}/api/analytics/run/${a.slug}`; }
  copy(a: AnalyticsApiDef) { navigator.clipboard?.writeText(this.url(a)).then(() => this.toast.success('Call URL copied'), () => this.toast.error('Could not copy')); }
  async remove(a: AnalyticsApiDef) {
    if (!(await this.modal.confirm({ title: `Delete "${a.name}"?`, message: `Anything calling /api/analytics/run/${a.slug} will stop working.`, confirmLabel: 'Delete', danger: true }))) return;
    this.api.remove(a.id!).subscribe({ next: () => { this.toast.success('Deleted'); this.load(); }, error: (e) => this.toast.error(e?.error?.error?.message || 'Could not delete') });
  }
}
