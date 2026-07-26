# WhatsApp Tester

A self-hosted dashboard for driving a real WhatsApp account through the browser — QR login, browsing contacts/chats, sending one-off or bulk messages, scheduling sends, and watching a live feed of incoming messages. Built for testing WhatsApp bot/automation flows by hand, not as a multi-tenant product.

It now also includes a full mock-transport testing lab (deterministic synthetic data, zero Chromium, zero real WhatsApp session touched), single-user authentication + RBAC, input validation, tiered rate limiting, security headers, structured + audit logging, health endpoints, a durable SQLite-backed job engine (transactional claiming, retry with backoff, circuit breaker, backpressure), a SQLite-backed scheduler with exactly-once job creation, an OWNER/ADMIN outbound kill switch, idempotency-key protection on sends, and a reproducible capacity benchmark — while every original feature (Chats, Contacts, Groups, Send, Bulk, Scheduler, Live log, QR login, Socket.IO real-time updates) still works exactly as before.

This one document covers what it does, how it's built, what security controls exist, and the measured benchmark results. (The individual files under `docs/` hold the same material broken out for deeper reference — `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, `docs/SECURITY_AUDIT.md`, `docs/CAPACITY.md`, `docs/OPERATIONS.md`, `docs/RECOVERY.md`, `docs/ROADMAP.md`, `docs/COMPLETION_MATRIX.md`.)

---

## 1. Quick start

```bash
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste into .env's SESSION_SECRET
npm run create-admin      # interactive, masked password — no default credentials exist
npm run dev                # TRANSPORT_MODE=mock by default: no Chromium, no real WhatsApp session touched
```

Open `http://localhost:5050`, sign in. You'll see a **TEST MODE** banner and synthetic contacts/chats/messages generated from a seed — nothing here is a real WhatsApp account.

To use a real WhatsApp account: set `TRANSPORT_MODE=real` and `NODE_ENV=production` in `.env`, then `npm start` and scan the QR as before. `./session/` (gitignored) then holds the live session credentials — treat it as a secret.

## 2. Features

| Tab | What it does |
| --- | --- |
| **Chats** | Live WhatsApp-style thread view — chat list with unread badges/previews, open a thread, read history, send a reply. Updates in real time via `chatMessage` socket events. |
| **Contacts** | Search contacts; click one (or its "Message" action) to drop it into Send-message recipients. |
| **Groups** | Multi-select groups with checkboxes, blast one message to all of them with a configurable delay. |
| **Send message** | Free-form recipients (manual or picked from Contacts) + one message, sent one at a time with a human-paced delay. |
| **Bulk (Excel)** | Upload `.xlsx`/`.xls`/`.csv` (fuzzy column matching — `Phone`, `Mobile`, `Msg`, etc. all work), preview/edit rows, `{ColumnName}` template placeholders resolved per row, send to all or export the resolved sheet back out. |
| **Scheduler** | One-time or repeating (minutes/hours/days/weeks, optional end date) scheduled sends; survives restarts; live `scheduled`/`sending`/`done` status with per-run results. |
| **Live log** | Real-time feed of every inbound message across all chats. |

New, security/ops-oriented additions on top of the above:

- **Login** (username + password, session cookie) gates the whole app — no more "trusted because it's localhost."
- **TEST MODE banner** — always visible when running against the mock transport, so it's never ambiguous whether a send is real.
- **Logout** button in the sidebar.
- **Audit log** (DB-only for now) of every privileged action: logins, sends, bulk sends, group sends, sheet import/export, schedule create/delete, kill-switch changes.
- **Health endpoints** (`/health/live`, `/health/ready`) for process/readiness checks.
- **Outbound kill switch** — an OWNER/ADMIN-only sidebar toggle that immediately blocks all sends (direct and scheduled) without stopping the whole app; durable across restarts, audit-logged.
- **Durable job engine** — schedules now fire through a SQLite-backed job queue with transactional claiming (proven correct across separate OS processes), bounded retry with backoff+jitter, a circuit breaker, and bounded concurrency. `/api/send`/`/api/send-groups`/`/api/send-bulk` don't use it yet (still synchronous) — see `docs/ROADMAP.md`.
- **Idempotency-Key support** on `/api/send`, `/api/send-groups`, `/api/send-bulk` — a repeated key within 5 minutes replays the cached result instead of sending twice.

## 3. Architecture — how it works

