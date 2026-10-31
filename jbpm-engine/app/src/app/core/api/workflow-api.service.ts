// Workflows, processes, assets, branches, versions, catalog, import/export, validation — the
// authoring-side surface, always consumed together by workflows/project/builder components.
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiBase, ApiList } from './api-base';
import type { AuditEvent, Branch, CallableProcess, Catalog, Folder, ImportResult, ValidationResult, Version, Workflow } from '../models';

@Injectable({ providedIn: 'root' })
export class WorkflowApiService extends ApiBase {
  // catalog
  catalog(): Observable<Catalog> { return this.http.get<Catalog>(`${this.base}/catalog/nodes`); }
  cheatSheet(lang?: string): Observable<{ cheatSheet: string; lang?: string }> { return this.http.get<{ cheatSheet: string; lang?: string }>(`${this.base}/catalog/cheat-sheet${lang ? `?lang=${lang}` : ''}`); }
  nodeReadme(engineType: string): Observable<any> { return this.http.get<any>(`${this.base}/catalog/nodes/${engineType}`); }
  assetReadme(kind: string): Observable<{ kind: string; readme: string }> { return this.http.get<{ kind: string; readme: string }>(`${this.base}/catalog/assets/${kind}/readme`); }
  callableProcesses(): Observable<CallableProcess[]> { return this.items(this.http.get<ApiList<CallableProcess>>(`${this.base}/catalog/processes`)); }

  // workflows
  listWorkflows(): Observable<Workflow[]> { return this.items(this.http.get<ApiList<Workflow>>(`${this.base}/workflows`)); }
  listArchivedWorkflows(): Observable<Workflow[]> { return this.items(this.http.get<ApiList<Workflow>>(`${this.base}/workflows?archived=true`)); }
  getWorkflow(id: string): Observable<Workflow> { return this.http.get<Workflow>(`${this.base}/workflows/${id}`); }
  createWorkflow(body: { name: string; description?: string; folderId?: string | null }): Observable<Workflow> { return this.http.post<Workflow>(`${this.base}/workflows`, body); }
  updateWorkflow(id: string, patch: Partial<Workflow>): Observable<Workflow> { return this.http.patch<Workflow>(`${this.base}/workflows/${id}`, patch); }
  archiveWorkflow(id: string): Observable<void> { return this.http.delete<void>(`${this.base}/workflows/${id}`); }
  restoreWorkflow(id: string): Observable<Workflow> { return this.http.post<Workflow>(`${this.base}/workflows/${id}/restore`, {}); }
  purgeWorkflow(id: string): Observable<void> { return this.http.delete<void>(`${this.base}/workflows/${id}/purge`); }
  purgeAllArchivedWorkflows(): Observable<{ purgedCount: number }> { return this.http.post<{ purgedCount: number }>(`${this.base}/workflows/purge-archived`, {}); }

  // folders (Projects-page tree; always consumed alongside workflows on that one page)
  listFolders(): Observable<Folder[]> { return this.items(this.http.get<ApiList<Folder>>(`${this.base}/folders`)); }
  createFolder(body: { name: string; parentId?: string | null }): Observable<Folder> { return this.http.post<Folder>(`${this.base}/folders`, body); }
  updateFolder(id: string, patch: { name?: string; parentId?: string | null }): Observable<Folder> { return this.http.patch<Folder>(`${this.base}/folders/${id}`, patch); }
  deleteFolder(id: string): Observable<void> { return this.http.delete<void>(`${this.base}/folders/${id}`); }

  // import / export (jBPM kjar & Node.js engine)
  importJbpm(files: Record<string, string>, name?: string): Observable<ImportResult> { return this.http.post<any>(`${this.base}/import/jbpm`, { files, name }); }
  importAndDeployJbpm(files: Record<string, string>, name: string | undefined, environment: string): Observable<ImportResult & { deploymentId: string }> {
    return this.http.post<any>(`${this.base}/import/jbpm/deploy`, { files, name, environment });
  }
  exportVersion(versionId: string): Observable<{ files: Record<string, string> }> { return this.http.get<any>(`${this.base}/versions/${versionId}/export`); }
  checkJbpmCompatibility(workflowId: string): Observable<{ valid: boolean; issues: any[] }> {
    return this.http.get<any>(`${this.base}/workflows/${workflowId}/jbpm-compatibility`);
  }
  exportEngineProject(workflowId: string): Observable<any> {
    return this.http.get<any>(`${this.base}/workflows/${workflowId}/export-engine`);
  }
  getEngine(workflowId: string): Observable<any> {
    return this.http.get<any>(`${this.base}/workflows/${workflowId}/engine`);
  }

