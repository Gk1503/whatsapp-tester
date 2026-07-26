# WhatsApp Tester

A self-hosted dashboard for driving a real WhatsApp account through the browser — QR login, browsing contacts/chats, sending one-off or bulk messages, scheduling sends, and watching a live feed of incoming messages. Built for testing WhatsApp bot/automation flows by hand, not as a multi-tenant product.

It now also includes a full mock-transport testing lab (deterministic synthetic data, zero Chromium, zero real WhatsApp session touched), single-user authentication + RBAC, input validation, tiered rate limiting, security headers, structured + audit logging, health endpoints, and a reproducible capacity benchmark — while every original feature (Chats, Contacts, Groups, Send, Bulk, Scheduler, Live log, QR login, Socket.IO real-time updates) still works exactly as before.

This one document covers what it does, how it's built, what security controls exist, and the measured benchmark results. (The individual files under `docs/` hold the same material broken out for deeper reference — `docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`, `docs/SECURITY_AUDIT.md`, `docs/CAPACITY.md`, `docs/OPERATIONS.md`, `docs/ROADMAP.md`.)

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
|---|---|
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
- **Audit log** (DB-only for now) of every privileged action: logins, sends, bulk sends, group sends, sheet import/export, schedule create/delete.
- **Health endpoints** (`/health/live`, `/health/ready`) for process/readiness checks.

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

                                       Scheduler (scheduler/index.js)
                                         reads/writes schedules.json, fires sends via transport.sendToNumbers()
```

Nothing outside `transports/` imports `whatsapp-web.js` directly. Every route and the scheduler depend only on the `Transport` interface — that's what lets `MockTransport` stand in for a real WhatsApp session everywhere except a deployment that explicitly opts into `TRANSPORT_MODE=real`.

### Module layout

| Path | Responsibility |
|---|---|
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
| `transports/` | `Transport.js` (interface), `WhatsAppWebTransport.js` (real, the original `whatsapp-web.js`/Puppeteer logic moved here unchanged), `MockTransport.js` (default), `index.js` (factory keyed on `TRANSPORT_MODE`). |
| `routes/` | One file per resource area (`health`, `auth`, `contacts`, `chats`, `messaging`, `bulk`, `schedules`); each exports `(transport|scheduler) => express.Router()`. |
| `scheduler/index.js` | Schedule CRUD + the 15-second tick loop; fires sends through the transport abstraction, same catch-up-on-restart repeat logic as before. |
| `scripts/create-admin.js` | One-time OWNER bootstrap — interactive masked prompt, or `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars for non-interactive/automated setup. Refuses to run if any account exists. No default credentials. |
| `benchmarks/run-benchmark.js` | Boots the real app in-process against a disposable DB and MockTransport, drives `autocannon`, writes `benchmarks/baseline/*.{json,md}`. |
| `test/` | `node:test` suite (zero new dependency) — 29 tests across MockTransport determinism, auth, validation, rate limiting, health. |

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
|---|---|
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
| Graceful shutdown | Closes Chromium cleanly on exit **without** logging out (session survives a restart) — logout is a separate, deliberate action. |

### STRIDE summary (full detail in `docs/THREAT_MODEL.md`)

- **Spoofing** — mitigated via hashed passwords, session regeneration, generic auth errors, throttling. No MFA yet.
- **Tampering** — mitigated via schema validation and formula-injection neutralization. `schedules.json` is still a flat file (not transactional) — small corruption window on crash, tracked for SQLite migration.
- **Repudiation** — mitigated via the audit log. Not yet tamper-evident (no hash chaining), no UI viewer yet.
- **Information disclosure** — mitigated via log redaction, safe error responses, session-gated Socket.IO. No secret-scanning CI gate yet.
- **Denial of service** — mitigated via body/upload/array/message size caps and tiered rate limiting. No global concurrency cap or circuit breaker yet; load/soak/burst testing beyond the one baseline benchmark is deferred.
- **Elevation of privilege** — every route checks permissions server-side; only OWNER accounts can be created today (no multi-user management UI yet).

### Known findings (full detail + severities in `docs/SECURITY_AUDIT.md`)

`npm audit` currently flags: **`xlsx`** (prototype pollution / ReDoS, no upstream fix — mitigated with size/shape caps, not eliminated) and **`archiver`/`glob`/`minimatch`/etc.** (transitive via `whatsapp-web.js`, not called directly by this codebase). Neither is fully resolved; both are documented rather than hidden. No idempotency protection on sends yet (a double-submitted request sends twice) — tracked in the roadmap.

