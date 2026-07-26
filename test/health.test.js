const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

process.env.DB_PATH = path.join(os.tmpdir(), `wa-tester-test-health-${process.pid}.db`);

const express = require('express');
const healthRoutes = require('../routes/health');

function startTestApp(transportStub) {
  const app = express();
  app.use('/health', healthRoutes(transportStub));
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('/health/live is unauthenticated and returns ok', async () => {
  const server = await startTestApp({ getConnectionState: () => 'ready' });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health/live`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
  } finally {
    server.close();
  }
});

test('/health/ready reports database + transport state without leaking secrets', async () => {
  const server = await startTestApp({ getConnectionState: () => 'qr' });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.checks.database, 'ok');
    assert.equal(body.checks.transport, 'qr');

    const serialized = JSON.stringify(body).toLowerCase();
    for (const forbidden of ['password', 'secret', 'session_secret', 'cookie', 'qr:', 'localauth']) {
      assert.ok(!serialized.includes(forbidden), `response leaked "${forbidden}"`);
    }
  } finally {
    server.close();
  }
});
