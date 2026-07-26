const express = require('express');
const crypto = require('node:crypto');
const db = require('../lib/db');
const config = require('../config');
const { verifyPassword } = require('../lib/auth/passwords');
const { isLockedOut, recordLoginAttempt, requireAuth } = require('../lib/auth/middleware');
const { validate, loginBody } = require('../lib/validation/schemas');
const { AuthenticationError } = require('../lib/errors');
const { recordAudit } = require('../lib/audit');
const rateLimit = require('../lib/rateLimit');

const GENERIC_AUTH_ERROR = 'Invalid username or password.';

const getUserStmt = db.prepare('SELECT * FROM users WHERE username = ?');
const touchLoginStmt = db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?');

function regenerateSession(req) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => (err ? reject(err) : resolve()));
  });
}

module.exports = function authRoutes() {
  const router = express.Router();

  router.post('/login', rateLimit.auth, validate({ body: loginBody }), async (req, res, next) => {
    const { username, password } = req.body;
    const ip = req.ip;

    try {
      if (isLockedOut(username)) {
        recordLoginAttempt(username, false, ip);
        recordAudit({ actor: username, action: 'login', result: 'locked_out', requestId: req.id });
        return next(AuthenticationError(GENERIC_AUTH_ERROR));
      }

      const user = getUserStmt.get(username);
      if (!user || !verifyPassword(password, user.password_hash)) {
        recordLoginAttempt(username, false, ip);
        recordAudit({ actor: username, action: 'login', result: 'failure', requestId: req.id });
        return next(AuthenticationError(GENERIC_AUTH_ERROR));
      }

      await regenerateSession(req);
      const now = Date.now();
      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role;
      req.session.lastActivityAt = now;
      req.session.absoluteExpiresAt = now + config.sessionAbsoluteTimeoutMs;
      req.session.csrfToken = crypto.randomUUID();
      req.session.cookie.maxAge = config.sessionIdleTimeoutMs;

      touchLoginStmt.run(now, user.id);
      recordLoginAttempt(username, true, ip);
      recordAudit({ actor: username, action: 'login', result: 'success', requestId: req.id });

      res.json({ username: user.username, role: user.role, csrfToken: req.session.csrfToken });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', requireAuth, (req, res, next) => {
    const actor = req.user.username;
    req.session.destroy((err) => {
      if (err) return next(err);
      recordAudit({ actor, action: 'logout', result: 'success', requestId: req.id });
      res.clearCookie('connect.sid');
      res.json({ ok: true });
    });
  });

  router.get('/me', requireAuth, (req, res) => {
    res.json({ username: req.user.username, role: req.user.role, csrfToken: req.session.csrfToken });
  });

  return router;
};