```
Browser (public/)                    server.js (composition root)
  login.html/login.js  ─── POST /api/auth/login ──►  routes/auth.js ──► lib/db (users, sessions)
  index.html/app.js    ─── session cookie + CSRF ──►  requireAuth/requirePermission (lib/auth/middleware.js)
                        ─── REST ──────────────────►  routes/*.js ──► Transport interface
                        ◄── Socket.IO (session-gated) ── transport events / scheduler events

                                       Transport interface (transports/Transport.js)
                                         ├─ WhatsAppWebTransport  (real: whatsapp-web.js + Puppeteer + LocalAuth → ./session)
                                         └─ MockTransport         (default everywhere except production: seeded synthetic
                                                                    data, zero Chromium, zero ./session access)

                                       Scheduler (scheduler/index.js)                Durable Job Engine (lib/jobs/)
                                         SQLite `schedules` table ─── creates ───►  transactional claiming, retry+backoff,
                                         exactly-once job creation                   circuit breaker, backpressure
                                         (idempotency key per occurrence)  ◄── settles ── fires via transport.sendToNumbers()
```

Nothing outside `transports/` imports `whatsapp-web.js` directly. Every route and the scheduler depend only on the `Transport` interface — that's what lets `MockTransport` stand in for a real WhatsApp session everywhere except a deployment that explicitly opts into `TRANSPORT_MODE=real`.

### Module layout

