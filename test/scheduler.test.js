const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.DB_PATH = path.join(os.tmpdir(), `wa-tester-test-scheduler-${process.pid}.db`);

const db = require('../lib/db');
const Scheduler = require('../scheduler');
const MockTransport = require('../transports/MockTransport');
const jobService = require('../lib/jobs/jobService');
const JobWorker = require('../lib/jobs/worker');

test.beforeEach(() => {
  db.exec('DELETE FROM job_events; DELETE FROM job_attempts; DELETE FROM job_items; DELETE FROM jobs; DELETE FROM schedules;');
});

function waitForState(transport, targetState, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (transport.getConnectionState() === targetState) return resolve();
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${targetState}`)), timeoutMs);
    transport.on('state', ({ state }) => {
      if (state === targetState) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

async function readyTransport(seed) {
  const t = new MockTransport({ seed });
  await t.initialize();
  await waitForState(t, 'ready');
  return t;
}

test('runTickIfReady creates exactly one job even when called twice for the same due occurrence (race safety)', async () => {
  const transport = await readyTransport(1);
  const scheduler = new Scheduler(transport, { logger: null });

  const schedule = scheduler.create({
    recipients: [{ number: '15551234567', name: 'A' }],
    message: 'hi',
    runAt: new Date(Date.now() - 1000).toISOString(), // already due
    delaySeconds: 0,
    repeat: null
  });

  scheduler.runTickIfReady();
  scheduler.runTickIfReady(); // simulates a second concurrent/overlapping tick

  const jobs = jobService.listJobs({ sourceType: 'schedule', sourceId: schedule.id });
  assert.equal(jobs.length, 1, `expected exactly one job, got ${jobs.length}`);

  await transport.shutdown();
});

test('a fired schedule reaches done and its lastResult reflects the job outcome, via the real worker', async () => {
  const transport = await readyTransport(2);
  const scheduler = new Scheduler(transport, { logger: null });
  const worker = new JobWorker(transport, { onJobSettled: (job) => scheduler.onJobSettled(job) });

  const schedule = scheduler.create({
    recipients: [{ number: '15551234567', name: 'A' }],
    message: 'hi',
    runAt: new Date(Date.now() - 1000).toISOString(),
    delaySeconds: 0,
    repeat: null
  });

  scheduler.runTickIfReady();
  worker.start();

  const settled = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('schedule never reached done')), 5000);
    scheduler.on('scheduleUpdate', (s) => {
      if (s.id === schedule.id && s.status === 'done') {
        clearTimeout(timer);
        resolve(s);
      }
    });
  });

  assert.equal(settled.status, 'done');
  assert.ok(settled.lastResult);
  assert.equal(settled.lastResult.results.length, 1);

  await worker.drainAndStop(2000);
  await transport.shutdown();
});

test('restart safety: recreating the Scheduler for the same DB does not duplicate an in-flight occurrence\'s job', async () => {
  const transport = await readyTransport(3);
  const schedulerA = new Scheduler(transport, { logger: null });

  const schedule = schedulerA.create({
    recipients: [{ number: '15551234567', name: 'A' }],
    message: 'hi',
    runAt: new Date(Date.now() - 1000).toISOString(),
    delaySeconds: 0,
    repeat: null
  });

  schedulerA.runTickIfReady(); // creates the job, flips schedule to 'sending'

  // Simulate a restart: a brand new Scheduler instance reads the same DB.
  const schedulerB = new Scheduler(transport, { logger: null });
  schedulerB.runTickIfReady(); // schedule is now 'sending', not 'scheduled' — must not fire again

  const jobs = jobService.listJobs({ sourceType: 'schedule', sourceId: schedule.id });
  assert.equal(jobs.length, 1);

  await transport.shutdown();
});

test('missed-run catch-up: a repeating schedule steps forward past every missed occurrence to one still in the future', async () => {
  const transport = await readyTransport(4);
  const scheduler = new Scheduler(transport, { logger: null });

  const fixedNow = Date.now();
  const schedule = scheduler.create({
    recipients: [{ number: '15551234567', name: 'A' }],
    message: 'hi',
    runAt: new Date(fixedNow - 10 * 60 * 1000).toISOString(), // 10 minutes overdue
    delaySeconds: 0,
    repeat: { everyValue: 1, everyUnit: 'minutes', endAt: null } // would have missed ~10 occurrences
  });

  const { job } = jobService.createJob({
    type: 'schedule_fire',
    idempotencyKey: `schedule:${schedule.id}:${schedule.runAt}`,
    items: [{ number: '15551234567', name: 'A', message: 'hi' }],
    sourceType: 'schedule',
    sourceId: schedule.id
  });
  jobService.markItemTerminal(job.items[0].id, 'succeeded');
  const settled = jobService.checkJobCompletion(job.id);
  scheduler.onJobSettled(settled);

  const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(schedule.id);
  assert.equal(row.status, 'scheduled');
  assert.ok(row.next_run_at > fixedNow, 'next_run_at must be in the future, not one of the missed minute-marks');
  // A single catch-up step, not ~10 backlogged fires:
  assert.equal(jobService.listJobs({ sourceType: 'schedule', sourceId: schedule.id }).length, 1);

  await transport.shutdown();
});
