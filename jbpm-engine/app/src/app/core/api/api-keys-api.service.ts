import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiBase } from './api-base';

export interface ApiKeyRow {
  id: string; name: string; prefix: string; permissions: string[]; createdBy: string; createdAt: string;
  expiresAt?: string; revokedAt?: string; revokedBy?: string; lastUsedAt?: string;
}
export interface CreatedApiKey extends ApiKeyRow { key: string }

/** Workspace API keys: credentials for server-to-server calls, used next to access tokens. The secret is only in the create response. */
@Injectable({ providedIn: 'root' })
export class ApiKeysApiService extends ApiBase {
  list(): Observable<{ items: ApiKeyRow[] }> { return this.http.get<{ items: ApiKeyRow[] }>(`${this.base}/api-keys`); }
  create(body: { name: string; permissions: string[]; expiresInDays?: number }): Observable<CreatedApiKey> { return this.http.post<CreatedApiKey>(`${this.base}/api-keys`, body); }
  revoke(id: string): Observable<void> { return this.http.delete<void>(`${this.base}/api-keys/${id}`); }
}