**No claim of "100% secure" or "unhackable" is made anywhere in this project.** This is a record of controls implemented, tests passed, and residual risk — see `docs/THREAT_MODEL.md` and `docs/SECURITY_AUDIT.md` for the full, honest accounting.

## 5. Benchmark report

**These are this application's measured limits against a local, seeded MockTransport — not WhatsApp/Meta's sending limits, and not a promise of production capacity on different hardware.** No benchmark in this repository has ever sent traffic to WhatsApp, Meta, or any real account — `npm run benchmark` boots the real app in-process against a disposable database and drives `autocannon` against it.

There is no meaningful "before" baseline: the pre-refactor app 409'd on every data endpoint without a live WhatsApp session, so this run **is** the reference baseline for future comparisons.

**Run:** `2026-07-26T12:30:31.050Z` · Node v25.9.0 · Windows x64 · 12 CPUs · 12 GB RAM · mock seed 12345 · 30 synthetic contacts / 20 synthetic chats.

| Scenario | Connections | Total Requests | Req/s (avg) | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | Errors | Timeouts |
|---|---|---|---|---|---|---|---|---|---|
| health_live | 1 | 4,263 | 852.6 | 1 | 1 | 1 | 2 | 0 | 0 |
| health_live | 10 | 8,235 | 1,647.0 | 5 | 8 | 12 | 16 | 0 | 0 |
| health_live | 50 | 9,346 | 1,869.4 | 24 | 34 | 45 | 66 | 0 | 0 |
| api_contacts | 1 | 1,681 | 336.2 | 2 | 3 | 3 | 4 | 0 | 0 |
| api_contacts | 10 | 2,030 | 406.0 | 24 | 27 | 33 | 37 | 0 | 0 |
| api_contacts | 50 | 2,050 | 410.0 | 123 | 134 | 167 | 190 | 0 | 0 |
| api_chats | 1 | 1,723 | 344.6 | 2 | 3 | 3 | 4 | 0 | 0 |
| api_chats | 10 | 2,010 | 402.0 | 24 | 28 | 32 | 37 | 0 | 0 |
| api_chats | 50 | 2,050 | 410.0 | 122 | 135 | 143 | 176 | 0 | 0 |

Raw data: `benchmarks/baseline/2026-07-26T12-30-31-050Z.json`.

**Reading these numbers honestly:**
- Zero errors and zero timeouts at every level tested — not evidence of a saturation point, just the top of what this session tested (only 1/10/50 connections were sampled).
- `/api/contacts` and `/api/chats` plateau around ~410 req/s while latency keeps climbing (24ms → 123ms p50 from 10→50 connections) — that's the authenticated middleware chain (session + permission check + validation) and synthetic-data generation becoming the bottleneck before raw HTTP handling does.
- `/health/live` scales further (852 → 1,869 req/s) since it skips auth/session/validation entirely — a rough ceiling for "the HTTP layer itself."
- Real saturation-point discovery (gradually increasing load until an inflection point appears), soak testing, and larger synthetic datasets are deferred — see `docs/ROADMAP.md`.

## 6. Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | yes | `development` | `development`\|`test`\|`production` |
| `TRANSPORT_MODE` | yes in production | `mock` outside production | `mock`\|`real` — no implicit fallback to real in production |
| `PORT` | no | `5050` | |
| `SESSION_SECRET` | **yes** | — | ≥32 random chars; app refuses to start without one |
| `MOCK_SEED` | no | `12345` | Only affects `TRANSPORT_MODE=mock` |
| `SESSION_IDLE_TIMEOUT_MS` / `SESSION_ABSOLUTE_TIMEOUT_MS` | no | 30 min / 8 hr | |
| `LOG_LEVEL` | no | `info` | `pino` levels |
| `DB_PATH` | no | `data/app.db` | SQLite file, gitignored |
| `SCHEDULES_FILE` | no | `schedules.json` | Unchanged from the original app |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | no | — | Only for non-interactive `create-admin`; never a default credential |

## 7. What's deferred

Durable job queue, SQLite migration of `schedules.json`, idempotency keys, multi-user account management UI, full fuzz/load/soak/chaos test suites, CI security gate, Docker hardening, Postman/curl verification pack. Full staged plan in `docs/ROADMAP.md` — nothing here was silently dropped.
