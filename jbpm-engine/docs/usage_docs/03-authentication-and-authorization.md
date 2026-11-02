# Authentication & Authorization

## Logging in

`POST /api/auth/login` with `{ username, password }` returns a JWT (`token`) and the user's public
profile. The Angular app stores the token in `sessionStorage` and attaches it as `Authorization:
Bearer <token>` on every subsequent request (`core/auth/auth.interceptor.ts`). Tokens expire after
the **Session timeout (hours)** System Setting (default 8h) and carry `sub` (user id), `username`,
`roles`, and `groups`.

Every route except `GET /api/health` and `POST /api/auth/login` requires a valid token — there is no
trust-any header. A missing/invalid/expired token gets `401 AUTH_REQUIRED`.

Self-service password change: `POST /api/auth/me/password` (current + new password, any authenticated
user, their own account only). Admin-set password: `POST /api/users/:id/password` (requires
`admin:iam`).

## API keys (programs, not people)
An API key is a credential for server-to-server calls, accepted next to access tokens. A workspace admin creates it in **Admin → API keys** (or `POST /api/api-keys`), ticks the permissions it needs, optionally sets an expiry, and copies the key (`ork_<id>.<secret>`) **once**; only a hash is stored.

| | |
|---|---|
| Send it as | `X-API-Key: ork_…`, or `Authorization: ApiKey ork_…`, or `Authorization: Bearer ork_…` |
| Acts as | the key itself (`apikey:<name>` in audit logs), never as a person |
| Scope | exactly one workspace (naming another with `x-tenant-id` is 403) and exactly the permissions on the key |
| Limits on what it can hold | a subset of what its creator holds; never `*`, `admin:*` or `team:manage`, so a key cannot manage users, roles, keys or the workspace |
| Lifetime | optional expiry; revoking stops it at once (401); `lastUsedAt` is kept |
| Not available to keys | endpoints about a signed-in person (profile, own availability) and the WebSocket event stream |

Rotate by creating a second key, switching the integration over, then revoking the first. Plan limits and rate limits of the workspace apply to key traffic as to any other.

## Roles & permissions

Roles are real, editable rows (`Admin → Roles`), not a hardcoded enum — but five are seeded on first
boot and cover the common cases:

| Role | Permissions | Typical user |
|---|---|---|
| `admin` | `*` (everything) | Platform operator |
| `author` | `workflow:view`, `workflow:edit` | Process designer |
| `release` | `workflow:view`, `workflow:deploy` | Release manager |
| `operator` | `workflow:view`, `workflow:run`, `query:read` | Runs and monitors instances |
| `worker` | `task:manage` | Works the task inbox only |
| `viewer` | `workflow:view`, `query:read` | Read-only / reporting |

The full permission taxonomy (`Admin → Roles → edit`, checkbox list — not freeform text, since the
server does zero validation on a hand-typed permission string):

| Permission | Grants |
|---|---|
| `workflow:view` | View projects & processes |
| `workflow:edit` | Edit projects & processes |
| `workflow:deploy` | Deploy projects |
| `workflow:run` | Start/signal/suspend/resume/abort/retry instances |
| `query:read` | Read analytics & cross-project queries |
| `task:manage` | Access the Task Inbox and act on tasks |
| `admin:iam` | Manage users, roles, groups, System Settings, and the Audit Log |
| `*` | Everything (only meaningful on `admin`) |

Every route declares the permission it needs server-side (`requirePermission`, `http/auth-middleware.ts`)
— there is no client-trust shortcut. An unknown or absent permission is `403 FORBIDDEN` by default
(deny-by-default), not silently allowed.

A `ns:*` namespace wildcard is also supported on a custom role (e.g. a role with only `workflow:*`) if
you need something between the seven fixed strings and full admin.

## Users & groups

`Admin → Users` / `Admin → Groups` (both `admin:iam`). A user has a username, one or more roles, and
zero or more groups. Groups are how [human tasks](07-human-tasks.md) get assigned to a team rather
than one person — a task's `group` field (set on the [User Task](nodes/user-task.md) node) is matched
against the acting user's `groups`, independent of their roles.

## Task-level segregation of duties

This is a **second, independent check**, layered on top of role permissions — matches real jBPM's own
design, not a bug if it surprises you:

- `admin`'s `*` role permission still does **not** let them claim/complete a group-gated task unless
  they are actually a member of that group (or the task's specific `assignee`, or its
  `businessAdmin`, which overrides both checks).
- `excludedOwners` on a task (e.g. "the submitter can't also approve their own claim") blocks a user
  from claiming/completing even if they're in the right group — checked against `TaskService.claim`/
  `.complete`/`.skip`, not against `businessAdmin`.
- This only activates for real, IAM-provisioned accounts. An un-registered actor string (e.g. a
  system/timer-driven action) is unaffected.

## Multi-tenancy

Every entity carries a `tenantId`, and the store enforces it on every query — genuinely real, not
theater. But every request currently resolves to the one `config.defaultTenant` (`default`); there is
no JWT-bound tenant claim or tenant-management API. This is a deliberate scope decision (see
[Security & quotas](10-security-and-quotas.md)), not an oversight — if you need real multi-tenancy,
that's a follow-up project, not a flag to flip.
