# Completion Matrix

Full gate-by-gate status against the 70-gate spec this project is working through across sessions. Updated at the end of each session — do not assume a gate marked DONE in an earlier version of this file is still accurate without re-checking; re-verify against the current code, same as this session did in Gate 0.

Legend: **DONE** (implemented and verified with evidence) · **PARTIAL** (some real part shipped, rest deferred with a stated reason) · **MISSING** (not started) · **N/A** (doesn't apply to this project's architecture).

| Gate | Area | Status | Evidence / next action |
|---|---|---|---|
| 0 | Re-audit + baseline | DONE | This session: read all 6 docs, ran `npm test` (29/29 before changes), ran a scratch install of `exceljs` to evaluate xlsx replacement with real data. |
| 1 | Security debt (xlsx, transitive deps) | DONE | `xlsx` kept — `exceljs` trial install showed the same `archiver` chain, no reduction in findings (`docs/SECURITY_AUDIT.md`). |
| 2 | Durable job architecture | PARTIAL | `lib/jobs/` fully built and proven via the scheduler (`test/jobs.test.js`, `test/scheduler.test.js`). **Not done**: `/api/send`/`/api/send-groups`/`/api/send-bulk` still execute synchronously — converting them needs a Jobs UI first (see `docs/ROADMAP.md`, next stage). |
| 3 | Job claiming & concurrency safety | DONE | `lib/jobs/claiming.js`, `BEGIN IMMEDIATE` transaction. Verified with a **real 8-process race test** (`test/jobs.test.js`), not just in-process. |
| 4 | Idempotency | PARTIAL | Job creation idempotent via DB UNIQUE constraint (verified). Synchronous send routes: opt-in `Idempotency-Key` header (`lib/idempotency.js`, verified in `test/idempotency.test.js`). **Not done**: idempotency for a hypothetical retry-of-a-job action (doesn't exist yet — no retry UI). |
| 5 | Retry engine | DONE | `lib/jobs/errorClassifier.js` + `lib/jobs/retry.js` — bounded exponential backoff + jitter, max 5 attempts, category-based (only TRANSIENT/UNKNOWN retried). Verified in `test/jobs.test.js`. |
| 6 | Backpressure & concurrency control | DONE | `lib/jobs/backpressure.js` (bounded semaphore, default 5 concurrent items, `JOB_WORKER_CONCURRENCY` env override). Verified with a unit test; real capacity impact measured in `docs/CAPACITY.md`. |
| 7 | Circuit breaker | DONE | `lib/jobs/circuitBreaker.js` — CLOSED/OPEN/HALF_OPEN, deterministic (no reliance on real timing beyond a configurable cooldown). Verified trip/cooldown/half-open/recover in `test/jobs.test.js`. |
| 8 | Global outbound kill switch | DONE | `lib/killSwitch.js`, `routes/admin.js`, sidebar UI, audit-logged, durable (SQLite `settings`). Verified **live**: blocks direct send (423) and blocks a queued job (stays at `sending`) until re-enabled, then completes without duplicating. |
| 9 | Pause / resume / cancel | PARTIAL | `jobService.pauseJob/resumeJob/cancelJob` implemented and unit-tested (completed items stay completed, cancel is idempotent). **Not done**: no UI exposes these yet (waits on the Jobs UI, Gate 2/47). |
| 10 | Migrate scheduler to SQLite | DONE | `scheduler/index.js` rewritten on the `schedules` table; `lib/migrateSchedulesJson.js` backs up and imports the old file once, never deletes it. Same REST/Socket.IO contract — zero frontend changes needed. |
| 11 | Scheduler exactly-once intent | DONE | Idempotency key `schedule:<id>:<nextRunAt>` on job creation. Verified: double-tick same-process test and a simulated-restart test (new `Scheduler` instance, same DB) in `test/scheduler.test.js`. Boundary documented in `docs/RECOVERY.md` (exactly-once job creation, not a distributed-transaction guarantee against WhatsApp itself). |
| 12 | Time / DST / missed-run correctness | PARTIAL | `catch_up_once` policy implemented and tested with fixed deterministic timestamps (`test/scheduler.test.js`). Uses epoch-ms throughout (DST-agnostic by construction). **Not done**: `SKIP`/`RUN_ONCE` alternative policies aren't implemented, only `catch_up_once`. |
| 13 | Multi-user RBAC completion | MISSING | `lib/rbac.js` models 4 roles; no UI/route creates ADMIN/OPERATOR/VIEWER accounts yet. |
| 14 | Optional MFA | MISSING | Not started. |
| 15 | Session management | MISSING | No "view/revoke sessions" UI or route yet. |
| 16 | Security event monitoring | PARTIAL | The audit log already records failed logins/lockouts/authorization failures/CSRF failures — but nothing surfaces them without a direct DB query. |
| 17 | Tamper-evident audit log | MISSING | Audit log is append-only but not hash-chained; no `npm run audit:verify`. |
| 18 | Audit log UI | MISSING | DB-query-only today. |
| 19 | Secret scanning | MISSING | No Gitleaks or equivalent wired up yet. |
| 20 | Static Application Security Testing | MISSING | No ESLint-security/Semgrep run yet. |
| 21 | Dependency security gate | PARTIAL | `npm audit` run and documented each session (`docs/SECURITY_AUDIT.md`); no CI gate, no OSV-Scanner. |
| 22 | API adversarial test suite | PARTIAL | This session added targeted adversarial tests for the *new* surface (job races, kill-switch bypass attempts, idempotency bypass) — `test/jobs.test.js`, `test/killSwitch.test.js`, `test/idempotency.test.js`. The full matrix (every route × every failure mode) doesn't exist. |
| 23 | Socket.IO security testing | MISSING (beyond session 1) | Unauthenticated-handshake rejection was verified live in session 1; expired/revoked-session-while-connected, reconnect storms, and Origin validation aren't separately tested. |
| 24 | XSS / DOM security | MISSING (beyond session 1) | `escapeHtml()` usage was reviewed during the frontend redesign; no fresh automated XSS payload pass this session. |
| 25 | Spreadsheet fuzzing | MISSING | Only manual/logical review (`docs/SECURITY_AUDIT.md` finding #14 — decompressed-size check still open). |
| 26 | General fuzz testing | MISSING | Not started for validation schemas/phone normalization/template resolution. |
| 27 | File upload isolation | PARTIAL | In-memory `multer` storage (no user-controlled path, nothing persisted to disk) already avoids most of this gate's concerns; no explicit random-filename/cleanup code exists because nothing is written to disk in the first place. |
| 28 | Template engine hardening | DONE | `lib/spreadsheet.js`'s `resolveTemplate()` is regex-based substitution only — no `eval`/`Function`. Unaffected by this session's changes; re-confirmed by reading it during this audit. |
| 29 | Observability foundation (metrics) | MISSING | Logs exist (`pino`); no metrics surface (queue depth, job throughput, event-loop lag, etc.). |
| 30 | System health dashboard | MISSING | `/health/live`, `/health/ready` exist; no authenticated operational dashboard. |
| 31 | Performance test environment | DONE | `benchmarks/run-benchmark.js` refuses to run against anything but the app it boots itself (hardcoded `127.0.0.1`, MockTransport, disposable DB) — there is no configuration surface that could point it at an external host. |
| 32 | Benchmark matrix | PARTIAL | Only 1/10/50 connections × 3 endpoints sampled, both before and after this session's changes. No larger synthetic datasets, no Socket.IO client scaling. |
| 33 | Benchmark metrics | PARTIAL | p50/p90/p95/p99/req-s/errors/timeouts captured; no CPU/RSS/heap/event-loop-lag capture during the run itself. |
| 34 | Saturation discovery | MISSING | Only fixed concurrency levels tested; no gradual ramp to find an inflection point. |
| 35 | Safe operating envelope | MISSING | Depends on Gate 34. |
| 36 | Soak testing | MISSING | Not run. |
| 37 | Memory leak analysis | MISSING | Not run. |
| 38 | Burst testing | MISSING | Not run as a distinct scenario (the benchmark's 50-connection level is a fixed load, not a burst). |
| 39 | Chaos testing | PARTIAL | This session's crash-recovery tests (stale claim recovery, restart-safety) are a narrow, real form of chaos testing for the job/scheduler subsystem specifically. Broader scenarios (DB locked, disk-full, worker exception mid-item) aren't simulated. |
| 40 | Crash recovery | DONE | `recoverStaleClaims()` + `test/jobs.test.js`, restart-safety in `test/scheduler.test.js`, live SIGTERM verification via direct in-process signal emission (`docs/RECOVERY.md`). |
| 41 | SQLite reliability | DONE | WAL mode (session 1) + `PRAGMA busy_timeout=5000` (this session) + `npm run db:check`. |
| 42 | Database migrations | PARTIAL | Minimal schema-version tracking (`settings.schema_version`) + idempotent `CREATE TABLE IF NOT EXISTS` — deliberately not a full up/down migration framework, since every change so far has been additive. |
| 43 | Backup & restore | MISSING | Not implemented. |
| 44 | Data retention | MISSING | Not implemented. |
| 45 | Privacy / redaction review | PARTIAL | `pino` redaction paths reviewed in session 1 and re-confirmed this session (job/schedule data doesn't add new logged fields beyond what's already redacted). No fresh full review of every storage surface. |
| 46 | Frontend large-data performance | MISSING | Not tested with large synthetic datasets. |
| 47 | Advanced Jobs UI | MISSING | Backend (`lib/jobs/`) is ready for this; no UI yet — see `docs/ROADMAP.md` next stage. |
| 48 | Failed item analysis | PARTIAL | Per-item status/error category/message is stored (`job_items`, `job_attempts`) and would render correctly once a Jobs UI exists; nothing surfaces it today. |
| 49 | Retry failed items | MISSING | No UI/route for it; `jobService` has the primitives (`createJob` with new items) but no dedicated "retry eligible failures" helper yet. |
| 50 | Scheduler UI improvements | N/A this session | The scheduler's REST/Socket.IO contract was deliberately kept identical, so the existing UI already shows next/last run, last result, status, repeat rule; pause/resume/disable controls beyond delete aren't exposed. |
| 51 | Diagnostics lab | MISSING | Not built. |
| 52 | Production safety interlock | PARTIAL | `config/index.js` already fails closed on missing/weak/reused-test `SESSION_SECRET` and requires explicit `TRANSPORT_MODE` in production (session 1). No additional `ENABLE_REAL_TRANSPORT` flag was added this session — judged unnecessary duplication given `TRANSPORT_MODE=real` is already explicit and fail-closed. |
| 53 | LocalAuth hardening | PARTIAL (unchanged) | `./session` still never served statically, gitignored, never logged — re-confirmed, not re-hardened further this session. |
| 54 | Chromium security | PARTIAL (unchanged) | Still launches with `--no-sandbox`, unchanged from the original app — documented, not fixed (`docs/SECURITY_AUDIT.md` finding #2). |
| 55 | HTTP hardening | MISSING | No explicit request/header timeout tuning beyond Node/Express defaults. |
| 56 | Error resilience | DONE | `uncaughtException` handler added this session (logs fatal, exits non-zero) alongside the existing `unhandledRejection` handler. |
| 57 | Graceful shutdown v2 | DONE | Extended to drain the job worker before closing the server; verified via direct in-process `SIGTERM` emission (`docs/RECOVERY.md`). |
| 58 | CI security & quality gate | MISSING | No CI configured in this repository. |
| 59 | Postman / curl verification pack | MISSING | Not created. |
| 60 | One-command security test | MISSING | Blocked on Gates 19/20 existing first. |
| 61 | One-command benchmark | DONE | `npm run benchmark` already exists (session 1), reused and rerun this session for before/after. |
| 62 | One-command full verification | MISSING | Blocked on Gates 58–60. |
| 63 | Before/after benchmark | DONE | `docs/CAPACITY.md` — real rerun, regression found and explained (job-worker/scheduler background polling contention), not hidden. |
| 64 | Update CAPACITY.md | DONE | Updated this session. |
| 65 | Update THREAT_MODEL.md | DONE | Updated this session (new assets: jobs/schedules/kill-switch; new mitigated scenarios). |
| 66 | Update SECURITY_AUDIT.md | DONE | Updated this session (xlsx re-evaluation, findings #12/#13 resolved, 3 new findings). |
| 67 | Operations / recovery documentation | DONE | `docs/OPERATIONS.md` updated; new `docs/RECOVERY.md` created. |
| 68 | Cleanup | DONE (scoped) | `schedules.json`-based scheduler code fully replaced, not left running alongside the new one; old file is migrated-and-renamed, not left active. |
| 69 | Full adversarial final review | PARTIAL | Scoped adversarial questions answered for this session's new surface only (job races, kill-switch bypass, restart duplication, idempotency bypass) — not the full 20-question list spanning MFA/SAST/sockets/etc. that aren't built yet. |
| 70 | Final acceptance (evidence-based) | PARTIAL | For what shipped this session: clean install, full test suite (60/60), live manual verification (schedule fire, kill switch, shutdown), before/after benchmark. Not run: SAST, secret scan, fuzzing, soak/chaos beyond the crash-recovery tests, production-config validation beyond what already existed. |

## Session-over-session summary

- **Session 1**: Gates 0 (partial, initial), 2 (transport abstraction precursor work), most of the "foundational" security controls that don't map 1:1 to this specific 70-gate numbering (auth, RBAC scaffold, validation, rate limiting, audit logging, health endpoints) — see that session's own report.
- **Session 2 (this one)**: Gates 0, 1, 3, 5, 6, 7, 8, 10, 11, 40, 41, 56, 57, 61, 63, 64, 65, 66, 67, 68 DONE; Gates 2, 4, 9, 12, 16, 21, 22, 27, 39, 42, 45, 48, 52, 53, 54, 69, 70 PARTIAL with a stated reason; the rest MISSING and staged in `docs/ROADMAP.md`.
- **Next session's clearest starting point**: convert `/api/send`/`/api/send-groups`/`/api/send-bulk` to the job model, paired with a minimal Jobs UI (closes Gates 2, 9, 47, 48, 49 together).
