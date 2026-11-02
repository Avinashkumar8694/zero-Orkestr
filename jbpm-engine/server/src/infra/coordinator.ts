// Cross-replica coordination. Every limit in the product (plan limits, platform caps, per-workspace overrides) is
// defined per WORKSPACE, so with N replicas behind a load balancer the numbers have to be enforced across all of
// them, not once per process. This module is the single place that does that:
//
//   rate(ws, n)            requests-per-minute budget shared by every replica
//   acquire(ws, max)       concurrent-request slots shared by every replica (crash-safe: slots are leases that expire)
//   place(ws, maxReplicas) at most `maxReplicas` replicas may serve a workspace at once; also tells each replica how
//                          many replicas currently share it, so per-replica pools can take their fair share
//   claim(key)             one-owner claims (a timer job fires on exactly one replica)
//   mutex(key, fn)         cluster-wide critical section (read-modify-write of usage counters)
//
// The shared state lives in Redis (REDIS_URL) behind the tiny SharedBackend interface; each primitive is ONE atomic
// Lua script, so replicas never need to talk to each other. Without REDIS_URL a private in-memory backend is used —
// exactly the old single-process behaviour. If Redis becomes unreachable the coordinator degrades to that local
// backend (limits become per-replica again, logged) rather than taking the API down.
import { config } from './config.ts';
import { logger } from './logger.ts';

export interface LeaseResult { ok: boolean; count: number }
export interface HitResult { ok: boolean; count: number; retryMs: number }

export interface SharedBackend {
  readonly kind: 'memory' | 'redis';
  /** atomic: drop expired members; an existing member is renewed (and, with `evict`, dropped when it ranks beyond
   *  `max` — lexicographic by id, so every replica agrees who loses after a shrink); a new member joins only while
   *  fewer than `max` live members exist. */
  lease(key: string, id: string, max: number, ttlMs: number, evict?: boolean): Promise<LeaseResult>;
  release(key: string, id: string): Promise<void>;
  members(key: string): Promise<string[]>;
  /** fixed window: counts only admitted hits; `retryMs` = time until the window resets */
  hit(key: string, windowMs: number, max: number): Promise<HitResult>;
  /** hits counted so far in the current window of `key`, without adding one */
  peek(key: string, windowMs: number): Promise<number>;
  close(): Promise<void>;
}

const FOREVER = 1_000_000_000;

// ------------------------------------------------------------------------------------------------ memory
export class MemoryBackend implements SharedBackend {
  readonly kind: 'memory' | 'redis';
  private sets = new Map<string, Map<string, number>>();
  private windows = new Map<string, { start: number; count: number }>();
  /** `simulateShared` (tests) makes several coordinators over ONE instance behave like replicas sharing Redis */
  constructor(private clock: () => number = Date.now, simulateShared = false) { this.kind = simulateShared ? 'redis' : 'memory'; }

  async lease(key: string, id: string, max: number, ttlMs: number, evict = false): Promise<LeaseResult> {
    const now = this.clock();
    let m = this.sets.get(key);
    if (!m) { m = new Map(); this.sets.set(key, m); }
    for (const [k, exp] of m) if (exp <= now) m.delete(k);
    if (m.has(id)) {
      if (evict && m.size > max && [...m.keys()].sort().indexOf(id) >= max) { m.delete(id); return { ok: false, count: m.size }; }
      m.set(id, now + ttlMs);
      return { ok: true, count: m.size };
    }
    if (m.size >= max) return { ok: false, count: m.size };
    m.set(id, now + ttlMs);
    return { ok: true, count: m.size };
  }
  async release(key: string, id: string): Promise<void> { this.sets.get(key)?.delete(id); }
  async members(key: string): Promise<string[]> {
    const now = this.clock();
    return [...(this.sets.get(key) ?? [])].filter(([, exp]) => exp > now).map(([k]) => k).sort();
  }
  async hit(key: string, windowMs: number, max: number): Promise<HitResult> {
    const now = this.clock();
    let w = this.windows.get(key);
    if (!w || now - w.start >= windowMs) { w = { start: now, count: 0 }; this.windows.set(key, w); }
    const retryMs = Math.max(1, w.start + windowMs - now);
    if (w.count >= max) return { ok: false, count: w.count, retryMs };
    w.count++;
    return { ok: true, count: w.count, retryMs };
  }
  async peek(key: string, windowMs: number): Promise<number> { const w = this.windows.get(key); return w && this.clock() - w.start < windowMs ? w.count : 0; }
  async close(): Promise<void> { this.sets.clear(); this.windows.clear(); }
  /** test hook: drop everything */
  clear(): void { this.sets.clear(); this.windows.clear(); }
}

