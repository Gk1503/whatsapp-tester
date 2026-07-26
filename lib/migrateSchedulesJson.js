// One-time migration: schedules.json -> the `schedules` SQLite table.
// Idempotent (safe to call on every startup) and never destructive — the
// original file is renamed to a `.migrated-<timestamp>` backup, never
// deleted, and a malformed/unreadable file is skipped (logged) rather than
// crashing startup.
const fs = require('node:fs');
const crypto = require('node:crypto');
const db = require('./db');

function migrateSchedulesJsonIfNeeded(file = 'schedules.json', logger) {
  if (!fs.existsSync(file)) return { migrated: 0 };

  const existingCount = db.prepare('SELECT COUNT(*) AS n FROM schedules').get().n;
  if (existingCount > 0) return { migrated: 0, skipped: 'schedules table already has data' };

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (logger) logger.warn({ err: err.message, file }, 'schedules_json_unreadable_skip_migration');
    return { migrated: 0, error: err.message };
  }
  if (!Array.isArray(raw) || raw.length === 0) return { migrated: 0 };

  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO schedules (id, message, recipients, delay_seconds, repeat_every_value, repeat_every_unit, repeat_end_at, status, next_run_at, last_run_at, last_result, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const s of raw) {
      insert.run(
        s.id || crypto.randomUUID(),
        s.message || '',
        JSON.stringify(s.recipients || []),
        s.delaySeconds || 0,
        s.repeat ? s.repeat.everyValue : null,
        s.repeat ? s.repeat.everyUnit : null,
        s.repeat ? s.repeat.endAt : null,
        s.status || 'scheduled',
        s.runAt || now,
        s.lastResult ? s.lastResult.ranAt : null,
        s.lastResult ? JSON.stringify(s.lastResult) : null,
        null,
        s.createdAt || now,
        now
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // no transaction to roll back
    }
    throw err;
  }

  const backupPath = `${file}.migrated-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.renameSync(file, backupPath);
  if (logger) logger.info({ count: raw.length, backupPath }, 'schedules_json_migrated');
  return { migrated: raw.length, backupPath };
}

module.exports = { migrateSchedulesJsonIfNeeded };
