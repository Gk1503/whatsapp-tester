// Transactional claiming — the core correctness guarantee of the job system.
// BEGIN IMMEDIATE acquires SQLite's write lock immediately (not deferred),
// which serializes claim attempts at the database level. This is correct
// across multiple connections/processes, not just multiple async callbacks
// in one process — the same guarantee holds if this app is ever split into
// separate worker processes sharing the same SQLite file.
const db = require('../db');

const LEASE_MS = 60000;

function claimNextItem(workerId) {
  const now = Date.now();
  db.exec('BEGIN IMMEDIATE');
  try {
    // Ordered by eligibility time first (earliest-due item across ALL queued
    // jobs wins, not just within one job), with SQLite's implicit rowid as a
    // stable tiebreaker for items that became eligible at the same instant —
    // `seq` only encodes intra-job order, which isn't meaningful globally.
    const row = db
      .prepare(
        `SELECT ji.id FROM job_items ji
         JOIN jobs j ON j.id = ji.job_id
         WHERE ji.status = 'queued' AND ji.next_attempt_at <= ? AND j.status IN ('QUEUED','RUNNING')
         ORDER BY ji.next_attempt_at ASC, ji.rowid ASC LIMIT 1`
      )
      .get(now);

    if (!row) {
      db.exec('COMMIT');
      return null;
    }

    const result = db
      .prepare(
        `UPDATE job_items SET status='claimed', claimed_by=?, claimed_at=?, lease_expires_at=?, updated_at=?
         WHERE id = ? AND status = 'queued'`
      )
      .run(workerId, now, now + LEASE_MS, now, row.id);

    db.exec('COMMIT');

    if (result.changes !== 1) return null;
    return db.prepare('SELECT * FROM job_items WHERE id = ?').get(row.id);
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // no transaction to roll back
    }
    throw err;
  }
}

/** Crash recovery: items left claimed/running past their lease expiry get requeued. Returns the count recovered. */
function recoverStaleClaims() {
  const now = Date.now();
  const result = db
    .prepare(
      `UPDATE job_items SET status='queued', claimed_by=NULL, claimed_at=NULL, lease_expires_at=NULL, updated_at=?
       WHERE status IN ('claimed','running') AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`
    )
    .run(now, now);
  return result.changes;
}

module.exports = { claimNextItem, recoverStaleClaims, LEASE_MS };
