// The `system_admins` table: a real boolean `enabled` column anyone with DB access can flip to grant / revoke system administrator.
import 'reflect-metadata';
import { test, after } from 'node:test';
import assert from 'node:assert';
import { PgStore } from '../../src/store/pg-store.ts';
import { config } from '../../src/infra/config.ts';
import { isPlatformAdmin, resetSystemAdminCache } from '../../src/modules/tenants/identity.ts';

const store = new PgStore(config.pgUrl!);
after(async () => { await store.close(); });
const ds = () => (store as any).ensureDataSource();
const who = (email: string) => ({ sub: `s-${email}`, username: email, email, emailVerified: true, source: 'oidc' as const });

test('SYSADM-1 enabled column grants and revokes system administrator without a restart', async () => {
  const email = `boss${Date.now()}@example.com`;
  assert.strictEqual(await isPlatformAdmin(store, who(email)), false);
  await (await ds()).query('INSERT INTO system_admins (email, enabled) VALUES ($1, true)', [email]);
  resetSystemAdminCache(store);
  assert.strictEqual(await isPlatformAdmin(store, who(email)), true, 'row with enabled = true');
  await (await ds()).query('UPDATE system_admins SET enabled = false WHERE email = $1', [email]);
  resetSystemAdminCache(store);
  assert.strictEqual(await isPlatformAdmin(store, who(email)), false, 'enabled = false');
  await store.seedSystemAdmin(config.platformAdminEmail, 'owner');
  await store.seedSystemAdmin(config.platformAdminEmail, 'again');            // idempotent
  assert.ok((await store.systemAdminEmails()).includes(config.platformAdminEmail));
});
