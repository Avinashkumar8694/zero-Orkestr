// Replicas that boot at the same moment on a brand-new database must all come up (the schema is created once, under a lock).
import 'reflect-metadata';
import { test, after } from 'node:test';
import assert from 'node:assert';
import pg from 'pg';
import { PgStore } from '../../src/store/pg-store.ts';
import { config } from '../../src/infra/config.ts';

after(() => setTimeout(() => process.exit(0), 50).unref());

test('SYNC-1 eight replicas initialising together on a fresh database all start, with one schema', async () => {
  const admin = new pg.Client({ connectionString: config.pgUrl!.replace(/\/[^/?]+(\?.*)?$/, '/postgres$1') });
  await admin.connect();
  const db = `sync_${Date.now()}`;
  await admin.query(`CREATE DATABASE ${db}`);
  const url = config.pgUrl!.replace(/\/[^/?]+(\?.*)?$/, `/${db}$1`);
  const stores = Array.from({ length: 8 }, () => new PgStore(url));
  try {
    const results = await Promise.allSettled(stores.map((s, i) => s.repo<any>('probe').put({ id: `r${i}`, tenantId: 't' })));
    assert.deepStrictEqual(results.filter((r) => r.status === 'rejected').map((r: any) => r.reason?.message), [], 'no replica failed to start');
    const rows = await stores[0]!.repo<any>('probe').list();
    assert.strictEqual(rows.length, 8, 'every replica wrote through the shared schema');
  } finally {
    await Promise.all(stores.map((s) => s.close().catch(() => {})));
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    await admin.end();
  }
});
