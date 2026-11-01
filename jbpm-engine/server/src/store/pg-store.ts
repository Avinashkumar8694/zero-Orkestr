// Postgres-backed store (TypeORM). Same generic "one JSON document per id" model as FileStore — just
// a single `kv_store` table (collection, id) -> jsonb, instead of a directory of .json files — so it
// stays a genuine drop-in for the Repository<T>/Store interface with zero schema-per-collection setup
// (matching FileStore's own "zero-setup" framing, just with a real DB behind it: durable, safe under
// concurrent writers, shareable across multiple server processes instead of a local directory).
//
// query(pred) fetches every row for the collection and applies the JS predicate in memory, exactly
// like FileStore/MemoryStore do — `pred` is an opaque closure the DB can't introspect, so this is the
// only correct option (not a shortcut); tenant_id is still extracted into a real, indexed column so a
// direct SQL/ops look at the table isn't just an opaque blob.
import { buildFindSql, FIND_INDEXES, type FindSpec } from './find.ts';
import 'reflect-metadata';
import { DataSource, Entity as TypeOrmEntity, PrimaryColumn, Column, Index } from 'typeorm';
import type { Entity as DomainEntity, Repository, Store } from './repository.ts';
import type { TimerJob } from '../domain.ts';
import { config } from '../infra/config.ts';

@TypeOrmEntity({ name: 'kv_store' })
@Index(['collection', 'tenantId'])
class KvRow {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  collection!: string;

  @PrimaryColumn({ type: 'varchar', length: 128 })
  id!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  tenantId!: string | null;

  @Column({ type: 'jsonb' })
  data!: unknown;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  updatedAt!: Date;
}

class PgRepo<T extends DomainEntity> implements Repository<T> {
  constructor(private collection: string, private getDs: () => Promise<DataSource>) {}
  private async orm() { return (await this.getDs()).getRepository(KvRow); }

  async get(id: string): Promise<T | undefined> {
    const row = await (await this.orm()).findOneBy({ collection: this.collection, id });
    return row ? (row.data as T) : undefined;
  }
  async list(): Promise<T[]> {
    const rows = await (await this.orm()).findBy({ collection: this.collection });
    return rows.map((r) => r.data as T);
  }
  async query(pred: (t: T) => boolean): Promise<T[]> {
    return (await this.list()).filter(pred);
  }
  async put(entity: T): Promise<T> {
    await (await this.orm()).upsert(
      { collection: this.collection, id: entity.id, tenantId: entity.tenantId ?? null, data: entity, updatedAt: new Date() },
      ['collection', 'id'],
    );
    return entity;
  }
  async delete(id: string): Promise<boolean> {
    const res = await (await this.orm()).delete({ collection: this.collection, id });
    return !!res.affected;
  }
}

export class PgStore implements Store {
  private ds?: DataSource;
  private dsPromise?: Promise<DataSource>;
  private repos = new Map<string, PgRepo<any>>();
  constructor(
    private url: string,
    private poolOptions?: { max?: number; idleTimeoutMillis?: number; connectionTimeoutMillis?: number },
  ) {}

  /** Lazily connects on first actual use (same idiom as FileRepo's own ensureLoaded()) — constructing
   *  a PgStore never itself requires an event loop tick or a reachable database. */
  private ensureDataSource(): Promise<DataSource> {
    if (this.ds) return Promise.resolve(this.ds);
    if (!this.dsPromise) {
      this.dsPromise = new DataSource({
        type: 'postgres',
        url: this.url,
        entities: [KvRow],
        // One trivial, schema-less table — safe to auto-create/reconcile; a real multi-table relational
        // rollout would want real migrations, but there's nothing here for synchronize to drift on.
        synchronize: true,
        logging: false,
        extra: {
          max: this.poolOptions?.max ?? config.pgPoolMax,
          idleTimeoutMillis: this.poolOptions?.idleTimeoutMillis ?? config.pgPoolIdleTimeoutMs,
          connectionTimeoutMillis: this.poolOptions?.connectionTimeoutMillis ?? config.pgPoolConnectionTimeoutMs,
        },
      }).initialize().then((ds) => (this.ds = ds));
    }
    return this.dsPromise;
  }

  /** Attempts to acquire a PostgreSQL session-level advisory lock (non-blocking). Returns true if acquired. */
  async tryAdvisoryLock(key: number): Promise<boolean> {
    try {
      const ds = await this.ensureDataSource();
      const rows = await ds.query('SELECT pg_try_advisory_lock($1) AS acquired', [key]);
      return Boolean(rows && rows[0]?.acquired);
    } catch {
      return false;
    }
  }

  /** Releases a previously acquired PostgreSQL session-level advisory lock. */
  async unlockAdvisoryLock(key: number): Promise<boolean> {
    try {
      const ds = await this.ensureDataSource();
      const rows = await ds.query('SELECT pg_advisory_unlock($1) AS unlocked', [key]);
      return Boolean(rows && rows[0]?.unlocked);
    } catch {
      return false;
    }
  }

  /** Atomically claims up to `limit` due timers using Postgres FOR UPDATE SKIP LOCKED.
   *  Allows multiple active-active replicas to concurrently process distinct batches of due timers
   *  in parallel without duplicate executions, coarse global locks, or manual role partitioning. */
  async claimDueTimers(tenantId: string, nowIso: string, limit: number): Promise<TimerJob[]> {
    const ds = await this.ensureDataSource();
    const sql = `
      WITH due_jobs AS (
        SELECT id FROM kv_store
        WHERE collection = 'timers'
          AND ($1::text IS NULL OR $1 = '' OR $1 = '*' OR "tenantId" = $1)
          AND (data->>'status') = 'scheduled'
          AND (data->>'dueAt') <= $2
        ORDER BY (data->>'dueAt') ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      )
      UPDATE kv_store
      SET data = jsonb_set(
            jsonb_set(data, '{status}', '"fired"'),
            '{fired}',
            to_jsonb(COALESCE((data->>'fired')::int, 0) + 1)
          ),
          "updatedAt" = NOW()
      WHERE collection = 'timers' AND id IN (SELECT id FROM due_jobs)
      RETURNING data;
    `;
    const res = await ds.query(sql, [tenantId, nowIso, limit]);
    const rows: Array<{ data: unknown }> = Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : [];
    return rows.map((r) => r.data as TimerJob);
  }

  private indexed = false;
  /** Indexed lookup (see store/find.ts). The indexes are created once, idempotently; failing to create them (privileges) only costs speed. */
  async findBy(collection: string, tenantId: string, spec: FindSpec): Promise<any[]> {
    const ds = await this.ensureDataSource();
    if (!this.indexed) { this.indexed = true; for (const sql of FIND_INDEXES) await ds.query(sql).catch(() => undefined); }
    const { sql, params } = buildFindSql(collection, tenantId, spec);
    const res = await ds.query(sql, params);
    const rows: Array<{ data: unknown }> = Array.isArray(res) ? (Array.isArray(res[0]) ? res[0] : res) : [];
    return rows.map((r) => r.data);
  }

  repo<T extends DomainEntity>(collection: string): Repository<T> {
    let r = this.repos.get(collection);
    if (!r) { r = new PgRepo<T>(collection, () => this.ensureDataSource()); this.repos.set(collection, r); }
    return r as Repository<T>;
  }

  async close(): Promise<void> { if (this.ds) await this.ds.destroy(); }
}
