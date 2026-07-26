# Architecture

## Overview

```
Browser (public/)                    server.js (composition root)
  login.html/login.js  ─── POST /api/auth/login ──►  routes/auth.js ──► lib/db (users, sessions)
  index.html/app.js    ─── session cookie + CSRF ──►  requireAuth/requirePermission (lib/auth/middleware.js)
                        ─── REST ──────────────────►  routes/*.js ──► Transport interface
                        ◄── Socket.IO (session-gated) ── transport events / scheduler events

                                       Transport interface (transports/Transport.js)
                                         ├─ WhatsAppWebTransport  (real: whatsapp-web.js + Puppeteer + LocalAuth → ./session)
                                         └─ MockTransport         (default everywhere except production: seeded synthetic data,
                                                                    zero Chromium, zero ./session access)

                                       Scheduler (scheduler/index.js)
                                         reads/writes schedules.json, fires via transport.sendToNumbers()
```

Nothing outside `transports/` imports `whatsapp-web.js` directly. Every route, and the scheduler, depend only on the `Transport` interface — that's what lets `MockTransport` stand in for a real WhatsApp session everywhere except a production deployment that explicitly opts into `TRANSPORT_MODE=real`.

## Module layout

| Path | Responsibility |
|---|---|
| `server.js` | Composition root only: config load (fails closed on unsafe config), middleware wiring, route mounting, Socket.IO auth gate + event bridging, graceful shutdown. |
| `config/index.js` | Parses/validates env vars once at startup; the single source of truth for mode (`development`/`test`/`production`) and transport mode. |
| `lib/db.js` | One `node:sqlite` database (`data/app.db`) — `users`, `sessions`, `audit_log`, `login_attempts`. Never stores WhatsApp LocalAuth material. |
| `lib/auth/` | `passwords.js` (scrypt hash/verify), `sessionStore.js` (SQLite-backed `express-session` store), `middleware.js` (`requireAuth`, `requirePermission`, CSRF check, login throttling). |
| `lib/rbac.js` | Roles (`OWNER/ADMIN/OPERATOR/VIEWER`) and the permission map every route checks. |
| `lib/validation/schemas.js` | `zod` schemas + a `validate()` middleware factory for every route's query/body/params. |
| `lib/rateLimit.js` | Tiered `express-rate-limit` limiters (auth/send/bulk/scheduleCreate/read). |
| `lib/errors.js` | `AppError` categories + the single Express error-handling middleware. |
| `lib/logger.js` / `lib/requestId.js` | `pino` structured logging with redaction, per-request correlation ID. |
| `lib/audit.js` | Append-only privileged-action log, separate from `lib/logger.js`'s operational logs. |
| `lib/spreadsheet.js` | Column-matching, `{ColumnName}` template resolution, CSV/formula-injection neutralization, size limits. |
| `lib/syntheticData.js` | Seeded deterministic contact/chat/message generator, shared by `MockTransport` and the benchmark script. |
| `transports/` | `Transport.js` (interface), `WhatsAppWebTransport.js` (real), `MockTransport.js` (default), `index.js` (factory keyed on `TRANSPORT_MODE`). |
| `routes/` | One file per resource area; each exports `(transport|scheduler) => express.Router()`. |
| `scheduler/index.js` | Schedule CRUD + the 15s tick loop; fires sends through the transport abstraction. |
| `scripts/create-admin.js` | One-time OWNER bootstrap (interactive, masked password; or `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars for automation). |
| `benchmarks/run-benchmark.js` | Boots the real app in-process against a disposable DB and MockTransport, drives `autocannon`, writes `benchmarks/baseline/*.{json,md}`. |
| `test/` | `node:test` suite — no new dependency, no fixed ports (ephemeral `listen(0)` or pure in-memory calls), isolated per-file SQLite paths. |

## Request lifecycle (authenticated API call)

1. `helmet()` sets security headers (CSP scoped to this app's own origin, no inline scripts).
2. `express.json({ limit: '10mb' })` parses the body.
3. `session` middleware (SQLite-backed store) attaches `req.session`.
4. `requestId` middleware assigns `req.id` + a child `pino` logger scoped to it.
5. Route-level `rateLimit.<tier>` runs first (cheapest check, protects everything behind it).
6. `requirePermission(permission)` → `requireAuth` checks session validity (idle + absolute timeout), CSRF header for unsafe methods, then the role/permission map.
7. `validate({ query, body, params })` parses/rejects via `zod`.
8. Route handler calls the `Transport`/`Scheduler` abstraction, never `whatsapp-web.js` directly.
9. Privileged actions call `recordAudit(...)` — actor, action, target, result, request ID. Never message bodies or secrets.
10. Errors thrown as `AppError` map to a safe `{ error, category, requestId }` response; anything else is logged in full server-side and reduced to a generic `INTERNAL_ERROR` for the client.

## Socket.IO

`io.engine.use(sessionMiddleware)` shares the same session parsing as HTTP; `io.use(...)` rejects any handshake without a valid `userId` in session **before** `connection` fires. An authenticated socket receives an initial `state` snapshot (`transport.getSnapshot()`), then `state`/`incoming`/`chatMessage` events bridged 1:1 from `Transport` events, and `scheduleUpdate`/`scheduleRemoved` bridged from the `Scheduler`. Payload shapes are unchanged from the pre-refactor app — the frontend needed no event-handling changes.

## What changed vs. the original monolith, and what didn't

- **Changed**: where the `whatsapp-web.js` logic lives (moved into `WhatsAppWebTransport`, unchanged behavior), how routes are organized (one file per resource instead of one 624-line `server.js`), added auth/validation/rate-limiting/audit/logging layers in front of every route.
- **Unchanged**: every `/api/*` URL, request/response shape, and Socket.IO event name/payload the frontend depends on. The QR state machine, the 5-second post-ready delay workaround, the `pupPage.evaluate` fallbacks for chats/messages, the scheduler's catch-up-on-restart repeat logic, and the spreadsheet template resolution are all the same logic, just relocated.

See `docs/THREAT_MODEL.md` for the security analysis, `docs/CAPACITY.md` for benchmark methodology/results, `docs/OPERATIONS.md` for running it, and `docs/ROADMAP.md` for what's intentionally deferred.
