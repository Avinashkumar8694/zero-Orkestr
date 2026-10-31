import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiBase, ApiList } from './api-base';
import type { Deployment, DeploymentProcessDef } from '../models';

export interface ListDeploymentsFilter { workflowId?: string; environment?: string; status?: string; }

@Injectable({ providedIn: 'root' })
export class DeploymentApiService extends ApiBase {
  deploy(versionId: string, body: { environment: string; tags?: string[]; env?: Record<string, string>; activate?: boolean }): Observable<Deployment> { return this.http.post<Deployment>(`${this.base}/versions/${versionId}/deploy`, body); }
  /** Cross-project — the top-level Deployments page. Pass {workflowId} to scope to one project. */
  listDeploymentsGlobal(filter?: ListDeploymentsFilter): Observable<Deployment[]> { return this.items(this.http.get<ApiList<Deployment>>(`${this.base}/deployments`, { params: this.cleanParams(filter) })); }
  listDeployments(wfId: string): Observable<Deployment[]> { return this.items(this.http.get<ApiList<Deployment>>(`${this.base}/workflows/${wfId}/deployments`)); }
  getDeployment(id: string): Observable<Deployment> { return this.http.get<Deployment>(`${this.base}/deployments/${id}`); }
  definitions(id: string): Observable<DeploymentProcessDef[]> { return this.items(this.http.get<ApiList<DeploymentProcessDef>>(`${this.base}/deployments/${id}/definitions`)); }
  activate(depId: string): Observable<Deployment> { return this.http.post<Deployment>(`${this.base}/deployments/${depId}/activate`, {}); }
  undeploy(depId: string): Observable<Deployment> { return this.http.post<Deployment>(`${this.base}/deployments/${depId}/undeploy`, {}); }
  archive(depId: string): Observable<Deployment> { return this.http.post<Deployment>(`${this.base}/deployments/${depId}/archive`, {}); }
  rollback(depId: string, body: { environment: string; toDeploymentId: string }): Observable<Deployment> { return this.http.post<Deployment>(`${this.base}/deployments/${depId}/rollback`, body); }
  setTags(depId: string, change: { add?: string[]; remove?: string[] }): Observable<Deployment> { return this.http.post<Deployment>(`${this.base}/deployments/${depId}/tags`, change); }
  exportSnapshot(depId: string): Observable<any> { return this.http.get<any>(`${this.base}/deployments/${depId}/snapshot`); }
  restoreToProject(depId: string): Observable<{ ok: boolean; workflowId: string; versionNumber?: number; message: string }> { return this.http.post<{ ok: boolean; workflowId: string; versionNumber?: number; message: string }>(`${this.base}/deployments/${depId}/restore`, {}); }
  importSnapshot(body: { snapshot?: any; engine?: any; environment?: string; activate?: boolean }): Observable<Deployment> { return this.http.post<Deployment>(`${this.base}/deployments/import`, body); }
}
