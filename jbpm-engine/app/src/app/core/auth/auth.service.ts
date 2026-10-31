// Signal-based auth/session state — no NgRx, matching how the rest of the app (e.g. BuilderComponent)
// already holds state. Token is persisted to sessionStorage (survives reload, dies on tab close — the
// right middle ground given the backend issues flat 12h JWTs with no refresh-token rotation: an
// in-memory-only token would log users out on every accidental reload with no way to silently re-auth,
// while localStorage persists indefinitely across restarts for no benefit here).
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap, switchMap, map, of, from } from 'rxjs';
import { AuthApiService } from './auth-api.service';
import { permissionGrants } from './permissions';
import type { AuthUser, JwtClaims, LoginOutcome, LoginResponse } from './auth.models';
import { TenantService } from '../tenant/tenant.service';
import { API_BASE } from '../config';

const STORAGE_KEY = 'jbpm.token';
// the Identity Server's ID token, kept (this tab only) purely as the id_token_hint for single sign-out
const ID_TOKEN_KEY = 'jbpm.idtoken';

const isJwt = (t: string | null | undefined): t is string => !!t && t.split('.').length === 3;

function decodeJwt(token: string): JwtClaims | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as JwtClaims;
  } catch {
    return null;
  }
}

/** The Identity Server sends roles/teams as objects ({ id, name, ... }), local tokens as plain strings: always hand the UI strings. */
function claimNames(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? String((x as any).name ?? (x as any).role ?? (x as any).id ?? '') : ''))
    .filter(Boolean);
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private api = inject(AuthApiService);
  private tenant = inject(TenantService);

  private tokenSig = signal<string | null>(
    (typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STORAGE_KEY) : null) ||
    (typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null)
  );
  private permissionsSig = signal<string[]>([]);

  token = this.tokenSig.asReadonly();
  permissions = this.permissionsSig.asReadonly();

  /** null if no token, or the token is present but expired/unparseable. */
  user = computed<AuthUser | null>(() => {
    const t = this.tokenSig();
    if (!t) return null;
    const claims = decodeJwt(t);
    if (!claims || claims.exp * 1000 <= Date.now()) return null;
    // an Identity Server token has no `username`/`roles`/`groups` — authorization comes from workspace membership
    return {
      id: claims.sub,
      username: claims.username || claims.email || claims.preferred_username || claims.sub,
      roles: claimNames(claims.roles),
      groups: claimNames(claims.groups),
      email: claims.email,
      name: claims.name,
    };
  });
  isAuthenticated = computed(() => this.user() !== null);

  private markReady!: () => void;
  ready: Promise<void> = new Promise((resolve) => { this.markReady = resolve; });

  constructor() {
    if (this.tokenSig() && this.user()) {
      queueMicrotask(() => {
        this.tenant.init(this.user()!.id);
        this.refreshPermissions().subscribe({ next: () => this.markReady(), error: () => this.markReady() });
      });
    } else {
      queueMicrotask(() => {
        this.tenant.init(null);
        this.markReady();
      });
    }
  }

  /** Password sign-in. May answer with the set-password step instead of a session (account still on its temporary password). */
  login(username: string, password: string): Observable<LoginOutcome> {
    return this.api.login(username, password).pipe(switchMap((res) => this.outcome(res)));
  }
  /** Step 2 of temp-password onboarding: choose a real password, get the first session. */
  setInitialPassword(setupToken: string, password: string): Observable<LoginOutcome> {
    return this.api.setPassword(setupToken, password).pipe(switchMap((res) => this.outcome(res)));
  }
  /** Passwordless sign-in with the emailed 6-digit code. */
  verifyOtp(email: string, code: string): Observable<LoginOutcome> {
    return this.api.otpVerify(email, code).pipe(switchMap((res) => this.outcome(res)));
  }
  private outcome(res: LoginResponse): Observable<LoginOutcome> {
    if ('passwordSetupRequired' in res) return of({ kind: 'setup', setupToken: res.setupToken, email: res.user?.email });
    this.tokenSig.set(res.token);
    sessionStorage.setItem(STORAGE_KEY, res.token);
    // Load the person's workspaces BEFORE anything navigates: the route guard decides "no workspace → create one" from
    // this state, and a guard that runs while it is still loading would let a brand-new user into an app they cannot use.
    return from(this.tenant.init(res.user.id)).pipe(
      switchMap(() => this.refreshPermissions()),
      map((user) => ({ kind: 'session', user }) as LoginOutcome),
    );
  }

  /** Finish a single-sign-on login: the server redirected here with the tokens in the URL fragment. Prefers the
   *  access token when it is a JWT (the server verifies it), else the ID token (always a JWT). */
  completeSso(accessToken: string | null, idToken: string | null): Observable<AuthUser> {
    const bearer = isJwt(accessToken) ? accessToken : isJwt(idToken) ? idToken : accessToken;
    if (!bearer) throw new Error('no token in sign-in response');
    this.tokenSig.set(bearer);
    sessionStorage.setItem(STORAGE_KEY, bearer);
    if (idToken) sessionStorage.setItem(ID_TOKEN_KEY, idToken);
    const u = this.user();
    return from(this.tenant.init(u ? u.id : null)).pipe(switchMap(() => this.refreshPermissions()));
  }

  /** Drop the local session only (also what a 401 does). */
  logout(): void {
    this.tokenSig.set(null);
    this.permissionsSig.set([]);
    sessionStorage.removeItem(STORAGE_KEY);
    sessionStorage.removeItem(ID_TOKEN_KEY);
    localStorage.removeItem(STORAGE_KEY);
    this.tenant.reset();
  }

  /** The user clicked "Sign out": drop the session and, for an SSO session, end the identity-server session too. */
  signOut(): void {
    const idToken = sessionStorage.getItem(ID_TOKEN_KEY);
    this.logout();
    if (idToken) {
      window.location.href = `${API_BASE}/auth/oidc/logout?id_token_hint=${encodeURIComponent(idToken)}`;
    }
  }

  hasPermission(action: string): boolean {
    if (this.tenant.can(action)) return true;
    return permissionGrants(this.permissionsSig(), action);
  }

  private refreshPermissions(): Observable<AuthUser> {
    return this.api.me().pipe(tap((res) => this.permissionsSig.set(res.permissions)), map(() => this.user()!));
  }
}
