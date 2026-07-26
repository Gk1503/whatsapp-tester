# Security Audit — Foundational Slice

Findings from this session's work. This is not a claim of "zero vulnerabilities" or "100% secure" — it's a record of what was checked, what was found, and what remains open. See `docs/THREAT_MODEL.md` for the broader STRIDE analysis this audit feeds into.

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
| 12 | No idempotency protection — a double-submitted send request sends twice. | Medium | Send/bulk/schedule-fire | **Open** — tracked in `docs/ROADMAP.md` Stage A. |
| 13 | `schedules.json` is a flat file, not transactional — a crash mid-write is a small but real corruption window. | Low | Scheduler | **Open** — tracked in `docs/ROADMAP.md` Stage A (SQLite migration). |
| 14 | Spreadsheet decompressed-size isn't checked independently of the post-parse row count — a small file could still expand significantly in memory during `XLSX.read` itself. | Low–Medium | `routes/bulk.js` | **Open** — tracked in `docs/ROADMAP.md` Stage E. |
| 15 | Only one role (OWNER) can actually be created — the RBAC permission map supports VIEWER/OPERATOR/ADMIN, but there's no UI/route to create those accounts yet. | Low (scaffold, not a live gap) | `lib/rbac.js` | **Open by design** — tracked in `docs/ROADMAP.md` Stage B. |

## What was NOT scanned/tested this session

Static analysis via ESLint-security or Semgrep, formal secret-scanning of git history, fuzz testing of parsers, load/soak/chaos testing beyond one baseline benchmark run, and a dedicated automated security test suite beyond the auth/validation/rate-limit/health tests in `test/`. All tracked in `docs/ROADMAP.md`.

## Verification performed

- Manual review of `pino` redaction config and a live run's logs — no passwords, cookies, session data, or QR payloads observed in output.
- Confirmed via running process list that `TRANSPORT_MODE=mock` spawns zero Chromium child processes (see session notes — a separate, pre-existing real WhatsApp session on the same machine was independently observed and left untouched).
- Confirmed unauthenticated `GET /api/contacts` → `401`, unauthenticated `GET /` → redirect to `/login.html`, unauthenticated Socket.IO handshake → rejected, CSRF-missing state-changing request → `401`, login rate limiter → `429` after repeated attempts — all via live requests against a running instance, not just code review.
