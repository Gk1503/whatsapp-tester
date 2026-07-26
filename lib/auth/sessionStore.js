// Minimal express-session Store backed by the same SQLite db everything else
// uses — durable across restarts, avoids the default MemoryStore (which
// express-session itself warns is "not designed for a production environment").
const session = require('express-session');
const db = require('../db');

const getStmt = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?');
const setStmt = db.prepare(
  'INSERT INTO sessions (sid, data, expires_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires_at = excluded.expires_at'
);
const destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
const sweepStmt = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

class SqliteSessionStore extends session.Store {
  get(sid, callback) {
    try {
      const row = getStmt.get(sid);
      if (!row || row.expires_at < Date.now()) return callback(null, null);
      callback(null, JSON.parse(row.data));
    } catch (err) {
      callback(err);
    }
  }

  set(sid, sessionData, callback) {
    try {
      const maxAge = sessionData.cookie && sessionData.cookie.maxAge ? sessionData.cookie.maxAge : 30 * 60 * 1000;
      setStmt.run(sid, JSON.stringify(sessionData), Date.now() + maxAge);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      destroyStmt.run(sid);
      callback(null);
    } catch (err) {
      callback(err);
    }
  }

  touch(sid, sessionData, callback) {
    this.set(sid, sessionData, callback);
  }
}

function sweepExpiredSessions() {
  sweepStmt.run(Date.now());
}

module.exports = { SqliteSessionStore, sweepExpiredSessions };
