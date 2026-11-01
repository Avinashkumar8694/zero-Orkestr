# Configuration Reference

Configuration lives in two layers: **environment variables** (deployment-time, read once at boot —
`server/src/infra/config.ts`) and **System Settings** (runtime, per-tenant, editable in the UI or via
`PATCH /api/settings/system` without a restart — `server/src/modules/settings/service.ts`).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `4000` | HTTP port the API server listens on |
| `DATA_DIR` | `./.data` | Where the file store persists (one JSON file per entity type) — irrelevant if `STORE=pg` |
| `STORE` | `file` | `file` or `pg` — see [Getting started](01-getting-started.md) for running against Postgres |
| `PG_URL` | `postgresql://jbpm:jbpm@localhost:5433/jbpm` | Postgres connection string, only read when `STORE=pg` |
| `JWT_SECRET` | `dev-insecure-secret-change-me` | HS256 signing key for auth tokens — **set a real value in any non-dev environment** |
| `ADMIN_INITIAL_PASSWORD` | `admin-change-me` | Password for the one-time seeded `admin` user (only used if no users exist yet at boot) |
| `INTEGRATION_BASE_URL` / per-deployment `INTEGRATION_LAYER_URL` | `http://localhost:3000` | Base URL an HTTP service task's *relative* `url` is appended to — see the [HTTP / Service Task](nodes/http-service.md) node doc. Deployment-level `env.INTEGRATION_LAYER_URL` (set at deploy time) overrides the global default per environment |
| `SCRIPT_TIMEOUT_MS` | `2000` | Wall-clock budget for a `js` script task/condition before it fails with `SCRIPT_TIMEOUT` |
| `SCRIPT_OVERFLOW_MODE` | `queue` | **Bootstrap default** of the platform's `scriptOverflowModeDefault`: what happens at a workspace's pool size — `queue` (wait, bounded) or `reject` (refuse immediately with `QUOTA_EXCEEDED`) |
| `SCRIPT_POOL_DEFAULT_SIZE` | `1` | Bootstrap default of `scriptPoolDefaultSize`: pool size (= parallel scripts) for a workspace that doesn't set one |
| `SCRIPT_POOL_MAX_SIZE` | `16` | Bootstrap default of `scriptPoolMaxSize`: **hard cap** on any workspace's pool size. Memory worst case per workspace = pool size × 64 MB |
| `SCRIPT_QUEUE_DEFAULT_MAX` | `1000` | Bootstrap default of `scriptQueueDefaultMax`: how many executions may wait per workspace (queue mode) |
| `SCRIPT_QUEUE_MAX` | `1000` | Bootstrap default of `scriptQueueMaxCap`: hard cap on a workspace's queue length |
| `SCRIPT_QUEUE_TIMEOUT_MS` | `5000` | Bootstrap default of `scriptQueueTimeoutMs`: max wait in the queue before `QUOTA_EXCEEDED` (not counted in `SCRIPT_TIMEOUT_MS`) |
| `SCRIPT_MAX_ISOLATES` | `max(8, 2×CPU cores)` | Bootstrap default of `scriptMaxIsolates`: server-wide ceiling of live isolates **per pod**. Keep it ≥ the sum of the busy workspaces' pool sizes. At the ceiling, waiting workspaces are served round-robin and may reclaim another's *idle* isolate |
| `MAX_ACTIVE_INSTANCES_CAP` / `MAX_ACTIVE_TIMERS_CAP` | `0` (no cap) | Bootstrap defaults of `maxActiveInstancesCap` / `maxActiveTimersCap` |
| `REDIS_URL` | *(unset)* | **Run several replicas? Set this.** `redis://host:6379` (or `rediss://`). Makes request limits, script pools, `maxReplicas` placement, timer ownership and usage counters hold across all replicas. Unset = single-process coordination (correct for exactly one pod). In production a configured-but-unreachable Redis stops the boot |
| `REDIS_KEY_PREFIX` | `orkestr:` | Prefix for every key, so several environments can share one Redis |
| `REPLICA_ID` | `$HOSTNAME` | This replica's name in the cluster (set it to the pod name; it appears in `X-Served-By` and `/api/platform/cluster`) |
| `CLUSTER_LEASE_TTL_MS` / `CLUSTER_HEARTBEAT_MS` | `20000` / `5000` | A replica's claim on a workspace slot expires this long after its last heartbeat (crash recovery time); how often live replicas renew and re-balance |
| `MAX_REPLICAS_CAP` | `0` (no cap) | Bootstrap default of `maxReplicasCap`: most replicas that may serve one workspace |
| `SCRIPT_ISOLATE_IDLE_MS` | `60000` | An idle isolate is disposed after this long (the pool shrinks to zero when a workspace goes quiet) |
| `SCRIPT_ISOLATE_MAX_RUNS` | `1000` | An isolate is recycled after this many executions (also recycled after a timeout, OOM, or near-full heap) |

