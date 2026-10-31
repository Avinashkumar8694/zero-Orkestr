# Security & Quotas

This is the usage-facing summary. For the full threat model and implementation detail, see
[`../07-security.md`](../07-security.md).

## Per-tenant resource quotas

Three independent limits, all on **Settings → System → Resource quotas** (or `PATCH
/api/settings/system`), all defaulting to `0` (unlimited):

| Quota | What it counts | Where it's enforced | On breach |
|---|---|---|---|
| **Max active instances** | Top-level (root) instances currently `running`/`waiting`, per tenant. Child/subprocess instances aren't separately counted — they're a consequence of a parent that already passed the check | `InstanceService.start()` / `.startScheduled()` | `429 QUOTA_EXCEEDED` from the start API call |
| **Max active timers** | Scheduled boundary/catch `TimerJob` rows, per tenant | `ExecutionEngine.scheduleTimer()` | A catchable node error, `errorCode: 'QUOTA_EXCEEDED'` — add an [error catch](nodes/boundary.md) to recover, or the instance fails |
| **Max concurrent scripts** | Script-task/exit-script executions running *at this instant*, per tenant (in-memory, not persisted — resets on restart, which is correct since nothing was really still running across a restart either) | Every [Script task](nodes/script.md) / [HTTP task](nodes/http-service.md) exit-script execution | Same catchable node error |

Set any of these when you need to protect the server from one tenant's runaway or misbehaving
workflow (an infinite loop spawning timers, a script-heavy process under load). Leave them at `0`
until you actually need the ceiling — they default off so no existing deployment is surprised by them.

## Rate limiting

In-memory, per-process (not distributed — if you ever run this multi-instance behind a load balancer,
this needs to move to a shared store):

| Route | Limit | Keyed by |
|---|---|---|
| `POST /auth/login` | 10 / 60s | Client IP (no user yet at this point) |
| `POST /instances` (start) | 120 / 60s | Authenticated user |
| `POST /versions/:id/deploy` | 20 / 60s | Authenticated user |
| `POST /import/jbpm`, `/import/jbpm/deploy` | 20 / 60s | Authenticated user |

Exceeding a limit returns `429 RATE_LIMITED`. This slows credential-stuffing on login and caps how hard
one user (or a runaway script hitting the API) can hammer the heaviest routes — it is not a
replacement for the quotas above, which cap steady-state resource usage, not request rate.

## SSRF protection on HTTP service tasks

An [HTTP / Service Task](nodes/http-service.md)'s `url` field has two shapes:

- **Relative** (`/v1/claims`) — appended to the deployment's own configured, operator-trusted base URL
  (`INTEGRATION_LAYER_URL`). Never gated — this is the intended, safe path for calling your real
  backend, even if that backend happens to be on `localhost` in dev.
- **Absolute** (`http://...`) — author-controlled (anyone who can edit the process can put anything
  here). Gated: blocked if the hostname (or its resolved IP, for a real DNS name) is a
  private/link-local/loopback address, including the classic cloud-metadata SSRF target
  (`169.254.169.254`). A blocked call fails the node with `errorCode: 'SSRF_BLOCKED'`, catchable like
  any other node error.

To intentionally allow an absolute URL that would otherwise be blocked (e.g. a legitimate internal
service), add it to `OUTBOUND_ALLOWLIST` (comma-separated hostnames or `.suffix` domains) — see
[Configuration](02-configuration.md).

## Script sandboxing

`js` script tasks/conditions (and the `Compute` work item) run in a fresh `isolated-vm` V8 isolate per execution — a real
isolation boundary: no `require`, `process`, `fs`, network or host objects exist inside it, prototype-chain escapes
reach nothing, the server environment is unreadable, heap is capped (64 MB) and a wall-clock timeout applies
(`SCRIPT_TIMEOUT_MS`, default 2s). Only JSON crosses the boundary, so scripts must keep process variables
JSON-serialisable. Safe for mutually-untrusted tenant authors.

`java`-dialect scripts (from real jBPM imports) never run as transpiled JavaScript — they're compiled
and executed as real Java in a separate sidecar process, one compile per distinct script (cached).

## Security headers & transport

Every JSON API response carries `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, and a strict `Content-Security-Policy` (the one HTML page, `/api/docs`'s
Swagger UI, is exempted so its CDN assets still load). TLS termination, HSTS, and locking `APP_ORIGIN`
to your real app origin are the deploying operator's responsibility — not built into this repo, since
they belong at the proxy/infra layer.

## Secrets Management & Dual-Tier RSA Cryptography

The engine provides an enterprise-grade **Dual-Tier RSA Cryptographic Architecture** protecting secrets and credentials both on the wire and in persistent storage:

1. **In-Transit Protection (Ephemeral RSA 2048)**:
   - On server startup, an ephemeral 2048-bit RSA key pair is generated in-memory.
   - The public key is retrieved by the frontend via `GET /api/crypto/public-key`.
   - Before passwords (`/auth/login`) or secrets (`Settings → System → Secrets`) are sent across the network, the browser encrypts them using native Web Crypto (`crypto.subtle`) with **RSA-OAEP SHA-256**.
   - Wire payloads appear prefixed with `rsa:v1:...`. The backend decrypts them in-memory; private keys are never written to disk and regenerate on each reboot.

2. **At-Rest Protection (Persistent RSA 2048)**:
   - Secret key-value pairs configured in System Settings are encrypted using a persistent RSA key (`encryptAtRest`) before persistence into the database.
   - The key is configured via `SECRETS_ENCRYPTION_PRIVATE_KEY` / `SECRETS_ENCRYPTION_PUBLIC_KEY` environment variables, or automatically persisted to `.secrets_rsa_key` in the data directory.
   - In the database, secret values are stored exclusively as `rsa:at-rest:...` ciphertext.
   - API endpoints (`GET /api/settings/secrets`) return only masked values (`********`).
   - Decryption occurs in-memory only at the moment a secret is injected into an HTTP service task or script runner.
