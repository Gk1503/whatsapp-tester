# Operations

## First-time setup

```bash
npm install
cp .env.example .env
# Generate a real secret and put it in .env's SESSION_SECRET:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm run create-admin   # prompts for username + a masked password
npm run dev             # TRANSPORT_MODE=mock by default — no Chromium, no real WhatsApp session touched
```

Open `http://localhost:5050`, sign in with the account you just created. You'll see the "TEST MODE" banner and synthetic contacts/chats/messages — nothing here touches a real WhatsApp account.

## Switching to a real WhatsApp session

Only when you intend to actually use it:

```bash
# in .env
TRANSPORT_MODE=real
NODE_ENV=production   # production requires TRANSPORT_MODE to be set explicitly — see config/index.js
```

```bash
npm start
```

Scan the QR as before. `./session/` (gitignored) holds the live credentials — back it up like a secret, never commit it, never serve it statically (the app never does).

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | yes | `development` | `development`\|`test`\|`production` |
| `TRANSPORT_MODE` | yes in production | `mock` outside production | `mock`\|`real` — no implicit fallback to real in production |
| `PORT` | no | `5050` | |
| `SESSION_SECRET` | **yes** | — | ≥32 random chars; app refuses to start without one, and refuses the well-known `.env.test` value in production |
| `MOCK_SEED` | no | `12345` | Only affects `TRANSPORT_MODE=mock` — same seed → same synthetic data and send outcomes |
| `SESSION_IDLE_TIMEOUT_MS` | no | `1800000` (30 min) | |
| `SESSION_ABSOLUTE_TIMEOUT_MS` | no | `28800000` (8 hr) | |
| `LOG_LEVEL` | no | `info` (`silent` in test) | `pino` levels |
| `DB_PATH` | no | `data/app.db` | SQLite file — gitignored |
| `SCHEDULES_FILE` | no | `schedules.json` | Only read once, at startup, by the migration step — the running scheduler uses the `schedules` SQLite table |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | no | — | Only read by `npm run create-admin` for non-interactive/automated bootstrap; never a default credential, ignored once an account exists |
| `JOB_WORKER_CONCURRENCY` | no | `5` | Max in-flight job items the durable job worker processes at once (backpressure — see `lib/jobs/backpressure.js`) |
| `DISABLE_RATE_LIMIT` | no (test-only) | unset | Only takes effect when `NODE_ENV=test` **and** this is explicitly `true` — production is never affected. Used solely by `benchmarks/run-benchmark.js` so it measures raw throughput instead of the rate-limit ceiling. |

## Common tasks

- **Run tests**: `npm test` (uses `.env.test` — a committed, dummy-secret, mock-transport config; never touches `data/app.db` or `./session`).
- **Run the capacity benchmark**: `npm run benchmark` — see `docs/CAPACITY.md`.
- **Check database integrity**: `npm run db:check` (`PRAGMA integrity_check` + reports the current schema version).
- **Bootstrap another environment**: `npm run create-admin` refuses to run if any account already exists (by design — this session doesn't include multi-user management yet, see `docs/ROADMAP.md`).
- **Rotate the admin password**: not yet exposed via the app; delete the user row from `data/app.db` and re-run `create-admin`, or wait for the ROADMAP's account-management UI.
- **View the audit log**: currently DB-only (`SELECT * FROM audit_log ORDER BY ts DESC`) — no UI yet (ROADMAP).
- **Disconnect/invalidate the WhatsApp session**: not yet wired to a route (the `Transport.disconnect()` method exists and does the right thing — `client.logout()` for the real transport — but no HTTP endpoint calls it yet; ROADMAP).
- **Emergency-stop all outbound messaging**: OWNER/ADMIN accounts see a red "Outbound: enabled/DISABLED" panel in the sidebar with a toggle, or call `POST /api/admin/kill-switch` with `{"disabled": true, "reason": "..."}` directly. Blocks the job worker's claiming loop and the direct send/bulk/group-send/chat-send routes immediately; queued schedules stay queued (not lost) until re-enabled. Every change is audit-logged.
- **Prevent a duplicate send on retry**: send an `Idempotency-Key` header (any unique string, e.g. a UUID) on `/api/send`, `/api/send-groups`, or `/api/send-bulk` — a repeat of the same key within 5 minutes replays the original response instead of sending again. The frontend already does this automatically for every click of Send/Send to groups/Send to all.
- **Migrating an existing `schedules.json`**: fully automatic — on first startup after upgrading, if `schedules.json` exists and the `schedules` table is empty, its contents are imported once and the file is renamed to `schedules.json.migrated-<timestamp>` (never deleted). Safe to leave that env var/file in place; the migration only ever runs once.

## Graceful shutdown

`SIGINT`/`SIGTERM` (Ctrl+C, `docker stop`, etc.) triggers, in order: stop accepting new connections → stop the scheduler tick → stop the job worker from claiming new items and let in-flight ones finish within an 8-second bound (`jobWorker.drainAndStop()`) → close Socket.IO → `transport.shutdown()` (closes Chromium cleanly **without** logging out — the WhatsApp session survives a restart) → exit. A 10-second forced-exit timer prevents a hang if something doesn't close cleanly. Verified via direct in-process signal emission (the same mechanism Node uses internally for a real OS signal) — see `docs/RECOVERY.md`.

Note the distinction: `transport.shutdown()` (called on process exit) never invalidates the session; `transport.disconnect()` (a deliberate user action, not yet wired to a route — see above) does log out and requires a fresh QR scan next time.

See `docs/RECOVERY.md` for crash-recovery behavior (stale job claims, restart-safe scheduling) and the kill switch procedure in more depth.

## Known operational quirks carried over from the original app

- `whatsapp-web.js` fires its `ready` event ~5 seconds before contacts/chats are actually queryable; the transport delays exposing `ready` to match.
- `client.getChats()`/`getChatById()` are bypassed in favor of a raw `pupPage.evaluate()` serialization, because the library's own group-metadata refresh throws and takes down the whole list/thread on one broken chat. See the comments in `transports/WhatsAppWebTransport.js`.
