// Java String.replace replaces every occurrence and replaceAll is a global regex; imported Java scripts must keep that when run as JS.
import { test, after } from 'node:test';
import assert from 'node:assert';
import { convertProjectToNodeEngine } from '../src/modules/import/service.ts';
import { runScript } from '../src/engine/sandbox.ts';

const convert = (code: string) => {
  const e: any = { id: 'p', processes: [{ id: 'p', nodes: [{ id: 'n', type: 'script', lang: 'java', code }], flows: [] }] };
  return convertProjectToNodeEngine(e).processes[0]!.nodes[0] as any;
};
const run = async (code: string, vars: Record<string, unknown> = {}) => { const v: Record<string, unknown> = { ...vars }; await runScript(convert(code).code, v, 2000, { lang: 'js' }); return v; };

test('JREP-1 replace(literal, literal) replaces every occurrence (the escaped-headers case from the policy project)', async () => {
  const v = await run('String h = "{\\"Content-Type\\":\\"application/json\\"}";\nString e = h.replace("\\"", "\\\\\\"");\nkcontext.setVariable("out", e);');
  assert.strictEqual(v.out, '{\\"Content-Type\\":\\"application/json\\"}');
  assert.ok(JSON.parse(`{"headers":"${v.out}"}`).headers, 'the result is valid inside a JSON string');
});

test('JREP-2 replaceAll(regex, x) is a global regex replace; nested calls and commas inside arguments are kept', async () => {
  const v = await run('String s = "a1b22c333";\nkcontext.setVariable("digits", s.replaceAll("[0-9]+", "#"));\nkcontext.setVariable("pair", "x,y,z".replace(",", ";"));\nkcontext.setVariable("chain", " a-b ".trim().replace("-", "_").replace("a", "A"));');
  assert.strictEqual(v.digits, 'a#b#c#');
  assert.strictEqual(v.pair, 'x;y;z');
  assert.strictEqual(v.chain, 'A_b');
});

test('JREP-3 Jackson semantics: a missing path serializes as null, nodes nest, and readTree throws on malformed JSON', async () => {
  const v = await run(`com.fasterxml.jackson.databind.JsonNode ctx = new com.fasterxml.jackson.databind.ObjectMapper().readTree("{\\"a\\":{\\"b\\":1},\\"n\\":null}");
com.fasterxml.jackson.databind.node.ObjectNode out = new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode();
out.set("missing", ctx.path("nope"));
out.set("nested", ctx.path("a"));
kcontext.setVariable("json", out.toString());
String err = "none";
try { new com.fasterxml.jackson.databind.ObjectMapper().readTree("{\\"a\\":\\"{\\\\\\"x\\":1}\\"}"); } catch (Exception e) { err = "threw"; }
kcontext.setVariable("err", err);`);
  assert.strictEqual(v.json, '{"missing":null,"nested":{"b":1}}');
  assert.strictEqual(v.err, 'threw');
});

test('JREP-4 a JsonNode is iterable and an ArrayNode has size/get (the send-communication response parsing in the policy project)', async () => {
  const v = await run(`com.fasterxml.jackson.databind.JsonNode root = new com.fasterxml.jackson.databind.ObjectMapper().readTree("{\\"results\\":[{\\"isCc\\":true,\\"status\\":\\"SENT\\"},{\\"isCc\\":false,\\"status\\":\\"SENT\\",\\"channel\\":\\"EMAIL\\"},{\\"isCc\\":false,\\"status\\":\\"FAILED\\",\\"channel\\":\\"PHYSICAL\\"}]}");
com.fasterxml.jackson.databind.node.ArrayNode failed = new com.fasterxml.jackson.databind.ObjectMapper().createArrayNode();
int primary = 0;
for (com.fasterxml.jackson.databind.JsonNode r : root.path("results")) {
  if (r.path("isCc").asBoolean(false)) { continue; }
  primary++;
  if (!"SENT".equals(r.path("status").asText(""))) { com.fasterxml.jackson.databind.node.ObjectNode f = failed.addObject(); f.put("channel", r.path("channel").asText()); }
}
kcontext.setVariable("primary", primary);
kcontext.setVariable("failedCount", failed.size());
kcontext.setVariable("failed", failed.toString());`);
  assert.strictEqual(v.primary, 2);
  assert.strictEqual(v.failedCount, 1);
  assert.strictEqual(v.failed, '[{"channel":"PHYSICAL"}]');
});

test('JREP-5 ObjectMapper.readValue / convertValue return plain maps, addPOJO appends, and readValue throws on malformed JSON (error_flow / policy_agreement_issuance)', async () => {
  const v = await run(`java.util.Map parsed = new com.fasterxml.jackson.databind.ObjectMapper().readValue("{\\"a\\":1,\\"b\\":{\\"c\\":2}}", java.util.Map.class);
java.util.Map conv = new com.fasterxml.jackson.databind.ObjectMapper().convertValue(parsed, java.util.Map.class);
com.fasterxml.jackson.databind.node.ObjectNode json = new com.fasterxml.jackson.databind.ObjectMapper().createObjectNode();
json.putArray("ids").addPOJO("AGR-1");
String bad = "ok";
try { new com.fasterxml.jackson.databind.ObjectMapper().readValue("{nope", java.util.Map.class); } catch (Exception e) { bad = "threw"; }
kcontext.setVariable("a", conv.get("a"));
kcontext.setVariable("ids", json.toString());
kcontext.setVariable("bad", bad);`);
  assert.strictEqual(v.a, 1);
  assert.strictEqual(v.ids, '{"ids":["AGR-1"]}');
  assert.strictEqual(v.bad, 'threw');
});

import { numericIdOf } from '../src/infra/ids.ts';
import { kit } from './flow-kit.ts';
import { InstanceService } from '../src/modules/instances/service.ts';

test('JID-1 a Java script sees ProcessInstance.getId() as a long (jBPM), the same number the server computes, and the API resolves it back to the instance', async () => {
  const k = kit('t1');
  const w = await k.deploy('jid', [{ id: 's', type: 'start' }, { id: 'j', type: 'script', lang: 'java', name: 'j', code: 'Long pid = kcontext.getProcessInstance().getId();\nlong again = kcontext.getProcessInstance().getId();\nkcontext.setVariable("pid", pid);\nkcontext.setVariable("same", pid == again);\nkcontext.setVariable("idString", kcontext.getProcessInstance().getIdString());' }, { id: 'u', type: 'userTask', name: 'wait', group: 'g' }, { id: 'e', type: 'end' }],
    [{ id: 'f0', from: 's', to: 'j' }, { id: 'f1', from: 'j', to: 'u' }, { id: 'f2', from: 'u', to: 'e' }], [{ name: 'pid', type: 'long' }, { name: 'same', type: 'bool' }, { name: 'idString', type: 'string' }]);
  const inst = await k.start(w.wf.id);
  const done = await k.get(inst.id);
  assert.strictEqual(String(done.variables.pid), numericIdOf(inst.id), 'the sidecar and the server agree on the number');
  assert.strictEqual(done.variables.same, true);
  assert.strictEqual(done.variables.idString, inst.id);
  const viaNumber = await new InstanceService(k.ctx).get(String(done.variables.pid));
  assert.strictEqual(viaNumber.id, inst.id, 'the numeric id resolves to the instance');
});
after(() => setTimeout(() => process.exit(0), 50).unref());   // the JVM sidecar / test server would otherwise keep this process alive
