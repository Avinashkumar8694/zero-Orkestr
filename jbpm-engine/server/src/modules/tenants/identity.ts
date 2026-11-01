// Who a verified caller is, in terms of workspace membership — shared by the auth middleware and the
// tenant routes so the rules live in exactly one place (they used to be copy-pasted per call site).
//
// Two kinds of caller:
//  - 'local': a user of this server's own IAM (POST /auth/login). Legacy matching is kept: a membership
//    belongs to them by user id, username, or an email equal to the username.
//  - 'oidc': a user signed in through the Identity Server. Their ONLY stable key is the `sub`; an email
//    never matches a membership on its own. A membership created ahead of time (signup, invitation,
//    platform-admin bootstrap) carries a PLACEHOLDER userId (the email, or `pending:<email>`) and is
//    BOUND to the real `sub` the first time that email shows up VERIFIED (email_verified=true) — the same
//    claim-by-verified-email rule zero-payment-ms uses. An already-bound membership is never re-bound.
import type { Store } from '../../store/repository.ts';
import { Collections, type TenantMember } from '../../domain.ts';
import type { JwtClaims } from '../../infra/auth.ts';
import { config } from '../../infra/config.ts';
import { logger } from '../../infra/logger.ts';

export type Identity = Pick<JwtClaims, 'sub' | 'username'> & Partial<Pick<JwtClaims, 'roles' | 'email' | 'emailVerified' | 'source'>>;

const lower = (s?: string | null) => (s || '').trim().toLowerCase();

export function isPlaceholderUserId(m: Pick<TenantMember, 'userId' | 'email'>): boolean {
  return !m.userId || m.userId.startsWith('pending:') || (!!m.email && lower(m.userId) === lower(m.email));
}

export function memberMatches(m: TenantMember, id: Identity): boolean {
  if (m.userId === id.sub) return true;
  if (id.source === 'oidc') return false;
  // Local account: by user id above; by username/email only when that is safe — a seat whose userId is just an
  // email placeholder (signup / invitation) is NOT given to whoever registers that email: the mailbox must be verified.
  if (isPlaceholderUserId(m) && id.emailVerified !== true) return false;
  const names = [id.username, id.sub, id.email].map(lower).filter(Boolean);
  return names.includes(lower(m.userId)) || (!!m.email && names.includes(lower(m.email)));
}

const recentlyClaimed = new Map<string, number>();
const CLAIM_INTERVAL_MS = 30_000;

/** Bind any placeholder memberships for this verified OIDC email to the caller's `sub`. No-op for other callers. */
export async function claimMemberships(store: Store, id: Identity): Promise<void> {
  if (id.source !== 'oidc' || !id.email || id.emailVerified !== true) return;
  const now = Date.now();
  if ((recentlyClaimed.get(id.sub) ?? 0) > now - CLAIM_INTERVAL_MS) return;
  recentlyClaimed.set(id.sub, now);
  if (recentlyClaimed.size > 5000) recentlyClaimed.clear();

  const repo = store.repo<TenantMember>(Collections.tenantMembers);
  const email = lower(id.email);
  const claimable = await repo.query((m) => lower(m.email) === email && m.status !== 'suspended' && m.userId !== id.sub && isPlaceholderUserId(m) && !(m.invitationExpiresAt && m.invitationExpiresAt < new Date().toISOString()));
  for (const m of claimable) {
    m.userId = id.sub;
    if (m.status === 'invited') { m.status = 'active'; m.invitationTokenHash = null; m.invitationExpiresAt = null; }
    m.lastActiveAt = new Date().toISOString();
    await repo.put(m);
    logger.info('membership bound to verified identity', { tenantId: m.tenantId, memberId: m.id, userId: id.sub });
  }
}

export async function membershipsOf(store: Store, id: Identity): Promise<TenantMember[]> {
  await claimMemberships(store, id);
  return store.repo<TenantMember>(Collections.tenantMembers).query((m) => memberMatches(m, id));
}

/** The single platform administrator is config.platformAdminEmail — nobody else is one, whatever their role,
 *  membership or local-IAM role says. An OIDC caller counts when that email is VERIFIED on their token. */
/** System administrators flagged in the database (`system_admins.enabled` on Postgres, the `systemAdmins` collection elsewhere), cached
 *  for a few seconds so ticking the box takes effect without a restart or a lookup per request. The configured e-mail is always one. */
const adminCache = new WeakMap<object, { at: number; emails: Set<string> }>();
export const resetSystemAdminCache = (store?: Store) => { if (store) adminCache.delete(store); };
async function flaggedAdmins(store: Store): Promise<Set<string>> {
  const hit = adminCache.get(store);
  if (hit && Date.now() - hit.at < 5000) return hit.emails;
  let emails: string[];
  try {
    emails = store.systemAdminEmails ? await store.systemAdminEmails()
      : (await store.repo<{ id: string; enabled?: boolean }>('systemAdmins').list()).filter((r) => r.enabled !== false).map((r) => lower(r.id));
  } catch { emails = []; }
  const set = new Set(emails.map(lower));
  adminCache.set(store, { at: Date.now(), emails: set });
  return set;
}

export async function isPlatformAdmin(store: Store, id: Identity, memberships?: TenantMember[]): Promise<boolean> {
  if (id.source === 'oidc' && id.emailVerified === true) {
    const email = lower(id.email);
    if (email === config.platformAdminEmail || (await flaggedAdmins(store)).has(email)) return true;
  }
  // Local development without SSO: the bootstrap account (a REAL local user — matched by id or username — holding a `system_admin` seat — never an e-mail
  // placeholder seat, so a token merely carrying the platform e-mail does not qualify) may manage the platform. Off in production.
  if (config.platformAdminAllowLocal && id.source !== 'oidc' && id.sub) {
    const seats = memberships ?? await membershipsOf(store, id);
    return seats.some((m) => m.role === 'system_admin' && m.status === 'active' && !isPlaceholderUserId(m) && (m.userId === id.sub || lower(m.userId) === lower(id.username)));
  }
  return false;
}

/** Idempotent start-up bootstrap: the platform admin is always a system_admin member of the default workspace
 *  (bound to their identity on first verified sign-in); a lower role on that seat is corrected. */
export async function ensurePlatformAdmin(store: Store, now: string, newId: () => string): Promise<void> {
  const email = config.platformAdminEmail;
  const repo = store.repo<TenantMember>(Collections.tenantMembers);
  const pgSeed = (store as { seedSystemAdmin?: (e: string, n: string) => Promise<void> }).seedSystemAdmin;
  if (pgSeed) await pgSeed.call(store, email, 'configured platform administrator').catch(() => {});
  const existing = await repo.query((m) => m.tenantId === config.defaultTenant && lower(m.email) === email);
  if (existing.length) {
    for (const m of existing) if (m.role !== 'system_admin' || m.status !== 'active') { m.role = 'system_admin'; m.status = 'active'; m.permissions = ['*']; await repo.put(m); }
    return;
  }
  await repo.put({
    id: newId(), tenantId: config.defaultTenant, userId: `pending:${email}`, email, role: 'system_admin',
    status: 'active', displayName: 'Platform Administrator', permissions: ['*'], joinedAt: now,
  });
  logger.info('platform administrator bootstrapped', { email });
}
