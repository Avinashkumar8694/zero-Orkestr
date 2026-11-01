import { Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { InstanceApiService } from '../../core/api/instance-api.service';
import { QueryApiService } from '../../core/api/query-api.service';
import { ToastService } from '../../shared/toast.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { IconComponent } from '../../shared/icon.component';
import type { ProcessDef } from '../../core/models';

interface VarRow { name: string; value: string; }

/** Start New Instance (ux_design/mockups/start-instance-form.html) — jBPM's "New Process Instance"
 *  flow: pick a deployed, startable process, then supply variables. This engine has no generated-form
 *  layer yet (see ux_design backlog item C4), so variables are a plain name/value editor instead of a
 *  rendered Data-Object form. */
@Component({
  selector: 'app-start-instance',
  standalone: true,
  imports: [IconComponent, RouterLink, FormsModule, BreadcrumbComponent],
  template: `
    <div class="page">
      <div class="topbar">
        <a class="btn ghost sm" [routerLink]="['/instances']"><app-icon name="chevronLeft" [size]="13" /> Instances</a>
        <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Instances', link: ['/instances'] }, { label: 'Start new instance' }]" /></div>
      </div>

      <div class="wrap">
        <h1>Start a new process instance</h1>
        <p class="muted sub">Pick a deployed, startable process and supply any variables it needs.</p>

        <div class="card pad">
          @if (loading()) {
            <div class="skeleton skeleton-line" style="width:60%"></div><div class="skeleton skeleton-line" style="width:40%"></div>
          } @else if (processes().length === 0) {
            <div class="empty-state">
              <div class="es-icon"><app-icon name="deployments" [size]="22" /></div>
              <h3>No startable processes</h3>
              <p>Deploy and activate a version with a start event before you can start an instance.</p>
              <a class="btn" [routerLink]="['/deployments']">Go to Deployments</a>
            </div>
          } @else {
            <div class="field">
              <label>Process</label>
              <select [ngModel]="selectedKey()" (ngModelChange)="select($event)">
                @for (p of processes(); track key(p)) { <option [value]="key(p)">{{ p.name }} — {{ p.environment }} ({{ p.version || 'v?' }})</option> }
              </select>
            </div>

            @if (selected(); as p) {
              <div class="section-title">Variables</div>
              @if (rows().length === 0) {
                <p class="muted sm">No variables added yet — add any this process' start event needs.</p>
              }
              @for (r of rows(); track $index; let idx = $index) {
                <div class="varrow">
                  <input placeholder="name" [(ngModel)]="r.name" />
                  <input placeholder="value (JSON or plain text)" [(ngModel)]="r.value" />
                  <button class="btn ghost sm" (click)="removeRow(idx)"><app-icon name="close" [size]="12" /></button>
                </div>
              }
              <button class="btn sm" (click)="addRow()"><app-icon name="plus" [size]="12" /> Add variable</button>

              <div class="field" style="margin-top:16px;">
                <label>Correlation key <span class="muted">(optional)</span></label>
                <input placeholder="e.g. an external case id" [(ngModel)]="correlationKey" />
              </div>

              <div class="row" style="margin-top:16px;">
                <button class="btn primary sm" [disabled]="starting()" (click)="start()"><app-icon name="play" [size]="12" /> {{ starting() ? 'Starting…' : 'Start' }}</button>
                <a class="btn sm" [routerLink]="['/instances']">Cancel</a>
              </div>
            }
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    .page { padding: 12px 14px; }
    .topbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .crumbwrap { margin-left: 2px; }
    .wrap { max-width: 640px; }
    h1 { font-size: 19px; margin: 0 0 4px; }
    .sub { margin: 0 0 18px; font-size: 13px; }
    .pad { padding: 20px; }
    .field { margin-bottom: 16px; }
    .field label { display: block; font-size: 12px; color: var(--muted); font-weight: 600; margin-bottom: 6px; }
    .field select, .field input { width: 100%; }
    .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; margin: 4px 0 8px; }
    .varrow { display: grid; grid-template-columns: 1fr 1fr auto; gap: 8px; margin-bottom: 8px; align-items: center; }
    .sm { font-size: 12px; }
    .empty-state .btn { margin-top: 10px; }
  `],
})
export class StartInstanceComponent {
  private api = inject(InstanceApiService);
  private queryApi = inject(QueryApiService);
  private toast = inject(ToastService);
  private router = inject(Router);

  loading = signal(true);
  processes = signal<ProcessDef[]>([]);
  selectedKey = signal<string>('');
  rows = signal<VarRow[]>([]);
  correlationKey = '';
  starting = signal(false);

  selected = computed(() => this.processes().find((p) => this.key(p) === this.selectedKey()) || null);

  constructor() {
    this.queryApi.processDefinitions().subscribe({
      next: (defs) => {
        const startable = defs.filter((d) => d.deploymentId);
        this.processes.set(startable);
        if (startable[0]) this.selectedKey.set(this.key(startable[0]));
        this.loading.set(false);
      },
      error: (e) => { this.loading.set(false); this.toast.error(e?.error?.error?.message || 'Could not load processes'); },
    });
  }

  key(p: ProcessDef): string { return `${p.deploymentId}::${p.processId}`; }
  select(k: string) { this.selectedKey.set(k); this.rows.set([]); }

  addRow() { this.rows.update((r) => [...r, { name: '', value: '' }]); }
  removeRow(i: number) { this.rows.update((r) => r.filter((_, idx) => idx !== i)); }

  start() {
    const p = this.selected(); if (!p) return;
    const variables: Record<string, unknown> = {};
    for (const r of this.rows()) {
      if (!r.name.trim()) continue;
      let v: unknown = r.value;
      try { v = JSON.parse(r.value); } catch { /* keep as string */ }
      variables[r.name.trim()] = v;
    }
    this.starting.set(true);
    this.api.startInstance({
      workflowId: p.workflowId!, processId: p.processId, deploymentId: p.deploymentId,
      variables, correlationKey: this.correlationKey.trim() || undefined,
    }).subscribe({
      next: (inst) => { this.toast.success('Instance started'); this.router.navigate(['/instances', inst.id]); },
      error: (e) => { this.starting.set(false); this.toast.error(e?.error?.error?.message || 'Could not start instance'); },
    });
  }
}
