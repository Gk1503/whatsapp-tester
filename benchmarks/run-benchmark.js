#!/usr/bin/env node
// Real, measured benchmark run against MockTransport — never against a live
// WhatsApp session, never against WhatsApp/Meta infrastructure. Boots the
// actual app in-process against a disposable benchmark database, logs in as
// a throwaway user it creates itself, then drives autocannon at a few
// concurrency levels against read endpoints. Writes results to
// benchmarks/baseline/<timestamp>.json + a generated .md summary.
//
// There is no meaningful "before" baseline for this app: every data
// endpoint 409s without a live WhatsApp session, and the pre-refactor app
// had no way to serve traffic without one. This run IS the reference
// baseline for future before/after comparisons (see docs/CAPACITY.md).
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { execSync } = require('node:child_process');

const BENCH_DB = path.join(__dirname, '..', 'data', 'benchmark.db');
const PORT = 5099;
const BASE_URL = `http://127.0.0.1:${PORT}`;

fs.rmSync(BENCH_DB, { force: true });
fs.rmSync(`${BENCH_DB}-wal`, { force: true });
fs.rmSync(`${BENCH_DB}-shm`, { force: true });

process.env.NODE_ENV = 'test';
process.env.TRANSPORT_MODE = 'mock';
process.env.PORT = String(PORT);
process.env.DB_PATH = BENCH_DB;
process.env.MOCK_SEED = process.env.MOCK_SEED || '12345';
process.env.LOG_LEVEL = 'silent';
// Only takes effect because NODE_ENV=test above — see lib/rateLimit.js.
process.env.DISABLE_RATE_LIMIT = 'true';
if (!process.env.SESSION_SECRET) {
  process.env.SESSION_SECRET = 'benchmark-only-secret-0000000000000000000000000000000';
}

const db = require('../lib/db');
const { hashPassword } = require('../lib/auth/passwords');

const BENCH_USER = 'benchmark-runner';
const BENCH_PASS = `bench-${Date.now()}-throwaway-password`;
db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run(
  BENCH_USER,
  hashPassword(BENCH_PASS),
  'OWNER',
  Date.now()
);

require('../server'); // boots the real app, in-process, against the benchmark DB

function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function waitForReady(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await httpRequest({ hostname: '127.0.0.1', port: PORT, path: '/health/ready', method: 'GET' });
      if (res.status === 200) return;
    } catch {
      // server not accepting connections yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Server did not become ready in time');
}

async function login() {
  const res = await httpRequest(
    {
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    },
    JSON.stringify({ username: BENCH_USER, password: BENCH_PASS })
  );
  if (res.status !== 200) throw new Error(`Login failed: ${res.status} ${res.body}`);
  const setCookie = res.headers['set-cookie'] || [];
  const sidCookie = setCookie.find((c) => c.startsWith('connect.sid='));
  if (!sidCookie) throw new Error('No session cookie returned from login');
  return sidCookie.split(';')[0];
}

async function waitForTransportReady(cookie, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/contacts',
      method: 'GET',
      headers: { Cookie: cookie }
    });
    if (res.status === 200) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('MockTransport did not reach ready state in time');
}

function runAutocannon(opts) {
  const autocannon = require('autocannon');
  return new Promise((resolve, reject) => {
    autocannon(opts, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

function summarize(result) {
  return {
    title: result.title,
    connections: result.connections,
    durationSec: result.duration,
    requests: { total: result.requests.total, average: result.requests.average },
    latencyMs: {
      p50: result.latency.p50,
      p90: result.latency.p90,
      p95: result.latency.p97_5 ?? result.latency.p95,
      p99: result.latency.p99,
      max: result.latency.max
    },
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx
  };
}

async function main() {
  console.log('Waiting for app to be ready...');
  await waitForReady();

  console.log('Logging in as throwaway benchmark user...');
  const cookie = await login();

  console.log('Waiting for MockTransport to reach the ready state...');
  await waitForTransportReady(cookie);

  const concurrencyLevels = [1, 10, 50];
  const scenarios = [
    { name: 'health_live', path: '/health/live', headers: {} },
    { name: 'api_contacts', path: '/api/contacts', headers: { Cookie: cookie } },
    { name: 'api_chats', path: '/api/chats', headers: { Cookie: cookie } }
  ];

  const results = [];
  for (const scenario of scenarios) {
    for (const connections of concurrencyLevels) {
      console.log(`Running ${scenario.name} @ ${connections} connections...`);
      const result = await runAutocannon({
        url: `${BASE_URL}${scenario.path}`,
        connections,
        duration: 5,
        headers: scenario.headers,
        title: `${scenario.name}_c${connections}`
      });
      results.push(summarize(result));
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpus: os.cpus().length,
      totalMemGB: Math.round(os.totalmem() / 1e9),
      gitCommit: safeGitCommit()
    },
    transportMode: 'mock',
    mockSeed: process.env.MOCK_SEED,
    scenarios: results
  };

  const outDir = path.join(__dirname, 'baseline');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = report.timestamp.replace(/[:.]/g, '-');
  const jsonPath = path.join(outDir, `${stamp}.json`);
  const mdPath = path.join(outDir, `${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(report));

  console.log(`\nWrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);

  process.emit('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}

function safeGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: path.join(__dirname, '..') }).toString().trim();
  } catch {
    return 'unknown';
  }
}

function renderMarkdown(report) {
  const rows = report.scenarios
    .map(
      (s) =>
        `| ${s.title} | ${s.connections} | ${s.requests.total} | ${s.requests.average.toFixed(1)} | ${s.latencyMs.p50} | ${s.latencyMs.p90} | ${s.latencyMs.p95} | ${s.latencyMs.p99} | ${s.errors} | ${s.timeouts} |`
    )
    .join('\n');

  return `# Benchmark report — ${report.timestamp}

**These are our application's measured limits against MockTransport — not WhatsApp/Meta's sending limits.**

## Environment

- Node: ${report.environment.node}
- Platform: ${report.environment.platform} (${report.environment.arch})
- CPUs: ${report.environment.cpus}
- RAM: ${report.environment.totalMemGB} GB
- Git commit: ${report.environment.gitCommit}
- Transport: mock (seed ${report.mockSeed})

## Results

| Scenario | Connections | Total Requests | Req/s (avg) | p50 (ms) | p90 (ms) | p95 (ms) | p99 (ms) | Errors | Timeouts |
|---|---|---|---|---|---|---|---|---|---|
${rows}
`;
}

main().catch((err) => {
  console.error('Benchmark run failed:', err);
  process.exit(1);
});
