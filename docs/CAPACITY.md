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

## Latest results

Run: `2026-07-26T12:30:31.050Z` · Node v25.9.0 · Windows x64 · 12 CPUs · 12 GB RAM · mock seed 12345 · 30 synthetic contacts / 20 synthetic chats.

| Scenario | Connections | Total Requests | Req/s (avg) | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | Errors | Timeouts |
|---|---|---|---|---|---|---|---|---|---|
| health_live | 1 | 4,263 | 852.6 | 1 | 1 | 1 | 2 | 0 | 0 |
| health_live | 10 | 8,235 | 1,647.0 | 5 | 8 | 12 | 16 | 0 | 0 |
| health_live | 50 | 9,346 | 1,869.4 | 24 | 34 | 45 | 66 | 0 | 0 |
| api_contacts | 1 | 1,681 | 336.2 | 2 | 3 | 3 | 4 | 0 | 0 |
| api_contacts | 10 | 2,030 | 406.0 | 24 | 27 | 33 | 37 | 0 | 0 |
| api_contacts | 50 | 2,050 | 410.0 | 123 | 134 | 167 | 190 | 0 | 0 |
| api_chats | 1 | 1,723 | 344.6 | 2 | 3 | 3 | 4 | 0 | 0 |
| api_chats | 10 | 2,010 | 402.0 | 24 | 28 | 32 | 37 | 0 | 0 |
| api_chats | 50 | 2,050 | 410.0 | 122 | 135 | 143 | 176 | 0 | 0 |

Raw data: `benchmarks/baseline/2026-07-26T12-30-31-050Z.json`.

## Reading these numbers honestly

- **Zero errors and zero timeouts** at every concurrency level tested — the app didn't fall over at 50 concurrent connections, but 50 is a small load; this is not a saturation point, just the top of what this session tested.
- **`/api/contacts` and `/api/chats` plateau around ~410 req/s** regardless of going from 10 to 50 connections, while latency keeps climbing (24ms → 123ms p50) — that's the signature of the authenticated middleware chain (session lookup + permission check + zod validation) and the synthetic-data generation becoming the bottleneck before raw HTTP handling does, not evidence of the actual ceiling.
- **`/health/live` scales further** (852 → 1,869 req/s) because it skips auth/session/validation entirely — useful as a rough ceiling for "the HTTP layer itself, no middleware."
- No p95/p99 degradation cliff was observed in this range — genuine saturation discovery (Phase 35: gradually increasing load until an inflection point appears) was **not** performed this session; only three fixed concurrency levels were sampled. That's explicitly a ROADMAP item, not a claim made here.

## Recommended operating guidance (from this data only)

Given zero errors through 50 concurrent connections against a single developer machine, there is no evidence in hand that this application's HTTP layer is a bottleneck for a single-user tool at realistic personal-use volumes. This says nothing about `whatsapp-web.js`/Puppeteer throughput under `TRANSPORT_MODE=real` — that was never measured (and per the non-negotiable rules, never will be by hammering a real WhatsApp session).

## What's not measured yet (see `docs/ROADMAP.md`)

Saturation-point discovery via gradually increasing load, soak testing (15–60 min sustained), burst testing, memory-leak-over-time snapshots, Socket.IO client scaling (1/10/50/100/500), larger synthetic datasets (1k/10k/50k contacts), bulk-row scaling (1k/10k/50k rows), and schedule-count scaling (100/1k/10k).
