# Capacity

**These are measured limits of this application's HTTP layer against `MockTransport`, running on one developer machine. They are not WhatsApp/Meta sending limits, and they are not a promise of production capacity on different hardware.** No benchmark in this repository has ever sent traffic to WhatsApp, Meta infrastructure, or any real WhatsApp account.

## Why there's no "before" baseline

The pre-refactor application had no way to serve `/api/contacts`, `/api/chats`, or any data endpoint without a live, QR-scanned WhatsApp session — every one of them returned `409` otherwise. There was nothing meaningful to benchmark before `MockTransport` existed. This run **is** the reference baseline; future sessions compare against it rather than inventing a retroactive "before" number.

## Methodology

`npm run benchmark` (`benchmarks/run-benchmark.js`):

1. Wipes and recreates a disposable SQLite DB (`data/benchmark.db`) — never the real `data/app.db`.
2. Boots the actual app in-process (`require('../server')`) with `TRANSPORT_MODE=mock`, `NODE_ENV=test`.
3. Creates a throwaway OWNER account, logs in over real HTTP to get a genuine session cookie.
4. Rate limiting is bypassed **only** because `NODE_ENV=test` **and** an explicit `DISABLE_RATE_LIMIT=true` env var are both set by the script itself — this bypass is structurally impossible in production (see `lib/rateLimit.js`), and exists only so the benchmark measures raw endpoint throughput rather than the intentional rate-limit ceiling.
5. Drives `autocannon` at connection counts 1 / 10 / 50, 5 seconds per scenario, against `/health/live` (unauthenticated), `/api/contacts`, `/api/chats` (authenticated via the real session cookie).
6. Writes `benchmarks/baseline/<timestamp>.json` (full detail) and a generated `.md` summary.

## Before/after: durable jobs + SQLite scheduler + kill switch session

The second baseline run below happened *after* adding the durable job engine (`lib/jobs/`, polling every 500ms), the SQLite-backed scheduler (replacing `schedules.json`), the kill switch, and idempotency-key checks — all running in the same process as the HTTP server being benchmarked. Same machine, same scenarios, same dataset size.

| Scenario (@ 50 conn) | Before (job engine) | After (job engine) | Delta |
|---|---|---|---|
| health_live req/s | 1,869.4 | 1,570.0 | **-16%** |
| health_live p50 | 24ms | 29ms | +5ms |
| api_contacts req/s | 410.0 | 330.0 | **-20%** |
| api_contacts p50 | 123ms | 150ms | +27ms |
| api_chats req/s | 410.0 | 280.0 | **-32%** |
| api_chats p50 | 122ms | 176ms | +54ms |
| Errors / timeouts (all scenarios) | 0 | 0 | none |

**This is a real, measured regression, not hidden.** The cause is identifiable and expected, not a mystery: the job worker polls for claimable work every 500ms and the scheduler ticks every 15s, both against the *same* SQLite connection the HTTP request handlers use, even when there is no job/schedule activity during the benchmark. That background polling competes for the single-threaded event loop and SQLite's writer lock with the benchmark's own read traffic. Zero errors or timeouts occurred at any concurrency level in either run — this is a latency/throughput cost, not a stability regression, and it is the accepted trade-off of gaining durable jobs/exactly-once scheduling/a kill switch, consistent with this project's stated priority order (**correctness → security → data integrity → recoverability → predictable latency → throughput**). A tunable/adaptive poll interval for the job worker (back off when idle) is a reasonable, low-risk future improvement and is noted in `docs/ROADMAP.md`.

## Latest results (after)

Run: `2026-07-26T13:29:27.067Z` · Node v25.9.0 · Windows x64 · 12 CPUs · 12 GB RAM · mock seed 12345 · 30 synthetic contacts / 20 synthetic chats · job worker + scheduler running in the background throughout.

| Scenario | Connections | Total Requests | Req/s (avg) | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | Errors | Timeouts |
|---|---|---|---|---|---|---|---|---|---|
| health_live | 1 | 3,616 | 723.2 | 1 | 1 | 2 | 4 | 0 | 0 |
| health_live | 10 | 6,757 | 1,351.4 | 6 | 9 | 15 | 22 | 0 | 0 |
| health_live | 50 | 7,850 | 1,570.0 | 29 | 39 | 46 | 71 | 0 | 0 |
| api_contacts | 1 | 1,368 | 273.6 | 3 | 4 | 5 | 5 | 0 | 0 |
| api_contacts | 10 | 1,640 | 328.0 | 29 | 34 | 40 | 43 | 0 | 0 |
| api_contacts | 50 | 1,650 | 330.0 | 150 | 168 | 236 | 239 | 0 | 0 |
| api_chats | 1 | 1,390 | 278.0 | 3 | 4 | 4 | 5 | 0 | 0 |
| api_chats | 10 | 1,580 | 316.0 | 31 | 37 | 44 | 46 | 0 | 0 |
| api_chats | 50 | 1,400 | 280.0 | 176 | 240 | 244 | 244 | 0 | 0 |

Raw data: `benchmarks/baseline/2026-07-26T13-29-27-067Z.json`. Prior ("before") run: `benchmarks/baseline/2026-07-26T12-30-31-050Z.json`.

## Reading these numbers honestly

- **Zero errors and zero timeouts** at every concurrency level tested, in both runs — the app didn't fall over at 50 concurrent connections, but 50 is a small load; this is not a saturation point, just the top of what this session tested.
- **`/api/contacts` and `/api/chats` plateau well before 50 connections** while latency keeps climbing — that's the authenticated middleware chain (session lookup + permission check + zod validation) plus, in the "after" run, background job-worker/scheduler polling contention, becoming the bottleneck before raw HTTP handling does — not evidence of the actual ceiling.
- **`/health/live` scales furthest in both runs** because it skips auth/session/validation entirely — useful as a rough ceiling for "the HTTP layer itself, no middleware."
- No p95/p99 degradation cliff was observed in this range — genuine saturation discovery (gradually increasing load until an inflection point appears) was **not** performed this session; only three fixed concurrency levels were sampled. That's explicitly a `docs/ROADMAP.md` item, not a claim made here.

## Recommended operating guidance (from this data only)

Given zero errors through 50 concurrent connections against a single developer machine, there is no evidence in hand that this application's HTTP layer is a bottleneck for a single-user tool at realistic personal-use volumes. This says nothing about `whatsapp-web.js`/Puppeteer throughput under `TRANSPORT_MODE=real` — that was never measured (and per the non-negotiable rules, never will be by hammering a real WhatsApp session).

## What's not measured yet (see `docs/ROADMAP.md`)

Saturation-point discovery via gradually increasing load, soak testing (15–60 min sustained), burst testing, memory-leak-over-time snapshots, Socket.IO client scaling (1/10/50/100/500), larger synthetic datasets (1k/10k/50k contacts), bulk-row scaling (1k/10k/50k rows), and schedule-count scaling (100/1k/10k).
