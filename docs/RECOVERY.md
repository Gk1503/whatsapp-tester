# Recovery

How this application behaves when things go wrong — crashes, restarts, stuck jobs, and the emergency kill switch. Everything here was verified by actually inducing the failure (killing a process, forcing a stale lease, disabling outbound and checking a job stays stuck) against `MockTransport`, not just reasoned about.

## Crash / restart recovery for the job queue

**What happens:** on every startup, before the job worker starts claiming new work, `jobWorker.recoverOnStartup()` runs `recoverStaleClaims()` (`lib/jobs/claiming.js`): any `job_items` left `claimed` or `running` whose lease (60s from the moment they were claimed) has expired are reset to `queued` and become eligible for claiming again.

**Why this is safe:** a lease only expires if the process that claimed the item died (or hung) before finishing it — a live worker updates the item's status well within the 60s lease window. Requeuing is the correct recovery: the item goes back through the same retry/attempt-counting path as a normal transient failure, so `job_items.max_attempts` still bounds it (it will not retry forever even after several crash/restart cycles).

**Verified:** `test/jobs.test.js` — "recoverStaleClaims requeues items whose lease has expired" (manually backdates a lease, confirms requeue) and "does not touch items with a still-valid lease" (confirms live work isn't disturbed).

## Restart safety for the scheduler

**What happens:** a due schedule occurrence is identified by `schedule:<scheduleId>:<nextRunAt>`, used as the job's `idempotency_key`. If the process restarts after the job was created but before the schedule row was updated to `'sending'` (or anywhere else in that window), the next tick calls `jobService.createJob()` again with the *same* key — the SQLite UNIQUE index returns the existing job instead of creating a duplicate, so the schedule doesn't fire twice for the same occurrence.

**Verified:** `test/scheduler.test.js` — "restart safety" test explicitly recreates a second `Scheduler` instance against the same database (simulating a process restart) and confirms only one job exists for the occurrence; "creates exactly one job even when called twice" simulates two overlapping ticks in the same process.

**Documented boundary, not glossed over:** this guarantees exactly-once *job creation* for a given occurrence. It does not — and no architecture without a transactional outbox on WhatsApp's own side could — guarantee that a real WhatsApp send is never duplicated if the process crashes *after* `transport.sendToNumbers()` succeeds but *before* the result is recorded. That specific narrow window is a known, accepted, and honestly documented residual risk (see `docs/THREAT_MODEL.md`).

## Missed schedule occurrences

Policy: `catch_up_once` (the only policy implemented). If the process was down (or the transport wasn't `ready`) through several occurrences of a repeating schedule, the next successful tick steps `next_run_at` forward by the repeat interval, in a loop, until it lands back in the future — then fires exactly once. It does not fire a backlog burst of every missed occurrence.

**Verified:** `test/scheduler.test.js` — "missed-run catch-up" test simulates a schedule roughly 10 minutes overdue on a 1-minute repeat interval and confirms exactly one job is created and `next_run_at` lands in the future, not on one of the ~10 missed minute-marks.

## The outbound kill switch

**Purpose:** an OWNER/ADMIN-only emergency stop for all outbound messaging, without needing to kill the whole process (which would also take down read-only functionality like viewing chats/contacts).

**How to activate:** sidebar toggle (OWNER/ADMIN only) or `POST /api/admin/kill-switch` with `{"disabled": true, "reason": "..."}`.

**What it does:**
- The job worker's tick checks `isOutboundDisabled()` before claiming any item — while active, queued/in-progress jobs simply stop making progress (they are **not** cancelled or lost; they resume automatically the moment it's disabled).
- `/api/send`, `/api/send-groups`, `/api/send-bulk`, and `POST /api/chats/:id/send` all check it before touching the transport, returning `423 Locked` if active.
- The state is stored in the `settings` table — durable across a restart.
- Every activation/deactivation is audit-logged with actor, reason, and timestamp.

**Verified live** (not just in tests): enabled the switch, confirmed a direct `/api/send` call returned `423`; created a due schedule while it was active and confirmed the job was created but stayed at `'sending'` with no `lastResult` (proof nothing was sent); disabled the switch and confirmed that same job completed on the very next worker tick with the expected `lastResult`, with no duplicate job created.

## Database integrity

`npm run db:check` runs `PRAGMA integrity_check` and reports the current schema version. Run it after any unclean shutdown if you want an extra confidence check — WAL mode plus `busy_timeout=5000` (see `lib/db.js`) already make SQLite itself resilient to a killed process (WAL recovery replays or discards the incomplete transaction on next open automatically), but the explicit check costs nothing and catches genuine corruption (e.g. from a failing disk) that WAL recovery can't fix.

## What's not covered yet

Automated soak/chaos test scenarios beyond the specific crash-recovery tests above (simulated DB-locked, simulated disk-full, simulated worker exception mid-item), a formal backup/restore command pair, and data retention/cleanup policies for old completed jobs. All tracked in `docs/ROADMAP.md`.