> **Single pod vs several.** Every workspace limit is a *workspace* number. With `REDIS_URL` set it is enforced across all replicas: the pool size / queue are split exactly over the replicas currently serving the workspace (8 slots over 2 replicas = 4 + 4), request and rate limits are shared counters, and `maxReplicas` bounds how many replicas serve it. `SCRIPT_MAX_ISOLATES` and memory remain **per pod** (a pod's worst case = its share of every workspace it serves). Without `REDIS_URL` the limits are per process, i.e. `limit × N` — fine for one pod only. See [Plans & limits → Running several replicas](plans-and-limits.md#running-several-replicas).

### Platform limits — who controls what (3 levels)

The script runtime and the workspace quotas are governed by a **platform administrator** (the fixed platform-admin SSO identity), not by workspace owners:

```
effective value = min( workspace setting , per-workspace platform cap , global platform cap )     (unset → the default, itself clamped to the cap)
```

| Level | Who sets it | Where | What |
|---|---|---|---|
| **Global** | platform admin | `GET/PUT /api/platform/limits` · UI *Platform limits* | defaults + hard caps: `scriptPoolDefaultSize`, `scriptPoolMaxSize`, `scriptQueueDefaultMax`, `scriptQueueMaxCap`, `scriptQueueTimeoutMs`, `scriptMaxIsolates`, `scriptOverflowModeDefault`, `maxActiveInstancesCap`, `maxActiveTimersCap`. Stored outside any workspace; the env vars above are only the bootstrap defaults, the stored values override them **live** (no restart) |
| **Per workspace** | platform admin | `GET/PUT /api/platform/workspaces/:id/limits` | tighten that workspace's caps/defaults (never above the global cap) and optionally **lock** its overflow mode (`lockedOverflowMode`) |
| **Workspace** | workspace admins | `PUT /api/settings/system` · Settings → System | `scriptPoolSize`, `scriptQueueMax`, `scriptOverflowMode`, `maxActiveInstances`, `maxActiveTimers` — only **within the caps**: above the cap → `422` naming the cap; `0 = unlimited` is accepted only when the cap itself is unlimited; going lower is always allowed |

- **One isolate runs one script at a time, so parallelism = pool size.** `scriptPoolSize` is *the* parallelism/memory knob. `maxConcurrentScripts` is a **deprecated alias** of the workspace's requested pool size (`scriptPoolSize` wins if both are set; `0` now means "platform default", not "unlimited"). The second, separate knob is `scriptQueueMax` (+ the platform's timeout) = how many may *wait*.
- Pools resize live: growing creates isolates lazily and starts waiting work immediately; shrinking drains idle isolates and retires busy ones after their run; queued work is never dropped.
- `GET /api/settings/system` returns the workspace's `effectiveLimits` and its read-only `limitCaps`; `GET /api/platform/limits/usage` (platform admin) lists every workspace's effective limits, pool size, running, queued, peak, created/recycled. Every platform change is audited (`platform.limits.updated`, `platform.workspace-limits.updated`).
- Every workspace owner/admin gets `403` on `/api/platform/*`; settings keys that are not workspace settings (including all caps) are refused with `422`.
- Workspace settings are stored **per workspace** (earlier builds shared one row, so one workspace's save overwrote another's; legacy rows are still read).


