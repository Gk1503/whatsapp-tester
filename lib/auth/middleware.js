const config = require('../../config');
const db = require('../db');
const { roleHasPermission } = require('../rbac');
const { AuthenticationError, AuthorizationError } = require('../errors');

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Authenticates the request against the session, enforces idle + absolute
// timeouts, and — for state-changing methods — a double-submit CSRF check.
// Every privileged route goes through this; nothing relies on the frontend
// hiding a button as "authorization".
function requireAuth(req, res, next) {
  const sess = req.session;
  if (!sess || !sess.userId) {
    return next(AuthenticationError());
  }

  const now = Date.now();
  if (sess.absoluteExpiresAt && now > sess.absoluteExpiresAt) {
    return req.session.destroy(() => next(AuthenticationError('Session expired — please log in again.')));
  }
  if (sess.lastActivityAt && now - sess.lastActivityAt > config.sessionIdleTimeoutMs) {
    return req.session.destroy(() => next(AuthenticationError('Session expired — please log in again.')));
  }
  sess.lastActivityAt = now;

  if (UNSAFE_METHODS.has(req.method)) {
    const supplied = req.headers['x-csrf-token'];
    if (!supplied || supplied !== sess.csrfToken) {
      return next(AuthenticationError('Missing or invalid CSRF token.'));
    }
  }

  req.user = { id: sess.userId, username: sess.username, role: sess.role };
  next();
}

function requirePermission(permission) {
  return function permissionMiddleware(req, res, next) {
    requireAuth(req, res, (err) => {
      if (err) return next(err);
      if (!roleHasPermission(req.user.role, permission)) {
        return next(AuthorizationError());
      }
      next();
    });
  };
}

// ---- Login throttling ----
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

const recentFailuresStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND success = 0 AND ts > ?'
);
const recordAttemptStmt = db.prepare('INSERT INTO login_attempts (username, ts, success, ip) VALUES (?, ?, ?, ?)');

function isLockedOut(username) {
  const row = recentFailuresStmt.get(username, Date.now() - WINDOW_MS);
  return row.n >= MAX_FAILURES;
}

function recordLoginAttempt(username, success, ip) {
  recordAttemptStmt.run(username, Date.now(), success ? 1 : 0, ip || null);
}

module.exports = { requireAuth, requirePermission, isLockedOut, recordLoginAttempt };
