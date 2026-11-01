// The policy project imported with its Java kept as Java (scriptDialect 'java'): every journey must run to completion on the real JVM sidecar against the
// mock integration server, exactly as the converted-to-JavaScript import does. This is what "Java support after import must not break" means.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boot } from '../harness.ts';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const mockUp = () => new Promise<boolean>((res) => { const s = net.connect(3010, '127.0.0.1'); s.once('connect', () => { s.destroy(); res(true); }); s.once('error', () => res(false)); });
let mock: ChildProcess | undefined;
let h: Awaited<ReturnType<typeof boot>>;
before(async () => {
  if (!(await mockUp())) { mock = spawn(process.execPath, ['server.js'], { cwd: path.join(rootDir, 'mock_server'), stdio: 'ignore' }); for (let n = 0; n < 60 && !(await mockUp()); n++) await new Promise((r) => setTimeout(r, 100)); }
  h = await boot();
});
after(async () => { mock?.kill(); await h?.close(); setTimeout(() => process.exit(0), 50).unref(); });

const kjar = () => { const root = path.join(rootDir, 'extracted_projects/policy_system'); const files: Record<string, string> = {}; const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (!/\.(png|svg|gitkeep)$/.test(f)) files[path.relative(root, p)] = fs.readFileSync(p, 'utf8'); } }; walk(root); return files; };
const API = 'http://localhost:3010';
const TYPES = ['CERTIFICATE_RESEND', 'FILE_FEED', 'TAKEOVER', 'CLAIMS', 'POLICY_TERMINATION', 'ESCALATION', 'ENROLLMENT'];

test('JAVA-IMPORT-1 the policy project imported with scriptDialect=java deploys, keeps its scripts as Java, and every journey completes on the JVM', { timeout: 280000 }, async () => {
  const ws = await h.workspace('policy-java', ['admin']);
  const tok = ws.tokens.admin;
  const call = (m: string, p: string, body?: unknown) => h.call(m, p, { token: tok, tenant: ws.id, body });
  const imp = await call('POST', '/import/jbpm/deploy', { files: kjar(), name: 'policy java', environment: 'prod', scriptDialect: 'java',
    env: { INTEGRATION_LAYER_URL: API, APL_POLICY_MS_URL: `${API}/policy-api`, APL_BROKER_MS_BASE_URL: `${API}/broker-ms-api`, QUOTATION_BASE_URL: `${API}/quote-api`, APL_QUOTATION_MS_URL: `${API}/quote-api`, APL_BROKER_DATA_FABRIC_BASE_URL: API } });
  assert.equal(imp.status, 201, JSON.stringify(imp.body).slice(0, 600));
  assert.equal(imp.body.processes, 23);
  const dep = (await call('GET', `/deployments/${imp.body.deploymentId}`)).body;
  const langs = new Set<string>();
  const walk = (nodes: any[]) => { for (const n of nodes || []) { if (n.type === 'script') langs.add(n.lang || 'none'); walk(n.nodes); } };
  for (const p of dep.engine.processes) walk(p.nodes);
  assert.ok(langs.has('java') && !langs.has('js'), `scripts stay Java: ${[...langs]}`);

  const vars = (type: string) => ({ process_value_type: type, caseId: `CASE-${type}`, cid: 1001, party_id: 'PRT-99', group_id: 'GRP-10', broker_id: 'BRK-55', policy_number: `POL-${type}`, policy_issuance_type: 'STANDARD', party_agreement_ids: JSON.stringify(['AGR-1']), reasonMode: 'NO_CHANGE', journeyType: 'RESEND', changeReason: 'NONE', commPurposeId: 'POLICY_ISSUED', current_user: 'admin', enrollment_reference_number: 'ENR-01', enrollment_review_group: 'REVIEWERS', enrollment_review_user: 'admin', billing_frequency: 'MONTHLY', valid_enrollment_change: true, baseUrl: API, communicationSendUrl: `${API}/mock/api`, communicationRetryUrl: `${API}/mock/api`, saveUrl: `${API}/mock/api`, sendSignalUrl: `${API}/mock/api`, emailUrl: `${API}/mock/api`, takoverUpdateUrl: `${API}/mock/api`, updateTerminationUrl: `${API}/mock/api`, failedEndpoint: `${API}/mock/api`, isError: false, adminDecision: 'SKIP', generateDocumentDecision: 'Approve', maxRetryCount: 2 });
  const roots: Array<{ type: string; id: string }> = [];
  for (const type of TYPES) {
    const r = await call('POST', '/instances', { workflowId: imp.body.workflowId, processId: 'policy_management_process', environment: 'prod', variables: vars(type) });
    assert.equal(r.status, 201, `${type}: ${JSON.stringify(r.body).slice(0, 300)}`);
    roots.push({ type, id: r.body.id });
  }
  const subtree = (all: any[], id: string): any[] => all.filter((i) => i.parentInstanceId === id).flatMap((k) => [k, ...subtree(all, k.id)]);
  for (let round = 0; round < 8; round++) {
    await new Promise((r) => setTimeout(r, 700));
    const all = (await call('GET', '/instances?limit=2000')).body.items as any[];
    let acted = 0;
    for (const root of roots) for (const inst of [all.find((i) => i.id === root.id), ...subtree(all, root.id)]) {
      if (!inst || inst.status !== 'waiting') continue;
      const full = (await call('GET', `/instances/${inst.id}`)).body;
      for (const t of full.tokens || []) {
        if (t.state !== 'waiting') continue;
        if (t.waitFor?.kind === 'task') { await call('POST', `/tasks/${t.waitFor.ref}/complete`, { variables: { adminDecision: 'SKIP', decision: 'Approve', approved: true } }); acted++; }
        else if (t.waitFor?.kind === 'signal') { await call('POST', `/instances/${inst.id}/signal`, { name: t.waitFor.ref }); acted++; }
      }
    }
    if (!acted) break;
  }
  await new Promise((r) => setTimeout(r, 700));
  const all = (await call('GET', '/instances?limit=2000')).body.items as any[];
  for (const root of roots) {
    const inst = all.find((i) => i.id === root.id);
    const bad = [inst, ...subtree(all, root.id)].filter((i) => i && ['failed', 'aborted'].includes(i.status)).map((i) => `${i.processId}: ${i.error?.message}`);
    const tree = [inst, ...subtree(all, root.id)].map((i) => `${i.processId}[${i.status}]${(i.tokens || []).filter((t: any) => t.state === 'waiting').map((t: any) => ` waits ${t.waitFor?.kind}:${String(t.waitFor?.ref).slice(0, 24)}`).join('')}`).join(' > ');
    assert.equal(inst.status, 'completed', `${root.type} ended ${inst.status} ${JSON.stringify(inst.error)} ${bad.join(' | ')} :: ${tree}`);
    assert.deepEqual(bad, [], `${root.type} has failed children`);
  }
});
