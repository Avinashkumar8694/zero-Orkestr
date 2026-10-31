import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiBase, ApiList } from './api-base';
import type { AuditEvent, Task, TaskComment } from '../models';

export interface ListTasksFilter {
  assignee?: string;
  group?: string;
  status?: string;
  overdue?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface PagedTasksResult {
  items: Task[];
  total: number;
  hasMore: boolean;
  offset: number;
  limit: number;
}

@Injectable({ providedIn: 'root' })
export class TaskApiService extends ApiBase {
  listTasks(filter?: ListTasksFilter): Observable<Task[]> { return this.items(this.http.get<ApiList<Task>>(`${this.base}/tasks`, { params: this.cleanParams(filter) })); }
  listTasksPaged(filter?: ListTasksFilter): Observable<PagedTasksResult> {
    return this.http.get<PagedTasksResult>(`${this.base}/tasks`, { params: this.cleanParams(filter) });
  }
  getTask(id: string): Observable<Task> { return this.http.get<Task>(`${this.base}/tasks/${id}`); }
  claimTask(id: string): Observable<Task> { return this.http.post<Task>(`${this.base}/tasks/${id}/claim`, {}); }
  releaseTask(id: string): Observable<Task> { return this.http.post<Task>(`${this.base}/tasks/${id}/release`, {}); }
  completeTask(id: string, outputs: Record<string, unknown>): Observable<Task> { return this.http.post<Task>(`${this.base}/tasks/${id}/complete`, { outputs }); }
  // was missing entirely — backend has had POST /tasks/:id/skip since the skippable:true feature shipped
  skipTask(id: string): Observable<Task> { return this.http.post<Task>(`${this.base}/tasks/${id}/skip`, {}); }
  // jBPM task lifecycle: Start (reserved → inprogress; from Ready = implicit claim) and Stop (back to reserved)
  startTask(id: string): Observable<Task> { return this.http.post<Task>(`${this.base}/tasks/${id}/start`, {}); }
  stopTask(id: string): Observable<Task> { return this.http.post<Task>(`${this.base}/tasks/${id}/stop`, {}); }
  /** Save partial outputs without completing (the Work tab's Save button). */
  saveTask(id: string, outputs: Record<string, unknown>): Observable<Task> { return this.http.post<Task>(`${this.base}/tasks/${id}/save`, { outputs }); }
  /** Delegate: hand to a specific user — lands reserved in their inbox. */
  delegateTask(id: string, to: string): Observable<Task> { return this.http.post<Task>(`${this.base}/tasks/${id}/delegate`, { to }); }
  /** Forward: back to Ready in a user's or group's queue — the target must claim it. */
  forwardTask(id: string, to: { user?: string; group?: string }): Observable<Task> { return this.http.post<Task>(`${this.base}/tasks/${id}/forward`, to); }
  remindTask(id: string): Observable<{ notified: string }> { return this.http.post<{ notified: string }>(`${this.base}/tasks/${id}/remind`, {}); }
  /** Admin-tab edits — priority / due date (dueAt: null clears it). */
  updateTask(id: string, patch: { priority?: number; dueAt?: string | null }): Observable<Task> { return this.http.patch<Task>(`${this.base}/tasks/${id}`, patch); }
  listComments(taskId: string): Observable<TaskComment[]> { return this.items(this.http.get<ApiList<TaskComment>>(`${this.base}/tasks/${taskId}/comments`)); }
  addComment(taskId: string, body: string): Observable<TaskComment> { return this.http.post<TaskComment>(`${this.base}/tasks/${taskId}/comments`, { body }); }
  deleteComment(taskId: string, commentId: string): Observable<void> { return this.http.delete<void>(`${this.base}/tasks/${taskId}/comments/${commentId}`); }
  /** The task's audit trail (the Logs tab), oldest first. */
  taskEvents(taskId: string): Observable<AuditEvent[]> { return this.items(this.http.get<ApiList<AuditEvent>>(`${this.base}/tasks/${taskId}/events`)); }
}
