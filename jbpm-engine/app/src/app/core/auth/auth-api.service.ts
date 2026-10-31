import { Injectable, inject } from '@angular/core';
import { Observable, from, switchMap } from 'rxjs';
import { ApiBase } from '../api/api-base';
import { CryptoService } from '../crypto/crypto.service';
import type { AuthConfig, LoginResponse, MeResponse } from './auth.models';

@Injectable({ providedIn: 'root' })
export class AuthApiService extends ApiBase {
  private crypto = inject(CryptoService);

  login(username: string, password: string): Observable<LoginResponse> {
    return from(this.crypto.encryptSecret(password)).pipe(
      switchMap((encryptedPassword) =>
        this.http.post<LoginResponse>(`${this.base}/auth/login`, { username, password: encryptedPassword })
      )
    );
  }
  config(): Observable<AuthConfig> {
    return this.http.get<AuthConfig>(`${this.base}/auth/config`);
  }
  /** temp-password method: no password is sent — a temporary one is emailed. password method: the chosen password is sent. */
  register(body: { email: string; name?: string; password?: string; tosAccepted?: boolean }): Observable<{ method?: string; expiresInHours?: number; verificationRequired?: boolean; email: string }> {
    return this.http.post<{ method?: string; expiresInHours?: number; verificationRequired?: boolean; email: string }>(`${this.base}/auth/register`, body);
  }
  setPassword(setupToken: string, password: string): Observable<LoginResponse> { return this.http.post<LoginResponse>(`${this.base}/auth/set-password`, { setupToken, password }); }
  otpRequest(email: string): Observable<unknown> { return this.http.post(`${this.base}/auth/otp/request`, { email }); }
  otpVerify(email: string, code: string): Observable<LoginResponse> { return this.http.post<LoginResponse>(`${this.base}/auth/otp/verify`, { email, code }); }
  verifyEmail(token: string): Observable<void> { return this.http.post<void>(`${this.base}/auth/verify-email`, { token }); }
  resendVerification(email: string): Observable<unknown> { return this.http.post(`${this.base}/auth/resend-verification`, { email }); }
  forgotPassword(email: string): Observable<unknown> { return this.http.post(`${this.base}/auth/forgot-password`, { email }); }
  checkResetToken(token: string): Observable<{ valid: boolean }> { return this.http.post<{ valid: boolean }>(`${this.base}/auth/reset-password/check`, { token }); }
  resetPassword(token: string, password: string): Observable<void> { return this.http.post<void>(`${this.base}/auth/reset-password`, { token, password }); }
  me(): Observable<MeResponse> {
    return this.http.get<MeResponse>(`${this.base}/auth/me`);
  }

  changePassword(currentPassword: string, newPassword: string): Observable<void> {
    return from(
      Promise.all([
        this.crypto.encryptSecret(currentPassword),
        this.crypto.encryptSecret(newPassword),
      ])
    ).pipe(
      switchMap(([encCurrent, encNext]) =>
        this.http.post<void>(`${this.base}/auth/me/password`, {
          currentPassword: encCurrent,
          newPassword: encNext,
        })
      )
    );
  }
}
