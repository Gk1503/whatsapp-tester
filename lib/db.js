// Single embedded SQLite database (node:sqlite, built into Node >=22.5 — no
// native dependency) for everything that must survive a restart: the one
// bootstrapped user account, sessions, the audit log, login-attempt
// throttling, durable jobs/schedules, and operational settings. WhatsApp
// LocalAuth credentials are NEVER stored here — they stay in ./session,
// managed entirely by whatsapp-web.js.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

// Schema is additive-only so far (every change is a new table/column with a
// safe default) — full up/down migrations aren't built yet (see
// docs/ROADMAP.md); this constant plus the `settings.schema_version` row
// exist so that boundary is at least tracked, not silently absent.
const CURRENT_SCHEMA_VERSION = 2;

const dir = path.dirname(config.dbPath);
if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
// Needed now that the job-claiming transaction (BEGIN IMMEDIATE) creates real
// write contention — lets a blocked writer wait up to 5s instead of failing
// immediately with SQLITE_BUSY.
db.exec('PRAGMA busy_timeout = 5000;');

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

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  );

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    route TEXT NOT NULL,
    response TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    message TEXT NOT NULL,
    recipients TEXT NOT NULL,
    delay_seconds INTEGER NOT NULL DEFAULT 0,
    repeat_every_value INTEGER,
    repeat_every_unit TEXT,
    repeat_end_at INTEGER,
    missed_run_policy TEXT NOT NULL DEFAULT 'catch_up_once',
    status TEXT NOT NULL DEFAULT 'scheduled',
    next_run_at INTEGER NOT NULL,
    last_run_at INTEGER,
    last_result TEXT,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    created_by TEXT,
    created_at INTEGER NOT NULL,
    started_at INTEGER,
    completed_at INTEGER,
    updated_at INTEGER NOT NULL,
    total INTEGER NOT NULL,
    succeeded INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    cancelled INTEGER NOT NULL DEFAULT 0,
    idempotency_key TEXT,
    source_type TEXT,
    source_id TEXT,
    metadata TEXT,
    error_summary TEXT
  );

  CREATE TABLE IF NOT EXISTS job_items (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id),
    seq INTEGER NOT NULL,
    recipient_number TEXT NOT NULL,
    recipient_name TEXT,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    next_attempt_at INTEGER NOT NULL,
    claimed_by TEXT,
    claimed_at INTEGER,
    lease_expires_at INTEGER,
    last_error_category TEXT,
    last_error_message TEXT,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS job_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_item_id TEXT NOT NULL REFERENCES job_items(id),
    attempt_number INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    outcome TEXT,
    error_category TEXT,
    error_message TEXT
  );

  CREATE TABLE IF NOT EXISTS job_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    detail TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
  CREATE INDEX IF NOT EXISTS idx_login_attempts_username_ts ON login_attempts(username, ts);
  CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log(ts);
  CREATE INDEX IF NOT EXISTS idx_schedules_next_run ON schedules(status, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_job_items_claimable ON job_items(job_id, status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, ts);
  CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);
`);

db.prepare(
  `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('schema_version', ?, ?, 'system')
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
).run(String(CURRENT_SCHEMA_VERSION), Date.now());

module.exports = db;
module.exports.CURRENT_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;
