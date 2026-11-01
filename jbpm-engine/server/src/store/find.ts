// Optional indexed lookup, in the same spirit as claimDueTimers: a store MAY implement `findBy` in SQL (Postgres does); every other store
// is already in memory and is served by the same filter in JavaScript. Callers use findRows() and never care which one answers, so a
// request that needs "the instances waiting on signal X" or "the tasks of instance Y" no longer loads a whole collection.
import type { Store, Entity } from './repository.ts';

type Scalar = string | number | boolean;
export interface FindSpec {
  /** top-level field = value, or = any of a list */
  eq?: Record<string, Scalar | Scalar[]>;
  /** top-level text field <= / >= value (ISO timestamps compare correctly as text) */
  lte?: Record<string, string>;
  gte?: Record<string, string>;
  /** the value at a top-level `path` contains `value` (objects: partial match; arrays: every pattern element matches some element) */
  contains?: { path: string; value: unknown };
  /** order by a top-level text field (default: id) and return at most `limit` rows; `afterId` continues an id-ordered page */
  orderBy?: string;
  limit?: number;
  afterId?: string;
}

declare module './repository.ts' {
  interface Store { findBy?(collection: string, tenantId: string, spec: FindSpec): Promise<any[]> }
}

/** the reference semantics — Postgres' SQL must agree with this */
export function jsonContains(actual: unknown, pattern: unknown): boolean {
  if (Array.isArray(pattern)) return Array.isArray(actual) && pattern.every((p) => actual.some((a) => jsonContains(a, p)));
  if (pattern && typeof pattern === 'object') return !!actual && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(pattern).every(([k, v]) => jsonContains((actual as Record<string, unknown>)[k], v));
  return actual === pattern;
}
const text = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
export function matchesSpec(row: Record<string, any>, spec: FindSpec): boolean {
  for (const [f, want] of Object.entries(spec.eq ?? {})) {
    const have = text(row[f]);
    if (Array.isArray(want) ? !want.map(String).includes(have as string) : have !== String(want)) return false;
  }
  for (const [f, v] of Object.entries(spec.lte ?? {})) { const h = text(row[f]); if (h === undefined || !(h <= v)) return false; }
  for (const [f, v] of Object.entries(spec.gte ?? {})) { const h = text(row[f]); if (h === undefined || !(h >= v)) return false; }
  if (spec.contains && !jsonContains(row[spec.contains.path], spec.contains.value)) return false;
  return true;
}

/** the generic path: filter, order, page — used by every store that has no SQL of its own */
export async function findRows<T extends Entity>(store: Store, collection: string, tenantId: string, spec: FindSpec = {}): Promise<T[]> {
  if (store.findBy) return (await store.findBy(collection, tenantId, spec)) as T[];
  let rows = (await store.repo<T>(collection).query((r) => r.tenantId === tenantId && matchesSpec(r as any, spec))) as T[];
  const by = spec.orderBy ?? 'id';
  rows = [...rows].sort((a: any, b: any) => (text(a[by]) ?? '').localeCompare(text(b[by]) ?? '') || a.id.localeCompare(b.id));
  if (spec.afterId) rows = rows.filter((r) => r.id > spec.afterId!);
  return spec.limit ? rows.slice(0, spec.limit) : rows;
}

/** Postgres: the same question as one parameterised query. Field names come from code (validated), values are always bound. */
export function buildFindSql(collection: string, tenantId: string, spec: FindSpec): { sql: string; params: unknown[] } {
  const ident = /^[A-Za-z][A-Za-z0-9_]*$/;
  const params: unknown[] = [collection, tenantId];
  const where = ['collection = $1', '"tenantId" = $2'];
  const field = (f: string) => { if (!ident.test(f)) throw new Error(`bad field "${f}"`); return `(data->>'${f}')`; };
  for (const [f, want] of Object.entries(spec.eq ?? {})) {
    if (Array.isArray(want)) { params.push(want.map(String)); where.push(`${field(f)} = ANY($${params.length}::text[])`); }
    else { params.push(String(want)); where.push(`${field(f)} = $${params.length}`); }
  }
  for (const [f, v] of Object.entries(spec.lte ?? {})) { params.push(v); where.push(`${field(f)} <= $${params.length}`); }
  for (const [f, v] of Object.entries(spec.gte ?? {})) { params.push(v); where.push(`${field(f)} >= $${params.length}`); }
  if (spec.contains) {
    if (!ident.test(spec.contains.path)) throw new Error(`bad path "${spec.contains.path}"`);
    params.push(JSON.stringify(spec.contains.value)); where.push(`(data->'${spec.contains.path}') @> $${params.length}::jsonb`);
  }
  if (spec.afterId) { params.push(spec.afterId); where.push(`id > $${params.length}`); }
  const order = spec.orderBy ? `${field(spec.orderBy)} ASC, id ASC` : 'id ASC';
  let sql = `SELECT data FROM kv_store WHERE ${where.join(' AND ')} ORDER BY ${order}`;
  if (spec.limit) { params.push(Math.max(1, Math.floor(spec.limit))); sql += ` LIMIT $${params.length}`; }
  return { sql, params };
}

/** indexes the lookups above rely on (all partial on the collection, all IF NOT EXISTS — safe to run on every start) */
export const FIND_INDEXES = [
  `CREATE INDEX IF NOT EXISTS kv_inst_status ON kv_store ("tenantId", (data->>'status')) WHERE collection = 'instances'`,
  `CREATE INDEX IF NOT EXISTS kv_inst_parent ON kv_store ("tenantId", (data->>'parentInstanceId')) WHERE collection = 'instances'`,
  `CREATE INDEX IF NOT EXISTS kv_inst_tokens ON kv_store USING gin ((data->'tokens') jsonb_path_ops) WHERE collection = 'instances'`,
  `CREATE INDEX IF NOT EXISTS kv_task_inst ON kv_store ("tenantId", (data->>'instanceId')) WHERE collection = 'tasks'`,
  `CREATE INDEX IF NOT EXISTS kv_task_status ON kv_store ("tenantId", (data->>'status'), (data->>'assignee')) WHERE collection = 'tasks'`,
  `CREATE INDEX IF NOT EXISTS kv_timer_due ON kv_store ("tenantId", (data->>'status'), (data->>'dueAt')) WHERE collection = 'timers'`,
  `CREATE INDEX IF NOT EXISTS kv_err_inst ON kv_store ("tenantId", (data->>'instanceId')) WHERE collection = 'errors'`,
];
