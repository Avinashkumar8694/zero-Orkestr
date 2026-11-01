// Differential check: every Java script of the imported project runs on the real JVM sidecar (the original Java) AND as the converted JavaScript on the
// same inputs; the resulting variables and the thrown/not-thrown outcome must agree. Run: node --import tsx test/diff/differential.ts [projectDir]
import fs from 'node:fs'; import path from 'node:path';
import { kjarToEngine } from '../../src/modules/import/service.ts';
import { parseBpmn } from '../../src/sdk/index.ts';
import { runScript } from '../../src/engine/sandbox.ts';

const root = path.resolve(process.argv[2] || '../extracted_projects/policy_system');
const files: Record<string, string> = {};
const walk = (d: string) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (!/\.(png|svg|gitkeep)$/.test(f)) files[path.relative(root, p)] = fs.readFileSync(p, 'utf8'); } };
walk(root);
const engine = kjarToEngine(files);
const jsNodes = new Map<string, any>();
const collect = (pid: string, nodes: any[]) => { for (const n of nodes || []) { jsNodes.set(`${pid}::${n.id}`, n); if (Array.isArray(n.nodes)) collect(pid, n.nodes); } };
for (const p of engine.processes) collect(p.id!, p.nodes as any[]);

// real jBPM's ProcessInstance.getId() is a long; the sidecar's is the engine's string id, so `Long x = ...getId()` is adapted for the reference run only
const javaRef = (src: string) => src.replace(/Long\s+(\w+)\s*=\s*kcontext\.getProcessInstance\(\)\.getId\(\)\s*;/g, 'Long $1 = Long.valueOf(7L);').replace(/long\s+(\w+)\s*=\s*kcontext\.getProcessInstance\(\)\.getId\(\)\s*;/g, 'long $1 = 7L;');
type Snip = { pid: string; nid: string; kind: string; java: string };
const snips: Snip[] = [];
const declared = new Map<string, Record<string, string>>();
for (const [rel, xml] of Object.entries(files)) {
  if (!/\.bpmn2?$/i.test(rel)) continue;
  const m: any = parseBpmn(xml);
  const pid = m.id as string;
  declared.set(pid, Object.fromEntries(((m.properties || m.vars || m.variables || []) as any[]).map((v) => [v.name, String(v.type || 'String')])));
  const rec = (nodes: any[]) => { for (const n of nodes || []) {
    if (n.type === 'scriptTask' && n.script) snips.push({ pid, nid: n.id, kind: 'code', java: javaRef(n.script) });
    if (n.onEntry) snips.push({ pid, nid: n.id, kind: 'onEntry', java: javaRef(n.onEntry) });
    if (n.onExit) snips.push({ pid, nid: n.id, kind: 'onExit', java: javaRef(n.onExit) });
    rec(n.children || n.nodes || []);
  } };
  rec(m.nodes);
}

