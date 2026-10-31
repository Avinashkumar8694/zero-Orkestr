import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiBase, ApiList } from './api-base';
import type { WorkflowDefinition } from '../models';

export interface CreateWorkflowDefinitionBody {
  name: string; deploymentId: string; processId?: string; dataSchema?: Record<string, unknown>; schemaValidationEnabled?: boolean;
}
export interface UpdateWorkflowDefinitionBody {
  name?: string; deploymentId?: string; processId?: string; dataSchema?: Record<string, unknown>; schemaValidationEnabled?: boolean;
}

@Injectable({ providedIn: 'root' })
export class WorkflowDefinitionApiService extends ApiBase {
  list(): Observable<WorkflowDefinition[]> { return this.items(this.http.get<ApiList<WorkflowDefinition>>(`${this.base}/workflow-definitions`)); }
  get(id: string): Observable<WorkflowDefinition> { return this.http.get<WorkflowDefinition>(`${this.base}/workflow-definitions/${id}`); }
  create(body: CreateWorkflowDefinitionBody): Observable<WorkflowDefinition> { return this.http.post<WorkflowDefinition>(`${this.base}/workflow-definitions`, body); }
  update(id: string, patch: UpdateWorkflowDefinitionBody): Observable<WorkflowDefinition> { return this.http.patch<WorkflowDefinition>(`${this.base}/workflow-definitions/${id}`, patch); }
}
