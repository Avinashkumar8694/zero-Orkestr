import { Injectable, inject, signal } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { WorkflowApiService } from '../../core/api/workflow-api.service';
import { DeploymentApiService } from '../../core/api/deployment-api.service';
import { ToastService } from '../../shared/toast.service';
import { ModalService } from '../../shared/modal.service';
import type { Workflow, GlobalErrorHandlerConfig, Problem } from '../../core/models';

export interface JbpmExportDenialIssue {
  processId: string;
  processName?: string;
  nodeId?: string;
  nodeName?: string;
  flowId?: string;
  kind: 'unsupported_code' | 'unsupported_node' | 'unsupported_feature';
  rule: string;
  message: string;
  remedy?: string;
}

export interface JbpmExportDenial {
  projectName: string;
  message: string;
  issues: JbpmExportDenialIssue[];
}

export interface ValidationDenial {
  action: 'build' | 'deploy';
  projectName: string;
  message: string;
  problems: Problem[];
}

// Route-scoped (provided by ProjectShellComponent, one instance per project) — shared by every section
// page rendered in the shell's <router-outlet>, so switching sections doesn't re-fetch the project or
// lose in-progress edits. Lifted from the former single-page ProjectComponent; behavior unchanged.
@Injectable()
export class ProjectContextService {
  private api = inject(WorkflowApiService);
  private deploymentApi = inject(DeploymentApiService);
  private toast = inject(ToastService);
  private modal = inject(ModalService);
  private route = inject(ActivatedRoute);

  id = this.route.snapshot.paramMap.get('id')!;
  wf = signal<Workflow | null>(null);
  processes = signal<{ id: string; name: string; nodes: number; flows: number; hasErrors?: boolean; errorCount?: number; warningCount?: number; problems?: any[] }[]>([]);
  assets = signal<Record<string, { name: string; usedBy: number; refs?: any[] }[]>>({});
  assetKinds = signal<{ key: string; label: string; nameField: string }[]>([]);
  vars = signal<{ name: string; type: string }[]>([]);
  envList = signal<{ key: string; value: string }[]>([]);
  globalErrorHandler = signal<GlobalErrorHandlerConfig>({ enabled: false, rules: [] });
  name = ''; description = ''; baseUrl = '';
  instanceCreationMode: 'both' | 'case-only' | 'process-only' | 'none' | '' = '';
  exportDenial = signal<JbpmExportDenial | null>(null);
  validationDenial = signal<ValidationDenial | null>(null);
  isJbpmCompatible = signal<boolean>(false);

  constructor() {
    this.api.getWorkflow(this.id).subscribe((w) => {
      this.wf.set(w); this.name = w.name; this.description = w.description || '';
      this.instanceCreationMode = (w.instanceCreationMode as any) || '';
      this.vars.set([...(w.variables || [])]);
      const envRecord = w.env || {};
      this.envList.set(Object.entries(envRecord).map(([key, value]) => ({ key, value })));
      this.globalErrorHandler.set(w.globalErrorHandler || { enabled: false, rules: [] });
    });
    this.loadProcesses();
    this.loadAssets();
    this.refreshCompatibility();
  }
  loadProcesses() {
    this.api.listProcesses(this.id).subscribe((p) => {
      this.processes.set(p);
      this.refreshCompatibility();
    });
  }
  loadAssets() {
    this.api.getAssets(this.id).subscribe((a) => {
      this.assets.set(a.assets);
      this.assetKinds.set(a.kinds);
      this.refreshCompatibility();
    });
  }

  refreshCompatibility() {
    this.api.checkJbpmCompatibility(this.id).subscribe({
      next: (res) => this.isJbpmCompatible.set(!!res?.valid),
      error: () => this.isJbpmCompatible.set(false),
    });
  }

  saveName() { const w = this.wf(); if (w) this.api.updateWorkflow(w.id, { name: this.name, description: this.description }).subscribe((u) => this.wf.set(u)); }

  saveCreationMode() {
    const w = this.wf();
    if (w) {
      this.api.updateWorkflow(w.id, { instanceCreationMode: (this.instanceCreationMode || undefined) as any }).subscribe((u) => {
        this.wf.set(u);
        this.toast.success('Instance creation mode updated');
      });
    }
  }

