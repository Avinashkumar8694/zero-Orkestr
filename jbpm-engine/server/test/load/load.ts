// Load / soak smoke over the real HTTP stack (in-process server on the in-memory store): run with `node --import tsx test/load/load.ts [instances]`.
// Not part of `npm test` (timing-dependent); prints throughput, latency percentiles, errors and memory growth.
import { boot } from '../harness.ts';
import { makeContext } from '../../src/context.ts';
import { WorkflowService } from '../../src/modules/workflows/service.ts';
import { VersionService } from '../../src/modules/versions/service.ts';
import { DeploymentService } from '../../src/modules/deployments/service.ts';

const N = Number(process.argv[2] || 600);
const h = await boot();
const ws = await h.workspace('loadws', ['operator'], 'enterprise');
const ctx = makeContext({ store: h.store, tenantId: ws.id });
const deploy = async (name: string, nodes: any[], flows: any[]) => {
  const wf = await new WorkflowService(ctx).create({ name }, 'a');
  const d = await new VersionService(ctx).saveDraft(wf.defaultBranchId, { id: wf.key, name, processes: [{ id: `${wf.key}.process`, name, package: 'p', vars: [], nodes, flows }] } as any, 'a');
  const pub = await new VersionService(ctx).publish(d.id, 'a');
  await new DeploymentService(ctx).deploy(pub.published.id, { environment: 'prod', activate: true }, 'a');
  return wf;
};
const line = (...mid: any[]) => ({ nodes: [{ id: 's', type: 'start' }, ...mid, { id: 'e', type: 'end' }], flows: [{ id: 'f0', from: 's', to: mid[0].id }, ...mid.slice(1).map((m, i) => ({ id: `f${i + 1}`, from: mid[i].id, to: m.id })), { id: 'fe', from: mid.at(-1).id, to: 'e' }] });
const script = { id: 'sc', type: 'script', name: 'calc', code: 'let t = 0; for (let i = 0; i < 20000; i++) t += i; setVariable("t", t)' };
const l1 = line(script); const fast = await deploy('loadfast', l1.nodes, l1.flows);
const l2 = line({ id: 'c', type: 'catch', event: { signal: 'GO' } }, script); const waiter = await deploy('loadwait', l2.nodes, l2.flows);
const tok = ws.tokens.operator;

const lat: number[] = [];
const errs: Record<string, number> = {};
async function timed(fn: () => Promise<{ status: number; body?: any }>) {
  const t = performance.now(); const r = await fn(); lat.push(performance.now() - t);
  if (r.status >= 400) errs[`${r.status} ${r.body?.error?.code ?? ''}`] = (errs[`${r.status} ${r.body?.error?.code ?? ''}`] || 0) + 1;
  return r;
}
async function pool<T>(n: number, conc: number, fn: (i: number) => Promise<T>) { let i = 0; await Promise.all(Array.from({ length: conc }, async () => { while (i < n) { const k = i++; await fn(k); } })); }
const pct = (p: number) => lat.slice().sort((a, b) => a - b)[Math.floor(lat.length * p)]!.toFixed(0);
const rss0 = process.memoryUsage().rss;

let t0 = performance.now();
await pool(N, 40, () => timed(() => h.call('POST', '/instances', { token: tok, tenant: ws.id, body: { workflowId: fast.id, environment: 'prod' } })));
const s1 = (performance.now() - t0) / 1000;
console.log(`start+script  ${N} instances, 40 concurrent: ${(N / s1).toFixed(0)}/s  p50 ${pct(0.5)}ms p95 ${pct(0.95)}ms p99 ${pct(0.99)}ms`);

lat.length = 0;
const ids: string[] = [];
await pool(N / 2, 40, async () => { const r = await timed(() => h.call('POST', '/instances', { token: tok, tenant: ws.id, body: { workflowId: waiter.id, environment: 'prod' } })); ids.push(r.body?.id); });
t0 = performance.now();
await pool(ids.length, 40, (i) => timed(() => h.call('POST', `/instances/${ids[i]}/signal`, { token: tok, tenant: ws.id, body: { name: 'GO' } })));
console.log(`signal        ${ids.length} waiting instances resumed: ${(ids.length / ((performance.now() - t0) / 1000)).toFixed(0)}/s  p95 ${pct(0.95)}ms`);

const list = await h.call('GET', '/instances?limit=50', { token: tok, tenant: ws.id });
const done = await h.call('GET', '/instances?status=completed&limit=1', { token: tok, tenant: ws.id });
console.log('errors', JSON.stringify(errs), '| list', list.status, '| rss growth', ((process.memoryUsage().rss - rss0) / 1048576).toFixed(0) + 'MB', '| completed sample', done.status);
await h.close(); process.exit(Object.keys(errs).length ? 1 : 0);
