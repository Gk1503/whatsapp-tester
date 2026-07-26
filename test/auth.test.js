const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

// Isolated DB per test file/process — avoids clashing with other test files
// or a real dev database.
process.env.DB_PATH = path.join(os.tmpdir(), `wa-tester-test-auth-${process.pid}.db`);

const { hashPassword, verifyPassword } = require('../lib/auth/passwords');
const { requireAuth, requirePermission, isLockedOut, recordLoginAttempt } = require('../lib/auth/middleware');

test('hashPassword/verifyPassword round-trip correctly', () => {
  const hash = hashPassword('correct horse battery staple');
  assert.equal(verifyPassword('correct horse battery staple', hash), true);
  assert.equal(verifyPassword('wrong password', hash), false);
});

test('verifyPassword rejects malformed stored hashes instead of throwing', () => {
  assert.equal(verifyPassword('anything', 'not-a-real-hash'), false);
  assert.equal(verifyPassword('anything', ''), false);
});

test('requireAuth denies a request with no session', (t, done) => {
  const req = { session: null, method: 'GET', headers: {} };
  const res = {};
  requireAuth(req, res, (err) => {
    assert.equal(err.category, 'AUTHENTICATION_ERROR');
    done();
  });
});

test('requireAuth denies an expired (idle timeout) session', (t, done) => {
  const req = {
    session: {
      userId: 1,
      username: 'owner',
      role: 'OWNER',
      lastActivityAt: Date.now() - 999 * 60 * 60 * 1000,
      destroy: (cb) => cb()
    },
    method: 'GET',
    headers: {}
  };
  requireAuth(req, {}, (err) => {
    assert.equal(err.category, 'AUTHENTICATION_ERROR');
    done();
  });
});

test('requireAuth rejects a state-changing request with a missing/mismatched CSRF token', (t, done) => {
  const req = {
    session: { userId: 1, username: 'owner', role: 'OWNER', lastActivityAt: Date.now(), csrfToken: 'abc' },
    method: 'POST',
    headers: {}
  };
  requireAuth(req, {}, (err) => {
    assert.equal(err.category, 'AUTHENTICATION_ERROR');
    done();
  });
});

test('requireAuth allows a valid session with a matching CSRF token on POST', (t, done) => {
  const req = {
    session: { userId: 1, username: 'owner', role: 'OWNER', lastActivityAt: Date.now(), csrfToken: 'abc' },
    method: 'POST',
    headers: { 'x-csrf-token': 'abc' }
  };
  requireAuth(req, {}, (err) => {
    assert.equal(err, undefined);
    assert.equal(req.user.username, 'owner');
    done();
  });
});

test('requirePermission denies a role that lacks the permission', (t, done) => {
  const req = {
    session: { userId: 1, username: 'viewer', role: 'VIEWER', lastActivityAt: Date.now() },
    method: 'GET',
    headers: {}
  };
  requirePermission('send_message')(req, {}, (err) => {
    assert.equal(err.category, 'AUTHORIZATION_ERROR');
    done();
  });
});

test('requirePermission allows OWNER for any known permission', (t, done) => {
  const req = {
    session: { userId: 1, username: 'owner', role: 'OWNER', lastActivityAt: Date.now() },
    method: 'GET',
    headers: {}
  };
  requirePermission('send_message')(req, {}, (err) => {
    assert.equal(err, undefined);
    done();
  });
});

test('login throttling locks out after repeated failures', () => {
  const username = `throttle-test-${Date.now()}`;
  assert.equal(isLockedOut(username), false);
  for (let i = 0; i < 5; i++) recordLoginAttempt(username, false, '127.0.0.1');
  assert.equal(isLockedOut(username), true);
});

test('login throttling does not lock out a username with only successes', () => {
  const username = `throttle-ok-${Date.now()}`;
  for (let i = 0; i < 5; i++) recordLoginAttempt(username, true, '127.0.0.1');
  assert.equal(isLockedOut(username), false);
});
