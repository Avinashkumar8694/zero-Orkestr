import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiBase } from './api-base';

export type FieldType = 'string' | 'number' | 'boolean' | 'date' | 'json';
export interface CatalogField { key: string; label: string; type: FieldType; computed: boolean }
export interface CatalogSource { key: string; label: string; permission: string; allowed: boolean; fields: CatalogField[]; dynamic: Array<{ key: string; label: string }> }
export interface CatalogRelation { key: string; label: string; from: string; to: string; many: boolean; recursive: boolean }
export interface Catalog { sources: CatalogSource[]; relations: CatalogRelation[]; functions: string[]; operators: string[]; buckets: string[] }

export type QValue = string | number | boolean | null | Array<string | number | boolean> | { param: string } | { now: string };
export interface QCond { field: string; op: string; value?: QValue }
export interface QGroup { op: 'and' | 'or'; items: Array<QCond | QGroup> }
export interface AnalyticsQuery {
  from: string;
  joins?: Array<{ rel: string; as?: string; from?: string; type?: 'left' | 'inner' }>;
  where?: QGroup;
  select?: Array<{ field: string; as?: string }>;
  groupBy?: Array<{ field: string; bucket?: string; as?: string }>;
  metrics?: Array<{ fn: string; field?: string; as?: string }>;
  having?: QGroup;
  sort?: Array<{ field: string; dir?: 'asc' | 'desc' }>;
  limit?: number; offset?: number;
}
export interface ParamSpec { name: string; type: 'string' | 'number' | 'boolean' | 'date' | 'list'; required?: boolean; default?: unknown; label?: string }
export interface AnalyticsApiDef {
  id?: string; slug: string; name: string; description?: string; query: AnalyticsQuery; params: ParamSpec[];
  cacheSeconds: number; status: 'draft' | 'published'; visibility: 'workspace' | 'private'; requires?: string; allowFlows?: boolean;
  builtIn?: boolean; ownerId?: string; version?: number; updatedAt?: string; updatedBy?: string;
}
export interface AnalyticsResult {
  mode: 'rows' | 'aggregate'; columns: Array<{ key: string; label: string; type: string }>; rows: Array<Record<string, unknown>>;
  meta: { tookMs: number; scanned: number; returned: number; total: number | null; truncated: boolean; truncatedReason?: string; cached?: boolean };
}

@Injectable({ providedIn: 'root' })
export class AnalyticsBuilderApiService extends ApiBase {
  private b = `${this.base}/analytics-builder`;
  catalog(): Observable<Catalog> { return this.http.get<Catalog>(`${this.b}/catalog`); }
  preview(query: AnalyticsQuery, params?: Record<string, unknown>): Observable<AnalyticsResult> { return this.http.post<AnalyticsResult>(`${this.b}/preview`, { query, params }); }
  list(): Observable<AnalyticsApiDef[]> { return this.items(this.http.get<{ items: AnalyticsApiDef[] }>(`${this.b}/apis`)); }
  get(id: string): Observable<AnalyticsApiDef> { return this.http.get<AnalyticsApiDef>(`${this.b}/apis/${id}`); }
  create(def: Partial<AnalyticsApiDef>): Observable<AnalyticsApiDef> { return this.http.post<AnalyticsApiDef>(`${this.b}/apis`, def); }
  update(id: string, def: Partial<AnalyticsApiDef>): Observable<AnalyticsApiDef> { return this.http.put<AnalyticsApiDef>(`${this.b}/apis/${id}`, def); }
  remove(id: string): Observable<void> { return this.http.delete<void>(`${this.b}/apis/${id}`); }
}
