import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
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

interface ModalState {
  editing: WorkflowDefinition | null;
  name: string;
  selectedProjectId: string;
  selectedProcessId: string;
  deploymentId: string;
  validationEnabled: boolean;
  fields: SchemaField[];
}

@Component({
  selector: 'app-workflow-management',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, BreadcrumbComponent, IconComponent, SchemaFieldEditorComponent],
  template: `
    <div class="page">
      <div class="crumbwrap"><app-breadcrumb [crumbs]="[{ label: 'Workflow Definitions' }]" /></div>
      <header class="pagehead">
        <div>
          <h1>Workflow Definitions</h1>
          <p class="muted">Stable, business-named handles mapped to project process definitions and deployments — start cases against these without breaking client applications when new versions ship.</p>
        </div>
        <span class="spacer"></span>
        <input class="search-input" placeholder="Search definitions..." [ngModel]="searchTerm()" (ngModelChange)="searchTerm.set($event)" style="padding:6px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); font-size:12.5px; width:200px; background:var(--surface);" />
        <button class="btn primary" (click)="openCreate()">
          <app-icon name="plus" [size]="13" /> Create Workflow Definition
        </button>
      </header>

      @if (loading()) {
        <div class="card"><div class="skeleton skeleton-line" style="width:60%"></div><div class="skeleton skeleton-line" style="width:40%"></div></div>
      } @else if (definitions().length === 0) {
        <div class="empty-state">
          <div class="es-icon"><app-icon name="admin" [size]="24" /></div>
          <h3>No workflow definitions yet</h3>
          <p>Create a workflow definition to bind a project process to a case workflow your applications can start cases against.</p>
        </div>
      } @else {
        <div class="card listcard">
          <table>
            <thead>
              <tr>
                <th>Workflow Name</th>
                <th>Project</th>
                <th>Bound Process</th>
                <th>Version</th>
                <th>Environment</th>
                <th>Status</th>
                <th>Validation</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (d of filteredDefinitions(); track d.id) {
                <tr>
                  <td class="mono bold">{{ d.name }}</td>
                  <td>
                    <a [routerLink]="['/projects', depOf(d)?.workflowId]">{{ projectName(depOf(d)?.workflowId) }}</a>
                  </td>
                  <td>
                    <span class="badge process-badge">{{ d.processId || '(Default Process)' }}</span>
                  </td>
                  <td class="muted">{{ depOf(d)?.versionLabel || ('v' + (depOf(d)?.versionNumber ?? '?')) }}</td>
                  <td class="muted">{{ depOf(d)?.environment }}</td>
                  <td>
                    <span class="badge" [class.active]="depOf(d)?.status === 'active'" [class.inactive]="depOf(d)?.status !== 'active'">
                      {{ depOf(d)?.status || 'unknown' }}
                    </span>
                  </td>
                  <td>
                    @if (d.schemaValidationEnabled) {
                      <span class="badge active">validated</span>
                    } @else {
                      <span class="badge inactive">open</span>
                    }
                  </td>
                  <td class="right">
                    <button class="btn sm" (click)="openEdit(d)">Edit</button>
                  </td>
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
            <span class="modal-title">
              <app-icon name="puzzle" [size]="16" /> {{ m.editing ? 'Edit Workflow Definition' : 'Create Workflow Definition' }}
            </span>
            <span class="spacer"></span>
            <button class="x" (click)="closeModal()" aria-label="Close"><app-icon name="close" [size]="15" /></button>
          </div>
          <nav class="tabs">
            <button [class.active]="tab() === 'deployment'" (click)="tab.set('deployment')">1. Project &amp; Process Selection</button>
            <button [class.active]="tab() === 'schema'" (click)="tab.set('schema')">2. Payload Data Schema</button>
          </nav>
          <div class="modal-body">
            @switch (tab()) {
              @case ('deployment') {
                <label class="fld">
                  <span>Workflow Name (Stable Case Handle)</span>
                  <input [(ngModel)]="m.name" placeholder="e.g. claim-review-v1" [disabled]="!!m.editing" />
                </label>
                <p class="hint sm">The stable handle passed as <code>workflowName</code> when creating a case instance — remains fixed even across future deployments.</p>

                <!-- Step 1: List All Projects -->
                <div class="section-title">1. Select Project</div>
                <div class="projgrid">
                  @for (w of workflows(); track w.id) {
                    <button type="button" class="projcard" [class.sel]="m.selectedProjectId === w.id" (click)="onSelectProject(m, w)">
                      <div class="dc-top">
                        <span class="dc-name bold">{{ w.name }}</span>
                        @if (activeDepOfProject(w.id); as adep) {
                          <span class="badge active">{{ adep.versionLabel || ('v' + adep.versionNumber) }}</span>
                        } @else {
                          <span class="badge inactive">No deploy</span>
                        }
                      </div>
                      <div class="dc-row">
                        <span class="muted sm">Key</span>
                        <span class="mono sm">{{ w.key }}</span>
                      </div>
                    </button>
                  }
                </div>

                <!-- Step 2: List All Processes For Selected Project -->
                @if (m.selectedProjectId) {
                  <div class="section-title">2. Select Process Definition (Within {{ projectName(m.selectedProjectId) }})</div>
                  @if (loadingProcesses()) {
                    <p class="muted sm">Loading project processes...</p>
                  } @else if (projectProcesses().length === 0) {
                    <p class="muted sm">No processes found in this project.</p>
                  } @else {
                    <div class="procgrid">
                      @for (p of projectProcesses(); track p.id) {
                        <button type="button" class="proccard" [class.sel]="m.selectedProcessId === p.id" (click)="onSelectProcess(m, p)">
                          <div class="dc-top">
                            <span class="bold">{{ p.name }}</span>
                            <span class="badge" [class.active]="m.selectedProcessId === p.id">{{ m.selectedProcessId === p.id ? 'Selected' : 'Select' }}</span>
                          </div>
                          <div class="dc-row">
                            <span class="muted sm">ID: {{ p.id }}</span>
                            <span class="mono sm">{{ p.nodes }} nodes</span>
                          </div>
                        </button>
                      }
                    </div>
                  }

                  <!-- Step 3: Target Deployment Binding -->
                  <div class="section-title">3. Target Deployment Snapshot</div>
                  @if (projectDeployments(m.selectedProjectId).length) {
                    <label class="fld">
                      <span>Deployment Version / Environment</span>
                      <select [(ngModel)]="m.deploymentId">
                        @for (dep of projectDeployments(m.selectedProjectId); track dep.id) {
                          <option [value]="dep.id">
                            {{ dep.versionLabel || ('v' + dep.versionNumber) }} · {{ dep.environment }} ({{ dep.status }}) — {{ dep.id | slice:-7 }}
                          </option>
                        }
                      </select>
                    </label>
                  } @else {
                    <div class="warn-box">
                      <app-icon name="warning" [size]="14" />
                      <span>This project has not been deployed yet. Deploy the project first to activate runtime case execution.</span>
                    </div>
                  }
                }
              }
              @case ('schema') {
                <div class="setting-row">
                  <div class="lbl">
                    Enable schema validation
                    <span class="shint">When enabled, business workflowData submitted when creating a case will be validated against this schema.</span>
                  </div>
                  <button class="switch" [class.on]="m.validationEnabled" role="switch" [attr.aria-checked]="m.validationEnabled" (click)="m.validationEnabled = !m.validationEnabled"></button>
                </div>
                <div class="section-title">Fields</div>
                <p class="hint sm">string, number, boolean, array, or object — object and array nest their own fields.</p>
                <app-schema-field-editor [fields]="m.fields" [depth]="0" />
                <button class="btn sm" (click)="addField(m)"><app-icon name="plus" [size]="12" /> Add field</button>
              }
            }
            @if (modalError()) { <p class="err">{{ modalError() }}</p> }
            <div class="row actionrow">
              <button class="btn primary sm" (click)="submit()">{{ m.editing ? 'Save Workflow Definition' : 'Create Workflow Definition' }}</button>
              <button class="btn sm" (click)="closeModal()">Cancel</button>
            </div>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    :host { display: block; }
    .page { padding: 12px 14px; max-width: 1160px; margin: 0 auto; }
    .crumbwrap { margin-bottom: 10px; }
    .pagehead { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 16px; }
    .pagehead h1 { font-size: 20px; margin: 0; font-weight: 700; }
    .pagehead p { margin: 4px 0 0; font-size: 13px; color: var(--muted); max-width: 72ch; line-height: 1.45; }
    .spacer { flex: 1; }
    .muted { color: var(--muted); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .bold { font-weight: 600; }
    .trunc { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; }
    .listcard { padding: 0; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 11px 16px; font-size: 13px; border-bottom: 1px solid var(--border); }
    th { font-size: 11.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); background: var(--surface-2); }
    td.right { text-align: right; }
    .empty-state { padding: 48px; text-align: center; }
    .es-icon { margin: 0 auto 10px; color: var(--muted); }
    .process-badge { background: var(--surface-2); color: var(--text-secondary); border: 1px solid var(--border); }

    .modal-bg { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: grid; place-items: center; z-index: 50; backdrop-filter: blur(2px); }
    .modal { background: var(--surface); border-radius: 14px; width: 440px; max-width: 92vw; max-height: 88vh; overflow: hidden; display: flex; flex-direction: column; box-shadow: var(--shadow-pop); border: 1px solid var(--border); }
    .modal.wide { width: 780px; max-width: 94vw; }
    .modal-h { display: flex; align-items: center; gap: 8px; padding: 14px 18px; border-bottom: 1px solid var(--border); font-weight: 700; }
    .modal-title { font-size: 15px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    .modal-h .x { border: none; background: transparent; font-size: 16px; cursor: pointer; color: var(--muted); }
    .modal-body { padding: 18px 20px; overflow: auto; }

    .fld { display: block; margin-bottom: 12px; }
    .fld span { display: block; font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 5px; }
    .fld input, .fld select { width: 100%; border: 1px solid var(--border); border-radius: 8px; padding: 8px 11px; font-size: 13px; font-family: inherit; background: var(--surface); color: var(--text); }
    .fld input:disabled { opacity: .6; }
    .hint.sm { font-size: 12px; color: var(--muted); margin: -6px 0 14px; }
    .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 700; margin: 16px 0 8px; }

    .projgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px; margin-bottom: 12px; }
    .projcard { text-align: left; border: 1.5px solid var(--border); border-radius: 9px; padding: 11px 12px; background: var(--surface); cursor: pointer; display: flex; flex-direction: column; gap: 5px; transition: all .15s ease; }
    .projcard:hover { border-color: var(--primary); background: var(--surface-2); }
    .projcard.sel { border-color: var(--primary); background: rgba(59,130,246,0.08); box-shadow: 0 0 0 1px var(--primary); }

    .procgrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px; margin-bottom: 12px; }
    .proccard { text-align: left; border: 1.5px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--surface); cursor: pointer; display: flex; flex-direction: column; gap: 4px; transition: all .15s ease; }
    .proccard:hover { border-color: var(--primary); background: var(--surface-2); }
    .proccard.sel { border-color: var(--primary); background: rgba(59,130,246,0.08); box-shadow: 0 0 0 1px var(--primary); }

    .dc-top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .dc-name { font-weight: 600; font-size: 13px; }
    .dc-row { display: flex; justify-content: space-between; font-size: 12px; }

    .warn-box { background: var(--amber-bg); color: var(--amber); border: 1px solid rgba(245,158,11,0.3); border-radius: 8px; padding: 10px 12px; font-size: 12.5px; display: flex; align-items: center; gap: 8px; }

    .setting-row { display: flex; align-items: center; gap: 16px; padding: 8px 0; }
    .setting-row .lbl { flex: 1; font-size: 13px; }
    .setting-row .shint { display: block; font-size: 11.5px; color: var(--muted); margin-top: 2px; }
    .switch { width: 34px; height: 20px; border-radius: 10px; border: 1px solid var(--border); background: var(--surface-3); position: relative; cursor: pointer; flex: none; }
    .switch::after { content: ''; position: absolute; top: 1px; left: 1px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform .12s; }
    .switch.on { background: var(--primary); border-color: var(--primary); } .switch.on::after { transform: translateX(14px); }

    .actionrow { display: flex; gap: 8px; margin-top: 18px; }
    .err { color: var(--red); font-size: 12.5px; margin: 10px 0 0; }
    .badge.active { background: var(--green-bg); color: var(--green); }
    .badge.inactive { background: var(--surface-3); color: var(--muted); }
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
  searchTerm = signal('');

  projectProcesses = signal<{ id: string; name: string; nodes: number; flows: number }[]>([]);
  loadingProcesses = signal(false);

  tab = signal<Tab>('deployment');
  modal = signal<ModalState | null>(null);
  modalError = signal('');

  depsById = computed(() => new Map(this.deployments().map((d) => [d.id, d])));
  wfNames = computed(() => new Map(this.workflows().map((w) => [w.id, w.name])));

  filteredDefinitions = computed(() => {
    const q = this.searchTerm().trim().toLowerCase();
    if (!q) return this.definitions();
    return this.definitions().filter((d) => {
      const matchName = d.name.toLowerCase().includes(q);
      const matchProc = (d.processId || '').toLowerCase().includes(q);
      const proj = this.projectName(this.depOf(d)?.workflowId).toLowerCase();
      return matchName || matchProc || proj.includes(q);
    });
  });

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

  projectDeployments(projectId: string): Deployment[] {
    return this.deployments().filter((d) => d.workflowId === projectId);
  }

  activeDepOfProject(projectId: string): Deployment | undefined {
    return this.deployments().find((d) => d.workflowId === projectId && d.status === 'active')
      || this.deployments().find((d) => d.workflowId === projectId);
  }

  private schemaToFields(schema: Record<string, unknown>): SchemaField[] { return objectSchemaToChildren(schema); }
  private fieldsToSchema(fields: SchemaField[]): Record<string, unknown> { return childrenToObjectSchema(fields); }

  openCreate() {
    this.tab.set('deployment');
    this.modalError.set('');
    this.projectProcesses.set([]);
    this.modal.set({
      editing: null,
      name: '',
      selectedProjectId: '',
      selectedProcessId: '',
      deploymentId: '',
      validationEnabled: false,
      fields: [],
    });
  }

  openEdit(d: WorkflowDefinition) {
    this.tab.set('deployment');
    this.modalError.set('');
    const dep = this.depOf(d);
    const projectId = dep?.workflowId || '';

    this.modal.set({
      editing: d,
      name: d.name,
      selectedProjectId: projectId,
      selectedProcessId: d.processId || '',
      deploymentId: d.deploymentId,
      validationEnabled: d.schemaValidationEnabled,
      fields: this.schemaToFields(d.dataSchema),
    });

    if (projectId) {
      this.loadingProcesses.set(true);
      this.wfApi.listProcesses(projectId).subscribe({
        next: (procs) => {
          this.projectProcesses.set(procs);
          this.loadingProcesses.set(false);
        },
        error: () => this.loadingProcesses.set(false),
      });
    }
  }

  closeModal() { this.modal.set(null); }

  onSelectProject(m: ModalState, w: Workflow) {
    m.selectedProjectId = w.id;
    m.selectedProcessId = '';

    const adep = this.activeDepOfProject(w.id);
    m.deploymentId = adep?.id || '';

    this.loadingProcesses.set(true);
    this.wfApi.listProcesses(w.id).subscribe({
      next: (procs) => {
        this.projectProcesses.set(procs);
        this.loadingProcesses.set(false);
        if (procs.length === 1) {
          this.onSelectProcess(m, procs[0]);
        }
      },
      error: () => this.loadingProcesses.set(false),
    });
  }

  onSelectProcess(m: ModalState, proc: { id: string; name: string }) {
    m.selectedProcessId = proc.id;
    if (!m.editing && (!m.name || m.name.endsWith('-v1'))) {
      m.name = proc.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-v1';
    }
  }

  addField(m: NonNullable<ReturnType<typeof this.modal>>) { m.fields.push({ key: '', type: 'string', required: false }); }

  submit() {
    const m = this.modal(); if (!m) return;
    if (!m.editing && !m.name.trim()) { this.modalError.set('Workflow name is required'); this.tab.set('deployment'); return; }
    if (!m.selectedProjectId) { this.modalError.set('Please select a project'); this.tab.set('deployment'); return; }
    if (!m.selectedProcessId) { this.modalError.set('Please select a process definition within the project'); this.tab.set('deployment'); return; }
    if (!m.deploymentId) { this.modalError.set('Selected project has no active deployment. Deploy the project first.'); this.tab.set('deployment'); return; }

    const dataSchema = this.fieldsToSchema(m.fields);
    const payload = {
      name: m.name.trim(),
      deploymentId: m.deploymentId,
      processId: m.selectedProcessId || undefined,
      dataSchema,
      schemaValidationEnabled: m.validationEnabled,
    };

    const obs = m.editing
      ? this.defsApi.update(m.editing.id, payload)
      : this.defsApi.create(payload);

    obs.subscribe({
      next: () => {
        this.toast.success(m.editing ? 'Workflow definition saved' : 'Workflow definition created');
        this.closeModal();
        this.reload();
      },
      error: (e) => this.modalError.set(e?.error?.error?.message || 'Save failed'),
    });
  }
}
