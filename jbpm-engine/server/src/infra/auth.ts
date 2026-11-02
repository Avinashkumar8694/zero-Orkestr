// Password hashing (Node's own scrypt — no extra dependency for this half) + JWT sign/verify. JWTs
// use the well-audited `jsonwebtoken` library rather than hand-rolled token code: this is exactly the
// kind of code where a subtle bug (algorithm confusion, timing leaks) is a security bug, not merely a
// correctness one, so a vetted library is the safer choice over saving one dependency.
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { config } from './config.ts';
import { oidc } from './oidc.ts';

const scrypt = promisify(scryptCb) as (password: string, salt: string, keylen: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;
  const derived = await scrypt(password, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export interface JwtClaims {
  sub: string; username: string; roles: string[]; groups: string[];
  /** 'local' = signed by this server (POST /auth/login); 'oidc' = issued by the Identity Server. Absent on legacy local tokens. */
  source?: 'local' | 'oidc' | 'apikey';
  email?: string;
  /** only a verified email may be used to claim a pre-created membership. */
  emailVerified?: boolean;
  name?: string;
}

export function signToken(claims: JwtClaims): string {
  return jwt.sign({ ...claims, source: 'local' }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '12h' });
}

/** Throws (jsonwebtoken's own JsonWebTokenError/TokenExpiredError) on a missing/invalid/expired token —
 *  verifies LOCAL (HS256) tokens only. Bearer auth goes through verifyBearer, which also accepts OIDC tokens. */
export function verifyToken(token: string): JwtClaims {
  return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as JwtClaims;
}

/** The single place a bearer token is accepted as authentic. HS256 → a token this server signed (only
 *  while local login is enabled); anything else → must verify against the Identity Server's JWKS
 *  (issuer/audience/expiry enforced). Throws on failure — fail closed, never decode-and-trust. */
export async function verifyBearer(token: string): Promise<JwtClaims> {
  const header = jwt.decode(token, { complete: true })?.header;
  if (!header) throw new Error('malformed token');
  if (header.alg === 'HS256') {
    if (!config.localLogin) throw new Error('local login is disabled');
    return { ...verifyToken(token), source: 'local' };
  }
  if (!oidc.isConfigured()) throw new Error('single sign-on is not configured');
  const c = await oidc.verify(token);
  if (!c) throw new Error('unverifiable token');
  const email = typeof c.email === 'string' ? c.email.trim().toLowerCase() : undefined;
  return {
    sub: c.sub,
    username: email || c.sub,
    roles: [],      // authorization comes from workspace membership, not IdP role claims
    groups: [],
    source: 'oidc',
    email,
    emailVerified: c.email_verified === true,
    name: typeof c.name === 'string' ? c.name : undefined,
  };
}

/** action strings a role grants: exact match, '*' (everything), or a 'ns:*' namespace wildcard. */
export function permissionGrants(permissions: string[], action: string): boolean {
  return permissions.some((p) => p === '*' || p === action || (p.endsWith(':*') && action.startsWith(p.slice(0, -1))));
}
