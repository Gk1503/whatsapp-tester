# Threat Model

This is a single-user (OWNER-role today) self-hosted tool that can send real WhatsApp messages on behalf of one linked account. The primary asset worth protecting is **the ability to send messages as that account** and **the LocalAuth session credentials** that make that possible. This document does not claim the application is "secure" or "unhackable" — it records what was analyzed, what controls exist, and what residual risk remains.

## Assets

1. **WhatsApp session credentials** (`./session/`, managed by `whatsapp-web.js`'s `LocalAuth`) — whoever has this can act as the linked WhatsApp account outside this app entirely.
2. **The ability to send/schedule messages** through the app's API.
3. **Contact/chat/message data** surfaced through the app (real WhatsApp data when `TRANSPORT_MODE=real`).
4. **The admin account credential** (one row in `data/app.db`, scrypt-hashed).
5. **Audit/log data** (who did what, when).
6. **The durable job queue and schedules table** (`jobs`/`job_items`/`job_attempts`/`schedules` in `data/app.db`) — whoever can write to these can queue arbitrary outbound sends or corrupt scheduling state; whoever can read them sees recipient numbers/names and message content for pending/recent operations.
7. **The outbound kill switch state** (`settings.outbound_disabled`) — whoever can flip this can silently disable all outbound messaging (a denial-of-service against the tool's own purpose) or, if compromised in the other direction, re-enable outbound sends an operator deliberately disabled during an incident.

## Actors

- **OWNER** — the one bootstrapped account (`scripts/create-admin.js`). Full permissions today.
- **Unauthenticated network client** — anyone who can reach the HTTP/Socket.IO port without a valid session.
- **A malicious/malformed spreadsheet** — untrusted input from the OWNER's own machine (they might open a file from someone else).
- **A compromised dependency** — supply-chain risk from `whatsapp-web.js`, `xlsx`, etc.

## Entry points / trust boundaries

| Entry point | Trust boundary | Classification |
|---|---|---|
| `GET /health/live`, `/health/ready` | None — deliberately public, no secrets in response | PUBLIC |
| `POST /api/auth/login` | Unauthenticated → authenticated | PUBLIC (rate-limited, throttled) |
| `GET /api/auth/me`, `/api/status` | Requires valid session | AUTHENTICATED |
| `GET /api/contacts`, `/api/chats`, `/api/chats/:id/messages` | Requires session + `view_chats` | AUTHENTICATED |
| `POST /api/chats/:id/send`, `/api/send`, `/api/send-groups` | Requires session + `send_message`/`send_groups` | PRIVILEGED / HIGH-RISK (dispatches real messages when `TRANSPORT_MODE=real`) |
| `POST /api/parse-sheet` | Requires session + `upload_sheet`; parses an untrusted file | PRIVILEGED / HIGH-RISK (untrusted file parser) |
| `POST /api/send-bulk` | Requires session + `bulk_send` | HIGH-RISK (many recipients per call) |
| `POST /api/build-sheet` | Requires session + `export_sheet` | PRIVILEGED |
| `POST/GET/DELETE /api/schedules*` | Requires session + `manage_schedules` | PRIVILEGED / HIGH-RISK (schedules execute unattended later, now via the durable job queue) |
| `GET/POST /api/admin/kill-switch` | Requires session + `manage_security` (OWNER/ADMIN only) | PRIVILEGED / DESTRUCTIVE (can silently halt or resume all outbound messaging) |
| Socket.IO handshake | Session-gated at the engine level | AUTHENTICATED |
| `./session/` on disk | Filesystem trust boundary — anyone with read access to this directory (or a backup of it) can impersonate the WhatsApp account | DESTRUCTIVE if exposed |
| `data/app.db` | Filesystem trust boundary — contains password hashes and audit history | DESTRUCTIVE if exposed |

## STRIDE analysis

### Spoofing
- **Risk**: forged session cookie, credential guessing, username enumeration.
- **Controls**: HttpOnly/SameSite=Lax/Secure(prod) cookies, session regenerated on login (fixation resistance), scrypt password hashing with per-user salt, generic "Invalid username or password" for both wrong-password and unknown-username cases, login throttling (5 failures/15min locks out further attempts on that username).
- **Residual risk**: no MFA. No account lockout notification/alerting. Single shared OWNER account today — no per-actor attribution beyond "OWNER".

### Tampering
- **Risk**: request body tampering, prototype pollution via crafted JSON, CSV/formula injection in exported sheets, schedule/job data corruption.
- **Controls**: `zod` schema validation on every route (rejects unknown/oversized shapes), `neutralizeFormula()` prefixes dangerous leading characters (`=`,`+`,`-`,`@`) on exported sheet cells, `schedules.json` written atomically via `fs.writeFileSync` (whole-file replace, not partial appends).
- **Residual risk**: `schedules.json` is still a flat file, not a transactional database — a crash mid-write could in principle corrupt it (small window; ROADMAP item to migrate to SQLite). No integrity signature on the file.

### Repudiation
- **Risk**: no record of who sent what, or when a security-relevant action happened.
- **Controls**: `lib/audit.js` records every privileged action (login, logout, failed login, send, bulk send, group send, sheet import/export, schedule create/delete) with actor, result, request ID, timestamp — append-only table.
- **Residual risk**: audit log itself isn't tamper-evident (no hash chaining) and isn't shipped off-box; an attacker with DB write access could edit it. No audit log viewer UI yet (ROADMAP).

### Information disclosure
- **Risk**: leaking session secrets, password hashes, LocalAuth material, or message content via logs/errors/health endpoints.
- **Controls**: `pino` redaction paths cover password/cookie/session/QR/csrf fields; error handler never returns raw stack traces to the client; health endpoints return only `status`/`checks`, no internals; `helmet` CSP prevents most reflected-content execution paths; Socket.IO rejects unauthenticated handshakes so QR/state/chat data never reaches an unauthenticated client; `./session/` and `data/*.db` are never served statically (only `public/` is).
- **Residual risk**: full message bodies ARE currently included in `recordAudit` payloads only as counts/metadata (not body text) — good — but are NOT redacted from `pino` request logs if a future route logs `req.body` directly; developers must keep following that convention. No secret-scanning CI gate yet (ROADMAP).

### Denial of service
- **Risk**: oversized uploads/bodies, huge recipient arrays, request floods, zip bombs in spreadsheets, unbounded scheduler growth.
- **Controls**: `express.json({ limit: '10mb' })`, `multer` file size limit (5MB) + extension/MIME allowlist, `zod` caps on recipients (500)/groups (200)/bulk rows (5000)/message length (4096)/delay (300s), `lib/spreadsheet.js` enforces row/column/cell-length caps independent of the multer limit, tiered rate limiting per endpoint risk. Durable job processing adds its own bounded concurrency (`lib/jobs/backpressure.js`, a fixed max in-flight claimed items — never unbounded `Promise.all` over a large recipient list) and a circuit breaker (`lib/jobs/circuitBreaker.js`) that stops hammering the transport after repeated transient failures.
- **Residual risk**: no global HTTP request concurrency cap and no protection against a single very slow client holding a connection open (mitigated somewhat by Express/Node defaults, not hardened further this session). The job worker's 500ms poll loop plus the scheduler's 15s tick run continuously in the background even when idle, which measurably reduced HTTP throughput in this session's before/after benchmark (`docs/CAPACITY.md`) — a real, accepted latency cost, not a stability issue (zero errors/timeouts observed). Load/soak/burst testing beyond the baseline benchmark reruns is a `docs/ROADMAP.md` item.

### Elevation of privilege
- **Risk**: a VIEWER-role account performing an OPERATOR/OWNER action; hidden-frontend-button-as-authorization.
- **Controls**: every route uses server-side `requirePermission(permission)` — the frontend never gates by hiding buttons alone; role→permission mapping lives in one place (`lib/rbac.js`).
- **Residual risk**: only OWNER accounts exist today (no UI to create ADMIN/OPERATOR/VIEWER users yet — ROADMAP), so this is currently more scaffold than lived defense-in-depth.

## Specific scenarios investigated

| Scenario | Outcome |
|---|---|
| CSRF (cross-site form/fetch triggers a send) | Mitigated: double-submit CSRF token required on all unsafe-method requests; JSON-only bodies also resist classic `<form>`-based CSRF. |
| XSS via a malicious contact/chat name or spreadsheet cell | Mitigated: frontend already used `escapeHtml()` everywhere untrusted text is rendered (carried over from the earlier redesign); CSP (`script-src 'self'`, no `unsafe-inline`) is defense-in-depth if that discipline ever lapses. |
| CORS abuse | Mitigated: no CORS headers are set at all — same-origin only, by omission not by an allowlist that could be misconfigured. |
| Socket.IO abuse (unauthenticated client reads chat data) | Mitigated: handshake rejected before `connection` without a valid session. |
| Prototype pollution via crafted JSON body | Mitigated: `zod` schemas define exact shapes; `JSON.parse` + object literal assembly used throughout, no `Object.assign(target, userInput)`-style merges. |
| Malicious spreadsheet upload (zip bomb, huge sheet, wrong file type disguised) | Partially mitigated: extension + MIME allowlist, row/column/cell caps, 5MB upload limit. **Not yet mitigated**: no decompressed-size check independent of row count (a small file that expands enormously in memory during `XLSX.read` could still cause a memory spike before the row-count check runs) — tracked in ROADMAP as spreadsheet deep-hardening. |
| Path traversal | Not directly exposed — no route accepts a user-supplied filesystem path; `multer` uses in-memory storage, not disk paths from user input. |
| Duplicate/replay send (double-click, retried request) | **Mitigated.** Opt-in `Idempotency-Key` header on `/api/send`/`/api/send-groups`/`/api/send-bulk` (`lib/idempotency.js`, SQLite-backed, 5-min TTL) replays the cached response instead of re-sending. Verified in `test/idempotency.test.js`. |
| Job claim race (two workers/ticks try to process the same item) | **Mitigated.** `BEGIN IMMEDIATE` transactional claiming (`lib/jobs/claiming.js`) serializes claims at the SQLite lock level — correct across separate OS processes, not just in-process callbacks. Verified with a real multi-process test (8 processes racing for one item, exactly one wins) in `test/jobs.test.js`. |
| Scheduler double-fire across a process restart | **Mitigated.** A due occurrence's job uses idempotency key `schedule:<id>:<next_run_at>` — the SQLite UNIQUE index on `jobs.idempotency_key` guarantees at most one job is ever created for that occurrence, even if two ticks race or the process restarts mid-fire. Verified with a same-process double-tick test and a simulated-restart test (`test/scheduler.test.js`) — a new `Scheduler` instance reading the same DB does not re-fire an occurrence already marked `'sending'`. **Residual, honestly documented boundary**: this guarantees exactly-once *job creation*, not a guarantee that WhatsApp itself never sees a duplicate if the process crashes after the transport call succeeds but before the result is recorded — true distributed exactly-once delivery cannot be universally guaranteed by this or any architecture without a transactional outbox on the WhatsApp side itself, which doesn't exist. |
| Kill switch bypass (a lower-privileged account or a stale job re-enables/ignores it) | **Mitigated.** `manage_security` permission gates the toggle route (OWNER/ADMIN only); the job worker checks `isOutboundDisabled()` before every claim attempt and the three synchronous send routes check it via `requireOutboundEnabled` middleware before touching the transport — verified live (enabled → `423` on direct send; a job created while enabled stays stuck at `sending`, untouched, until disabled). |
| Dependency compromise | `npm audit` results captured in `docs/SECURITY_AUDIT.md` — known issues traced to `whatsapp-web.js`'s `archiver` dependency and `xlsx`'s prototype-pollution/ReDoS advisories (no patched release upstream). |
| Chromium/LocalAuth compromise | Chromium still runs with `--no-sandbox` (unchanged from the original app) — see `docs/SECURITY_AUDIT.md` for why this wasn't hardened further this session and what it would take. |
| Logging of sensitive data | Checked: `pino` redaction config covers the known-sensitive field names; manual review during verification found no accidental logging of passwords/cookies/QR data. |
| localhost-only trust assumption | Removed as the sole boundary: the app now requires authentication regardless of network location; `trust proxy` is explicitly `false` by default so `req.ip` isn't spoofable via headers unless a reverse proxy is deliberately configured. |

## Non-negotiables this respects

- No claim of 100% security anywhere in this document or the code comments.
- No destructive testing was ever run against real WhatsApp/Meta infrastructure — all testing in this session used `MockTransport`.
- No default/hard-coded credentials exist; `config/index.js` refuses to start without an explicit, sufficiently random `SESSION_SECRET`.
