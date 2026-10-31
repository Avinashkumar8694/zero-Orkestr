# 07 — Security

## 1. Threat model (STRIDE, summarized)

| Threat | Surface | Mitigation |
|--------|---------|-----------|
| **Spoofing** | API/WS auth | JWT implemented for the REST API (`requireAuth`, no anonymous mutating routes) — refresh tokens and a WS token handshake are not built; the WebSocket hub itself has no auth today |
| **Tampering** | Versions/deployments | Immutable published versions & deployment snapshots; optimistic locks; audit |
| **Repudiation** | Any action | Append-only audit with actor, time, before/after (redacted) |
| **Information disclosure** | Variables, secrets, payloads | Tenant isolation on every query; secrets never in engine JSON; Dual-Tier RSA encryption (ephemeral in-transit + persistent at-rest); payload redaction in logs/audit |
| **Denial of service** | Script tasks, HTTP tasks, timers | Sandbox CPU/time budget; per-tenant rate limits — **implemented**; timer/instance/script quotas — **implemented**; outbound allowlist — **implemented** |
| **Elevation of privilege** | RBAC | Deny-by-default; role checks server-side on every route; no client-trust |

## 2. AuthN / AuthZ — **implemented**

- **AuthN**: `POST /auth/login` (username/password) → JWT (`sub`, `username`, `roles`, `groups`, 12h
  expiry, HS256 via `jsonwebtoken`). Passwords are scrypt-hashed (`infra/auth.ts`), never returned by
  any API. `requireAuth` (`http/auth-middleware.ts`) verifies the `Authorization: Bearer <token>` on
  every route except `/health`, `/auth/login`, `/auth/config` and `/auth/oidc/*` — there is no
  trust-any header anymore.
  **Single sign-on** (same Identity Server contract as `zero-payment-ms`): `GET /auth/oidc/login` →
  IdP (authorization code + **PKCE S256**, `state`, `nonce`; `client_secret_basic` at the token
  endpoint; the transaction lives in a signed HttpOnly `oidc_tx` cookie) → `GET /auth/oidc/callback`
  → SPA `/auth/callback` with the tokens in the URL **fragment**. Bearer tokens are verified against
  the issuer's JWKS (`infra/oidc.ts`): asymmetric algorithms only, `iss`/`aud`/`exp` enforced, fail
  closed. HS256 is accepted only for tokens this server signed itself (local login). See
  `usage_docs/02-configuration.md` for the `OIDC_*`/`IDS_*` variables.
- **Workspaces (multi-tenancy)**: every request is scoped by `x-tenant-id` and the caller must be an
  **active member** of that workspace (`requireWorkspaceAccess`), else 403 — an explicit workspace is
  never silently swapped. The ONE platform administrator (`PLATFORM_ADMIN_EMAIL`, an environment variable, required in production) always seeded as `system_admin` of the default workspace, recognised on a *verified* SSO email), may use any workspace and the `all` platform view; nobody else can — not a `system_admin` role on another seat, not the first member, not the local `admin`. A membership created ahead of time
  (signup, invitation, the platform-admin seed) carries a placeholder `userId` and is **bound to the
  caller's `sub` on the first sign-in with that email *verified*** (`modules/tenants/identity.ts`);
  a bound seat is never re-bound, an email alone never matches. With SSO on, `POST /tenants/signup`
  requires sign-in and makes the caller the owner. Workspace roles map to permissions through the
  workspace's own `Role` rows, falling back to `DEFAULT_ROLES`. WebSockets are bound to one workspace
  and can only subscribe to that workspace's instances; the timer scheduler fires per workspace.
  Production start-up refuses weak defaults (`assertProductionConfig`).
