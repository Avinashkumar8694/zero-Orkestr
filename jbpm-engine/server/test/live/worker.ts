// One replica = one OS process: its own Postgres connection, its own Redis coordinator, its own replica id.
// Reads a command from LIVE_CMD, prints one JSON line.
import 'reflect-metadata';
import { PgStore } from '../../src/store/pg-store.ts';
import { makeContext } from '../../src/context.ts';
import { config } from '../../src/infra/config.ts';
import { initCoordinator } from '../../src/infra/coordinator.ts';
import { InstanceService } from '../../src/modules/instances/service.ts';
import { TimerService } from '../../src/modules/timers/service.ts';
import { AllocationService } from '../../src/modules/allocation/service.ts';

const cmd = JSON.parse(process.env.LIVE_CMD!);
const co = await initCoordinator();
const store = new PgStore(config.pgUrl!);
const ctx = makeContext({ store, tenantId: cmd.tenant });
const out: Record<string, unknown> = { replica: co.replicaId, coordinator: co.kind };
try {
  if (cmd.op === 'signal') await new InstanceService(ctx).signal(cmd.id, cmd.name, undefined, 'amy').then(() => (out.ok = true));
  else if (cmd.op === 'allocate') {                                    // what the allocator runner does: only the replica holding the workspace's lease runs a pass
    const rel = await co.claim(`allocator:${cmd.tenant}`, 30_000);
    out.ok = true; out.leased = !!rel;
    if (rel) { try { out.assigned = (await new AllocationService(ctx).runOnce()).assigned; } finally { await rel(); } }
  }
  else if (cmd.op === 'start') { for (let i = 0; i < cmd.count; i++) await new InstanceService(ctx).start({ workflowId: cmd.workflowId, environment: 'prod' }, 'amy'); out.ok = true; }
  else if (cmd.op === 'vars') {
    for (const [k, v] of Object.entries(cmd.vars)) await new InstanceService(ctx).updateVariables(cmd.id, { [k]: v }, 'amy');
    out.ok = true;
  } else if (cmd.op === 'tick') {
    out.fired = await new TimerService(ctx).tick(cmd.now, { admit: async () => (await co.place(cmd.tenant, 0)).ok, claim: (job) => co.claim(`timer:${job.id}`) });
  } else if (cmd.op === 'hold') {          // take a one-owner lease and never give it back (the parent kills this process)
    const rel = await co.claim(cmd.key, cmd.ttlMs); out.ok = !!rel; console.log(JSON.stringify(out)); await new Promise((r) => setTimeout(r, 60_000));
  } else if (cmd.op === 'claim') { const rel = await co.claim(cmd.key, cmd.ttlMs); out.ok = !!rel; }
} catch (e) { out.error = (e as Error).message; }
console.log(JSON.stringify(out));
await co.stop(); await store.close(); process.exit(0);