| Path | Responsibility |
| --- | --- |
| `server.js` | Composition root only: config load (fails closed on unsafe config), middleware wiring, route mounting, Socket.IO auth gate + event bridging, graceful shutdown. |
| `config/index.js` | Parses/validates env vars once at startup — the single source of truth for mode (`development`/`test`/`production`) and transport mode. Refuses to start on unsafe config (missing session secret, reused test secret in production, etc). |
| `lib/db.js` | One `node:sqlite` database (`data/app.db`, zero native dependencies — built into Node ≥22.5) — `users`, `sessions`, `audit_log`, `login_attempts`. Never stores WhatsApp LocalAuth material. |
| `lib/auth/` | `passwords.js` (scrypt hash/verify, also built into Node core), `sessionStore.js` (SQLite-backed `express-session` store), `middleware.js` (`requireAuth`, `requirePermission`, CSRF check, idle/absolute timeout, login throttling). |
| `lib/rbac.js` | Roles (`OWNER/ADMIN/OPERATOR/VIEWER`) and the permission map every route checks server-side. |
| `lib/validation/schemas.js` | `zod` schemas + a `validate()` middleware for every route's query/body/params, with hard caps on recipients/rows/message length/etc. |
| `lib/rateLimit.js` | Tiered `express-rate-limit` limiters (auth/send/bulk/scheduleCreate/read) — endpoint risk decides the tier, not one global number. |
| `lib/errors.js` | `AppError` categories + the one centralized error-handling middleware (never leaks stack traces to the client). |
| `lib/logger.js` / `lib/requestId.js` | `pino` structured logging with redaction (passwords/cookies/QR/session never logged), per-request correlation ID. |
| `lib/audit.js` | Append-only privileged-action log, separate from operational logs. |
| `lib/spreadsheet.js` | Column-matching, `{ColumnName}` template resolution, CSV/formula-injection neutralization on exports, size limits. |
| `lib/syntheticData.js` | Seeded deterministic contact/chat/message generator — shared by `MockTransport` and the benchmark script. |
| `lib/killSwitch.js` | OWNER/ADMIN-only outbound kill switch — durable (SQLite `settings`), audit-logged, an Express middleware (`requireOutboundEnabled`) used by every send route and checked by the job worker before claiming. |
| `lib/idempotency.js` | Opt-in `Idempotency-Key` header support for the synchronous send routes — SQLite-backed, 5-minute TTL. |
| `lib/jobs/` | The durable job engine: `jobService.js` (CRUD + state machine, idempotent creation via a DB UNIQUE constraint), `claiming.js` (transactional `BEGIN IMMEDIATE` claim — correct across separate OS processes, not just in-process), `errorClassifier.js` + `retry.js` (bounded exponential backoff+jitter, category-based), `circuitBreaker.js` (CLOSED/OPEN/HALF_OPEN), `backpressure.js` (bounded concurrency), `worker.js` (the polling loop tying it together). |
| `lib/migrateSchedulesJson.js` | One-time, idempotent, non-destructive migration of the old `schedules.json` into the SQLite `schedules` table (backs up, never deletes). |
| `transports/` | `Transport.js` (interface), `WhatsAppWebTransport.js` (real, the original `whatsapp-web.js`/Puppeteer logic moved here unchanged), `MockTransport.js` (default, now with deterministic failure-injection hooks for testing retry/circuit-breaker logic), `index.js` (factory keyed on `TRANSPORT_MODE`). |
| `routes/` | One file per resource area (`health`, `auth`, `contacts`, `chats`, `messaging`, `bulk`, `schedules`, `admin`); each exports `(transport\|scheduler) => express.Router()`. |
| `scheduler/index.js` | Schedule CRUD against the SQLite `schedules` table + the 15-second tick loop; fires sends by creating a job with an idempotency key derived from `(scheduleId, intendedRunAt)` — same REST/Socket.IO contract as the original `schedules.json`-based version, so the frontend needed zero changes. |
| `scripts/create-admin.js` | One-time OWNER bootstrap — interactive masked prompt, or `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars for non-interactive/automated setup. Refuses to run if any account exists. No default credentials. |
| `scripts/db-check.js` | `npm run db:check` — `PRAGMA integrity_check` + reports the schema version. |
| `benchmarks/run-benchmark.js` | Boots the real app in-process against a disposable DB and MockTransport, drives `autocannon`, writes `benchmarks/baseline/*.{json,md}`. Structurally incapable of targeting anything but the instance it boots itself. |
| `test/` | `node:test` suite (zero new dependency) — 60 tests across MockTransport determinism, auth, validation, rate limiting, health, durable jobs (including a real multi-process claim-race test), scheduler correctness/restart-safety, kill switch, idempotency. |

### Request lifecycle (an authenticated API call)

1. `helmet()` sets security headers (CSP scoped to this app's own origin).
2. `express.json({ limit: '10mb' })` parses the body.
3. SQLite-backed `session` middleware attaches `req.session`.
4. `requestId` middleware assigns a correlation ID + scoped logger.
5. Route-level rate limiter runs first (cheapest check).
6. `requirePermission(permission)` checks session validity (idle + absolute timeout), CSRF header on unsafe methods, then role→permission.
7. `zod` validates/rejects the request shape.
8. The route calls `Transport`/`Scheduler` — never `whatsapp-web.js` directly.
9. Privileged actions get audit-logged (actor, action, result, request ID — never message bodies or secrets).
10. Errors map to a safe `{ error, category, requestId }` response; unexpected errors are logged in full server-side and reduced to a generic message for the client.

### Connection state machine (unchanged from the original app)

```
initializing → qr → authenticated → ready
                                        ↘
                                    disconnected  (reachable from any state)
```

`whatsapp-web.js` fires `ready` about 5 seconds before contacts/chats are actually queryable, so the transport delays exposing `ready` to the frontend to match. `MockTransport` simulates the same state machine on a fast fixed timer (~1 second total) so dev/test never waits on a real connection.

### Socket.IO

Shares the same session store as HTTP (`io.engine.use(sessionMiddleware)`); an unauthenticated handshake is rejected before `connection` fires — no state/QR/chat/schedule data ever reaches a client that hasn't logged in. Payload shapes are unchanged from the original app, so the frontend needed no event-handling changes.

## 4. Security features

### What's controlled today

| Control | Detail |
| --- | --- |
| Authentication | scrypt-hashed passwords (Node built-in, no native dependency), SQLite-backed sessions (not the default in-memory store), session regenerated on login, HttpOnly/SameSite=Lax/Secure(prod) cookies, idle timeout (30 min default) + absolute timeout (8 hr default). |
| Brute-force protection | Login rate-limited (10/min) **and** independently throttled per-username (5 failures/15 min lockout) via the DB — two separate mechanisms. |
| CSRF | Double-submit token issued at login, required as `X-CSRF-Token` on every state-changing request. |
| Authorization | Every route enforces `requirePermission(...)` server-side against a role→permission map (`OWNER/ADMIN/OPERATOR/VIEWER`) — never a frontend-hidden-button. |
| Input validation | `zod` schemas on every route; hard caps: 500 recipients, 200 groups, 5,000 bulk rows, 4,096-char messages, 300s max delay, 10MB JSON body limit, 5MB file upload limit + extension/MIME allowlist. |
| Rate limiting | Tiered by endpoint risk (auth/send/bulk/scheduleCreate/read), not one global number. |
| Security headers | `helmet()` with an app-specific CSP — `script-src 'self'`, `img-src 'self' data:` (for the QR code), no `unsafe-inline`/`unsafe-eval`. |
| Socket.IO | Session-gated handshake — unauthenticated clients get nothing. |
| Spreadsheet safety | Extension/MIME allowlist, row/column/cell-length caps, formula-injection neutralization on exports (`=`,`+`,`-`,`@`-prefixed cells get escaped). |
| Logging | `pino` redaction covers passwords/cookies/session/QR/CSRF fields; errors never leak stack traces to the client. |
| Audit trail | Append-only log of every privileged action — actor, action, target, result, request ID, timestamp. |
| Fail-closed startup | The app refuses to start without a sufficiently random `SESSION_SECRET`, and refuses the well-known test secret in production. |
| Graceful shutdown | Drains the job worker, stops the scheduler, closes Chromium cleanly on exit **without** logging out (session survives a restart) — logout is a separate, deliberate action. Verified via direct in-process signal emission. |
| Outbound kill switch | OWNER/ADMIN-only, durable, audit-logged — blocks the job worker's claiming loop and every synchronous send route immediately. Verified live, not just unit-tested. |
| Idempotency | Opt-in `Idempotency-Key` header on the three synchronous send routes (SQLite-backed, 5-min TTL); scheduled sends get exactly-once job creation for free via a DB unique constraint. |
| Job claiming safety | `BEGIN IMMEDIATE` transactional claim — verified correct across 8 separate OS processes racing for the same item, not just multiple in-process callbacks. |
| Retry / circuit breaker | Bounded exponential backoff+jitter (max 5 attempts, only for transient failures); a circuit breaker stops hammering the transport after repeated transient failures, with a cooldown + single half-open probe before resuming. |

### STRIDE summary (full detail in `docs/THREAT_MODEL.md`)

- **Spoofing** — mitigated via hashed passwords, session regeneration, generic auth errors, throttling. No MFA yet.
- **Tampering** — mitigated via schema validation and formula-injection neutralization. The scheduler now runs on a transactional SQLite table (`schedules.json` retired, migrated once at startup).
- **Repudiation** — mitigated via the audit log. Not yet tamper-evident (no hash chaining), no UI viewer yet.
- **Information disclosure** — mitigated via log redaction, safe error responses, session-gated Socket.IO. No secret-scanning CI gate yet.
- **Denial of service** — mitigated via body/upload/array/message size caps, tiered rate limiting, bounded job-worker concurrency, and a circuit breaker around transport calls. No global HTTP concurrency cap yet; load/soak/burst testing beyond the baseline benchmark reruns is deferred.
- **Elevation of privilege** — every route checks permissions server-side; only OWNER accounts can be created today (no multi-user management UI yet).

### Known findings (full detail + severities in `docs/SECURITY_AUDIT.md`)

`npm audit` currently flags: **`xlsx`** (prototype pollution / ReDoS, no upstream fix). **Re-evaluated this session with a real trial install of `exceljs`** (the leading alternative) — it pulls in the exact same `archiver` vulnerability chain, so switching would not reduce findings while losing `.xls` support; kept `xlsx`, mitigated with size/shape caps. `archiver`/`glob`/`minimatch`/etc. remain open, transitive via `whatsapp-web.js`, not called directly by this codebase. Double-submitted sends are now protected via `Idempotency-Key` (resolved this session) — see `docs/SECURITY_AUDIT.md` for the full before/after finding table.

**No claim of "100% secure" or "unhackable" is made anywhere in this project.** This is a record of controls implemented, tests passed, and residual risk — see `docs/THREAT_MODEL.md` and `docs/SECURITY_AUDIT.md` for the full, honest accounting.

## 5. Benchmark report

**These are this application's measured limits against a local, seeded MockTransport — not WhatsApp/Meta's sending limits, and not a promise of production capacity on different hardware.** No benchmark in this repository has ever sent traffic to WhatsApp, Meta, or any real account — `npm run benchmark` boots the real app in-process against a disposable database and drives `autocannon` against it.

There is no meaningful "before" baseline for the *first* run: the pre-refactor app 409'd on every data endpoint without a live WhatsApp session. That first MockTransport run became the reference baseline; this session reran the identical scenarios after adding the job engine/scheduler/kill switch for an honest before/after comparison.

**Latest run:** `2026-07-26T13:29:27.067Z` · Node v25.9.0 · Windows x64 · 12 CPUs · 12 GB RAM · mock seed 12345 · 30 synthetic contacts / 20 synthetic chats · job worker + scheduler running in the background throughout.

| Scenario | Connections | Total Requests | Req/s (avg) | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | Errors | Timeouts |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| health_live | 1 | 3,616 | 723.2 | 1 | 1 | 2 | 4 | 0 | 0 |
| health_live | 10 | 6,757 | 1,351.4 | 6 | 9 | 15 | 22 | 0 | 0 |
| health_live | 50 | 7,850 | 1,570.0 | 29 | 39 | 46 | 71 | 0 | 0 |
| api_contacts | 1 | 1,368 | 273.6 | 3 | 4 | 5 | 5 | 0 | 0 |
| api_contacts | 10 | 1,640 | 328.0 | 29 | 34 | 40 | 43 | 0 | 0 |
| api_contacts | 50 | 1,650 | 330.0 | 150 | 168 | 236 | 239 | 0 | 0 |
| api_chats | 1 | 1,390 | 278.0 | 3 | 4 | 4 | 5 | 0 | 0 |
| api_chats | 10 | 1,580 | 316.0 | 31 | 37 | 44 | 46 | 0 | 0 |
| api_chats | 50 | 1,400 | 280.0 | 176 | 240 | 244 | 244 | 0 | 0 |

Raw data: `benchmarks/baseline/2026-07-26T13-29-27-067Z.json` (prior run: `2026-07-26T12-30-31-050Z.json`).

**Before/after at 50 connections** (full table in `docs/CAPACITY.md`): `health_live` req/s **-16%** (1,869→1,570), `api_contacts` req/s **-20%** (410→330), `api_chats` req/s **-32%** (410→280) — **zero errors/timeouts in either run.** This is a real, measured regression, not hidden: the job worker polls every 500ms and the scheduler ticks every 15s, both against the same SQLite connection the benchmark's HTTP traffic uses, even when idle. It's an accepted latency/throughput cost for gaining durable jobs, exactly-once scheduling, and a kill switch — consistent with this project's stated priority order (correctness → security → data integrity → recoverability → predictable latency → throughput). A tunable/adaptive poll interval is a noted future improvement.

**Reading these numbers honestly:**

- Zero errors and zero timeouts at every level tested, in both runs — not evidence of a saturation point, just the top of what this session tested (only 1/10/50 connections were sampled).
- `/health/live` scales furthest in both runs since it skips auth/session/validation entirely — a rough ceiling for "the HTTP layer itself."
- Real saturation-point discovery (gradually increasing load until an inflection point appears), soak testing, and larger synthetic datasets are deferred — see `docs/ROADMAP.md`.

## 6. Environment variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | yes | `development` | `development`\|`test`\|`production` |
| `TRANSPORT_MODE` | yes in production | `mock` outside production | `mock`\|`real` — no implicit fallback to real in production |
| `PORT` | no | `5050` | |
| `SESSION_SECRET` | **yes** | — | ≥32 random chars; app refuses to start without one |
| `MOCK_SEED` | no | `12345` | Only affects `TRANSPORT_MODE=mock` |
| `SESSION_IDLE_TIMEOUT_MS` / `SESSION_ABSOLUTE_TIMEOUT_MS` | no | 30 min / 8 hr | |
| `LOG_LEVEL` | no | `info` | `pino` levels |
| `DB_PATH` | no | `data/app.db` | SQLite file, gitignored |
| `SCHEDULES_FILE` | no | `schedules.json` | Only read once, at startup, by the one-time migration into the SQLite `schedules` table |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | no | — | Only for non-interactive `create-admin`; never a default credential |
| `JOB_WORKER_CONCURRENCY` | no | `5` | Max in-flight job items processed at once (backpressure) |

## 7. What's deferred

Converting `/api/send`/`/api/send-groups`/`/api/send-bulk` to the durable job model (needs a Jobs UI first — see `docs/ROADMAP.md`), multi-user account management UI, MFA, session management UI, tamper-evident audit log + viewer, secret scanning/SAST/CI gate, full fuzz/load/soak/chaos test suites beyond this session's crash-recovery tests, backup/restore tooling, Docker hardening (explicitly out of scope), Postman/curl verification pack. Full staged plan and a gate-by-gate completion matrix in `docs/ROADMAP.md` and `docs/COMPLETION_MATRIX.md` — nothing here was silently dropped.
