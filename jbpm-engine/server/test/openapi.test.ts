// The Swagger/OpenAPI doc must stay honest: every documented path+method exists in the Express router,
// and every registered route (except the docs endpoints themselves) is documented. Also sanity-check
// that all $ref targets resolve.
import { test } from 'node:test';
import assert from 'node:assert';
import { openapiSpec } from '../src/http/openapi.ts';
import { buildRoutes } from '../src/http/routes.ts';
import { buildAuthRoutes } from '../src/http/auth-routes.ts';

// Express path (":id") ↔ OpenAPI path ("{id}")
const toExpress = (p: string) => p.replace(/\{([^}]+)\}/g, ':$1');

function collect(router: any, out: Set<string>, prefix = '') {
  for (const layer of router.stack) {
    if (layer.route) {
      for (const m of Object.keys(layer.route.methods)) {
        if (layer.route.methods[m]) out.add(`${m.toUpperCase()} ${prefix}${layer.route.path}`);
      }
    } else if (layer.name === 'router' && layer.handle) {
      collect(layer.handle, out, prefix);
    }
  }
}

// app.ts mounts buildAuthRoutes() at /api/auth (unauthenticated) and buildRoutes() at /api (behind
// requireAuth) — both contribute to the documented surface, so both need to be checked here.
function routerRoutes(): Set<string> {
  const out = new Set<string>();
  collect(buildRoutes(), out);
  collect(buildAuthRoutes(), out, '/auth');
  return out;
}

test('spec is a valid OpenAPI 3 document with servers, tags and paths', () => {
  assert.match(openapiSpec.openapi, /^3\./);
  assert.ok(openapiSpec.info?.title && openapiSpec.info?.version);
  assert.deepStrictEqual(openapiSpec.servers, [{ url: '/api', description: 'This server' }]);
  assert.ok(Object.keys(openapiSpec.paths).length >= 40, 'documents the full surface');
});

test('every documented path+method is registered in the router', () => {
  const registered = routerRoutes();
  const missing: string[] = [];
  for (const [path, ops] of Object.entries<any>(openapiSpec.paths)) {
    for (const method of Object.keys(ops)) {
      const key = `${method.toUpperCase()} ${toExpress(path)}`;
      if (!registered.has(key)) missing.push(key);
    }
  }
  assert.deepStrictEqual(missing, [], `documented but not routed: ${missing.join(', ')}`);
});

test('every routed endpoint is documented (docs endpoints excluded)', () => {
  const documented = new Set<string>();
  for (const [path, ops] of Object.entries<any>(openapiSpec.paths))
    for (const method of Object.keys(ops)) documented.add(`${method.toUpperCase()} ${toExpress(path)}`);

  const undocumented = [...routerRoutes()].filter((k) => !documented.has(k) && !k.includes('/openapi.json') && !k.includes('/docs'));
  assert.deepStrictEqual(undocumented, [], `routed but undocumented: ${undocumented.join(', ')}`);
});

test('all $ref targets resolve to a component schema', () => {
  const names = new Set(Object.keys(openapiSpec.components.schemas));
  const refs: string[] = [];
  JSON.stringify(openapiSpec, (k, v) => { if (k === '$ref') refs.push(v); return v; });
  const broken = refs.filter((r) => !names.has(r.replace('#/components/schemas/', '')));
  assert.deepStrictEqual(broken, [], `unresolved refs: ${broken.join(', ')}`);
});
