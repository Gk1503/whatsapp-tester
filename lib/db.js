// Single embedded SQLite database (node:sqlite, built into Node >=22.5 — no
// native dependency) for everything that must survive a restart: the one
// bootstrapped user account, sessions, the audit log, and login-attempt
// throttling. WhatsApp LocalAuth credentials are NEVER stored here — they stay
// in ./session, managed entirely by whatsapp-web.js.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

const dir = path.dirname(config.dbPath);
if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'OWNER',
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor TEXT,
    action TEXT NOT NULL,
    target TEXT,
    result TEXT NOT NULL,
    request_id TEXT,
    metadata TEXT
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    ts INTEGER NOT NULL,
    success INTEGER NOT NULL,
    ip TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_login_attempts_username_ts ON login_attempts(username, ts);
  CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
`);

module.exports = db;