// ------------------------------------------------------------------------------------------------ redis
const LEASE_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local max, ttl, evict = tonumber(ARGV[2]), tonumber(ARGV[3]), ARGV[4] == '1'
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZSCORE', KEYS[1], ARGV[1]) then
  local n = redis.call('ZCARD', KEYS[1])
  if evict and n > max then
    local all = redis.call('ZRANGE', KEYS[1], 0, -1)
    table.sort(all)
    for i = 1, #all do
      if all[i] == ARGV[1] then
        if i > max then redis.call('ZREM', KEYS[1], ARGV[1]); return {0, n - 1} end
        break
      end
    end
  end
  redis.call('ZADD', KEYS[1], now + ttl, ARGV[1])
  redis.call('PEXPIRE', KEYS[1], ttl * 2)
  return {1, n}
end
local n = redis.call('ZCARD', KEYS[1])
if n >= max then return {0, n} end
redis.call('ZADD', KEYS[1], now + ttl, ARGV[1])
redis.call('PEXPIRE', KEYS[1], ttl * 2)
return {1, n + 1}`;

const HIT_LUA = `
local c = tonumber(redis.call('GET', KEYS[1]) or '0')
local max, win = tonumber(ARGV[2]), tonumber(ARGV[1])
if c >= max then return {0, c, math.max(1, redis.call('PTTL', KEYS[1]))} end
c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], win) end
return {1, c, math.max(1, redis.call('PTTL', KEYS[1]))}`;

const MEMBERS_LUA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
return redis.call('ZRANGE', KEYS[1], 0, -1)`;

/** the slice of ioredis this module uses (kept narrow so tests and alternatives can stand in) */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  zrem(key: string, member: string): Promise<unknown>;
  get?(key: string): Promise<string | null>;
  quit(): Promise<unknown>;
}

export class RedisBackend implements SharedBackend {
  readonly kind = 'redis' as const;
  constructor(private r: RedisLike, private prefix: string) {}
  private k(key: string) { return this.prefix + key; }
  async lease(key: string, id: string, max: number, ttlMs: number, evict = false): Promise<LeaseResult> {
    const [ok, count] = (await this.r.eval(LEASE_LUA, 1, this.k(key), id, Math.min(max, FOREVER), ttlMs, evict ? '1' : '0')) as number[];
    return { ok: ok === 1, count };
  }
  async release(key: string, id: string): Promise<void> { await this.r.zrem(this.k(key), id); }
  async members(key: string): Promise<string[]> { return (await this.r.eval(MEMBERS_LUA, 1, this.k(key))) as string[]; }
  async hit(key: string, windowMs: number, max: number): Promise<HitResult> {
    const [ok, count, ttl] = (await this.r.eval(HIT_LUA, 1, this.k(key), windowMs, max)) as number[];
    return { ok: ok === 1, count, retryMs: Math.max(1, ttl) };
  }
  async peek(key: string, _windowMs: number): Promise<number> { return Number(await (this.r as any).get(this.k(key)).catch(() => 0)) || 0; }
  async close(): Promise<void> { await this.r.quit().catch(() => {}); }
}

export async function connectRedis(url: string, prefix: string): Promise<RedisBackend> {
  const { default: IORedis } = await import('ioredis');
  const r = new IORedis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: true, connectTimeout: 3000 });
  r.on('error', () => { /* surfaced through the failing call; the coordinator degrades */ });
  await r.connect();
  return new RedisBackend(r as unknown as RedisLike, prefix);
}

// ------------------------------------------------------------------------------------------------ coordinator
export type Release = () => Promise<void>;
export interface Placement { ok: boolean; holders: number; rank: number }
export interface CoordinatorOptions { replicaId: string; leaseTtlMs: number; heartbeatMs: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Coordinator {
  readonly replicaId: string;
  private local: MemoryBackend;
  private degradedAt = 0;
  private lastWarn = 0;
  private seq = 0;
  private timer?: NodeJS.Timeout;
  /** my in-flight request/claim leases (key → ids) — renewed by the heartbeat so a long request never loses its slot */
  private held = new Map<string, string>();
  private placements = new Map<string, { at: number; ok: boolean; holders: number; rank: number; max: number; touched: number }>();

  constructor(private backend: SharedBackend, private opts: CoordinatorOptions) {
    this.replicaId = opts.replicaId;
    this.local = backend instanceof MemoryBackend ? backend : new MemoryBackend();
  }

