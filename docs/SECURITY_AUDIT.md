# Security Audit

Findings across sessions. This is not a claim of "zero vulnerabilities" or "100% secure" — it's a record of what was checked, what was found, and what remains open. See `docs/THREAT_MODEL.md` for the broader STRIDE analysis this audit feeds into.

## Update — durable jobs / SQLite scheduler / kill switch session

**xlsx replacement re-evaluated with a real trial install, not left as an assumption.** `xlsx@0.18.5` remains the latest npm-registry version (SheetJS stopped publishing newer fixed versions to npm). `exceljs@4.4.0` — the leading maintained alternative — was installed in an isolated scratch directory and audited: its own dependency tree pulls in the exact same `archiver`/`glob`/`minimatch`/`brace-expansion` chain already flagged below (10 findings: 1 moderate, 9 high — nearly identical to `xlsx`'s current 12). Switching would not reduce high-severity findings at all, while dropping `.xls` support and requiring a risky rewrite of the working parser/template/export pipeline. **Decision: kept `xlsx`.** This supersedes any implicit assumption that "a replacement exists but wasn't tried" — it was tried and evaluated.

Findings #12 and #13 below are now resolved (see the row detail). New controls added this session: durable job engine with transactional claiming (verified correct across separate OS processes, not just in-process — see `test/jobs.test.js`), retry with bounded exponential backoff + jitter, a circuit breaker around transport calls, an OWNER/ADMIN-only outbound kill switch (durable, audited, blocks both the job worker and the direct synchronous send routes), and `Idempotency-Key` support on `/api/send`, `/api/send-groups`, `/api/send-bulk`.

## Automated dependency audit (`npm audit`)

Run against the full dependency tree after adding this session's new packages (`zod`, `express-rate-limit`, `helmet`, `pino`, `express-session`, dev-only `autocannon`/`socket.io-client`):

| Package | Severity | Via | Affected component | Status |
|---|---|---|---|---|
| `xlsx` | high | Prototype Pollution; ReDoS (SheetJS) | Spreadsheet parsing (`routes/bulk.js`) | **Open, no upstream fix.** Already documented in the original app. Mitigated in this session by: extension/MIME allowlist, 5MB upload cap, row/column/cell-length caps (`lib/spreadsheet.js`), and treating parse results as untrusted (validated by `zod` before any further use). Not eliminated — see `docs/ROADMAP.md` Stage E. |
| `archiver`, `archiver-utils`, `zip-stream`, `readdir-glob`, `glob`, `minimatch`, `brace-expansion` | high | Transitive via `whatsapp-web.js` | Not directly used by our code — pulled in by `whatsapp-web.js`'s own dependency tree | **Open, upstream.** Our code never calls into `archiver` directly. Tracked for re-check whenever `whatsapp-web.js` is upgraded. |
| `autocannon` → `hyperid` → `uuid` | moderate | Missing buffer bounds check in `uuid` v3/v5/v6 | Dev-only benchmarking tool, never shipped/run in production | **Open, low priority** — devDependency only, not part of the running application. |

Run `npm audit` yourself for the current, exact state — dependency advisories change over time and this table reflects the moment this session ended.

## Manual review findings

| # | Finding | Severity | Component | Status |
|---|---|---|---|---|
| 1 | Original app had zero authentication — every `/api/*` route trusted "reachable from localhost" as its only control. | High | Whole app | **Fixed** — session auth + RBAC scaffold on every route this session. |
| 2 | Chromium launched with `--no-sandbox`. | Medium | `transports/WhatsAppWebTransport.js` | **Not fixed this session** — carried over unchanged from the original app. Disabling the sandbox is a real reduction in defense-in-depth against a compromised/malicious page reached via the WhatsApp Web session; re-enabling it needs host-environment-specific testing this session didn't have room for. Tracked in `docs/ROADMAP.md` Stage F. |
| 3 | `express-session` would default to `MemoryStore` (explicitly flagged by the library itself as unfit for production — no persistence, unbounded memory growth). | Medium | Session handling | **Fixed** — replaced with a SQLite-backed store (`lib/auth/sessionStore.js`). |
| 4 | No CSRF protection on state-changing routes. | Medium | All `POST`/`DELETE` routes | **Fixed** — double-submit token issued at login, required via `X-CSRF-Token` header, checked server-side in `requireAuth`. |
| 5 | No rate limiting anywhere — login endpoint could be brute-forced without limit, send endpoints could be hammered. | Medium | All routes | **Fixed** — tiered `express-rate-limit`, plus DB-backed login throttling (5 failures/15min lockout per username) independent of the IP-based rate limiter. |
| 6 | No input size/shape limits — a single request could submit an unbounded recipient array, an oversized message, or an unbounded spreadsheet row count. | Medium | Send/bulk/schedule routes | **Fixed** — `zod` caps (500 recipients, 200 groups, 5000 bulk rows, 4096-char messages, 300s max delay) plus independent spreadsheet-specific caps in `lib/spreadsheet.js`. |
| 7 | Generated `.xlsx` exports could contain formula-injection payloads if a spreadsheet cell/name/number began with `=`, `+`, `-`, or `@`. | Medium | `routes/bulk.js` build-sheet | **Fixed** — `neutralizeFormula()` prefixes a leading apostrophe on any such value before writing the export. |
| 8 | No audit trail — no record of who sent what, when, or who changed a schedule. | Medium | Whole app | **Fixed** — append-only `audit_log` table populated on every privileged action. |
| 9 | Errors could leak raw stack traces / internal detail to the client. | Low–Medium | All routes | **Fixed** — centralized error handler returns only a safe category + message; full detail logged server-side only. |
| 10 | No security headers (CSP, frame-ancestors, etc.). | Low–Medium | Whole app | **Fixed** — `helmet()` with an app-specific CSP (`script-src 'self'`, `img-src 'self' data:` for the QR code, no `unsafe-inline`/`unsafe-eval`). |
| 11 | Socket.IO accepted any connection and broadcast connection state/QR/chat data to it. | Medium | Socket.IO | **Fixed** — handshake now shares the session store and rejects unauthenticated clients before `connection` fires. |
| 12 | No idempotency protection — a double-submitted send request sends twice. | Medium | Send/bulk/schedule-fire | **RESOLVED.** `/api/send`, `/api/send-groups`, `/api/send-bulk` support an opt-in `Idempotency-Key` header (`lib/idempotency.js`, SQLite-backed, 5-minute TTL) — verified in `test/idempotency.test.js` (same key replays cached result, different/expired key re-sends). Scheduled fires get exactly-once *job creation* for free via `jobs.idempotency_key` (`schedule:<id>:<intendedRunAt>`) — verified with a real cross-process race test in `test/jobs.test.js` and a same-process double-tick test in `test/scheduler.test.js`. |
| 13 | `schedules.json` is a flat file, not transactional — a crash mid-write is a small but real corruption window. | Low | Scheduler | **RESOLVED.** Scheduler rewritten on the SQLite `schedules` table (`scheduler/index.js`); `schedules.json` is migrated once at startup (`lib/migrateSchedulesJson.js`, backs up to `schedules.json.migrated-<timestamp>`, never deletes) and is no longer read or written by the running app. |
| 14 | Spreadsheet decompressed-size isn't checked independently of the post-parse row count — a small file could still expand significantly in memory during `XLSX.read` itself. | Low–Medium | `routes/bulk.js` | **Open** — tracked in `docs/ROADMAP.md` Stage E. |
| 15 | Only one role (OWNER) can actually be created — the RBAC permission map supports VIEWER/OPERATOR/ADMIN, but there's no UI/route to create those accounts yet. | Low (scaffold, not a live gap) | `lib/rbac.js` | **Open by design** — tracked in `docs/ROADMAP.md`. |
| 16 | No way to stop all outbound messaging in an emergency without killing the whole process. | Medium | Whole app | **RESOLVED.** OWNER/ADMIN-only kill switch (`lib/killSwitch.js`, `routes/admin.js`), durable across restart (SQLite `settings` row), blocks the job worker's claiming loop *and* the direct synchronous send routes, audit-logged with actor/reason, visible in the sidebar UI. Verified live (enabled → `423` on `/api/send`, scheduled job stays stuck at `sending` until re-enabled, then completes) — see session verification notes. |
| 17 | The job-claiming transaction's correctness across multiple processes sharing one SQLite file was a design intent, not something empirically verified. | Low (design risk, not a live gap) | `lib/jobs/claiming.js` | **RESOLVED.** `test/jobs.test.js` spawns 8 separate OS processes racing to claim the same single job item; exactly one wins, verified via the DB row's final state, not just process exit codes. |
| 18 | `PRAGMA busy_timeout` was not set — the new job-claiming transaction (`BEGIN IMMEDIATE`) introduces real write contention that didn't exist before. | Low | `lib/db.js` | **RESOLVED.** `PRAGMA busy_timeout = 5000` added; `npm run db:check` (`PRAGMA integrity_check`) added as a repeatable sanity check. |

## What was NOT scanned/tested (still open — see `docs/ROADMAP.md` for staging)

Static analysis via ESLint-security or Semgrep, formal secret-scanning of git history, fuzz testing of parsers, load/soak/chaos testing beyond the baseline benchmark reruns, a dedicated adversarial API/Socket.IO test suite beyond what's in `test/`, MFA, multi-user account management, tamper-evident audit log hash-chaining, an audit-log viewer UI, and converting `/api/send`/`/api/send-groups`/`/api/send-bulk` to the durable job model (deferred alongside a Jobs UI — see `docs/ROADMAP.md`).

## Verification performed

- Manual review of `pino` redaction config and live run logs — no passwords, cookies, session data, or QR payloads observed in output.
- Confirmed via running process list that `TRANSPORT_MODE=mock` spawns zero Chromium child processes.
- Confirmed unauthenticated `GET /api/contacts` → `401`, unauthenticated `GET /` → redirect to `/login.html`, unauthenticated Socket.IO handshake → rejected, CSRF-missing state-changing request → `401`, login rate limiter → `429` after repeated attempts — all via live requests against a running instance, not just code review.
- This session, additionally verified live (not just unit tests): a due schedule fires through the real job worker end-to-end and reaches `done` with the correct `lastResult` shape; the kill switch blocks both a direct `/api/send` call (`423`) and a scheduled job's execution (stuck at `sending` until re-enabled, then completes without a duplicate send); the graceful-shutdown handler (verified via direct in-process `SIGTERM` emission, the same mechanism Node uses internally for a real OS signal) drains the job worker and exits cleanly well within its timeout; `npm run db:check` reports `ok` after all of the above.