| `WS_PATH` | `/ws` | WebSocket path for live UI updates (node/task/instance events) |
| `DEFAULT_TENANT` | `default` | The workspace a request resolves to when it sends no `x-tenant-id` (the caller still has to be a member) |
| `PLATFORM_ADMIN_EMAIL` | `arjunkumargupta108@gmail.com` (dev/test only) | The one platform administrator: a verified SSO identity, always seeded as `system_admin`. **Required in production** (start-up refuses without it) |
| `OIDC_ISSUER` (alias `IDS_ISSUER_URL`) | *(unset = SSO off)* | Identity Server issuer, e.g. `https://ids.fabrixly.com/oidc` (discovery at `/.well-known/openid-configuration`). Must be https in production |
| `OIDC_CLIENT_ID` (alias `IDS_CLIENT_ID`) | *(unset)* | Registered client id (`zero-orkestr`) |
| `OIDC_CLIENT_SECRET` (alias `IDS_CLIENT_SECRET`) | *(unset = public client, PKCE only)* | Client secret, sent as `client_secret_basic`. **Secret — environment/secret store only, never committed** |
| `OIDC_REDIRECT_URI` | `http://localhost:$PORT/api/auth/oidc/callback` | Must be registered at the IdP (prod: `https://orkestr.fabrixly.com/api/auth/oidc/callback`; local: `http://localhost:4000/…` or `http://localhost:4200/…`) |
| `OIDC_AUDIENCE` | the client id | Comma-separated accepted `aud` values for bearer tokens |
| `OIDC_CLOCK_TOLERANCE_SEC` | `30` | Clock skew allowed when checking `exp`/`nbf` |
| `DASHBOARD_URL` | `APP_ORIGIN`, else `http://localhost:4200` | Where the SSO callback and logout send the browser (post-logout URI must be registered: `https://orkestr.fabrixly.com`, `http://localhost:4200`, `http://localhost:4000`) |
| `AUTH_REGISTRATION_METHOD` | `temp_password` | `temp_password` = Identity-Server / rules-manager model: sign-up asks for name + email only, a **temporary password** is emailed, signing in with it creates the account, and the first sign-in forces choosing a real password. `password` = the person picks a password at sign-up (pair with `AUTH_REQUIRE_EMAIL_VERIFICATION`) |
| `AUTH_TEMP_PASSWORD_HOURS` | `72` | How long an emailed temporary password stays valid (expired → "register again") |
| `AUTH_OTP_LOGIN` | `false` | Passwordless sign-in with an emailed 6-digit code (10 min, 5 attempts, single use) |
| `AUTH_BLOCK_DISPOSABLE_EMAILS` | `true` | Refuse throw-away mailbox domains at registration |
| `AUTH_ALLOWED_EMAIL_DOMAINS` | *(empty)* | Comma-separated; if set, only these domains may self-register |
| `AUTH_TOS_URL` | *(unset)* | If set, registration requires accepting the terms at this URL |
| `AUTH_REGISTRATION` | `true` | Self-service account creation (needs local login); the landing page's "Get started" goes to `/register` when on, else to sign-in |
| `AUTH_FORGOT_PASSWORD` | `true` | Forgot / reset password flow (needs local login) |
| `AUTH_REQUIRE_EMAIL_VERIFICATION` | `false` | A registered account cannot sign in until it confirms its email |
| `AUTH_PASSWORD_MIN_LENGTH` | `8` | Minimum password length (never below 8); self-service passwords also need a letter and a digit and may not be common |
| `AUTH_MAX_FAILED_LOGINS` / `AUTH_LOCKOUT_MINUTES` | `5` / `15` | Account lockout after consecutive wrong passwords |
| `SMTP_HOST` `SMTP_PORT` `SMTP_SECURE` `SMTP_USER` `SMTP_PASSWORD` | *(unset)* | Real SMTP delivery (aliases `EMAIL_HOST/PORT/SECURE/USER/PASS` as in rules-manager) |
| `MAIL_FROM` | `no-reply@$DOMAIN` | From address |
| `MAIL_WEBHOOK_URL` | *(unset)* | Alternative to SMTP: JSON relay `{from,to,subject,text,html}`. With neither, mails are only logged in dev (never in production) and invitation links are returned to the inviter |
| `AUTH_LOCAL_LOGIN` | `true` | Set `false` to disable `POST /auth/login` and HS256 tokens once SSO is the only way in |
| `NODE_ENV` | — | `production` makes start-up refuse a default `JWT_SECRET`/`ADMIN_INITIAL_PASSWORD` and a non-https issuer |
| `JAVA_SIDECAR_CLASSPATH` | `<repo>/java-runtime/out` | Compiled classes for the Java script sidecar |
| `JAVA_SIDECAR_STARTUP_TIMEOUT_MS` | `10000` | How long to wait for the sidecar JVM to report ready at boot |
| `JAVA_SIDECAR_TIMEOUT_MS` | `10000` | Per-request timeout for a sidecar `/execute` call (the first call for a given script includes a real `javac` compile) |
| `OUTBOUND_ALLOWLIST` | *(empty)* | Comma-separated hostnames or `.suffix` domains an HTTP service task's **absolute** URL is allowed to reach even though it resolves to a private/link-local/loopback address — see [Security & quotas](10-security-and-quotas.md) |
| `APP_ORIGIN` | `*` (dev) | CORS origin allowed to call the API — **set this to your real app origin in any non-dev environment** |

