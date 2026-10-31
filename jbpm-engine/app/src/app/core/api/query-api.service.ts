import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiBase, ApiList } from './api-base';
import type { ProcessAnalytics, ProcessDef, Summary, Task, TaskAnalytics, UserRow } from '../models';

@Injectable({ providedIn: 'root' })
export class QueryApiService extends ApiBase {
  queryUsers(): Observable<UserRow[]> { return this.items(this.http.get<ApiList<UserRow>>(`${this.base}/query/users`)); }
  userTasks(user: string, status?: string): Observable<Task[]> { return this.items(this.http.get<ApiList<Task>>(`${this.base}/query/users/${user}/tasks`, { params: status ? { status } : {} })); }
  userTasksCompleted(user: string): Observable<Task[]> { return this.items(this.http.get<ApiList<Task>>(`${this.base}/query/users/${user}/tasks/completed`)); }
  groupTasks(group: string, status?: string): Observable<Task[]> { return this.items(this.http.get<ApiList<Task>>(`${this.base}/query/groups/${group}/tasks`, { params: status ? { status } : {} })); }
  processDefinitions(): Observable<ProcessDef[]> { return this.items(this.http.get<ApiList<ProcessDef>>(`${this.base}/query/process-definitions`)); }
  instanceTasks(instanceId: string): Observable<Task[]> { return this.items(this.http.get<ApiList<Task>>(`${this.base}/query/instances/${instanceId}/tasks`)); }
  processSignals(processId: string): Observable<{ processId: string; listensFor: string[]; throws: string[] }> { return this.http.get<any>(`${this.base}/query/process-definitions/${processId}/signals`); }
  analyticsSummary(params?: { days?: number; since?: string; from?: string; to?: string; processId?: string }): Observable<Summary> {
    return this.http.get<Summary>(`${this.base}/query/analytics/summary`, { params: this.cleanParams(params) });
  }
  analyticsTasks(params?: { days?: number; since?: string; from?: string; to?: string; processId?: string }): Observable<TaskAnalytics> {
    return this.http.get<TaskAnalytics>(`${this.base}/query/analytics/tasks`, { params: this.cleanParams(params) });
  }
  analyticsProcesses(params?: { days?: number; since?: string; from?: string; to?: string; processId?: string }): Observable<ProcessAnalytics> {
    return this.http.get<ProcessAnalytics>(`${this.base}/query/analytics/processes`, { params: this.cleanParams(params) });
  }
}
