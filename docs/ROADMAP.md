# Roadmap — deferred from the foundational-slice session

This session (see `docs/ARCHITECTURE.md` for what shipped) implemented the highest-leverage subset of a much larger request: config/mode system, transport abstraction + MockTransport, single-user auth, RBAC scaffold, input validation, tiered rate limiting, security headers, structured + audit logging, centralized errors, health endpoints, TEST MODE visibility, graceful shutdown, a baseline benchmark, and 29 automated tests.

Everything below is explicitly **not done yet** — staged by what unlocks the most for the next session, not by the original phase numbering.

## Stage A — Durability & data integrity
- Migrate `schedules.json` to the existing SQLite DB (transactional, atomic, survives partial writes) — preserve existing schedules during migration.
- Durable job queue for large sends: API creates a job and returns immediately; a worker processes it; progress/results persisted and pushed over Socket.IO (`queued/running/paused/completed/partially_completed/failed/cancelled`).
- Idempotency keys for `/api/send`, `/api/send-groups`, `/api/send-bulk`, and scheduled fires — prevent duplicate sends from double-clicks or client retries.
- Bounded exponential backoff + jitter for transient send failures; never retry permanent failures indefinitely.
- Backup/restore procedure for the SQLite DB; explicit exclusion of `./session` from any general backup tooling.
- Data retention policy for audit logs, job results, benchmark artifacts, and temporary uploads (currently in-memory only via multer, already not persisted to disk — verify this stays true as the job queue is added).

## Stage B — Multi-user & account management
- UI + routes for creating/managing ADMIN/OPERATOR/VIEWER accounts (the `lib/rbac.js` permission map already supports this; only account-management surface is missing).
- Password rotation / reset flow.
- Per-actor audit log viewer in the app (currently DB-query-only).
- Session/account management: list active sessions, force-logout, a proper "Disconnect WhatsApp / Invalidate Session" route wired to the already-implemented `Transport.disconnect()`.
- Global OWNER-only emergency stop (disable all outbound operations; queued jobs pause; audit-logged on activate/deactivate).

## Stage C — Testing depth
- Full Phase-59-equivalent test suite: integration tests per route (not just the security-critical sample this session covered), Socket.IO integration tests, scheduler restart/recovery tests, upload edge-case tests.
- Fuzz testing for the spreadsheet parser, template resolver, phone-number normalizer, and every zod schema — bounded runtime/memory/input-size, must fail controllably, never crash the process.
- API security test suite: unauthenticated access, wrong role, malformed JSON, oversized bodies/arrays, prototype-pollution payloads, XSS payloads, path-traversal strings, invalid upload types — expand what `test/validation.test.js`/`test/auth.test.js` started into a dedicated suite.
- Load/soak/burst/chaos testing against MockTransport: gradual concurrency ramp to find the actual saturation point (this session only sampled 1/10/50 connections — see `docs/CAPACITY.md`), 15–60 minute soak runs watching for memory growth, sudden burst simulation, and chaos scenarios (simulated transport disconnect, DB unavailable/locked, corrupted schedule data, worker crash, slow/timeout transport responses).
- Larger synthetic datasets for benchmarking: 1k/10k/50k contacts, 1k/10k/50k bulk rows, 100/1k/10k schedules, 1/10/50/100/500 concurrent Socket.IO clients.

## Stage D — CI & supply chain
- CI pipeline (GitHub Actions or equivalent, free tier): lint, `npm test`, `npm audit`, secret scanning, a production-config-validation smoke test — all against MockTransport, no real WhatsApp account ever required in CI.
- Static security analysis (ESLint security rules and/or Semgrep community rules) as a repeatable local + CI command.
- Formal `npm run security` command bundling audit + secret scan + static analysis, matching the pattern `npm test`/`npm run benchmark` already established.
- Resolve or formally document the current `npm audit` findings (see `docs/SECURITY_AUDIT.md`) — most trace to `whatsapp-web.js`'s `archiver` dependency and `xlsx`'s unpatched prototype-pollution/ReDoS advisories.

## Stage E — Deeper spreadsheet/input hardening
- Decompressed-size check independent of the row-count cap (a small malicious file could still expand significantly in memory before `enforceSheetLimits()` runs against the parsed result).
- External-link / formula-handling review inside `XLSX.read` itself (today's mitigation is on the *output* side — `neutralizeFormula()` — not the *input* parse side).
- Consider a maintained alternative to `xlsx` if one emerges without the current advisories; otherwise keep isolating/capping as the primary mitigation.

## Stage F — Isolation & deployment hardening
- Puppeteer/Chromium sandboxing review: the app still launches with `--no-sandbox` (unchanged from the original), because enabling the OS sandbox reliably across arbitrary host environments (especially inside a container) needs deliberate testing this session didn't have room for. Next step: evaluate running Chromium with its sandbox enabled where the host supports it, or move Chromium into its own hardened container (non-root, read-only root FS, tmpfs, dropped capabilities, `no-new-privileges`, seccomp/AppArmor profile) with the HTTP-facing process as a separate trust boundary.
- Hardened Docker setup for the whole app (non-root user, minimal base image, resource limits, no Docker socket, no host networking) — explicitly never mounting the real `./session` into a benchmark/test container.
- Reverse-proxy guidance: HTTPS termination, trusted-proxy configuration (`app.set('trust proxy', ...)` is currently `false` — safe default, but needs a real value documented for anyone deploying behind nginx/Caddy/etc.), CORS allowlist if this is ever exposed beyond one browser.

## Stage G — Verification artifacts
- Postman collection and/or curl script pack covering the full API surface (auth, status, contacts, chats, messages, jobs once they exist, bulk dry-run, schedules, health, deliberate authorization/validation/rate-limit failures) — defaulted to localhost + mock transport, no credentials embedded.
- `npm run verify` composite command (lint + test + security + integration + sandbox smoke test) once the above pieces exist — not created this session since several of its inputs (lint config, full integration suite) don't exist yet either.
- Before/after benchmark comparison once Stage A/C land — this session's `benchmarks/baseline/` run is the reference point.

## Explicitly out of scope until asked for again
Anything not listed above from the original 70-phase request — e.g. a full campaign/job UX with pause/resume/cancel controls, command-palette/keyboard-shortcut power-user features, frontend virtualization for very large lists — is not planned proactively; revisit if/when the underlying capability (job queue, larger real datasets) actually exists to justify it.