  // processes (within a project) + assets
  listProcesses(projectId: string): Observable<{ id: string; name: string; nodes: number; flows: number }[]> { return this.items(this.http.get<ApiList<any>>(`${this.base}/workflows/${projectId}/processes`)); }
  addProcess(projectId: string, name: string): Observable<{ id: string; name: string }> { return this.http.post<any>(`${this.base}/workflows/${projectId}/processes`, { name }); }
  renameProcess(projectId: string, pid: string, name: string): Observable<any> { return this.http.patch(`${this.base}/workflows/${projectId}/processes/${pid}`, { name }); }
  removeProcess(projectId: string, pid: string): Observable<any> { return this.http.delete(`${this.base}/workflows/${projectId}/processes/${pid}`); }
  getProcess(projectId: string, pid: string): Observable<any> { return this.http.get<any>(`${this.base}/workflows/${projectId}/processes/${pid}`); }
  saveProcess(projectId: string, pid: string, process: any): Observable<any> { return this.http.put(`${this.base}/workflows/${projectId}/processes/${pid}`, { process }); }
  getAssets(projectId: string): Observable<{ kinds: { key: string; label: string; nameField: string }[]; assets: Record<string, { name: string; usedBy: number }[]> }> { return this.http.get<any>(`${this.base}/workflows/${projectId}/assets`); }
  addAsset(projectId: string, kind: string, name: string, fields?: Record<string, unknown>): Observable<any> { return this.http.post(`${this.base}/workflows/${projectId}/assets`, { kind, name, ...(fields ? { fields } : {}) }); }
  getAsset(projectId: string, kind: string, name: string): Observable<{ kind: string; asset: any; usedBy: { kind: string; process: string; nodeId?: string; nodeName?: string; via: string }[] }> {
    return this.http.get<any>(`${this.base}/workflows/${projectId}/assets/${kind}/${encodeURIComponent(name)}`);
  }
  updateAsset(projectId: string, kind: string, name: string, patch: Record<string, unknown>): Observable<{ kind: string; name: string }> {
    return this.http.patch<any>(`${this.base}/workflows/${projectId}/assets/${kind}/${encodeURIComponent(name)}`, patch);
  }
  testAsset(projectId: string, kind: string, name: string, payload: Record<string, unknown> = {}): Observable<any> {
    return this.http.post<any>(`${this.base}/workflows/${projectId}/assets/${kind}/${encodeURIComponent(name)}/test`, payload);
  }
  duplicateAsset(projectId: string, kind: string, name: string, newName: string): Observable<{ kind: string; name: string }> {
    return this.http.post<any>(`${this.base}/workflows/${projectId}/assets/${kind}/${encodeURIComponent(name)}/duplicate`, { newName });
  }
  deleteAsset(projectId: string, kind: string, name: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/workflows/${projectId}/assets/${kind}/${encodeURIComponent(name)}`);
  }

  // branches + versions
  listBranches(wfId: string): Observable<Branch[]> { return this.items(this.http.get<ApiList<Branch>>(`${this.base}/workflows/${wfId}/branches`)); }
  listVersions(branchId: string): Observable<Version[]> { return this.items(this.http.get<ApiList<Version>>(`${this.base}/branches/${branchId}/versions`)); }
  saveDraft(branchId: string, engine: any, message?: string): Observable<Version> { return this.http.post<Version>(`${this.base}/branches/${branchId}/versions`, { engine, message }); }
  publish(versionId: string, label?: string): Observable<any> { return this.http.post(`${this.base}/versions/${versionId}/publish`, { label }); }
  validate(versionId: string): Observable<ValidationResult> { return this.http.post<ValidationResult>(`${this.base}/versions/${versionId}/validate`, {}); }
  validateProcess(process: any): Observable<ValidationResult> { return this.http.post<ValidationResult>(`${this.base}/validate`, { process }); }

  // workspace-scoped audit
  getWorkflowAudit(projectId: string, filter?: { actor?: string; kind?: string; limit?: number; offset?: number }): Observable<{ items: AuditEvent[]; total: number }> {
    return this.http.get<{ items: AuditEvent[]; total: number }>(`${this.base}/workflows/${projectId}/audit`, { params: this.cleanParams(filter) });
  }
  getWorkflowAuditFacets(projectId: string): Observable<{ kinds: string[]; actors: string[] }> {
    return this.http.get<{ kinds: string[]; actors: string[] }>(`${this.base}/workflows/${projectId}/audit/facets`);
  }
  getWorkflowAuditEvent(projectId: string, eventId: string): Observable<AuditEvent> {
    return this.http.get<AuditEvent>(`${this.base}/workflows/${projectId}/audit/${eventId}`);
  }
}