- **Script sandbox**: `js` script tasks, flow conditions and the `Compute` work item run in `isolated-vm` V8 isolates
  (64 MB heap cap, hard wall-clock timeout, no Node APIs, no host objects — only JSON crosses the boundary).
  Prototype-chain escapes resolve to `undefined`; the host environment (secrets) is unreadable (`System.getenv`/
  `Environment.get` see only the instance `env`). Isolates come from a **bounded pool keyed by workspace**
  (`src/engine/isolate-pool.ts`): an isolate is never shared across workspaces and runs one execution at a time;
  **every execution gets a fresh context** (new global scope/realm) so no `globalThis` write or prototype pollution
  survives into the next script. Effective concurrency (= pool size) = min(workspace `scriptPoolSize` (alias `maxConcurrentScripts`), per-workspace cap, global cap), default `scriptPoolDefaultSize`;
  at that limit the overflow mode decides: `queue` (default) waits in a bounded per-workspace FIFO queue
  (`SCRIPT_QUEUE_MAX`, `SCRIPT_QUEUE_TIMEOUT_MS` → `QUOTA_EXCEEDED`), `reject` refuses immediately with
  `QUOTA_EXCEEDED` — platform default `scriptOverflowModeDefault` (env `SCRIPT_OVERFLOW_MODE`), overridable per workspace
  via `scriptOverflowMode` unless the platform admin locked it. Counters/queues are per pod (limit × pods in a
  multi-pod deployment).
  **Who may change limits:** the caps are platform-admin-only (`/api/platform/*`, 403 for every workspace role, local admin and
  every other SSO user). A workspace admin can only set values *within* the caps (422 otherwise, `0 = unlimited` refused when
  capped, non-workspace keys refused), so a self-registered workspace owner cannot lift `maxConcurrentScripts`,
  `maxActiveInstances` or `maxActiveTimers` to defeat platform protection. See usage_docs/02-configuration.md → *Platform limits*.
  a global ceiling (`SCRIPT_MAX_ISOLATES`) with round-robin fairness stops one workspace starving others, and an isolate
  is recycled after a timeout/OOM/`SCRIPT_ISOLATE_MAX_RUNS` and evicted after `SCRIPT_ISOLATE_IDLE_MS` idle.
  `acquireScriptSlot` remains a hard-reject admission cap used only for the `java` sidecar (no pool there); `js` never
  touches it, so nothing is counted twice.
  Covered by EXE-91/91b/91c/91d and POOL-1…6; `sandboxStats()` exposes counters. `java` scripts run in the JVM sidecar.
- **Task ownership**: once claimed, a task can be completed/saved/released/delegated/forwarded only by its owner, its
  business admin, or a workspace owner/admin; a task held by someone else cannot be claimed.