const JSON_RESULT = '{"status":"SUCCESS","sent":true,"results":[{"partyId":"P1","role":"PRIMARY","channel":"EMAIL","isCc":false,"status":"SENT","shipmentId":"S1"}],"timelineId":"TL-1","id":"X1"}';
const sample = (name: string, profile: number, type = 'String'): unknown => {
  const n = name.toLowerCase();
  const ty = type.toLowerCase();
  if (profile === 2 && !/^(caseid|piid)$/.test(n)) return undefined;
  if (profile !== 2 && /(^|\.)list$|^arraylist$/.test(ty)) return ['A1', 'A2'];
  if (profile !== 2 && /jsonnode|objectnode|^map$|hashmap/.test(ty)) return { partyId: 'P1', groupId: 'G1', brokerId: 'B1', certificateIds: [], a: 1 };
  if (profile !== 2 && /^(int|integer|long|short)$/.test(ty)) return n === 'maxretrycount' ? 3 : profile === 1 ? 2 : 1;
  if (profile !== 2 && /^(double|float|bigdecimal)$/.test(ty)) return 1.5;
  if (profile !== 2 && /^boolean$/.test(ty)) return profile === 1;
  if (/url$/.test(n)) return 'http://localhost:3010/mock/api';
  if (n === 'retrycount') return profile === 1 ? 2 : 0;
  if (n === 'maxretrycount') return 3;
  if (n === 'failedcontext') return '{"url":"http://localhost:3010/a/b","payload":{"x":1},"method":"POST","headers":"{\\"Content-Type\\":\\"application/json\\"}"}';
  if (/^(result|response|resppayload|restresult)$/.test(n) || /result$/.test(n)) return JSON_RESULT;
  if (/payload|contentdata|context$/.test(n)) return '{"a":1,"partyId":"P1","party_id":"P1","groupId":"G1","brokerId":"B1"}';
  if (/^(is|has|should|can)|required$|success$|valid|sent$|flag$/.test(n)) return profile === 1;
  if (/count$|retry|attempt|cid$|^n$|index/.test(n)) return profile === 1 ? 1 : 0;
  if (/ids$|list$/.test(n)) return '["A1","A2"]';
  return profile === 1 ? 'VAL-' + name : 'val';
};
const varsOf = (java: string) => [...new Set([...java.matchAll(/getVariable\(\s*"(\w+)"\s*\)/g)].map((m) => m[1]!))];
const scalars = (x: unknown): unknown => (x === null || x === undefined ? null : Array.isArray(x) ? x.map(scalars) : typeof x === 'object' ? Object.fromEntries(Object.entries(x as object).map(([k, y]) => [k, scalars(y)])) : String(x));   // 7 and "7" are the same value here (jBPM ids are numbers, this engine's are strings)
const norm = (v: Record<string, unknown>) => JSON.stringify(scalars(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, typeof x === 'string' && /^[{\[]/.test(x) ? (() => { try { return JSON.parse(x); } catch { return x; } })() : x]))));

let ok = 0; const diffs: string[] = [];
for (const s of snips) {
  const js = jsNodes.get(`${s.pid}::${s.nid}`);
  const jsCode = js?.[s.kind];
  if (!jsCode) { diffs.push(`${s.pid} ${s.nid} ${s.kind}: converted code missing`); continue; }
  for (const profile of [0, 1, 2]) {
    const inputs: Record<string, unknown> = {};
    for (const v of varsOf(s.java)) { const x = sample(v, profile, declared.get(s.pid)?.[v]); if (x !== undefined) inputs[v] = x; }
    const a = JSON.parse(JSON.stringify(inputs)), b = JSON.parse(JSON.stringify(inputs));
    let ja: string, jb: string;
    try { await runScript(s.java, a, 15000, { lang: 'java', tenantId: 'diff', env: { INTEGRATION_LAYER_URL: 'http://localhost:3010', APL_POLICY_MS_URL: 'http://localhost:3010/policy-api' } } as any); ja = 'ok:' + norm(a); } catch (e) { ja = 'throw'; (globalThis as any).__je = ((e as Error).message || '').slice(0, 220).replace(/\n/g, ' '); }
    try { await runScript(jsCode, b, 5000, { lang: 'js', tenantId: 'diff', instanceId: '7', env: { INTEGRATION_LAYER_URL: 'http://localhost:3010', APL_POLICY_MS_URL: 'http://localhost:3010/policy-api' } } as any); jb = 'ok:' + norm(b); } catch (e) { jb = 'throw'; (globalThis as any).__je2 = ((e as Error).message || '').slice(0, 220).replace(/\n/g, ' '); }
    if (ja === jb) ok++; else diffs.push(`${s.pid} ${s.nid.slice(0, 24)} ${s.kind} profile ${profile}\n     java: ${ja === 'throw' ? 'throw ' + (globalThis as any).__je : ja.slice(0, 330)}\n     js  : ${jb === 'throw' ? 'throw ' + (globalThis as any).__je2 : jb.slice(0, 330)}`);
  }
}
console.log(`${snips.length} snippets × 3 input profiles: ${ok} agree, ${diffs.length} differ`);
for (const d of diffs) console.log(' -', d);
process.exit(0);