## System Settings (runtime, no restart needed)

**Settings → System** in the UI, or `GET`/`PATCH /api/settings/system` (requires `admin:iam`). One row
per tenant; a missing row returns documented defaults, so there's no seed step.

### Process engine

| Field | Default | Meaning |
|---|---|---|
| Default items per page | `20` | Applies to Instances, Tasks, Errors, Jobs, Audit lists (`10`/`20`/`50`/`100`) |
| Instance history retention (days) | `90` | Completed/aborted instances older than this are eligible for pruning |
| Allow variable edits on running instances | `on` | When off, the Variables tab is read-only for everyone, even admins |

### Resource quotas — *see [Security & quotas](10-security-and-quotas.md) for full detail*

| Field | Default | Meaning |
|---|---|---|
| Max active instances | `0` (unlimited) | Top-level (root) process instances running/waiting at once, per tenant |
| Max active timers | `0` (unlimited) | Scheduled boundary/catch `TimerJob` rows at once, per tenant |
| Max concurrent scripts | `0` (unlimited) | Script-task/exit-script executions running at this instant, per tenant |

### Jobs & timers

| Field | Default | Meaning |
|---|---|---|
| Executor interval (seconds) | `5` | How often the durable timer poller checks for due jobs |
| Default job retries | `3` | Attempts before a job is marked failed and surfaced in Execution Errors |

### Notifications & email

| Field | Default | Meaning |
|---|---|---|
| SLA warning threshold | `80%` | When a task flips from on-track to at-risk (percent of time-to-due elapsed) |
| Email delivery | `off` | Needed for SLA-breach/reminder emails; in-app notifications work without it |
| From address / SMTP host / SMTP port | — | Only shown/used when email delivery is on |

### Security & session

| Field | Default | Meaning |
|---|---|---|
| Session timeout (hours) | `8` | How long a JWT stays valid after login |
| Audit retention (days) | `365` | Pruned by the same scheduled job as instance history |

## Precedence

Deployment-level `env` (set when you deploy — e.g. `INTEGRATION_LAYER_URL`) always overrides the
matching global environment variable for instances running on that deployment. System Settings never
override environment variables or deployment env — they're a distinct, runtime-editable layer for
operational limits and defaults, not secrets or connection strings.
