const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.DB_PATH = path.join(os.tmpdir(), `wa-tester-test-killswitch-${process.pid}.db`);

const db = require('../lib/db');
const { isOutboundDisabled, setOutboundDisabled, getKillSwitchState } = require('../lib/killSwitch');
const jobService = require('../lib/jobs/jobService');
const JobWorker = require('../lib/jobs/worker');
const MockTransport = require('../transports/MockTransport');

test.beforeEach(() => {
  db.exec('DELETE FROM job_events; DELETE FROM job_attempts; DELETE FROM job_items; DELETE FROM jobs; DELETE FROM audit_log;');
  setOutboundDisabled(false, { actor: 'test-setup' });
});

test('kill switch is disabled by default', () => {
  assert.equal(isOutboundDisabled(), false);
});

test('enabling the kill switch is durable and audited', () => {
  setOutboundDisabled(true, { actor: 'owner1', reason: 'incident drill' });
  assert.equal(isOutboundDisabled(), true);

  const state = getKillSwitchState();
  assert.equal(state.disabled, true);
  assert.equal(state.reason, 'incident drill');

  const audit = db.prepare("SELECT * FROM audit_log WHERE action='kill_switch_enabled' ORDER BY ts DESC LIMIT 1").get();
  assert.ok(audit);
  assert.equal(audit.actor, 'owner1');
});

test('disabling the kill switch restores normal operation and is audited', () => {
  setOutboundDisabled(true, { actor: 'owner1' });
  setOutboundDisabled(false, { actor: 'owner1', reason: 'resolved' });
  assert.equal(isOutboundDisabled(), false);

  const audit = db.prepare("SELECT * FROM audit_log WHERE action='kill_switch_disabled' ORDER BY ts DESC LIMIT 1").get();
  assert.ok(audit);
});

test('a real JobWorker never claims new items while the kill switch is active, and resumes once re-enabled', async () => {
  const transport = new MockTransport({ seed: 99 });
  await transport.initialize();
  await new Promise((resolve) => transport.on('state', ({ state }) => state === 'ready' && resolve()));

  const { job } = jobService.createJob({ type: 'test', items: [{ number: '1555000', name: 'A', message: 'hi' }] });
  const worker = new JobWorker(transport, {});

  setOutboundDisabled(true, { actor: 'owner1' });
  worker._tick();
  await new Promise((r) => setTimeout(r, 50));
  let item = db.prepare('SELECT * FROM job_items WHERE job_id = ?').get(job.id);
  assert.equal(item.status, 'queued', 'kill switch active — item must remain queued, never claimed');

  setOutboundDisabled(false, { actor: 'owner1' });
  worker._tick();
  await new Promise((r) => setTimeout(r, 100));
  item = db.prepare('SELECT * FROM job_items WHERE job_id = ?').get(job.id);
  assert.notEqual(item.status, 'queued', 'kill switch disabled — item should now be claimed/processed');

  await worker.drainAndStop(2000);
  await transport.shutdown();
});
