# Enterprise test catalogue

Every scenario an enterprise multi-tenant workflow platform should prove, where it is tested, and what is **not**
covered. Run everything with `npm test --workspace server` (≈ 300 tests, no external services; the 25 Java-sidecar
tests need a JDK and fail without one; inside the production image's Linux + JDK environment the whole suite passes). IDs below are in the test titles, so `--test-name-pattern="EXE-3"` etc. work.

Legend: ✅ automated · 🟡 partly · ⛔ known gap (listed again at the end)

## 1. Sign-in surface (configuration-driven) — `auth-accounts.test.ts`, `oidc-sso.test.ts`
| ID | Scenario | |
|---|---|---|
| AUTH-CFG-01 | `/auth/config` reflects every flag (SSO, local login, registration, forgot-password, email verification, password policy); local-only features disappear when local login is off | ✅ |
| AUTH-CFG-02 | every disabled feature answers 404 on every endpoint | ✅ |
| AUTH-CFG-03 | local login off ⇒ already-issued local tokens are refused too | ✅ |
| oidc-sso | SSO: PKCE S256 + state + nonce, `client_secret_basic`, tokens only in the URL fragment, forged/missing transaction cookie, open-redirect `return_to`, logout via end-session, JWKS verification (wrong key/aud/iss/expired/alg-none/HS256-confusion) | ✅ |
| oidc-sso | claim-by-verified-email (unverified refused, bound seat never re-bound), platform admin only by verified email, SSO signup requires sign-in and ignores a free-text owner | ✅ |
| REG-TMP-01…08 | **Identity-Server style onboarding**: register asks no password → 202 + emailed temporary password, no account yet; signing in with it creates the account and returns the *set-password step* (setup token ≠ bearer); choosing a password (policy, ≠ temp) yields the first session; anti-enumeration (existing account gets an "already registered" mail, identical answer); expiry & re-register; throttle; no squatting (unconfirmed address blocks nobody, matches no seats); brute-force lockout of a pending registration | ✅ |
| REG-RULE-01…03 | disposable-domain block, allowed-domain list, terms acceptance, input hardening, config advertised to the UI | ✅ |
| OTP-01…03 | emailed 6-digit sign-in code: hashed, single use, expiry, 5 guesses burn it, resend throttle, anti-enumeration, deactivated accounts, temp-password accounts still go through set-password | ✅ |
| ACT-01…03 | invited person without an account sets a password from the invitation (token proves the mailbox; works with open registration off); expired/cancelled/local-off refused | ✅ |
| AUTH-REG-01…05 (method `password`) | register: normalised email, welcome mail, validation matrix, no roles / no workspace access, `x-tenant-id` cannot steer account creation, registering a victim's email does **not** grant their pending seat | ✅ |
| AUTH-VER-01…03 | email verification: blocked until verified, single use, expiry, resend rotates & never reveals existence, tokens hashed at rest, no secrets in `/users` | ✅ |
| AUTH-PWD-01…05 | forgot/reset: single use, expiry, old password dies, reuse refused, other sessions revoked, anti-enumeration, per-account throttle, unlocks account, deactivated user, change-own-password | ✅ |
| AUTH-LOCK-01/02 | lockout after N failures (even for the right password), expiry, notice mail, counter reset, unknown-user ≡ wrong-password | ✅ |
| AUTH-TOK-01 | tampered / alg-none / garbage / truncated / wrong-secret / no-scheme / token-in-query ⇒ 401 | ✅ |
| AUTH-POL-01 | password policy (length, identity, common, character classes, admin path) | ✅ |
| SEC-06 | per-IP login throttling | ✅ |
| — | real Identity Server round-trip (discovery matches; flow tested against a fake IdP) | 🟡 |

## 2. Email — `auth-accounts.test.ts` (MAIL-*)
| ID | Scenario | |
|---|---|---|
| MAIL-01 | all 19 templates (temp password, already-registered, sign-in code, verification, reset, password-changed ×3, locked, welcome, workspace-created, invitation, invitation-accepted, role-changed, suspended/restored, removed, ownership ×2) render subject+text+HTML; links stay on `DASHBOARD_URL`; user input HTML-escaped | ✅ |
| MAIL-02 | CR/LF header injection neutralised | ✅ |
| MAIL-03 | full team lifecycle sends the right mails to the right people | ✅ |
| MAIL-04 | transport failure never breaks the triggering request | ✅ |
| MAIL-05 | with a transport, the invite token travels only by email (not in the API response); webhook payload verified | ✅ |
| MAIL-06 | real SMTP transport (nodemailer → an in-test SMTP server): multipart text+HTML, From/To/Subject, one-time link intact, token not returned | ✅ |
| MAIL-07 | admin-set password notifies the user and revokes their sessions | ✅ |
| — | delivery to real inboxes (spam filters, SPF/DKIM, HTML rendering in mail clients) | ⛔ |

## 3. Workspaces, switcher, membership — `enterprise-edge.test.ts`, `rbac-matrix.test.ts`, `tenant-isolation.test.ts`, `team.test.ts`
| ID | Scenario | |
|---|---|---|
| WS-01 | switcher lists exactly your workspaces with *your* role in each; no platform view for ordinary members | ✅ |
| WS-02 | same person: admin in A, viewer in B, nothing in C — enforced and reflected in `/me/profile` | ✅ |
| WS-03 | removal / demotion / suspension take effect on the next request and in the switcher | ✅ |
| WS-04 | suspended / pending / deleted workspace unusable for everyone incl. owner; hidden from switcher; reactivation restores | ✅ |
| WS-05 | invited / suspended seats are not "your workspaces"; shown as inactive memberships | ✅ |
| WS-06 | switcher search + limit over own workspaces only | ✅ |
| WS-07 | default workspace is not a free-for-all | ✅ |
| WS-08 | `x-tenant-id` abuse (empty, padded, case, huge, injection, wildcard, lists) ⇒ 403, never 500/other tenant | ✅ |
| WS-09 | signup race (exactly one wins), reserved / invalid / homoglyph slugs | ✅ |
| rbac-matrix | **every route × 7 roles × scopes** (none, non-member, suspended, other workspace, `all`, local admin): denied ⇒ exactly 403, allowed ⇒ never 401/403/5xx; UI permission list ≡ server permission set | ✅ |
| tenant-isolation | other workspace's ids probed on every id route; lists & analytics never include foreign rows | ✅ |
| oidc-sso | platform admin = the single fixed email; fake `system_admin` seat, first member, local admin confer nothing | ✅ |
| ws-auth / oidc-sso | WebSocket bound to one workspace, only that workspace's instance topics | ✅ |
| — | WS message delivery end-to-end over a real socket | ⛔ |

## 4. Team & invitations — `team.test.ts`, `enterprise-edge.test.ts` (INV-*)
| ID | Scenario | |
|---|---|---|
| team | invite → accept, hashed token, expiry, single use, owner/admin/member hierarchy (`canManage`), assignable roles, no second owner, suspend/reinstate, resend/cancel, leave, ownership transfer (+ former owner demoted), cross-workspace member ids ⇒ 404 | ✅ |
| INV-01 | normalisation, re-invite rotates token, admin cannot invite admin, unknown role, non-member / anonymous cannot invite | ✅ |
| INV-02 | invited to several workspaces: a role per workspace, tokens not interchangeable | ✅ |
| INV-03 | leaked token + wrong / unverified mailbox refused; seat stays pending | ✅ |
| INV-04 | cancelled token dead; invited seat cannot act | ✅ |

## 5. Executions — `execution-matrix.test.ts` (EXE-*) driven through the HTTP API as real roles
| ID | Execution type | |
|---|---|---|
| EXE-01/02/03 | script task; who may start (`workflow:run`) vs only view; start edge cases (unknown workflow/deployment/env, malformed/huge body, archived deployment) | ✅ |
| EXE-10…13 | user task: claim → start → save → complete; **ownership** (only owner/admin may complete/save/release/delegate/forward; no claim-stealing); racing completions ⇒ exactly one wins; manual task | ✅ |
| EXE-20…23 | exclusive, parallel, inclusive, event-based gateways | ✅ |
| EXE-30…32 | catch timer, boundary timer (interrupting + non-interrupting), timers tenant-scoped | ✅ |
| EXE-40/41 | signal catch (wrong name ignored, viewers refused); signal throw never crosses workspaces | ✅ |
| EXE-50…52 | embedded subprocess, call activity (+ cannot call another workspace's process), multi-instance sequential & parallel | ✅ |
| EXE-60…62 | business-rule (DMN) task, HTTP service task (success / failure recorded), SSRF blocked (metadata, loopback, link-local, private, `file:`) | ✅ |
| EXE-70/71 | failure → recorded → ack → fix → retry; error boundary, error end event | ✅ |
| EXE-80…82 | suspend/resume, abort, terminal-state control, variable edits, deployment lifecycle by role | ✅ |
| EXE-90…92 | quotas per workspace (no bleed), sandbox infinite loop & direct globals, 25 concurrent starts | ✅ |
| EXE-95/96 | other workspace can neither see nor drive any of it; analytics per workspace | ✅ |
| EXE-97 | case management: definition/instance roles, isolation, no audit on non-existent case | ✅ |
| PLIM-1…7 | platform-governed limits: every `/api/platform/*` route 403 for all workspace roles/local admin/other SSO user, 200 only for the platform admin; escalation closed (above-cap, 0=unlimited, platform-only keys → 422); min-chain resolution; per-workspace override + mode lock; live pool resize without dropping queued work; validation; audit entries; usage endpoint | ✅ |
| POOL-7…11 | overflow mode: reject (2000-burst, limit 50 → exactly 50 run/1950 refused instantly), queue (all 2000 ok, ≤50 concurrent), small queue/short wait errors, effective concurrency + workspace-over-env + invalid value, mixed-mode workspaces, pool healthy after reject burst | ✅ |
| POOL-1…6 | isolate pool: no state leak between scripts/tenants, 2000-burst bounded, queue overflow/timeout, recycle on timeout/OOM, idle eviction, fair under a global ceiling | ✅ |
| EXE-91b | **sandbox escape via constructor chains** | ✅ |
| engine-*.test.ts | 30 files of engine semantics (cascades, compensation, messaging, DMN import, java sidecar…) | ✅ (java needs JDK) |

## 5b. Plans and limits — `plan-limits.test.ts` (PLAN-*) — every plan limit is enforced
| ID | Scenario | |
|---|---|---|
| PLAN-01…03 | free-trial seed (7 days, 50 concurrent requests, per-day/week/month starts, every key present), signup = exactly 7 days, default workspace unlimited, old databases topped up without overwriting edits | ✅ |
| PLAN-10…14 | per-day / per-week / per-month start limits, tightest wins, resets on UTC day / Monday / month boundaries, race-safe under 30 parallel starts, refused starts uncounted, per-workspace budgets | ✅ |
| PLAN-20/21 | expired trial → 402 on new work, reads intact, extension restores access; platform admin exempt | ✅ |
| PLAN-30…35 | maxWorkflows, maxTeamMembers (pending counts, re-invite free), maxDeployments, maxActiveInstances, concurrentScripts, maxActiveTimers — and a workspace cannot raise them | ✅ |
| PLAN-40…42 | requestsPerMinute, concurrentRequests (429 + Retry-After, counter released), the free plan's 50 concurrent requests | ✅ |
| PLAN-50/60 | `/plan/usage` for every member, plan administration validation, edits apply at once, hidden plans | ✅ |

## 5c. Several replicas — `cluster.test.ts` (CLU-*) — limits hold whatever the replica count
Run against a shared in-memory backend (fake clock) **and**, when `REDIS_URL` is set, the same contract against real Redis.
| ID | Scenario | |
|---|---|---|
| CLU-01/02 | concurrent-request slots and requests-per-minute are one shared budget across 5 replicas (exact totals), freed slots usable from any replica, window reset | ✅ |
| CLU-03/04 | `maxReplicas`: of 10 replicas exactly 2 serve; per-workspace; lowering/raising applies on every replica and the survivors agree | ✅ |
| CLU-05/06 | crashed replica's slots expire and move; renewal keeps a live replica's slot; graceful stop hands over at once | ✅ |
| CLU-07/08 | one-owner claim (10 racers → 1 winner); cluster mutex never loses an update | ✅ |
| CLU-09 | pool/queue split exactly across holders (sums to the limit, ≥ 1 each, shared slot only when replicas > slots) | ✅ |
| CLU-10/11 | no Redis = private single-process behaviour; Redis outage degrades to per-replica limits, API stays up | ✅ |
| CLU-12 | a timer fires exactly once with 5 replicas ticking at once; only admitted replicas work the workspace | ✅ |
| CLU-13 | HTTP: 503 `REPLICA_NOT_ASSIGNED` + `Retry-After` + `X-Served-By` on a non-holder; plan rate/concurrency counted across replicas; raising the cap lets the next replica in | ✅ |
Also verified by hand: 5 real OS processes racing on a Redis container (exactly 2 placed, exactly 7 of 7 request slots granted) and the production bundle booting against Redis, registering and releasing on SIGTERM.

## 6. Hostile input, headers, audit, config — `enterprise-edge.test.ts`
SEC-01 mass assignment · SEC-02 prototype pollution · SEC-03 malformed bodies ⇒ 4xx, no stack traces · SEC-04 operator injection in login ·
SEC-05 security headers & CORS preflight · SEC-07 no secrets in responses · AUD-01 audit trail scoped per workspace · CFG-01 landing/sign-in render from public endpoints only. ✅

## 7. Gaps — stated plainly
1. ⛔ No browser-driven end-to-end tests of the Angular screens (verified manually: login, team page, invite). The permission *logic* behind the UI is covered by the parity test in `rbac-matrix`.
2. 🟡 No load / soak tests. Multi-replica limits are covered (CLU-*); the WebSocket hub and per-IP login limiters are still single-process in-memory.
3. 🟡 Postgres store: the unit suite uses the in-memory store. The production image is smoke-tested against a real Postgres by `scripts/docker-smoke.sh` (sign-in, Java + JS scripts, UTF-8, case management, 40 parallel starts); `npm run test:pg` is not part of it.
4. ⛔ Real SMTP and real Identity Server round-trips are not automated (fakes/capture are).
5. 🟡 Task *group* membership is enforced only for IAM-provisioned users; workspace members (SSO) are authorised by role, not by task group.

## 5d. Workspace IAM — roles, groups, users (`server/test/iam-workspace.test.ts`)

| ID | What it proves |
|----|----------------|
| IAMW-01 | A new workspace lists every built-in role (virtual until customised) with user/seat counts |
| IAMW-02 | Editing a built-in role stores a copy for that workspace only; deleting it resets to the default |
| IAMW-03 | Role names, reserved names, unknown permissions, duplicates; `admin` is immutable |
| IAMW-04 | A role in use cannot be deleted; another workspace cannot see or touch it |
| IAMW-05 | Users may only hold roles and groups that exist in their own workspace; usernames unique case-insensitively |
| IAMW-06 | Groups: validation, rename carries members, membership editing, delete detaches members |
| IAMW-07 | Nobody can grant a permission or role they do not hold themselves |
| IAMW-08 | Platform-wide view is read-only for users, roles and groups |
