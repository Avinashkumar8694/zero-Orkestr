import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiBase, ApiList } from './api-base';
import type { Instance, VariableChange } from '../models';

export interface StartInstanceBody {
  workflowId: string; processId?: string; environment?: string; deploymentId?: string;
  variables?: Record<string, unknown>; correlationKey?: string;
}
export interface ListInstancesFilter {
  workflowId?: string;
  status?: string;
  deploymentId?: string;
  correlationKey?: string;
  type?: string;
  caseId?: string;
  search?: string;
  q?: string;
  limit?: number;
  offset?: number;
  full?: boolean;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
}

@Injectable({ providedIn: 'root' })
export class InstanceApiService extends ApiBase {
  startInstance(body: StartInstanceBody): Observable<Instance> { return this.http.post<Instance>(`${this.base}/instances`, body); }
  listInstances(filter: ListInstancesFilter): Observable<Instance[]> { return this.items(this.http.get<ApiList<Instance>>(`${this.base}/instances`, { params: this.cleanParams(filter) })); }
  listInstancesPaged(filter: ListInstancesFilter): Observable<PagedResult<Instance>> {
    return this.http.get<PagedResult<Instance>>(`${this.base}/instances`, { params: this.cleanParams(filter) });
  }
  getInstance(id: string): Observable<Instance> { return this.http.get<Instance>(`${this.base}/instances/${id}`); }
  diagramState(id: string): Observable<any> { return this.http.get(`${this.base}/instances/${id}/diagram-state`); }
  instanceGraph(id: string): Observable<{ nodes: any[]; flows: any[]; diagram: { activeNodeIds: string[]; visitedNodeIds: string[]; status: string }; counts: Record<string, number>; status: string }> { return this.http.get<any>(`${this.base}/instances/${id}/graph`); }
  relatedInstances(id: string): Observable<{ instance: Instance; parent: Instance | null; children: Instance[] }> { return this.http.get<any>(`${this.base}/instances/${id}/related`); }
  signalInstance(id: string, name: string, payload?: unknown): Observable<Instance> { return this.http.post<Instance>(`${this.base}/instances/${id}/signal`, { name, payload }); }
  retryNode(id: string, nodeId: string): Observable<Instance> { return this.http.post<Instance>(`${this.base}/instances/${id}/retry`, { nodeId }); }
  suspendInstance(id: string): Observable<Instance> { return this.http.post<Instance>(`${this.base}/instances/${id}/suspend`, {}); }
  resumeInstance(id: string): Observable<Instance> { return this.http.post<Instance>(`${this.base}/instances/${id}/resume`, {}); }
  abort(id: string): Observable<Instance> { return this.http.post<Instance>(`${this.base}/instances/${id}/abort`, {}); }
  /** Inline variable edits from the Variables tab — audited server-side, refused once the instance ends. */
  updateVariables(id: string, patch: Record<string, unknown>): Observable<Instance> { return this.http.put<Instance>(`${this.base}/instances/${id}/variables`, patch); }
  variableHistory(id: string, name?: string): Observable<VariableChange[]> { return this.items(this.http.get<ApiList<VariableChange>>(`${this.base}/instances/${id}/variable-history`, { params: this.cleanParams({ name }) })); }
}
