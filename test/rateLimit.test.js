const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { errorHandler } = require('../lib/errors');
const rateLimit = require('../lib/rateLimit');

function startTestApp(limiter) {
  const app = express();
  app.get('/probe', limiter, (req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

test('the auth rate limiter returns 429 after the configured max requests', async () => {
  assert.equal(process.env.DISABLE_RATE_LIMIT, undefined, 'this test requires the real limiter, not the benchmark bypass');

  const server = await startTestApp(rateLimit.auth);
  const port = server.address().port;
  try {
    const statuses = [];
    for (let i = 0; i < 15; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/probe`);
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), `expected at least one 429 among: ${statuses.join(',')}`);
    assert.ok(statuses.filter((s) => s === 200).length <= 10, 'auth limiter should cap successes at its configured max');
  } finally {
    server.close();
  }
});

test('the read rate limiter allows a modest burst without tripping', async () => {
  const server = await startTestApp(rateLimit.read);
  const port = server.address().port;
  try {
    const statuses = [];
    for (let i = 0; i < 20; i++) {
      const res = await fetch(`http://127.0.0.1:${port}/probe`);
      statuses.push(res.status);
    }
    assert.ok(statuses.every((s) => s === 200), `expected all 200s among: ${statuses.join(',')}`);
  } finally {
    server.close();
  }
});
