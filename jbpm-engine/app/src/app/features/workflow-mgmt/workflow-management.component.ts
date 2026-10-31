import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { WorkflowDefinitionApiService } from '../../core/api/workflow-definition-api.service';
import { DeploymentApiService } from '../../core/api/deployment-api.service';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { BreadcrumbComponent } from '../../shared/breadcrumb.component';
import { ToastService } from '../../shared/toast.service';
import { IconComponent } from '../../shared/icon.component';
import { SchemaFieldEditorComponent } from './schema-field-editor.component';
import { childrenToObjectSchema, objectSchemaToChildren, type SchemaField } from './schema-field.model';
import type { Deployment, Workflow, WorkflowDefinition } from '../../core/models';

type Tab = 'deployment' | 'schema';

/** Workflow Management (docs/usage_docs/14-workflow-instance-management.md): the stable
 *  name -> deployment mapping a client app holds onto across redeployments, plus the JSON-Schema
 *  used to validate a case's business `data`. "Create Workflow Schema" opens a 2-tab modal — pick a
 *  deployment (as a card, not a bare dropdown — this is the one thing a client actually cares about
 *  getting right when wiring up a new case type) and build the data schema. */
@Component({
  selector: 'app-workflow-management',
  standalone: true,
  imports: [FormsModule, RouterLink, BreadcrumbComponent, IconComponent, SchemaFieldEditorComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Workflow Management' }]" /></div>
      <header class="pagehead">
        <div><h1>Workflow Management</h1><p class="muted">Stable, named handles onto a deployment — repoint them as new versions ship, without changing the name a client app already uses.</p></div>
        <span class="spacer"></span>
        <button class="btn primary" (click)="openCreate()"><app-icon name="plus" [size]="13" /> Create Workflow Schema</button>
      </header>

      @if (loading()) {
        <div class="card"><div class="skeleton skeleton-line" style="width:60%"></div><div class="skeleton skeleton-line" style="width:40%"></div></div>
      } @else if (definitions().length === 0) {
        <div class="empty-state">
          <div class="es-icon"><app-icon name="admin" [size]="24" /></div>
          <h3>No workflow definitions yet</h3>
          <p>Create one to give a deployment a stable name your client apps can start cases against.</p>
        </div>
      } @else {
        <div class="card listcard">
          <table>
            <thead><tr><th>Name</th><th>Project</th><th>Version</th><th>Environment</th><th>Status</th><th>Schema</th><th></th></tr></thead>
            <tbody>
              @for (d of definitions(); track d.id) {
                <tr>
                  <td class="mono">{{ d.name }}</td>
                  <td><a [routerLink]="['/projects', depOf(d)?.workflowId]">{{ projectName(depOf(d)?.workflowId) }}</a></td>
                  <td class="muted">{{ depOf(d)?.versionLabel || ('v' + (depOf(d)?.versionNumber ?? '?')) }}</td>
                  <td class="muted">{{ depOf(d)?.environment }}</td>
                  <td><span class="badge" [class.active]="depOf(d)?.status === 'active'" [class.inactive]="depOf(d)?.status !== 'active'">{{ depOf(d)?.status || 'unknown' }}</span></td>
                  <td>@if (d.schemaValidationEnabled) { <span class="badge active">validated</span> } @else { <span class="badge inactive">open</span> }</td>
                  <td class="right"><button class="btn sm" (click)="openEdit(d)">Edit</button></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    @if (modal(); as m) {
      <div class="modal-bg" (click)="closeModal()">
        <div class="modal wide" (click)="$event.stopPropagation()">
          <div class="modal-h">
            <span>{{ m.editing ? 'Edit workflow schema' : 'Create workflow schema' }}</span><span class="spacer"></span>
            <button class="x" (click)="closeModal()" aria-label="Close"><app-icon name="close" [size]="15" /></button>
          </div>
          <nav class="tabs">
            <button [class.active]="tab() === 'deployment'" (click)="tab.set('deployment')">Deployment</button>
            <button [class.active]="tab() === 'schema'" (click)="tab.set('schema')">Schema</button>
          </nav>
          <div class="modal-body">
            @switch (tab()) {
              @case ('deployment') {
                <label class="fld"><span>Workflow name</span><input [(ngModel)]="m.name" placeholder="claim-review-v1" [disabled]="!!m.editing" /></label>
                <p class="hint sm">The stable handle a client app passes as <code>workflowName</code> when creating a case — never changes, even after you repoint the deployment below.</p>
                <div class="section-title">Pick a deployment</div>
                <div class="depgrid">
                  @for (d of deployments(); track d.id) {
                    <button type="button" class="depcard" [class.sel]="m.deploymentId === d.id" (click)="m.deploymentId = d.id">
                      <div class="dc-top"><span class="dc-name">{{ projectName(d.workflowId) }}</span><span class="badge" [class.active]="d.status==='active'" [class.inactive]="d.status!=='active'">{{ d.status }}</span></div>
                      <div class="dc-row"><span class="muted sm">Version</span><span>{{ d.versionLabel || ('v' + (d.versionNumber ?? '?')) }}</span></div>
                      <div class="dc-row"><span class="muted sm">Environment</span><span>{{ d.environment }}</span></div>
                      <div class="dc-row"><span class="muted sm">workflowId</span><span class="mono trunc">{{ d.workflowId }}</span></div>
                      <div class="dc-row"><span class="muted sm">deploymentId</span><span class="mono trunc">{{ d.id }}</span></div>
                    </button>
                  }
                </div>
              }
              @case ('schema') {
                <div class="setting-row">
                  <div class="lbl">Enable schema validation<span class="shint">When off, workflowData is accepted as-is, no validation.</span></div>
                  <button class="switch" [class.on]="m.validationEnabled" role="switch" [attr.aria-checked]="m.validationEnabled" (click)="m.validationEnabled = !m.validationEnabled"></button>
                </div>
                <div class="section-title">Fields</div>
                <p class="hint sm">string, number, boolean, array (of string/number/boolean/object), or object — object and "array of object" nest their own fields.</p>
                <app-schema-field-editor [fields]="m.fields" [depth]="0" />
                <button class="btn sm" (click)="addField(m)"><app-icon name="plus" [size]="12" /> Add field</button>
              }
            }
            @if (modalError()) { <p class="err">{{ modalError() }}</p> }
            <div class="row actionrow">
              <button class="btn primary sm" (click)="submit()">{{ m.editing ? 'Save' : 'Create' }}</button>
              <button class="btn sm" (click)="closeModal()">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .page { padding: 20px 24px; max-width: 1080px; }
    .crumbwrap { margin-bottom: 10px; }
    .pagehead { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
    .pagehead h1 { font-size: 19px; margin: 0; }
    .pagehead p { margin: 4px 0 0; font-size: 13px; color: var(--muted); max-width: 68ch; }
    .spacer { flex: 1; }
    .muted { color: var(--muted); }
    .mono { font-family: ui-monospace, monospace; }
    .trunc { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
    .listcard { padding: 0; }
    table { width: 100%; }
    th, td { text-align: left; padding: 10px 14px; font-size: 13px; border-bottom: 1px solid var(--border); }
    td.right { text-align: right; }
    .empty-state { padding: 40px; text-align: center; }
    .es-icon { margin: 0 auto 10px; color: var(--muted); }
    .modal-bg { position: fixed; inset: 0; background: rgba(16,24,40,.4); display: grid; place-items: center; z-index: 50; }
    .modal { background: var(--surface); border-radius: 14px; width: 440px; max-width: 92vw; max-height: 86vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: var(--shadow-pop); }
    .modal.wide { width: 760px; max-width: 94vw; }
    .modal-h { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--border); font-weight: 700; }
    .modal-h .x { border: none; background: transparent; font-size: 16px; cursor: pointer; color: var(--muted); }
    .modal-body { padding: 16px 18px; overflow: auto; }


    .fld { display: block; margin-bottom: 10px; } .fld span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 5px; }
    .fld input, .fld select { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13px; font-family: inherit; }
    .fld input:disabled { opacity: .6; }
    .hint.sm { font-size: 12px; color: var(--muted); margin: -4px 0 12px; }
    .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 700; margin: 14px 0 8px; }
    .depgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; }
    .depcard { text-align: left; border: 1px solid var(--border); border-radius: 10px; padding: 12px; background: var(--surface); cursor: pointer; display: flex; flex-direction: column; gap: 6px; }
    .depcard:hover { border-color: var(--border-strong); }
    .depcard.sel { border-color: var(--primary); background: var(--primary-50); }
    .dc-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .dc-name { font-weight: 600; font-size: 13px; }
    .dc-row { display: flex; justify-content: space-between; font-size: 12px; }
    .setting-row { display: flex; align-items: center; gap: 16px; padding: 8px 0; }
    .setting-row .lbl { flex: 1; font-size: 13px; }
    .setting-row .shint { display: block; font-size: 11.5px; color: var(--muted); margin-top: 2px; }
    .switch { width: 34px; height: 20px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface-3); position: relative; cursor: pointer; flex: none; }
    .switch::after { content: ''; position: absolute; top: 1px; left: 1px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .12s; }
    .switch.on { background: var(--primary); border-color: var(--primary); } .switch.on::after { transform: translateX(14px); }
    .fieldrow { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
    .fkey { flex: 1; border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; font-size: 13px; }
    .fieldrow select { border: 1px solid var(--border); border-radius: 8px; padding: 6px 9px; font-size: 13px; }
    .reqlbl { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); white-space: nowrap; }
    .btn.danger { color: var(--red); }
    .actionrow { gap: 8px; margin-top: 14px; }
    .err { color: var(--red); font-size: 12px; margin: 8px 0 0; }
    .badge.active { background: var(--green-bg); color: var(--green); } .badge.inactive { background: var(--surface-3); color: var(--muted); }
  `],
})
export class WorkflowManagementComponent {
  private defsApi = inject(WorkflowDefinitionApiService);
  private depApi = inject(DeploymentApiService);
  private wfApi = inject(WorkflowApiService);
  private toast = inject(ToastService);

  loading = signal(true);
  definitions = signal<WorkflowDefinition[]>([]);
  deployments = signal<Deployment[]>([]);
  workflows = signal<Workflow[]>([]);

  tab = signal<Tab>('deployment');
  modal = signal<{ editing: WorkflowDefinition | null; name: string; deploymentId: string; validationEnabled: boolean; fields: SchemaField[] } | null>(null);
  modalError = signal('');

  depsById = computed(() => new Map(this.deployments().map((d) => [d.id, d])));
  wfNames = computed(() => new Map(this.workflows().map((w) => [w.id, w.name])));

  constructor() { this.reload(); }

  reload() {
    this.loading.set(true);
    this.wfApi.listWorkflows().subscribe((w) => this.workflows.set(w));
    this.depApi.listDeploymentsGlobal().subscribe((d) => this.deployments.set(d));
    this.defsApi.list().subscribe({
      next: (d) => { this.definitions.set(d); this.loading.set(false); },
      error: (e) => { this.loading.set(false); this.toast.error(e?.error?.error?.message || 'Could not load workflow definitions'); },
    });
  }

  depOf(d: WorkflowDefinition): Deployment | undefined { return this.depsById().get(d.deploymentId); }
  projectName(workflowId: string | undefined): string { return workflowId ? this.wfNames().get(workflowId) || workflowId : '—'; }

  // Recursive JSON Schema <-> field-tree conversion lives in ./schema-field.model.ts, shared with
  // schema-field-editor.component.ts so the builder and the conversion never drift out of sync on
  // what a "field" can be (string/number/boolean/array/object, arbitrarily nested).
  private schemaToFields(schema: Record<string, unknown>): SchemaField[] { return objectSchemaToChildren(schema); }
  private fieldsToSchema(fields: SchemaField[]): Record<string, unknown> { return childrenToObjectSchema(fields); }

  openCreate() {
    this.tab.set('deployment');
    this.modalError.set('');
    this.modal.set({ editing: null, name: '', deploymentId: '', validationEnabled: false, fields: [] });
  }
  openEdit(d: WorkflowDefinition) {
    this.tab.set('deployment');
    this.modalError.set('');
    this.modal.set({ editing: d, name: d.name, deploymentId: d.deploymentId, validationEnabled: d.schemaValidationEnabled, fields: this.schemaToFields(d.dataSchema) });
  }
  closeModal() { this.modal.set(null); }

  // Mutates m.fields IN PLACE (push) — same reasoning as schema-field-editor.component.ts's own
  // remove(): m.fields is the SAME array object bound into <app-schema-field-editor [fields]="m.fields">,
  // so push()ing here and splice()ing there both stay visible to each other and to this template.
  addField(m: NonNullable<ReturnType<typeof this.modal>>) { m.fields.push({ key: '', type: 'string', required: false }); }

  submit() {
    const m = this.modal(); if (!m) return;
    if (!m.editing && !m.name.trim()) { this.modalError.set('Workflow name is required'); this.tab.set('deployment'); return; }
    if (!m.deploymentId) { this.modalError.set('Pick a deployment'); this.tab.set('deployment'); return; }
    const dataSchema = this.fieldsToSchema(m.fields);
    const obs = m.editing
      ? this.defsApi.update(m.editing.id, { deploymentId: m.deploymentId, dataSchema, schemaValidationEnabled: m.validationEnabled })
      : this.defsApi.create({ name: m.name.trim(), deploymentId: m.deploymentId, dataSchema, schemaValidationEnabled: m.validationEnabled });
    obs.subscribe({
      next: () => { this.toast.success(m.editing ? 'Workflow schema saved' : 'Workflow schema created'); this.closeModal(); this.reload(); },
      error: (e) => this.modalError.set(e?.error?.error?.message || 'Save failed'),
    });
  }
}
