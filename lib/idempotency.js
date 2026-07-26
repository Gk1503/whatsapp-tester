// Lightweight idempotency for the still-synchronous send routes (Security
// Audit finding #12: a double-submitted request currently sends twice).
// Opt-in via an `Idempotency-Key` request header — a repeat key within the
// TTL replays the cached response instead of re-executing the route.
// Backed by SQLite (`idempotency_keys`), not an in-memory map, so it
// survives a restart within the TTL window.
const db = require('../lib/db');

const TTL_MS = 5 * 60 * 1000;

function idempotent(routeName) {
  return function idempotencyMiddleware(req, res, next) {
    const key = req.headers['idempotency-key'];
    if (!key || typeof key !== 'string') return next();

    const compositeKey = `${routeName}:${key}`;
    const now = Date.now();
    const cached = db.prepare('SELECT response FROM idempotency_keys WHERE key = ? AND expires_at > ?').get(compositeKey, now);
    if (cached) {
      res.setHeader('X-Idempotent-Replay', 'true');
      return res.status(200).json(JSON.parse(cached.response));
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          db.prepare(
            `INSERT INTO idempotency_keys (key, route, response, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(key) DO NOTHING`
          ).run(compositeKey, routeName, JSON.stringify(body), now, now + TTL_MS);
        } catch {
          // best-effort caching only — never fail the real response over this
        }
      }
      return originalJson(body);
    };
    next();
  };
}

function sweepExpiredIdempotencyKeys() {
  db.prepare('DELETE FROM idempotency_keys WHERE expires_at < ?').run(Date.now());
}

module.exports = { idempotent, sweepExpiredIdempotencyKeys, TTL_MS };
