// Auth routes. Mounted in app.ts BEFORE the requireAuth middleware, so /login stays reachable without
// a token; /me needs one, so it applies requireAuth itself rather than moving into the protected router
// (it's conceptually "auth", not a workflow/task/etc. resource).
import { Router } from 'express';
import type { Request } from 'express';
import { asyncHandler } from '../infra/errors.ts';
import type { AppContext } from '../context.ts';
import { IamService } from '../modules/iam/service.ts';
import { AccountService } from '../modules/iam/accounts.ts';
import { requireAuth } from './auth-middleware.ts';
import type { JwtClaims } from '../infra/auth.ts';
import { rateLimit } from './rate-limit.ts';
import { config } from '../infra/config.ts';
import { makeContext } from '../context.ts';
import { logger } from '../infra/logger.ts';
import { oidc, openTx, readCookie, sealTx, TX_COOKIE, TX_COOKIE_PATH } from '../infra/oidc.ts';
import { forbidden, notFound } from '../infra/errors.ts';
import { decryptInTransit } from '../infra/crypto.ts';

const ctxOf = (req: Request): AppContext => (req as any).ctx;
// Accounts live in the default workspace's IAM; a caller-supplied x-tenant-id must never pick where an account is
// created or looked up (register / login / reset), so those flows pin the context.
const accountCtx = (req: Request): AppContext => makeContext({ store: ctxOf(req).store, tenantId: config.defaultTenant });

// per-IP (no authenticated user yet at this route) — slows credential-stuffing/brute-force without
// blocking a legitimate user who mistypes their password a few times in a row.
const loginLimiter = rateLimit({ windowMs: 60_000, max: 10, keyOf: (req) => req.ip || 'anon' });

/** only same-origin relative paths may be used as the post-login destination (no open redirect). */
const safeReturnTo = (v: unknown): string | undefined =>
  typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') && v.length < 512 ? v : undefined;

const txCookie = (value: string, maxAgeSec: number) =>
  `${TX_COOKIE}=${encodeURIComponent(value)}; Path=${TX_COOKIE_PATH}; Max-Age=${maxAgeSec}; HttpOnly; SameSite=Lax${config.oidc.redirectUri.startsWith('https:') ? '; Secure' : ''}`;