  /** true when state is shared between replicas (Redis), false for a private single-process backend */
  get shared(): boolean { return this.backend.kind === 'redis'; }
  get degraded(): boolean { return this.degradedAt > 0 && Date.now() - this.degradedAt < 15_000; }
  get kind(): string { return this.degraded ? 'redis(degraded→local)' : this.backend.kind; }

  /** runs `fn` on the shared backend; on failure uses `fb` on the local one (and retries Redis after 15 s) */
  private async guard<T>(fn: (b: SharedBackend) => Promise<T>): Promise<T> {
    if (this.backend === this.local || this.degraded) return fn(this.local);
    try { const v = await fn(this.backend); this.degradedAt = 0; return v; } catch (e) {
      this.degradedAt = Date.now();
      if (Date.now() - this.lastWarn > 30_000) { this.lastWarn = Date.now(); logger.error('redis unavailable — limits are enforced per replica until it is back', { err: (e as Error).message }); }
      return fn(this.local);
    }
  }

  start(): void {
    if (this.timer) return;
    const beat = () => { void this.heartbeat().catch(() => {}); };
    this.timer = setInterval(beat, this.opts.heartbeatMs);
    this.timer.unref?.();
    beat();
  }

  private async heartbeat(): Promise<void> {
    const ttl = this.opts.leaseTtlMs;
    await this.guard((b) => b.lease('replicas', this.replicaId, FOREVER, ttl * 3));
    for (const [id, key] of this.held) await this.guard((b) => b.lease(key, id, FOREVER, ttl)).catch(() => {});
    const now = Date.now();
    for (const [ws, p] of this.placements) {
      if (now - p.touched > ttl) { this.placements.delete(ws); continue; }   // idle here: let the slot lapse
      if (p.ok) await this.refreshPlacement(ws, p.max).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    for (const [ws, p] of this.placements) if (p.ok) await this.guard((b) => b.release(`place:${ws}`, this.replicaId)).catch(() => {});
    for (const [id, key] of this.held) await this.guard((b) => b.release(key, id)).catch(() => {});
    await this.guard((b) => b.release('replicas', this.replicaId)).catch(() => {});
    this.placements.clear(); this.held.clear();
    await this.backend.close();
  }

  // ---- rate: shared requests-per-minute budget
  /** has `ws` already used up its per-minute budget? (reads the same counter as rate(), adds nothing) */
  async rateExhausted(ws: string, perMinute: number): Promise<boolean> { return (await this.guard((b) => b.peek(`rate:${ws}`, 60_000))) >= perMinute; }
  rate(ws: string, perMinute: number): Promise<HitResult> { return this.guard((b) => b.hit(`rate:${ws}`, 60_000, perMinute)); }

  // ---- concurrency: shared slots; null = none free
  async acquire(scope: string, ws: string, max: number): Promise<Release | null> {
    const key = `${scope}:${ws}`;
    const id = `${this.replicaId}:${++this.seq}`;
    const r = await this.guard((b) => b.lease(key, id, max, this.opts.leaseTtlMs));
    if (!r.ok) return null;
    this.held.set(id, key);
    let done = false;
    return async () => {
      if (done) return; done = true; this.held.delete(id);
      await this.guard((b) => b.release(key, id)).catch(() => {});
    };
  }
  async inUse(scope: string, ws: string): Promise<number> { return (await this.guard((b) => b.members(`${scope}:${ws}`))).length; }

  // ---- placement: at most `maxReplicas` replicas serve a workspace (<= 0 = unlimited, but still counted)
  private async refreshPlacement(ws: string, maxReplicas: number): Promise<Placement> {
    const max = maxReplicas > 0 ? maxReplicas : FOREVER;
    const r = await this.guard((b) => b.lease(`place:${ws}`, this.replicaId, max, this.opts.leaseTtlMs, true));
    let holders = Math.max(1, r.count), rank = 0;
    if (r.ok) {                                  // my position among the (sorted) holders = my share of the workspace's budget
      const all = await this.guard((b) => b.members(`place:${ws}`));
      const i = all.indexOf(this.replicaId);
      if (i >= 0) { holders = all.length; rank = i; }
    }
    const prev = this.placements.get(ws);
    this.placements.set(ws, { at: Date.now(), ok: r.ok, holders, rank, max: maxReplicas, touched: prev?.touched ?? Date.now() });
    return { ok: r.ok, holders, rank };
  }
  /** Is this replica allowed to serve `ws`? Cheap: asks the backend at most once per heartbeat while allowed, and at
   *  most once a second while refused; a changed `maxReplicas` is re-evaluated immediately. */
  async place(ws: string, maxReplicas: number): Promise<Placement> {
    const now = Date.now();
    const p = this.placements.get(ws);
    if (p) {
      p.touched = now;
      const age = now - p.at;
      if (p.max === maxReplicas && age < (p.ok ? this.opts.heartbeatMs : Math.min(1000, this.opts.heartbeatMs))) return { ok: p.ok, holders: p.holders, rank: p.rank };
    }
    return this.refreshPlacement(ws, maxReplicas);
  }
  /** replicas currently sharing `ws` as last seen by this one (>= 1) — used to split pool/queue budgets */
  holdersOf(ws: string): { holders: number; rank: number } { const p = this.placements.get(ws); return { holders: p?.holders ?? 1, rank: p?.rank ?? 0 }; }
  async holders(ws: string): Promise<string[]> { return this.guard((b) => b.members(`place:${ws}`)); }
  async replicas(): Promise<string[]> { return this.guard((b) => b.members('replicas')); }

  // ---- ownership of a single piece of work (timer job) — released by the caller, expires if this replica dies
  async claim(key: string, ttlMs = 30_000): Promise<Release | null> {
    const r = await this.guard((b) => b.lease(`claim:${key}`, this.replicaId, 1, ttlMs));
    if (!r.ok) return null;
    return async () => { await this.guard((b) => b.release(`claim:${key}`, this.replicaId)).catch(() => {}); };
  }

  /** non-blocking form of `mutex`: the lock (same key space) or null when someone holds it. Expires on its own if this replica dies. */
  async tryLock(key: string, ttlMs = 30_000): Promise<Release | null> {
    const id = `${this.replicaId}:l${++this.seq}`;
    const r = await this.guard((b) => b.lease(`mutex:${key}`, id, 1, ttlMs));
    if (!r.ok) return null;
    return async () => { await this.guard((b) => b.release(`mutex:${key}`, id)).catch(() => {}); };
  }

  // ---- cluster-wide critical section (only worth it when state is shared; otherwise just runs `fn`)
  async mutex<T>(key: string, fn: () => Promise<T>, waitMs = 5000): Promise<T> {
    if (!this.shared || this.degraded) return fn();
    const id = `${this.replicaId}:m${++this.seq}`;
    const deadline = Date.now() + waitMs;
    for (let delay = 5; ; delay = Math.min(delay * 2, 50)) {
      const r = await this.guard((b) => b.lease(`mutex:${key}`, id, 1, 10_000));
      if (r.ok) break;
      if (Date.now() > deadline) throw new Error(`could not take cluster lock ${key} within ${waitMs} ms`);
      await sleep(delay);
    }
    try { return await fn(); } finally { await this.guard((b) => b.release(`mutex:${key}`, id)).catch(() => {}); }
  }
}

// ------------------------------------------------------------------------------------------------ singleton
let current: Coordinator | undefined;

export function coordinator(): Coordinator {
  if (!current) {
    const c = config.cluster;
    current = new Coordinator(new MemoryBackend(), { replicaId: c.replicaId, leaseTtlMs: c.leaseTtlMs, heartbeatMs: c.heartbeatMs });
  }
  return current;
}
/** tests: a fresh private in-memory coordinator (drops every counter, lease and placement) */
export function resetCoordinator(): void {
  const c = config.cluster;
  current = new Coordinator(new MemoryBackend(), { replicaId: c.replicaId, leaseTtlMs: c.leaseTtlMs, heartbeatMs: c.heartbeatMs });
}
/** boot (and tests): replace the process-wide coordinator */
export function setCoordinator(c: Coordinator): void { current = c; }
/** boot: Redis when REDIS_URL is set (a failure to connect is fatal in production — silently running unshared would
 *  make every limit N× too generous), else the private in-memory backend. */
export async function initCoordinator(): Promise<Coordinator> {
  const c = config.cluster;
  let backend: SharedBackend = new MemoryBackend();
  if (c.redisUrl) {
    try { backend = await connectRedis(c.redisUrl, c.keyPrefix); logger.info('cluster coordination via redis', { replicaId: c.replicaId }); }
    catch (e) {
      if (config.isProduction) throw new Error(`REDIS_URL is set but Redis is unreachable: ${(e as Error).message}`);
      logger.error('redis unreachable — coordinating in-process only', { err: (e as Error).message });
    }
  }
  const co = new Coordinator(backend, { replicaId: c.replicaId, leaseTtlMs: c.leaseTtlMs, heartbeatMs: c.heartbeatMs });
  setCoordinator(co);
  co.start();
  return co;
}
