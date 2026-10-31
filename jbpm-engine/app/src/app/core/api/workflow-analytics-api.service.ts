import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiBase, ApiList } from './api-base';
import type { OwnershipTimeline, QueryDefinition, QueryRunResult, SavedQuery, TasksAndProcesses, WorkflowTat } from '../models';

export interface WorkflowInstanceSummary {
  total: number;
  byStatus: Record<string, number>;
  byWorkflowName?: Record<string, number>;
  activeCases?: number;
  closedCases?: number;
  withoutPiid: number;
}

@Injectable({ providedIn: 'root' })
export class WorkflowAnalyticsApiService extends ApiBase {
  summary(params?: { since?: string; from?: string; to?: string }): Observable<WorkflowInstanceSummary> {
    return this.http.get<WorkflowInstanceSummary>(`${this.base}/workflow-analytics/summary`, { params: this.cleanParams(params) });
  }
  tat(params?: { since?: string; from?: string; to?: string }): Observable<WorkflowTat> {
    return this.http.get<WorkflowTat>(`${this.base}/workflow-analytics/tat`, { params: this.cleanParams(params) });
  }
  ownershipTimeline(workflowInstanceId: string, taskId: string): Observable<OwnershipTimeline> {
    return this.http.get<OwnershipTimeline>(`${this.base}/workflow-instances/${workflowInstanceId}/tasks/${taskId}/ownership-timeline`);
  }
  tasksAndProcesses(piid: string): Observable<TasksAndProcesses> { return this.http.get<TasksAndProcesses>(`${this.base}/analytics/tasks-and-processes/${piid}`); }

  runQuery(definition: QueryDefinition): Observable<QueryRunResult> { return this.http.post<QueryRunResult>(`${this.base}/analytics/query/run`, definition); }
  listSavedQueries(): Observable<SavedQuery[]> { return this.items(this.http.get<ApiList<SavedQuery>>(`${this.base}/analytics/queries`)); }
  saveQuery(name: string, definition: QueryDefinition, shared = false): Observable<SavedQuery> { return this.http.post<SavedQuery>(`${this.base}/analytics/queries`, { name, definition, shared }); }
  runSavedQuery(id: string): Observable<QueryRunResult> { return this.http.post<QueryRunResult>(`${this.base}/analytics/queries/${id}/run`, {}); }
  deleteSavedQuery(id: string): Observable<void> { return this.http.delete<void>(`${this.base}/analytics/queries/${id}`); }
}