export function buildAuthRoutes(): Router {
  const r = Router();

  // What sign-in methods are available — the SPA renders its login screen from this.
  r.get('/config', (_req, res) => {
    const local = config.localLogin;
    res.json({
      appName: config.appName,
      sso: oidc.isConfigured(),
      localLogin: local,
      // the built-in account flows only exist alongside local login
      registration: local && config.auth.registration,
      registrationMethod: config.auth.registrationMethod,
      tempPasswordHours: config.auth.tempPasswordHours,
      otpLogin: local && config.auth.otpLogin,
      tosUrl: config.auth.tosUrl ?? null,
      forgotPassword: local && config.auth.forgotPassword,
      emailVerification: local && config.auth.emailVerification,
      passwordMinLength: config.auth.passwordMinLength,
      ssoLoginUrl: oidc.isConfigured() ? '/api/auth/oidc/login' : null,
    });
  });

  // --- built-in account lifecycle (flag-driven; see modules/iam/accounts.ts). Anti-enumeration: forgot-password and
  // resend-verification answer 202 whether or not the address exists. ---
  const sensitiveLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, keyOf: (req) => req.ip || 'anon' });
  const accounts = (req: Request) => new AccountService(accountCtx(req));
  const needLocal = (on: boolean) => { if (!config.localLogin || !on) throw notFound('This feature'); };

  r.post('/register', sensitiveLimiter, asyncHandler(async (req, res) => {
    needLocal(config.auth.registration);
    // temp-password registration answers 202 (uniform, whether or not the address is new); password registration 201
    res.status(config.auth.registrationMethod === 'temp_password' ? 202 : 201).json(await accounts(req).register(req.body || {}));
  }));
  // Step 2 of temp-password onboarding: the person signed in with the emailed temporary password and now chooses their own.
  r.post('/set-password', sensitiveLimiter, asyncHandler(async (req, res) => {
    needLocal(true);
    res.json(await accounts(req).setInitialPassword(String(req.body?.setupToken || ''), String(req.body?.password || '')));
  }));
  // Passwordless sign-in with an emailed 6-digit code (AUTH_OTP_LOGIN)
  const otpLimiter = rateLimit({ windowMs: 15 * 60_000, max: 20, keyOf: (req) => req.ip || 'anon' });
  r.post('/otp/request', otpLimiter, asyncHandler(async (req, res) => {
    needLocal(config.auth.otpLogin);
    await accounts(req).requestOtp(String(req.body?.email || '')); res.status(202).json({ ok: true });
  }));
  r.post('/otp/verify', otpLimiter, asyncHandler(async (req, res) => {
    needLocal(config.auth.otpLogin);
    res.json(await accounts(req).verifyOtp(String(req.body?.email || ''), String(req.body?.code || '')));
  }));
  r.post('/verify-email', sensitiveLimiter, asyncHandler(async (req, res) => {
    needLocal(config.auth.emailVerification);
    await accounts(req).verifyEmail(req.body?.token); res.status(204).end();
  }));
  r.post('/resend-verification', sensitiveLimiter, asyncHandler(async (req, res) => {
    needLocal(config.auth.emailVerification);
    await accounts(req).resendVerification(String(req.body?.email || '')); res.status(202).json({ ok: true });
  }));
  r.post('/forgot-password', sensitiveLimiter, asyncHandler(async (req, res) => {
    needLocal(config.auth.forgotPassword);
    await accounts(req).forgotPassword(String(req.body?.email || '')); res.status(202).json({ ok: true });
  }));
  r.post('/reset-password/check', sensitiveLimiter, asyncHandler(async (req, res) => {
    needLocal(config.auth.forgotPassword);
    res.json({ valid: await accounts(req).checkResetToken(String(req.body?.token || '')) });
  }));
  r.post('/reset-password', sensitiveLimiter, asyncHandler(async (req, res) => {
    needLocal(config.auth.forgotPassword);
    await accounts(req).resetPassword(String(req.body?.token || ''), String(req.body?.password || '')); res.status(204).end();
  }));

  // --- Single sign-on (Identity Server): authorization code + PKCE; the SPA never sees the client secret ---
  // GET /api/auth/oidc/login     → redirect to the IdP (state/nonce/PKCE verifier kept in a signed HttpOnly cookie)
  // GET /api/auth/oidc/callback  → registered redirect URI; exchanges the code, then sends the browser to the SPA
  //                                with the tokens in the URL FRAGMENT (never the query string: logs/Referer)
  // GET /api/auth/oidc/logout    → ends the IdP session (RP-initiated logout), returns to the SPA
  r.get('/oidc/login', loginLimiter, asyncHandler(async (req, res) => {
    if (!oidc.isConfigured()) throw notFound('Single sign-on');
    try {
      const { url, tx } = await oidc.authorizationRequest(safeReturnTo(req.query.redirect));
      res.append('Set-Cookie', txCookie(sealTx(tx), 600));
      res.redirect(url);
    } catch (e) {
      logger.error('OIDC login could not start', { err: (e as Error).message });
      res.status(503).json({ error: { code: 'SSO_UNAVAILABLE', message: 'The identity provider could not be reached. Please try again shortly.' } });
    }
  }));

  r.get('/oidc/callback', loginLimiter, asyncHandler(async (req, res) => {
    if (!oidc.isConfigured()) throw notFound('Single sign-on');
    const back = (params: Record<string, string>) => res.redirect(`${config.dashboardUrl}/auth/callback#${new URLSearchParams(params).toString()}`);
    const tx = openTx(readCookie(req.header('cookie'), TX_COOKIE));
    res.append('Set-Cookie', txCookie('', 0));          // single use, whatever the outcome
    if (!tx) { logger.warn('OIDC callback without a valid login transaction'); return back({ error: 'Session expired. Please try logging in again.' }); }
    if (typeof req.query.error === 'string') { logger.warn('OIDC callback reported an error', { error: req.query.error.slice(0, 80) }); return back({ error: 'Sign-in was cancelled or denied.' }); }
    try {
      const t = await oidc.handleCallback(req.query as Record<string, unknown>, tx);
      const frag: Record<string, string> = {};
      if (t.access_token) frag.access_token = t.access_token;
      if (t.id_token) frag.id_token = t.id_token;
      if (t.expires_in) frag.expires_in = String(t.expires_in);
      if (tx.r) frag.return_to = tx.r;
      back(frag);
    } catch (e) {
      const msg = (e as Error).message || '';
      logger.warn('OIDC callback failed', { reason: msg.slice(0, 200) });
      back({ error: msg.includes('invalid_grant') ? 'Authorization code expired or already used. Please try again.'
        : msg.includes('invalid_client') ? 'Client configuration error. Please contact support.'
        : msg.includes('state') || msg.includes('nonce') ? 'Session expired. Please try logging in again.'
        : 'Authentication failed' });
    }
  }));

  r.get('/oidc/logout', asyncHandler(async (req, res) => {
    const hint = typeof req.query.id_token_hint === 'string' ? req.query.id_token_hint : undefined;
    res.redirect((oidc.isConfigured() ? await oidc.logoutUrl(hint) : undefined) ?? config.dashboardUrl);
  }));

  r.post('/login', loginLimiter, asyncHandler(async (req, res) => {
    if (!config.localLogin) throw notFound('Local login');
    const { username, password } = req.body || {};
    const decryptedPassword = decryptInTransit(password);
    res.json(await new IamService(accountCtx(req)).login(String(username || ''), String(decryptedPassword || '')));
  }));
  // "what can I actually do" — lets the frontend resolve real permissions (including custom roles
  // created later via the admin UI) instead of hardcoding a mirror of DEFAULT_ROLES.
  r.get('/me', requireAuth, asyncHandler(async (req, res) => {
    const claims = (req as any).user as JwtClaims;
    const permissions = await new IamService(ctxOf(req)).permissionsFor(claims.roles);
    res.json({ user: { id: claims.sub, username: claims.username, roles: claims.roles, groups: claims.groups, email: claims.email, name: claims.name, source: claims.source ?? 'local' }, permissions });
  }));
  // self-service — any authenticated user can change their OWN password (gated by knowing the current
  // one), independent of the admin-only POST /users/:id/password.
  r.post('/me/password', requireAuth, asyncHandler(async (req, res) => {
    const claims = (req as any).user as JwtClaims;
    if (claims.source === 'oidc') throw forbidden('Your password is managed by the identity provider');
    const currentPassword = decryptInTransit(req.body?.currentPassword) ?? '';
    const newPassword = decryptInTransit(req.body?.newPassword) ?? '';
    await new IamService(ctxOf(req)).changeOwnPassword(claims.sub, currentPassword, newPassword);
    res.status(204).end();
  }));
  return r;
}