- **Team management** (same model as `zero-payment-ms`'s TeamService; `modules/tenants/team.ts`,
  `http/team-routes.ts`, UI at `/team`): exactly one **owner** per workspace, **admins**, and role-based
  members (built-in roles + the workspace's own `Role` rows). `POST /team/members/invite` (`team:invite`)
  creates an `invited` seat with a single-use 7-day token (stored hashed; there is no mail transport, so the
  link is returned to the inviter). The invitee signs in and `POST /team/invitations/accept`s — their
  *verified* email must equal the invited one. `canManage`: nobody manages themselves, nobody touches the
  owner except via `POST /team/ownership/transfer` (owner only, to an active member; the old owner becomes
  admin), admins cannot manage or mint admins, the platform-admin seat is untouchable, `POST /team/leave`
  for everyone but the owner. Permissions: `team:read` (all roles), `team:invite`, `team:manage` (owner/admin).
- **Verification**: `test/rbac-matrix.test.ts` runs every route × every role × every scope (no token,
  non-member, suspended, other workspace, `all`, local admin) and checks the UI's permission list equals
  the server's; `test/tenant-isolation.test.ts` probes every id-addressed route with another workspace's
  ids; `test/team.test.ts` and `test/oidc-sso.test.ts` cover team rules and SSO.
- **AuthZ**: RBAC with roles `admin`, `author`, `release`, `operator`, `worker`, `viewer`, seeded on
  first boot (`modules/iam/service.ts`'s `DEFAULT_ROLES`) — each a named `Role` row carrying a
  `permissions: string[]` list (real, editable rows, not a hardcoded enum). Every route declares its
  required permission via `requirePermission(action)`; `admin`'s `'*'` grants everything, and
  `'ns:*'` namespace wildcards are supported. The permission taxonomy is coarser than one string per
  route (`workflow:view/edit/deploy/run`, `task:manage`, `query:read`, `admin:iam`) — deliberately, to
  keep the surface reviewable rather than 50+ near-duplicate strings.
  **Not yet wired**: `WorkflowPermission[]` (per-workflow grants layered on top of roles) is still
  only stored via `PUT /workflows/:id/permissions`, not read by any authorization check — role-based
  access is real, but a workflow's own bespoke grant list isn't consulted yet.
- **Task-level**: `TaskService.claim/complete/skip` enforce `excludedOwners` (segregation of duties)
  and, for any acting username that resolves to a real registered `User`, group membership against
  the task's `group` (or the existing assignee, or the task's `businessAdmin`, which always overrides
  both checks). This only activates for real IAM-provisioned accounts — an un-registered actor string
  is unaffected, so pre-IAM callers keep working exactly as before.
- **Deny by default**: unknown/absent permission → 403 (`FORBIDDEN`); missing/invalid/expired token →
  401 (`AUTH_REQUIRED`).
- **Bootstrap**: if no users exist at boot, one `admin` user is seeded from `ADMIN_INITIAL_PASSWORD`
  (default `admin-change-me` — set a real value outside local dev).

## 3. Multi-tenancy — **partial, and intentionally not pursued further**

- Every entity carries `tenantId`; the store enforces it (`FileStore`/`PgStore`/`MemoryStore` alike —
  no cross-tenant reads even by id). This part is real and exercised by every module.
- **Deliberately not built**: JWT-bound multi-tenancy (binding a caller's token to one tenant among
  many) and any tenant management API. Every request resolves to the single `config.defaultTenant`
  ('default') — there is currently no way to have more than one tenant in practice. This was an
  explicit scope decision (real multi-tenancy adds meaningful surface — tenant provisioning, JWT claim
  validation, cross-tenant admin actions — for no current need), not an oversight.

## 4. Script & expression sandboxing

- **JavaScript (`js`)**: executed in a per-execution `isolated-vm` isolate (a pooled, tenant-private isolate with a fresh context
  per call) exposing **only** `kcontext` (get/setVariable, node/instance context) and a safe stdlib subset. **No** `require`,
  `process`, `fs`, network, globals, or prototype escape.
  - **Limits**: wall-clock timeout (`SCRIPT_TIMEOUT_MS`, default 2s, or the workspace's `scriptTimeoutSeconds`), a memory cap,
    no async I/O from scripts. Timeout → node fails with `SCRIPT_TIMEOUT` (retryable).
- **Java (`java`)**: Real Java execution supported via the JVM Sidecar process (`jbpm-engine/java-runtime/`).
  - **Static denylist** (`java-compat.ts`): Scanned prior to execution for prohibited reflection,
    `System.exit`, thread creation, and socket operations.
  - **Compiler wrapper**: Scripts and conditions compile as typed methods against a synthetic `kcontext`
    wrapper with declared process variable types.
  - **Build-stage pre-compilation**: Validated at publish time via `java-support` rule; bytecode cache is
    pre-warmed for instant zero-compile runtime execution.
- `mvel` dialect is not executed (recorded as skipped with advisory warning, preserved for export).

## 5. Outbound (HTTP service tasks) — allowlist **implemented**, secrets integrated

- Base URL comes from the **deployment env** (`INTEGRATION_LAYER_URL`), not author-controlled arbitrary
  hosts — a *relative* `url` is always appended to it and is never gated. An **absolute** `url` (an
  author can put anything there) IS gated: `infra/outbound-guard.ts`'s `assertOutboundAllowed` blocks
  it if the hostname (or its resolved IP, for a real DNS name) falls in a private/link-local/loopback
  range — this includes the classic cloud-metadata SSRF target, 169.254.169.254, via the same
  link-local rule, no special case needed. Override per-deployment via the `OUTBOUND_ALLOWLIST` env
  var (comma-separated hostnames or `.suffix` domains). A blocked call fails the node with
  `errorCode: 'SSRF_BLOCKED'`, catchable by an Error Catch like any other node failure.
- Secrets referenced by name (`{{secret:NAME}}`) are injected at call time from the encrypted secret store;
  never stored in engine JSON, never logged.

## 6. Secrets management & Dual-Tier RSA Cryptography — **implemented**

The platform implements an enterprise **Dual-Tier RSA Cryptographic Architecture** (`server/src/infra/crypto.ts` + `app/src/app/core/crypto/crypto.service.ts`):

```
┌────────────────────────────────────────────────────────┐
│ UI / Browser Client                                    │
│  - Fetches ephemeral public key from /api/crypto/public-key
│  - Encrypts password/secrets with Web Crypto (RSA-OAEP)│
└───────────────────────────┬────────────────────────────┘
                            │ Wire In-Transit (rsa:v1:...)
                            ▼
┌────────────────────────────────────────────────────────┐
│ Backend API Gateway                                    │
│  - Decrypts with Ephemeral Private Key in-memory      │
│  - Encrypts with Persistent RSA Key for DB storage     │
└───────────────────────────┬────────────────────────────┘
                            │ At-Rest (rsa:at-rest:...)
                            ▼
┌────────────────────────────────────────────────────────┐
│ Database / Persistent Store (kv_store / Postgres)     │
│  - Zero plaintext secrets at rest                     │
│  - Decrypted only when executed (HTTP/Script calls)   │
└────────────────────────────────────────────────────────┘
```

- **Tier 1: In-Transit Cryptography (Ephemeral RSA 2048)**:
  - An ephemeral 2048-bit RSA key pair is generated on every server startup in memory.
  - The public key is exposed via unauthenticated endpoint `GET /api/crypto/public-key`.
  - Frontend encrypts sensitive fields (login passwords, secret values) using native Web Crypto
    `window.crypto.subtle` with RSA-OAEP SHA-256 before wire transmission.
  - Ephemeral private key is never written to disk and is regenerated every time the server restarts
    (guaranteeing forward secrecy across server lifecycles).
  - Payloads prefixed with `rsa:v1:` are automatically decrypted in memory by `decryptInTransit()`.

- **Tier 2: At-Rest Cryptography (Persistent RSA 2048)**:
  - Secrets stored in the database or settings collection (`SettingsService.setSecrets`) are encrypted
    using a persistent RSA key (`encryptAtRest`).
  - Key configuration: Configured via environment variables `SECRETS_ENCRYPTION_PRIVATE_KEY` and
    `SECRETS_ENCRYPTION_PUBLIC_KEY`, with automatic generation and persistence to `.secrets_rsa_key`
    in the server data directory if unspecified.
  - Ciphertext is prefixed with `rsa:at-rest:`.
  - Secrets are **never** returned in API responses (values are masked as `********`).
  - Decryption happens exclusively in-memory when a secret is actively needed (e.g., injecting
    headers into HTTP service tasks or providing credentials to script runners).

## 7. Input validation & output encoding

- All request bodies validated with zod DTOs; reject unknown fields on sensitive routes.
- Engine JSON validated via SDK `validateModel` before persist/deploy/run.
- API returns JSON only; Angular escapes by default (avoid `[innerHTML]`; sanitize any rich text).
- File/zip import: size limits, path traversal guards, only expected asset extensions; scan for zip
  bombs (entry count/uncompressed size caps).

## 8. Transport & headers — partial

- TLS everywhere (terminate at proxy). HSTS, secure cookies if used. — **not built** (proxy's job; no
  proxy config lives in this repo).
- CORS: locked to `APP_ORIGIN` when set; defaults to `*` in dev if unset — **set `APP_ORIGIN` in any
  non-dev environment**, this is not enforced automatically.
- Security headers — **implemented** (`app.ts`): `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Content-Security-Policy: default-src
  'none'` on every JSON API response (the one HTML response, `/api/docs`'s Swagger UI, is exempted so
  its CDN-hosted assets keep working).
- CSRF: token auth in `Authorization` header (not cookies) avoids CSRF; if cookies used, add CSRF token.

## 9. Rate limiting & quotas — **implemented**

- Per-principal (JWT `sub`) rate limits, in-memory/single-process (`http/rate-limit.ts`): login is
  limited per-IP (no user yet at that point); start-instance, deploy, and import are limited per-user.
  A caller over the limit gets `429 RATE_LIMITED`. Not a distributed limiter — if this server is ever
  run multi-instance behind a load balancer, this needs to move to a shared store.
- Per-tenant quotas on `SystemSettings` (configured via the existing System Settings API/UI —
  `PATCH /settings`, "Resource quotas" card): `maxActiveInstances` (top-level instances
  running/waiting), `maxActiveTimers` (scheduled boundary/catch TimerJobs), `maxConcurrentScripts`
  (script-task/exit-script executions running at this instant, tracked in-memory per tenant —
  `infra/quotas.ts`). All three default to `0` (unlimited) so existing tenants are unaffected until an
  admin opts in. A breach raises `429 QUOTA_EXCEEDED` at the API layer, or — for a quota hit mid-flow
  (a timer that couldn't be scheduled) — a catchable `errorCode: 'QUOTA_EXCEEDED'` node failure, same
  as any other engine error.

## 10. Audit & observability

- Append-only `audit` for auth, authz denials, version publish, deploy/activate/rollback, instance
  lifecycle, task actions, admin/secret changes. Redact variable payloads to configured fields.
- Structured logs with correlation ids; no secrets/PII in logs.

## 11. Dependency & supply chain

- Pin versions; `npm audit` in CI; lockfile committed; minimal deps; SDK is first-party.

## 12. Data protection

- Encrypt sensitive variables at rest if flagged; TTL/retention for completed instances & audit;
  export/delete per-subject (GDPR) via admin tooling (P2).