  addProcess(name: string) { const n = name.trim(); if (!n) return; this.api.addProcess(this.id, n).subscribe(() => this.loadProcesses()); }
  async renameProcess(p: { id: string; name: string }) {
    const n = await this.modal.prompt({ title: 'Rename process', initialValue: p.name });
    if (n && n.trim()) this.api.renameProcess(this.id, p.id, n.trim()).subscribe(() => this.loadProcesses());
  }
  async removeProcess(p: { id: string; name: string }) {
    if (await this.modal.confirm({ title: 'Delete process', message: `Delete process "${p.name}"? This can't be undone.`, confirmLabel: 'Delete', danger: true })) {
      this.api.removeProcess(this.id, p.id).subscribe(() => this.loadProcesses());
    }
  }
  addVar() { this.vars.set([...this.vars(), { name: '', type: 'string' }]); }
  rmVar(i: number) { const v = [...this.vars()]; v.splice(i, 1); this.vars.set(v); }
  saveVars() { const w = this.wf(); if (w) this.api.updateWorkflow(w.id, { variables: this.vars().filter((v) => v.name.trim()) as any }).subscribe((u) => { this.wf.set(u); this.toast.success('Shared variables saved'); }); }

  addEnvVar() { this.envList.set([...this.envList(), { key: '', value: '' }]); }
  rmEnvVar(i: number) { const list = [...this.envList()]; list.splice(i, 1); this.envList.set(list); }
  saveEnv() {
    const w = this.wf();
    if (!w) return;
    const envObj: Record<string, string> = {};
    for (const item of this.envList()) {
      const k = item.key.trim();
      if (k) envObj[k] = item.value;
    }
    this.api.updateWorkflow(w.id, { env: envObj } as any).subscribe({
      next: (u) => {
        this.wf.set(u);
        this.toast.success('Environment variables saved');
      },
      error: () => this.toast.error('Failed to save environment variables'),
    });
  }

  updateGlobalErrorHandler(patch: Partial<GlobalErrorHandlerConfig>) {
    this.globalErrorHandler.set({ ...this.globalErrorHandler(), ...patch });
  }

  saveGlobalErrorHandler() {
    const w = this.wf();
    if (!w) return;
    this.api.updateWorkflow(w.id, { globalErrorHandler: this.globalErrorHandler() } as any).subscribe({
      next: (u) => {
        this.wf.set(u);
        this.toast.success('Project Global Error Handler saved');
      },
      error: () => this.toast.error('Failed to save Global Error Handler'),
    });
  }

  addAsset(kind: string, name: string, fields?: Record<string, unknown>) {
    const n = name.trim(); if (!n) return;
    this.api.addAsset(this.id, kind, n, fields).subscribe({ next: () => this.loadAssets(), error: (e) => this.toast.error(e?.error?.error?.message || 'add failed') });
  }
  getAsset(kind: string, name: string) { return this.api.getAsset(this.id, kind, name); }
  updateAsset(kind: string, name: string, patch: Record<string, unknown>) { return this.api.updateAsset(this.id, kind, name, patch); }
  duplicateAsset(kind: string, name: string, newName: string) { return this.api.duplicateAsset(this.id, kind, name, newName); }
  testAsset(kind: string, name: string, payload: Record<string, unknown> = {}) { return this.api.testAsset(this.id, kind, name, payload); }
  getAudit(filter?: { actor?: string; kind?: string; limit?: number; offset?: number }) { return this.api.getWorkflowAudit(this.id, filter); }
  getAuditFacets() { return this.api.getWorkflowAuditFacets(this.id); }
  async removeAsset(kind: string, name: string, usedBy: number): Promise<void> {
    if (usedBy > 0) { this.toast.error(`"${name}" is referenced by ${usedBy} process node(s) — remove those references first`); return; }
    if (!(await this.modal.confirm({ title: 'Delete asset', message: `Delete "${name}"? This can't be undone.`, confirmLabel: 'Delete', danger: true }))) return;
    this.api.deleteAsset(this.id, kind, name).subscribe({
      next: () => { this.toast.success(`"${name}" deleted`); this.loadAssets(); },
      error: (e) => this.toast.error(e?.error?.error?.message || 'delete failed'),
    });
  }

