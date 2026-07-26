const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DB_PATH = path.join(os.tmpdir(), `wa-tester-test-jobs-${process.pid}.db`);
process.env.DB_PATH = DB_PATH;

const jobService = require('../lib/jobs/jobService');
const { claimNextItem, recoverStaleClaims } = require('../lib/jobs/claiming');
const { CircuitBreaker } = require('../lib/jobs/circuitBreaker');
const { Semaphore } = require('../lib/jobs/backpressure');
const { computeBackoffMs, BASE_DELAY_MS, MAX_DELAY_MS } = require('../lib/jobs/retry');
const { classifyOutcome, classifyException, CATEGORIES } = require('../lib/jobs/errorClassifier');
const db = require('../lib/db');

function makeItems(n) {
  return Array.from({ length: n }, (_, i) => ({ number: `1555${i}`, name: `R${i}`, message: 'hi' }));
}

// Every test creates its own job(s) fresh — wipe between tests so claim-order
// tests never see a leftover queued item from an earlier test as "theirs".
test.beforeEach(() => {
  db.exec('DELETE FROM job_events; DELETE FROM job_attempts; DELETE FROM job_items; DELETE FROM jobs;');
});

// ---------- createJob idempotency ----------

test('createJob with the same idempotencyKey returns the existing job, does not create a second one', () => {
  const key = `test-key-${Date.now()}`;
  const { job: first, created: firstCreated } = jobService.createJob({ type: 'test', idempotencyKey: key, items: makeItems(2) });
  const { job: second, created: secondCreated } = jobService.createJob({ type: 'test', idempotencyKey: key, items: makeItems(2) });
  assert.equal(firstCreated, true);
  assert.equal(secondCreated, false);
  assert.equal(first.id, second.id);
  const count = db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE idempotency_key = ?').get(key).n;
  assert.equal(count, 1);
});

test('createJob without an idempotencyKey always creates a new job', () => {
  const { job: a } = jobService.createJob({ type: 'test', items: makeItems(1) });
  const { job: b } = jobService.createJob({ type: 'test', items: makeItems(1) });
  assert.notEqual(a.id, b.id);
});

// ---------- claiming: single-process exclusivity ----------

test('claimNextItem: only one of many sequential attempts against a single item succeeds', () => {
  const { job } = jobService.createJob({ type: 'test', items: makeItems(1) });
  const claims = Array.from({ length: 10 }, () => claimNextItem('seq-worker'));
  const successes = claims.filter((c) => c && c.job_id === job.id);
  assert.equal(successes.length, 1);
});

// ---------- claiming: cross-process exclusivity (the real guarantee) ----------

test('claimNextItem: exactly one process wins when several race for the same item (cross-process)', async () => {
  const { job } = jobService.createJob({ type: 'test', items: makeItems(1) });

  const helper = path.join(__dirname, 'helpers', 'claimAttempt.js');
  const attempts = Array.from({ length: 8 }, (_, i) =>
    execFileAsync(process.execPath, [helper, `child-${i}`], { env: { ...process.env, DB_PATH } })
  );
  const results = await Promise.all(attempts.map((p) => p.then((r) => JSON.parse(r.stdout))));

  const winners = results.filter((r) => r.claimedId !== null);
  assert.equal(winners.length, 1, `expected exactly one winner, got ${JSON.stringify(results)}`);

  const item = db.prepare('SELECT * FROM job_items WHERE job_id = ?').get(job.id);
  assert.equal(item.status, 'claimed');
});

// ---------- crash recovery ----------

test('recoverStaleClaims requeues items whose lease has expired', () => {
  const { job } = jobService.createJob({ type: 'test', items: makeItems(1) });
  const item = db.prepare('SELECT * FROM job_items WHERE job_id = ?').get(job.id);
  const past = Date.now() - 1000;
  db.prepare("UPDATE job_items SET status='running', claimed_by='dead-worker', claimed_at=?, lease_expires_at=? WHERE id=?").run(
    past - 60000,
    past,
    item.id
  );

  const recovered = recoverStaleClaims();
  assert.ok(recovered >= 1);

  const after = db.prepare('SELECT * FROM job_items WHERE id = ?').get(item.id);
  assert.equal(after.status, 'queued');
  assert.equal(after.claimed_by, null);
});

test('recoverStaleClaims does not touch items with a still-valid lease', () => {
  const { job } = jobService.createJob({ type: 'test', items: makeItems(1) });
  const item = db.prepare('SELECT * FROM job_items WHERE job_id = ?').get(job.id);
  db.prepare("UPDATE job_items SET status='running', claimed_by='live-worker', claimed_at=?, lease_expires_at=? WHERE id=?").run(
    Date.now(),
    Date.now() + 60000,
    item.id
  );

  recoverStaleClaims();

  const after = db.prepare('SELECT * FROM job_items WHERE id = ?').get(item.id);
  assert.equal(after.status, 'running');
});

// ---------- job completion state machine ----------

test('checkJobCompletion reports COMPLETED when every item succeeded', () => {
  const { job } = jobService.createJob({ type: 'test', items: makeItems(2) });
  for (const item of job.items) jobService.markItemTerminal(item.id, 'succeeded');
  const settled = jobService.checkJobCompletion(job.id);
  assert.equal(settled.status, 'COMPLETED');
});

