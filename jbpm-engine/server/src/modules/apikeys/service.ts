// Workspace API keys. A key is `ork_<id>.<secret>`; the id finds the row, only SHA-256(secret) is stored (the secret is 256 random bits, so a fast hash is
// enough), and it is compared in constant time. A key belongs to one workspace, carries an explicit list of permissions that is a subset of what its creator
// may do and never includes admin rights or "everything", may expire, and can be revoked at once. It is accepted next to access tokens (X-API-Key header, or
// Authorization: ApiKey <key>, or a Bearer token that starts with ork_).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { AppContext } from '../../context.ts';
import { Collections, type ApiKey } from '../../domain.ts';
import type { Store } from '../../store/repository.ts';
import { authRequired, notFound, validation } from '../../infra/errors.ts';
import { permissionGrants } from '../../infra/auth.ts';

export const KEY_PREFIX = 'ork_';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const LAST_USED_EVERY_MS = 60_000;
/** what a key can never hold, whoever creates it: managing users, roles, keys or the workspace, and the all-powerful permission */
const FORBIDDEN = (p: string) => p === '*' || p.startsWith('admin:') || p === 'team:manage' || p.endsWith(':*') && (p.startsWith('admin') || p.startsWith('team'));
export type PublicApiKey = Omit<ApiKey, 'hash'>;
const pub = (k: ApiKey): PublicApiKey => { const { hash: _h, ...rest } = k; return rest; };

/** the raw key from a request, whichever way it was sent; undefined when the request carries none */
export function apiKeyFromRequest(req: Request): string | undefined {
  const x = req.header('x-api-key'); if (x) return x.trim();
  const a = req.header('authorization') || '';
  if (/^ApiKey\s+/i.test(a)) return a.replace(/^ApiKey\s+/i, '').trim();
  if (a.startsWith('Bearer ' + KEY_PREFIX)) return a.slice(7).trim();
  return undefined;
}

/** Resolves a raw key to its row, or throws 401. Runs before the workspace is known, so it reads the key by id. */
export async function authenticateApiKey(store: Store, raw: string, now: string): Promise<ApiKey> {
  const m = /^ork_([A-Za-z0-9]+)\.([A-Za-z0-9_-]{20,})$/.exec(raw);
  const row = m ? await store.repo<ApiKey>(Collections.apiKeys).get(m[1]!) : undefined;
  const ok = !!row && (() => { const a = Buffer.from(sha(m![2]!)), b = Buffer.from(row.hash); return a.length === b.length && timingSafeEqual(a, b); })();
  if (!row || !ok) throw authRequired('invalid API key');
  if (row.revokedAt) throw authRequired('this API key has been revoked');
  if (row.expiresAt && row.expiresAt <= now) throw authRequired('this API key has expired');
  // remember when it was last used, at most once a minute so a busy integration does not write on every call
  if (!row.lastUsedAt || Date.parse(now) - Date.parse(row.lastUsedAt) > LAST_USED_EVERY_MS) { row.lastUsedAt = now; await store.repo<ApiKey>(Collections.apiKeys).put(row); }
  return row;
}

export class ApiKeyService {
  constructor(private ctx: AppContext) {}
  private repo() { return this.ctx.store.repo<ApiKey>(Collections.apiKeys); }

  async list(): Promise<PublicApiKey[]> {
    return (await this.repo().query((k) => k.tenantId === this.ctx.tenantId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(pub);
  }

  /** `creatorPermissions`: what the person creating it holds. The secret is returned here and never again. */
  async create(input: { name?: string; permissions?: string[]; expiresAt?: string | null; expiresInDays?: number }, creatorPermissions: string[], actor: string): Promise<{ key: string; record: PublicApiKey }> {
    if (!this.ctx.tenantId || this.ctx.tenantId === 'all') throw validation('Select a workspace first: an API key belongs to one workspace');
    const name = (input.name ?? '').trim();
    if (!name) throw validation('a key needs a name (what uses it)');
    if (name.length > 80) throw validation('the name is too long (max 80 characters)');
    const perms = [...new Set((Array.isArray(input.permissions) ? input.permissions : []).map((p) => String(p).trim()).filter(Boolean))];
    if (!perms.length) throw validation('choose at least one permission for the key');
    for (const p of perms) {
      if (!/^[a-z][a-z0-9_-]*:[a-z0-9_*-]+$/i.test(p)) throw validation(`"${p}" is not a permission`);
      if (FORBIDDEN(p)) throw validation(`"${p}" cannot be given to an API key (keys cannot manage users, roles, keys or the workspace)`);
      if (!permissionGrants(creatorPermissions, p)) throw validation(`you cannot give a key "${p}": you do not hold it yourself`);
    }
    let expiresAt: string | undefined;
    if (input.expiresInDays != null) { const d = Number(input.expiresInDays); if (!Number.isInteger(d) || d < 1 || d > 3650) throw validation('expiresInDays must be between 1 and 3650'); expiresAt = new Date(Date.parse(this.ctx.clock()) + d * 86400_000).toISOString(); }
    else if (input.expiresAt) { if (Number.isNaN(Date.parse(input.expiresAt))) throw validation('expiresAt must be a date and time'); expiresAt = new Date(input.expiresAt).toISOString(); if (expiresAt <= this.ctx.clock()) throw validation('expiresAt must be in the future'); }
    const id = this.ctx.newId();
    const secret = randomBytes(32).toString('base64url');
    const row: ApiKey = { id, tenantId: this.ctx.tenantId, name, prefix: secret.slice(0, 6), hash: sha(secret), permissions: perms, createdBy: actor, createdAt: this.ctx.clock(), ...(expiresAt ? { expiresAt } : {}) };
    await this.repo().put(row);
    await this.ctx.audit({ actor, kind: 'api-key.created', data: { id, name, permissions: perms, expiresAt } });
    return { key: `${KEY_PREFIX}${id}.${secret}`, record: pub(row) };
  }

  async revoke(id: string, actor: string): Promise<void> {
    const k = await this.repo().get(id);
    if (!k || k.tenantId !== this.ctx.tenantId) throw notFound('API key');
    if (k.revokedAt) return;
    k.revokedAt = this.ctx.clock(); k.revokedBy = actor;
    await this.repo().put(k);
    await this.ctx.audit({ actor, kind: 'api-key.revoked', data: { id, name: k.name } });
  }
}
