import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiBase } from './api-base';

export type AllocationStrategy = 'roundRobin' | 'leastLoaded' | 'skills';
export interface AssignmentRule {
  id: string; name: string; enabled: boolean; priority: number;
  scope: { workflowId?: string; nodeId?: string; group?: string };
  strategy: AllocationStrategy; requiredSkills?: string[];
  pool?: { groups?: string[]; users?: string[] };
  respectLimits: boolean; updatedAt?: string; updatedBy?: string;
}
export type RuleInput = Partial<Omit<AssignmentRule, 'id' | 'updatedAt' | 'updatedBy'>>;
export interface PersonLoad {
  username: string; skills: string[]; available: boolean; awayUntil?: string; canWork?: boolean; maxOpenTasks?: number; maxTasksPerDay?: number;
  open: number; inProgress: number; assignedToday: number; completedToday: number;
}
export interface Tracker { people: PersonLoad[]; waiting: { pending: number; queued: number }; rules: number }

/** Automatic task assignment: rules, the per-person workload tracker, and a run-now for the allocator. */
@Injectable({ providedIn: 'root' })
export class AllocationApiService extends ApiBase {
  private b = `${this.base}/allocation`;
  rules(): Observable<{ items: AssignmentRule[] }> { return this.http.get<{ items: AssignmentRule[] }>(`${this.b}/rules`); }
  createRule(body: RuleInput): Observable<AssignmentRule> { return this.http.post<AssignmentRule>(`${this.b}/rules`, body); }
  updateRule(id: string, body: RuleInput): Observable<AssignmentRule> { return this.http.put<AssignmentRule>(`${this.b}/rules/${id}`, body); }
  deleteRule(id: string): Observable<void> { return this.http.delete<void>(`${this.b}/rules/${id}`); }
  myAvailability(): Observable<{ available: boolean; awayUntil?: string; managed: boolean }> { return this.http.get<{ available: boolean; awayUntil?: string; managed: boolean }>(`${this.base}/me/availability`); }
  setMyAvailability(body: { available: boolean; awayUntil?: string; keepTasks?: boolean }): Observable<{ available: boolean; awayUntil?: string; released: number }> { return this.http.put<{ available: boolean; awayUntil?: string; released: number }>(`${this.base}/me/availability`, body); }
  tracker(): Observable<Tracker> { return this.http.get<Tracker>(`${this.b}/tracker`); }
  runNow(): Observable<{ assigned: number; queued: number }> { return this.http.post<{ assigned: number; queued: number }>(`${this.b}/run`, {}); }
}
