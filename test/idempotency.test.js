const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.DB_PATH = path.join(os.tmpdir(), `wa-tester-test-idempotency-${process.pid}.db`);

const express = require('express');
const db = require('../lib/db');
const { idempotent } = require('../lib/idempotency');

test.beforeEach(() => {
  db.exec('DELETE FROM idempotency_keys;');
});

function startTestApp() {
  let callCount = 0;
  const app = express();
  app.use(express.json());
  app.post('/probe', idempotent('probe'), (req, res) => {
    callCount++;
    res.json({ callCount, body: req.body });
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve({ server, getCallCount: () => callCount }));
  });
}

async function post(port, key, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(`http://127.0.0.1:${port}/probe`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
  return { status: res.status, json: await res.json(), replay: res.headers.get('x-idempotent-replay') };
}

test('same Idempotency-Key returns the cached result without re-executing the route', async () => {
  const { server, getCallCount } = await startTestApp();
  const port = server.address().port;
  try {
    const first = await post(port, 'key-1', { n: 1 });
    const second = await post(port, 'key-1', { n: 1 });

    assert.equal(getCallCount(), 1, 'route handler must only run once');
    assert.equal(first.json.callCount, 1);
    assert.equal(second.json.callCount, 1); // replayed, not a fresh call
    assert.equal(second.replay, 'true');
  } finally {
    server.close();
  }
});

test('a different Idempotency-Key sends again', async () => {
  const { server, getCallCount } = await startTestApp();
  const port = server.address().port;
  try {
    await post(port, 'key-a', {});
    await post(port, 'key-b', {});
    assert.equal(getCallCount(), 2);
  } finally {
    server.close();
  }
});

test('no Idempotency-Key header means no idempotency protection at all (opt-in only)', async () => {
  const { server, getCallCount } = await startTestApp();
  const port = server.address().port;
  try {
    await post(port, null, {});
    await post(port, null, {});
    assert.equal(getCallCount(), 2);
  } finally {
    server.close();
  }
});

test('an expired key sends again instead of replaying', async () => {
  const { server, getCallCount } = await startTestApp();
  const port = server.address().port;
  try {
    await post(port, 'key-expiring', {});
    assert.equal(getCallCount(), 1);

    // Simulate TTL expiry by rewriting the stored row's expires_at into the past.
    db.prepare("UPDATE idempotency_keys SET expires_at = ? WHERE key = 'probe:key-expiring'").run(Date.now() - 1000);

    await post(port, 'key-expiring', {});
    assert.equal(getCallCount(), 2);
  } finally {
    server.close();
  }
});
