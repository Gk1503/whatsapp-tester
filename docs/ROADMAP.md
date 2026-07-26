# Roadmap

Full gate-by-gate status lives in `docs/COMPLETION_MATRIX.md`. This file is the narrative version — what's done, why, and what's next, staged by what unlocks the most for the following session (not by the original numbering of either mega-spec this project has worked through).

## Done

- **Foundational slice** (session 1): config/mode system, transport abstraction + MockTransport, single-user auth, RBAC scaffold, input validation, tiered rate limiting, security headers, structured + audit logging, health endpoints, TEST MODE visibility, graceful shutdown, baseline benchmark, 29 tests.
- **Durability core** (session 2, this one): durable job engine (`lib/jobs/` — transactional claiming verified correct across separate processes, retry with bounded backoff+jitter, circuit breaker, bounded concurrency/backpressure), SQLite-backed scheduler (schedules.json retired and migrated automatically), exactly-once job creation for scheduled occurrences (verified with real race/restart tests), an OWNER/ADMIN-only outbound kill switch (durable, audited, verified live), opt-in idempotency keys on the three synchronous send routes, crash recovery for stale job claims (verified by inducing it), extended graceful shutdown (drains the job worker), `uncaughtException` handling, `busy_timeout` + `npm run db:check`, xlsx replacement re-evaluated with a real trial install and rejected with evidence. 31 new tests (60 total), before/after benchmark comparison with an honestly-explained regression.

## Next up — Stage: Jobs UI + converting the synchronous send routes

The durable job engine exists and is proven (via the scheduler), but `/api/send`, `/api/send-groups`, and `/api/send-bulk` still execute synchronously in the request handler. Converting them to create-a-job-and-return is the highest-value remaining item, but it requires a minimal Jobs view (job list, per-item status, pause/resume/cancel) so the Send/Bulk/Groups tabs don't regress into "click Send, see nothing." Do both together, not one without the other.

- Convert `/api/send`, `/api/send-groups`, `/api/send-bulk` to `jobService.createJob(...)`, returning `{ jobId }` immediately.
- Minimal Jobs/Operations view: job list with status/progress, per-item results (success/skipped/permanent-failure/transient-failure-exhausted), pause/resume/cancel controls, live updates via a new `jobUpdate` Socket.IO event (bridged the same way `scheduleUpdate` already is).
- Retry-failed-items: a new job containing just the eligible failed items from a prior one, with `originalJobId`/`retryJobId` lineage — not mutating the historical job.

## Stage: Multi-user & account management

- UI + routes for creating/managing ADMIN/OPERATOR/VIEWER accounts (`lib/rbac.js` already models this).
- Password rotation/reset flow.
- Session management: list active sessions, force-logout, revoke-all-other-sessions.
- Optional TOTP-based MFA for OWNER/ADMIN (hashed recovery codes, standard interoperable TOTP, no SMS dependency).
- A proper "Disconnect WhatsApp / Invalidate Session" route wired to the already-implemented `Transport.disconnect()`.

## Stage: Testing depth & security tooling

- Full adversarial API/Socket.IO test suite (unauthenticated/wrong-role/expired-session/CSRF/prototype-pollution/path-traversal/oversized-payload matrix) beyond the focused set this session added for the new job/scheduler/kill-switch surface.
- Fuzz testing for the spreadsheet parser, template resolver, phone normalizer, and every zod schema.
- Secret scanning (e.g. Gitleaks) + SAST (ESLint security rules and/or Semgrep) as repeatable local commands, then a CI gate.
- Load/soak/burst/chaos testing: this session's benchmark reruns still only sample 1/10/50 connections — real saturation-point discovery (gradual ramp until an inflection point appears), 15–60 minute soak runs, burst simulation, and chaos scenarios (DB locked, worker exception, transport timeout) remain undone.
- Larger synthetic datasets for benchmarking (1k/10k/50k contacts/bulk rows, 100/1k/10k schedules, concurrent Socket.IO clients).
- A tunable/adaptive job-worker poll interval (back off when idle) to recover the throughput cost documented in `docs/CAPACITY.md`'s before/after comparison.

## Stage: Observability

- Structured metrics beyond logs: queue depth, active jobs, job throughput/failure rate, scheduler lag, event-loop delay, exposed via an authenticated health/status surface (not a public dashboard).
- Security event monitoring surfaced to OWNER/ADMIN (failed-login bursts, lockouts, authorization failures, CSRF failures, rate-limit violations) — the audit log already records these; this is about making them visible without a DB query.
- Tamper-evident audit log (hash-chaining) + an `npm run audit:verify` command + an in-app audit viewer with filtering/pagination.

## Stage: Operational hardening

- Backup/restore command pair for the SQLite DB (explicitly excluding `./session`), tested by an actual backup → destroy → restore → verify cycle.
- Data retention policies for completed jobs, job events, audit logs, benchmark artifacts.
- Puppeteer/Chromium sandboxing review — still launches with `--no-sandbox`, unchanged from the original app; re-enabling the OS sandbox needs host-specific testing.
- HTTP hardening (request/header timeouts, trusted-proxy configuration for anyone deploying behind a reverse proxy).
- Docker/container hardening — **explicitly deferred**, not part of this project's current phase per direct instruction, revisit only when asked.

## Stage: Verification artifacts

- Postman collection / curl script pack covering the full API surface, defaulted to localhost + mock transport, no embedded credentials.
- `npm run security` (bundling secret scan + SAST + dependency audit) and `npm run verify` (lint + tests + security + integration + sandbox smoke test) — blocked on the tooling above existing first.

## Explicitly out of scope until asked for again

Docker/Kubernetes, Redis or any distributed queue (SQLite has shown no evidence of being inadequate for this single-node tool), frontend virtualization for very large lists (no evidence yet that current datasets need it), a command palette or other power-user UI features not tied to a specific reliability/security gap.