  exportEngineProject() {
    const w = this.wf(); if (!w) return;
    this.api.exportEngineProject(this.id).subscribe({
      next: (engine) => {
        const json = JSON.stringify(engine, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${w.key}-project.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        this.toast.success(`Exported Node.js engine project "${w.name}" successfully`);
      },
      error: (err) => {
        this.toast.error(err?.error?.error?.message || 'Failed to export Node.js engine project');
      },
    });
  }

  exportKjar() {
    const w = this.wf(); if (!w) return;
    this.api.listVersions(w.defaultBranchId).subscribe({
      next: (vs) => {
        const head = vs.at(-1);
        if (!head) {
          this.toast.error('No version found to export');
          return;
        }
        this.api.exportVersion(head.id).subscribe({
          next: (kjar) => {
            const blob = new Blob([JSON.stringify(kjar, null, 2)], { type: 'application/json' });
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `${w.key}-kjar.json`; a.click(); URL.revokeObjectURL(a.href);
            this.toast.success(`Exported jBPM project "${w.name}" successfully`);
          },
          error: (err) => {
            const errObj = err?.error?.error;
            if (errObj?.code === 'JBPM_EXPORT_DENIED') {
              const issues: JbpmExportDenialIssue[] = errObj.details?.issues || [];
              this.exportDenial.set({
                projectName: w.name || w.key,
                message: errObj.message || 'Export to jBPM denied: project contains unsupported code or features.',
                issues,
              });
              this.toast.error(`Export to jBPM denied: ${issues.length} incompatible construct(s) detected.`);
            } else {
              this.toast.error(errObj?.message || 'Failed to export jBPM project');
            }
          },
        });
      },
      error: () => this.toast.error('Failed to load project versions'),
    });
  }

  closeExportDenial() {
    this.exportDenial.set(null);
  }

  closeValidationDenial() {
    this.validationDenial.set(null);
  }

  /** "Build" alone (jBPM's compile-without-deploy): publishes the head draft into an immutable
   *  version but doesn't push it to a runtime environment. */
  build() {
    const w = this.wf(); if (!w) return;
    this.api.listVersions(w.defaultBranchId).subscribe((vs) => {
      const head = vs.filter((v) => v.state === 'draft').at(-1);
      if (!head) { this.toast.error('Nothing to build — no draft changes since the last version.'); return; }
      this.api.publish(head.id, 'ui').subscribe({
        next: (p: any) => this.toast.success(`Built v${p.published.number}.`),
        error: (e) => {
          const probs: Problem[] = e?.error?.error?.details || [];
          if (probs.length > 0) {
            this.validationDenial.set({
              action: 'build',
              projectName: w.name,
              message: e?.error?.error?.message || 'Project contains validation errors that prevent building.',
              problems: probs,
            });
          } else {
            this.toast.error('Cannot build: ' + (e?.error?.error?.message || 'validation failed'));
          }
        },
      });
    });
  }
  deployProject(
    opts: { environment: string; versionLabel?: string; activate: boolean } = { environment: 'prod', activate: true },
    onDone?: (dep: any) => void,
    onError?: (err: any) => void
  ) {
    const w = this.wf(); if (!w) return;
    this.api.listVersions(w.defaultBranchId).subscribe({
      next: (vs) => {
        const head = vs.filter((v) => v.state === 'draft').at(-1) || vs.at(-1);
        if (!head) { this.toast.error('No project version available to deploy.'); onError?.('No draft'); return; }

        const proceedWithDeployment = (versionId: string, versionNumber: number | string) => {
          this.deploymentApi.deploy(versionId, { environment: opts.environment, activate: opts.activate }).subscribe({
            next: (dep) => {
              this.toast.success(`Deployed project "${w.name}" v${versionNumber} to ${opts.environment}.`);
              if (onDone) onDone(dep);
            },
            error: (e) => {
              const probs: Problem[] = e?.error?.error?.details || [];
              if (probs.length > 0) {
                this.validationDenial.set({
                  action: 'deploy',
                  projectName: w.name,
                  message: e?.error?.error?.message || 'Project contains validation errors that prevent deployment.',
                  problems: probs,
                });
              } else {
                this.toast.error('Deploy failed: ' + (e?.error?.error?.message || 'unknown error'));
              }
              onError?.(e);
            },
          });
        };

        if (head.state === 'draft') {
          this.api.publish(head.id, opts.versionLabel?.trim() || undefined).subscribe({
            next: (p: any) => proceedWithDeployment(p.published.id, p.published.number),
            error: (e) => {
              const probs: Problem[] = e?.error?.error?.details || [];
              if (probs.length > 0) {
                this.validationDenial.set({
                  action: 'deploy',
                  projectName: w.name,
                  message: e?.error?.error?.message || 'Cannot build snapshot before deploy: validation errors found.',
                  problems: probs,
                });
              } else {
                this.toast.error('Cannot build/publish snapshot: ' + (e?.error?.error?.message || 'validation failed'));
              }
              onError?.(e);
            },
          });
        } else {
          proceedWithDeployment(head.id, head.number);
        }
      },
      error: (e) => {
        this.toast.error('Failed to load project versions');
        onError?.(e);
      },
    });
  }
}