test('checkJobCompletion reports PARTIALLY_COMPLETED when some items failed', () => {
  const { job } = jobService.createJob({ type: 'test', items: makeItems(2) });
  jobService.markItemTerminal(job.items[0].id, 'succeeded');
  jobService.markItemTerminal(job.items[1].id, 'failed', 'PERMANENT', 'not_on_whatsapp');
  const settled = jobService.checkJobCompletion(job.id);
  assert.equal(settled.status, 'PARTIALLY_COMPLETED');
});

test('checkJobCompletion reports FAILED when every item failed', () => {
  const { job } = jobService.createJob({ type: 'test', items: makeItems(2) });
  for (const item of job.items) jobService.markItemTerminal(item.id, 'failed', 'PERMANENT', 'not_on_whatsapp');
  const settled = jobService.checkJobCompletion(job.id);
  assert.equal(settled.status, 'FAILED');
});

test('checkJobCompletion returns null while work remains', () => {
  const { job } = jobService.createJob({ type: 'test', items: makeItems(2) });
  jobService.markItemTerminal(job.items[0].id, 'succeeded');
  const settled = jobService.checkJobCompletion(job.id);
  assert.equal(settled, null);
});

// ---------- cancel / pause / resume ----------

test('cancelJob cancels only non-terminal items, leaves completed ones alone, and is idempotent', () => {
  const { job } = jobService.createJob({ type: 'test', items: makeItems(2) });
  jobService.markItemTerminal(job.items[0].id, 'succeeded');

  const cancelled = jobService.cancelJob(job.id, 'tester');
  assert.equal(cancelled.status, 'CANCELLED');
  const items = db.prepare('SELECT * FROM job_items WHERE job_id = ?').all(job.id);
  assert.equal(items.find((i) => i.id === job.items[0].id).status, 'succeeded');
  assert.equal(items.find((i) => i.id === job.items[1].id).status, 'cancelled');

  const eventsBefore = db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE job_id=? AND type='cancelled'").get(job.id).n;
  jobService.cancelJob(job.id, 'tester'); // cancelling again must be a no-op
  const eventsAfter = db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE job_id=? AND type='cancelled'").get(job.id).n;
  assert.equal(eventsAfter, eventsBefore);
});

test('pauseJob stops claiming and resumeJob allows it again', () => {
  const { job } = jobService.createJob({ type: 'test', items: makeItems(1) });
  jobService.pauseJob(job.id, 'tester');
  assert.equal(claimNextItem('w1'), null);

  jobService.resumeJob(job.id, 'tester');
  const claimed = claimNextItem('w1');
  assert.ok(claimed);
  assert.equal(claimed.job_id, job.id);
});

// ---------- retry classification + backoff ----------

test('classifyOutcome maps outcomes to the right retry category', () => {
  assert.equal(classifyOutcome('sent'), null);
  assert.equal(classifyOutcome('not_on_whatsapp'), CATEGORIES.PERMANENT);
  assert.equal(classifyOutcome('error'), CATEGORIES.TRANSIENT);
  assert.equal(classifyOutcome('skipped'), CATEGORIES.VALIDATION);
  assert.equal(classifyOutcome('something_unexpected'), CATEGORIES.UNKNOWN);
});

test('classifyException maps a not-ready transport to TRANSIENT', () => {
  const err = new Error('not ready');
  err.name = 'TransportNotReadyError';
  assert.equal(classifyException(err), CATEGORIES.TRANSIENT);
});

test('computeBackoffMs grows with attempt number and stays within bounds', () => {
  const d1 = computeBackoffMs(1);
  const d2 = computeBackoffMs(2);
  const d3 = computeBackoffMs(3);
  assert.ok(d1 >= BASE_DELAY_MS && d1 <= BASE_DELAY_MS * 1.2);
  assert.ok(d2 > d1);
  assert.ok(d3 > d2);
  assert.ok(computeBackoffMs(20) <= MAX_DELAY_MS * 1.2);
});

// ---------- circuit breaker ----------

test('circuit breaker trips OPEN after consecutive transient failures, then recovers via HALF_OPEN', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 30 });
  assert.equal(breaker.getState(), 'CLOSED');

  for (let i = 0; i < 3; i++) {
    assert.equal(breaker.canAttempt(), true);
    breaker.recordFailure('TRANSIENT');
  }
  assert.equal(breaker.getState(), 'OPEN');
  assert.equal(breaker.canAttempt(), false);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(breaker.canAttempt(), true); // first probe after cooldown
  assert.equal(breaker.getState(), 'HALF_OPEN');
  assert.equal(breaker.canAttempt(), false); // no second concurrent probe

  breaker.recordSuccess();
  assert.equal(breaker.getState(), 'CLOSED');
  assert.equal(breaker.canAttempt(), true);
});

test('circuit breaker ignores non-transient failures', () => {
  const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000 });
  breaker.recordFailure('PERMANENT');
  breaker.recordFailure('VALIDATION');
  assert.equal(breaker.getState(), 'CLOSED');
});

// ---------- backpressure ----------

test('Semaphore never allows more than maxConcurrent acquisitions at once', () => {
  const sem = new Semaphore(2);
  assert.equal(sem.tryAcquire(), true);
  assert.equal(sem.tryAcquire(), true);
  assert.equal(sem.tryAcquire(), false);
  sem.release();
  assert.equal(sem.tryAcquire(), true);
});
