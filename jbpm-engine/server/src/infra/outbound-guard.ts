// SSRF guard for HTTP service tasks whose `url` field is a full ABSOLUTE url — author-controlled (a
// workflow author can put anything there), unlike a relative url, which is appended to the
// deployment's operator-configured, trusted integrationBaseUrl and is deliberately NOT gated here
// (gating it too would block the default dev setup, whose base url is itself http://localhost:3000 —
// see docs/07-security.md section 5 and http/handler.ts's own url-resolution comment).
import dns from 'node:dns/promises';
import net from 'node:net';
import { config } from './config.ts';

const PRIVATE_V4 = [/^169\.254\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^127\./, /^0\./];

function isBlockedIp(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return PRIVATE_V4.some((re) => re.test(ip));
  if (kind === 6) {
    const l = ip.toLowerCase();
    return l === '::1' || l.startsWith('fe80:') || l.startsWith('fc') || l.startsWith('fd')
      || l.startsWith('::ffff:127.') || l.startsWith('::ffff:169.254.') || l.startsWith('::ffff:10.')
      || l.startsWith('::ffff:192.168.');
  }
  return false;
}

function isAllowlisted(hostname: string, extraAllowlist: string[] = []): boolean {
  const combined = [...config.outboundAllowlist, ...extraAllowlist];
  return combined.some((h) => h === hostname || hostname.endsWith(`.${h}`));
}

/** Throws if `absoluteUrl`'s host is (or resolves to) a private/link-local/loopback/metadata address
 *  and isn't explicitly allowlisted (OUTBOUND_ALLOWLIST env or system setting — comma-separated
 *  hostnames or ".suffix" domains). Blocks the classic cloud-metadata SSRF target (169.254.169.254)
 *  by the same private/link-local rule, no special-case needed. */
export async function assertOutboundAllowed(absoluteUrl: string, dynamicAllowlist?: string[] | string): Promise<void> {
  const { hostname } = new URL(absoluteUrl);
  const extra = Array.isArray(dynamicAllowlist)
    ? dynamicAllowlist
    : (dynamicAllowlist ? dynamicAllowlist.split(',').map((s) => s.trim()).filter(Boolean) : []);
  if (isAllowlisted(hostname, extra)) return;
  const literalIp = net.isIP(hostname) !== 0;
  // an unresolvable hostname isn't an SSRF concern (fetch() will fail with its own, clearer network
  // error) — only a hostname that DOES resolve, to a blocked range, is what this guard is for.
  const ips = literalIp ? [hostname] : (await dns.lookup(hostname, { all: true }).catch(() => [])).map((r) => r.address);
  if (ips.some(isBlockedIp)) {
    throw new Error(`outbound call to "${hostname}" blocked: private/link-local/loopback address (SSRF protection) — add it to OUTBOUND_ALLOWLIST if this is intentional`);
  }
}
