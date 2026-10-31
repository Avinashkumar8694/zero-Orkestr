// Work-item handler framework — pluggable executors for operation tasks (Email/SMS/DB/Compute/Log/Rest),
// the Node equivalent of jBPM WorkItemHandlers. Each returns result data mapped back to variables.
// External handlers (Email/SMS/DB/Rest) call service URLs or simulate when not configured.
import { evalExpression } from '../sandbox.ts';
import { assertOutboundAllowed } from '../../infra/outbound-guard.ts';

export type WorkItemHandler = (params: Record<string, unknown>, env: Record<string, string>, ctx?: { tenantId?: string }) => Promise<Record<string, unknown>>;

async function callService(url: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const t = await res.text();
  try { return t ? JSON.parse(t) : {}; } catch { return { raw: t }; }
}

export const WORKITEM_HANDLERS: Record<string, WorkItemHandler> = {
  // record only (audit/logging)
  Log: async (p) => ({ logged: true, message: p['message'] ?? p }),
  // evaluate a JS expression with params in scope → { result }
  Compute: async (p, _env, ctx) => {
    const expr = String(p['expression'] ?? p['expr'] ?? '');
    if (!expr) return { result: undefined };
    return { result: await evalExpression(expr, p, 1000, ctx?.tenantId) };
  },
  // external side-effects — call the configured service, else simulate
  Email: async (p, env) => (env['EMAIL_SERVICE_URL'] ? { ...(await callService(env['EMAIL_SERVICE_URL'], p)), sent: true } : { sent: true, simulated: true, to: p['to'] }),
  SMS: async (p, env) => (env['SMS_SERVICE_URL'] ? { ...(await callService(env['SMS_SERVICE_URL'], p)), sent: true } : { sent: true, simulated: true, to: p['to'] }),
  DBQuery: async (p, env) => (env['DB_SERVICE_URL'] ? await callService(env['DB_SERVICE_URL'], p) : { rows: [], simulated: true }),

  // standard jBPM REST work item handler
  Rest: async (p, env) => {
    let rawUrl = String(p['Url'] || p['url'] || '');
    if (!rawUrl) throw new Error('Rest workitem requires "Url" parameter');

    // Dynamically resolve template variables ${VAR} from deployment environment or task params
    let url = rawUrl.replace(/\$\{([^}]+)\}/g, (_, key) => String(env[key] ?? p[key] ?? ''));

    // If relative path or cluster-internal URL (.svc.cluster.local), resolve against BASE_URL or INTEGRATION_LAYER_URL
    const baseUrl = env['BASE_URL'] || env['INTEGRATION_LAYER_URL'] || '';
    if (baseUrl) {
      const base = baseUrl.replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(url)) {
        url = url.startsWith('/') ? `${base}${url}` : `${base}/${url}`;
      } else if (url.includes('.svc.cluster.local')) {
        url = url.replace(/^https?:\/\/[^/]+/, base);
      }
    }

    // SSRF Guard: prevent calls to private, link-local, loopback, or cloud-metadata endpoints unless allowlisted
    if (/^https?:\/\//i.test(url)) {
      const dynamicAllowlist = [
        ...(env['OUTBOUND_ALLOWLIST'] ? env['OUTBOUND_ALLOWLIST'].split(',').map((s) => s.trim()) : []),
        ...(baseUrl ? [new URL(baseUrl).hostname] : []),
      ];
      await assertOutboundAllowed(url, dynamicAllowlist);
    }

    const method = String(p['Method'] || p['method'] || 'POST').toUpperCase();
    const contentType = String(p['ContentType'] || p['contentType'] || 'application/json');
    let headers: Record<string, string> = { 'content-type': contentType };

    const rawHeaders = p['Headers'] || p['headers'];
    if (typeof rawHeaders === 'string' && rawHeaders.trim()) {
      try {
        const parsed = JSON.parse(rawHeaders);
        if (typeof parsed === 'object' && parsed !== null) headers = { ...headers, ...parsed };
      } catch {
        for (const line of rawHeaders.split(/[\n;]/)) {
          const idx = line.indexOf(':') !== -1 ? line.indexOf(':') : line.indexOf('=');
          if (idx !== -1) {
            const k = line.substring(0, idx).trim();
            const v = line.substring(idx + 1).trim();
            if (k) headers[k] = v;
          }
        }
      }
    } else if (typeof rawHeaders === 'object' && rawHeaders !== null) {
      headers = { ...headers, ...(rawHeaders as Record<string, string>) };
    }

    let body: any = undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const content = p['ContentData'] ?? p['Content'] ?? p['body'];
      if (typeof content === 'string') {
        body = content;
      } else if (content !== undefined && content !== null) {
        body = JSON.stringify(content);
      }
    }

    const connectTimeout = Number(p['ConnectTimeout'] || p['ReadTimeout'] || 10000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), connectTimeout);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let resultData: any = text;
      const resultClass = String(p['ResultClass'] || '').trim();
      if (resultClass) {
        try {
          resultData = text ? JSON.parse(text) : {};
        } catch {
          resultData = text;
        }
      }
      if (!res.ok) {
        const handleResponseErrors = String(p['HandleResponseErrors']).toLowerCase() === 'true';
        if (handleResponseErrors) {
          throw new Error(`HTTP ${res.status} from ${url}: ${text}`);
        }
      }
      return {
        Result: resultData,
        Status: res.status,
        result: resultData,
        status: res.status,
      };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  },
};

WORKITEM_HANDLERS.REST = WORKITEM_HANDLERS.Rest;

export const WORKITEM_NAMES = Object.keys(WORKITEM_HANDLERS);
