// Allocator at scale on the real store: many people, many waiting tasks. Run: PG_URL=… node --import tsx test/load/allocator-load.ts [users] [tasks]
import 'reflect-metadata';
import { PgStore } from '../../src/store/pg-store.ts';
import { makeContext } from '../../src/context.ts';
import { config } from '../../src/infra/config.ts';
import { AllocationService, resetRuleCache } from '../../src/modules/allocation/service.ts';
import { Collections } from '../../src/domain.ts';

const USERS = Number(process.argv[2] || 2000), TASKS = Number(process.argv[3] || 3000), GROUPS = 20;
const store = new PgStore(config.pgUrl!);
const tenant = `alloc_load_${Date.now()}`;
const ctx = makeContext({ store, tenantId: tenant });
const svc = new AllocationService(ctx);
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;
const put = async (col: string, rows: any[]) => { const t = performance.now(); let i = 0; await Promise.all(Array.from({ length: 16 }, async () => { while (i < rows.length) await store.repo<any>(col).put(rows[i++]!); })); return ms(t); };

const now = new Date().toISOString();
const users = Array.from({ length: USERS }, (_, i) => ({ id: `u${i}`, tenantId: tenant, username: `user${i}`, passwordHash: 'x', roles: [], groups: [`g${i % GROUPS}`], active: true, createdAt: now, skills: i % 3 === 0 ? ['motor'] : [], maxOpenTasks: 1000, available: true }));
console.log(`insert ${USERS} users:`, await put(Collections.users, users));
await svc.createRule({ name: 'all groups', strategy: 'leastLoaded' } as any, 'bench'); resetRuleCache();
const task = (i: number, extra: object = {}) => ({ id: `t${i}`, tenantId: tenant, instanceId: `i${i}`, tokenId: `k${i}`, nodeId: 'u', name: 'Review', group: `g${i % GROUPS}`, status: 'created', inputs: {}, createdAt: new Date(Date.now() + i).toISOString(), workflowId: 'w', allocation: 'pending', ...extra });
console.log(`insert ${TASKS} waiting tasks:`, await put(Collections.tasks, Array.from({ length: TASKS }, (_, i) => task(i))));

// 1. the real work: assign everything
let passes = 0, assigned = 0; const t0 = performance.now();
for (;;) { const t = performance.now(); const r = await svc.runOnce(200); passes++; assigned += r.assigned; console.log(`  pass ${passes}: assigned ${r.assigned}, queued ${r.queued} in ${ms(t)}`); if (!r.assigned && !r.queued) break; if (passes > 60) break; }
console.log(`ASSIGN ${assigned} tasks over ${USERS} people: ${passes} passes, ${ms(t0)} total (${((performance.now() - t0) / Math.max(1, assigned)).toFixed(1)} ms per task)`);
const tr = performance.now(); const tracker = await svc.tracker(); console.log(`tracker over ${USERS} people:`, ms(tr), `(${tracker.people.length} rows)`);

// 2. nothing waiting: the cost of an idle pass (this runs every ~2 s per workspace)
const ti = performance.now(); for (let i = 0; i < 20; i++) await svc.runOnce(200); console.log('idle pass, average of 20:', `${((performance.now() - ti) / 20).toFixed(1)} ms`);

// 3. worst case: nobody qualifies (everyone away), TASKS queued: what a retry pass costs
for (const u of users.slice(0, USERS)) await store.repo<any>(Collections.users).put({ ...u, available: false });
await put(Collections.tasks, Array.from({ length: Math.min(TASKS, 2000) }, (_, i) => task(100000 + i, { allocation: 'queued' })));
const tq = performance.now(); const rq = await svc.runOnce(200); console.log(`retry pass over ${Math.min(TASKS, 2000)} queued tasks (limit 200): ${ms(tq)}`, JSON.stringify(rq));
const tq2 = performance.now(); for (let i = 0; i < 5; i++) await svc.runOnce(200); console.log('5 more retry passes:', ms(tq2), `(${((performance.now() - tq2) / 5).toFixed(0)} ms each)`);
await store.close(); process.exit(0);
