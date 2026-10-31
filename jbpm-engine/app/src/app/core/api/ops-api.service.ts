// Operations surfaces: Execution Errors, Jobs & Timers, and the (admin-only) Audit Log.
// Split from query-api because these pages consume list+act pairs (list/ack, list/cancel), not
// read-only analytics.
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiBase, ApiList } from './api-base';
import type { AuditEvent, ErrorSummary, ExecutionError, TimerJob } from '../models';

export interface ListErrorsFilter {
  /** comma-separated types: process,task,job,integration */
  type?: string;
  instanceId?: string; taskId?: string; jobId?: string; workflowId?: string; processId?: string;
  acknowledged?: boolean;
  from?: string; to?: string;
  limit?: number; offset?: number;
}
export interface ListAuditFilter {
  actor?: string;
  /** exact kind, or a prefix ending in '.' (e.g. 'task.') */
  kind?: string;
  workflowId?: string; deploymentId?: string; instanceId?: string; taskId?: string;
  from?: string; to?: string;
  limit?: number; offset?: number;
}
export interface ListJobsFilter { status?: string; instanceId?: string; kind?: string; }

@Injectable({ providedIn: 'root' })
export class OpsApiService extends ApiBase {
  // --- execution errors ---
  listErrors(filter?: ListErrorsFilter): Observable<{ items: ExecutionError[]; total: number }> {
    return this.http.get<{ items: ExecutionError[]; total: number }>(`${this.base}/errors`, { params: this.cleanParams(filter) });
  }
  errorSummary(): Observable<ErrorSummary> { return this.http.get<ErrorSummary>(`${this.base}/errors/summary`); }
  getError(id: string): Observable<ExecutionError> { return this.http.get<ExecutionError>(`${this.base}/errors/${id}`); }
  acknowledgeError(id: string): Observable<ExecutionError> { return this.http.post<ExecutionError>(`${this.base}/errors/${id}/ack`, {}); }
  acknowledgeErrors(ids: string[]): Observable<{ results: { id: string; ok: boolean; reason?: string }[] }> {
    return this.http.post<{ results: { id: string; ok: boolean; reason?: string }[] }>(`${this.base}/errors/ack`, { ids });
  }

  // --- jobs & timers ---
  listJobs(filter?: ListJobsFilter): Observable<TimerJob[]> { return this.items(this.http.get<ApiList<TimerJob>>(`${this.base}/jobs`, { params: this.cleanParams(filter) })); }
  getJob(id: string): Observable<TimerJob> { return this.http.get<TimerJob>(`${this.base}/jobs/${id}`); }
  cancelJob(id: string): Observable<TimerJob> { return this.http.post<TimerJob>(`${this.base}/jobs/${id}/cancel`, {}); }
  /** Fire a scheduled job now instead of waiting for dueAt. */
  triggerJob(id: string): Observable<TimerJob> { return this.http.post<TimerJob>(`${this.base}/jobs/${id}/trigger`, {}); }
  /** Move the fire time; also revives a cancelled job. */
  rescheduleJob(id: string, dueAt: string): Observable<TimerJob> { return this.http.post<TimerJob>(`${this.base}/jobs/${id}/reschedule`, { dueAt }); }

  // --- audit log (admin) ---
  listAudit(filter?: ListAuditFilter): Observable<{ items: AuditEvent[]; total: number }> {
    return this.http.get<{ items: AuditEvent[]; total: number }>(`${this.base}/audit`, { params: this.cleanParams(filter) });
  }
  auditFacets(): Observable<{ kinds: string[]; actors: string[] }> { return this.http.get<{ kinds: string[]; actors: string[] }>(`${this.base}/audit/facets`); }
  getAuditEvent(id: string): Observable<AuditEvent> { return this.http.get<AuditEvent>(`${this.base}/audit/${id}`); }
}
