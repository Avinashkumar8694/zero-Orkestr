// Platform-administrator surface (limits every workspace lives under). All calls are 403 for anyone but the platform admin.
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { ApiBase } from './api-base';

export interface PlatformLimits {
  scriptPoolDefaultSize: number; scriptPoolMaxSize: number; scriptQueueDefaultMax: number; scriptQueueMaxCap: number;
  scriptQueueTimeoutMs: number; scriptMaxIsolates: number; scriptOverflowModeDefault: 'queue' | 'reject';
  maxActiveInstancesCap: number; maxActiveTimersCap: number; maxReplicasCap: number;
}
export interface WorkspaceLimitOverride {
  scriptPoolDefaultSize?: number; scriptPoolMaxSize?: number; scriptQueueDefaultMax?: number; scriptQueueMaxCap?: number;
  maxActiveInstancesCap?: number; maxActiveTimersCap?: number; maxReplicasCap?: number; lockedOverflowMode?: 'queue' | 'reject';
}
export interface PlatformUsageRow {
  workspaceId: string; name?: string; slug?: string; plan?: string | null; planExpiresAt?: string | null; status?: string;
  effective: { scriptPoolSize: number; scriptQueueMax: number; scriptOverflowMode: string; maxActiveInstances: number; maxActiveTimers: number };
  caps: { scriptPoolMaxSize: number; scriptQueueMaxCap: number; maxActiveInstancesCap: number; maxActiveTimersCap: number; lockedOverflowMode?: string };
  pool: { size: number | null; isolatesAlive: number; running: number; queued: number; peakRunning: number; created: number; recycled: number };
}
export interface PlatformUsage {
  global: PlatformLimits;
  server: { totalIsolates: number; maxIsolates: number; queuedTotal: number; created: number; recycled: number; executions: number; queueRejected: number; overflowRejected: number; queueTimeouts: number };
  workspaces: PlatformUsageRow[];
}

export type PlanStatus = 'active' | 'disabled' | 'upcoming' | 'hidden';
export interface PlanContact { type: 'email' | 'url'; value: string; label?: string; }
export interface PlanRow {
  key: string; name: string; description: string; stored: boolean; status: PlanStatus; isDefault: boolean; isCustom: boolean;
  trialDays: number | null; contactConfig: PlanContact | null; features: string[]; sortOrder: number; workspaces: number; limits: Record<string, number>;
}
/** what the editor sends: every field optional on update; `key` only on create */
export interface PlanInput {
  key?: string; name?: string; description?: string; status?: PlanStatus; isDefault?: boolean; isCustom?: boolean; trialDays?: number | null;
  contactConfig?: PlanContact | null; features?: string[]; sortOrder?: number; limits?: Record<string, number>;
}
export interface LimitInfo { label: string; unit: string; description: string; }

@Injectable({ providedIn: 'root' })
export class PlatformApiService extends ApiBase {
  getLimits(): Observable<{ limits: PlatformLimits; defaults: PlatformLimits; overriddenFields: string[] }> { return this.http.get<{ data: any }>(`${this.base}/platform/limits`).pipe(map((r) => r.data)); }
  putLimits(patch: Partial<PlatformLimits>): Observable<{ limits: PlatformLimits }> { return this.http.put<{ data: any }>(`${this.base}/platform/limits`, patch).pipe(map((r) => r.data)); }
  usage(): Observable<PlatformUsage> { return this.http.get<{ data: PlatformUsage }>(`${this.base}/platform/limits/usage`).pipe(map((r) => r.data)); }
  getWorkspace(id: string): Observable<{ override: WorkspaceLimitOverride }> { return this.http.get<{ data: any }>(`${this.base}/platform/workspaces/${id}/limits`).pipe(map((r) => r.data)); }
  putWorkspace(id: string, patch: Record<string, unknown>): Observable<{ override: WorkspaceLimitOverride }> { return this.http.put<{ data: any }>(`${this.base}/platform/workspaces/${id}/limits`, patch).pipe(map((r) => r.data)); }
  plans(): Observable<{ plans: PlanRow[]; catalog: Record<string, LimitInfo> }> { return this.http.get<{ data: any }>(`${this.base}/platform/plans`).pipe(map((r) => r.data)); }
  createPlan(body: PlanInput): Observable<PlanRow> { return this.http.post<{ data: PlanRow }>(`${this.base}/platform/plans`, body).pipe(map((r) => r.data)); }
  updatePlan(key: string, patch: PlanInput): Observable<PlanRow> { return this.http.put<{ data: PlanRow }>(`${this.base}/platform/plans/${key}`, patch).pipe(map((r) => r.data)); }
  deletePlan(key: string): Observable<void> { return this.http.delete<void>(`${this.base}/platform/plans/${key}`); }
  assignPlan(id: string, body: { plan: string; planExpiresAt?: string | null; extendDays?: number }): Observable<{ id: string; plan: string; planExpiresAt: string | null }> { return this.http.put<{ data: any }>(`${this.base}/platform/workspaces/${id}/plan`, body).pipe(map((r) => r.data)); }
}
