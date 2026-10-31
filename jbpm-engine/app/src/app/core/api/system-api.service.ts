// System-level surfaces used by the shell and Settings page: the caller's own notifications
// (bell panel) and the global SystemSettings singleton.
import { Injectable, inject } from '@angular/core';
import { Observable, from, switchMap } from 'rxjs';
import { ApiBase } from './api-base';
import { CryptoService } from '../crypto/crypto.service';
import type { AppNotification, SystemSettings } from '../models';

@Injectable({ providedIn: 'root' })
export class SystemApiService extends ApiBase {
  private crypto = inject(CryptoService);

  // --- notifications (always scoped server-side to the caller) ---
  listNotifications(opts?: { unread?: boolean; limit?: number }): Observable<{ items: AppNotification[]; unread: number }> {
    return this.http.get<{ items: AppNotification[]; unread: number }>(`${this.base}/notifications`, { params: this.cleanParams(opts) });
  }
  markNotificationRead(id: string): Observable<AppNotification> { return this.http.post<AppNotification>(`${this.base}/notifications/${id}/read`, {}); }
  markAllNotificationsRead(): Observable<{ marked: number }> { return this.http.post<{ marked: number }>(`${this.base}/notifications/read-all`, {}); }

  // --- system settings (read: any signed-in user; write: admin) ---
  getSystemSettings(): Observable<SystemSettings> { return this.http.get<SystemSettings>(`${this.base}/settings/system`); }

  updateSystemSettings(patch: Partial<SystemSettings>): Observable<SystemSettings> {
    if (patch.smtpPassword && patch.smtpPassword !== '••••••••') {
      return from(this.crypto.encryptSecret(patch.smtpPassword)).pipe(
        switchMap((encSecret) => this.http.put<SystemSettings>(`${this.base}/settings/system`, { ...patch, smtpPassword: encSecret }))
      );
    }
    return this.http.put<SystemSettings>(`${this.base}/settings/system`, patch);
  }
}
