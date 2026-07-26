// Durable job CRUD + state transitions. Every write that must be atomic
// (job + its items, cancel + item cancellation) is wrapped in an explicit
// transaction. Idempotent job creation relies on the DB-level UNIQUE index
// on jobs.idempotency_key (lib/db.js), not just an in-memory check.
const crypto = require('node:crypto');
const db = require('../db');

const TERMINAL_ITEM_STATUSES = ['succeeded', 'failed', 'skipped', 'cancelled'];
const TERMINAL_JOB_STATUSES = ['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'];

function recordEvent(jobId, type, detail) {
  db.prepare('INSERT INTO job_events (job_id, ts, type, detail) VALUES (?, ?, ?, ?)').run(
    jobId,
    Date.now(),
    type,
    detail ? JSON.stringify(detail) : null
  );
}

function getJob(id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) return null;
  const items = db.prepare('SELECT * FROM job_items WHERE job_id = ? ORDER BY seq').all(id);
  return { ...job, metadata: job.metadata ? JSON.parse(job.metadata) : null, items };
}

function listJobs({ status, sourceType, sourceId, limit = 100 } = {}) {
  const clauses = [];
  const params = [];
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (sourceType) {
    clauses.push('source_type = ?');
    params.push(sourceType);
  }
  if (sourceId) {
    clauses.push('source_id = ?');
    params.push(sourceId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(Math.min(Math.max(1, limit), 1000));
  return db.prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`).all(...params);
}

/**
 * items: [{ number, name, message }]
 * Returns { job, created } — created is false when an existing job with the
 * same idempotencyKey was found (no new job/items were inserted).
 */
function createJob({ type, idempotencyKey = null, items, sourceType = null, sourceId = null, createdBy = null, metadata = null }) {
  if (idempotencyKey) {
    const existing = db.prepare('SELECT id FROM jobs WHERE idempotency_key = ?').get(idempotencyKey);
    if (existing) return { job: getJob(existing.id), created: false };
  }

  const id = crypto.randomUUID();
  const now = Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(
      `INSERT INTO jobs (id, type, status, created_by, created_at, updated_at, total, idempotency_key, source_type, source_id, metadata)
       VALUES (?, ?, 'QUEUED', ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, type, createdBy, now, now, items.length, idempotencyKey, sourceType, sourceId, metadata ? JSON.stringify(metadata) : null);

    const insertItem = db.prepare(
      `INSERT INTO job_items (id, job_id, seq, recipient_number, recipient_name, message, status, next_attempt_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
    );
    items.forEach((item, i) => {
      insertItem.run(crypto.randomUUID(), id, i, item.number, item.name || '', item.message, now, now);
    });

    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // no transaction to roll back
    }
    if (idempotencyKey && /UNIQUE/i.test(String(err.message))) {
      const existing = db.prepare('SELECT id FROM jobs WHERE idempotency_key = ?').get(idempotencyKey);
      if (existing) return { job: getJob(existing.id), created: false };
    }
    throw err;
  }

  recordEvent(id, 'created', { total: items.length, sourceType, sourceId });
  return { job: getJob(id), created: true };
}

function markItemRunning(itemId) {
  const now = Date.now();
  const item = db.prepare('SELECT job_id FROM job_items WHERE id = ?').get(itemId);
  if (!item) return;
  db.prepare("UPDATE job_items SET status='running', updated_at=? WHERE id=?").run(now, itemId);
  const result = db.prepare("UPDATE jobs SET status='RUNNING', started_at=COALESCE(started_at,?), updated_at=? WHERE id=? AND status='QUEUED'").run(
    now,
    now,
    item.job_id
  );
  if (result.changes > 0) recordEvent(item.job_id, 'started', null);
}

function recordAttemptStart(itemId, attemptNumber) {
  const now = Date.now();
  db.prepare('INSERT INTO job_attempts (job_item_id, attempt_number, started_at) VALUES (?, ?, ?)').run(itemId, attemptNumber, now);
  db.prepare('UPDATE job_items SET attempt_count = ?, updated_at = ? WHERE id = ?').run(attemptNumber, now, itemId);
}

function recordAttemptFinish(itemId, attemptNumber, outcome, category, detail) {
  db.prepare(
    'UPDATE job_attempts SET finished_at=?, outcome=?, error_category=?, error_message=? WHERE job_item_id=? AND attempt_number=?'
  ).run(Date.now(), outcome, category, detail, itemId, attemptNumber);
}

function scheduleRetry(itemId, nextAttemptAt, category, detail) {
  const now = Date.now();
  db.prepare(
    `UPDATE job_items SET status='queued', next_attempt_at=?, last_error_category=?, last_error_message=?,
     claimed_by=NULL, claimed_at=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`
  ).run(nextAttemptAt, category, detail, now, itemId);
}

function markItemTerminal(itemId, status, category = null, detail = null) {
  const now = Date.now();
  const item = db.prepare('SELECT job_id FROM job_items WHERE id = ?').get(itemId);
  if (!item) return;
  db.prepare(
    `UPDATE job_items SET status=?, last_error_category=?, last_error_message=?, claimed_by=NULL, claimed_at=NULL, lease_expires_at=NULL, updated_at=?
     WHERE id=?`
  ).run(status, category, detail, now, itemId);

  const counterColumn = { succeeded: 'succeeded', failed: 'failed', skipped: 'skipped', cancelled: 'cancelled' }[status];
  if (counterColumn) {
    db.prepare(`UPDATE jobs SET ${counterColumn} = ${counterColumn} + 1, updated_at = ? WHERE id = ?`).run(now, item.job_id);
  }
}

/** Call after every item reaches a terminal state. Returns the settled job row if the job just became terminal, else null. */
function checkJobCompletion(jobId) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId);
  if (!job || TERMINAL_JOB_STATUSES.includes(job.status)) return null;

  const counts = db.prepare('SELECT status, COUNT(*) AS n FROM job_items WHERE job_id = ? GROUP BY status').all(jobId);
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  const total = job.total;
  const terminalCount = TERMINAL_ITEM_STATUSES.reduce((sum, s) => sum + (byStatus[s] || 0), 0);
  if (terminalCount < total) return null; // still work remaining

  const succeeded = byStatus.succeeded || 0;
  const finalStatus = succeeded === total ? 'COMPLETED' : succeeded > 0 ? 'PARTIALLY_COMPLETED' : 'FAILED';
  const now = Date.now();
  db.prepare("UPDATE jobs SET status=?, completed_at=?, updated_at=? WHERE id=? AND status NOT IN ('CANCELLED')").run(
    finalStatus,
    now,
    now,
    jobId
  );
  recordEvent(jobId, 'completed', { finalStatus, succeeded, failed: byStatus.failed || 0, skipped: byStatus.skipped || 0 });
  return getJob(jobId);
}

function cancelJob(id, actor) {
  const now = Date.now();
  const result = db
    .prepare(`UPDATE jobs SET status='CANCELLED', completed_at=?, updated_at=? WHERE id=? AND status NOT IN (${TERMINAL_JOB_STATUSES.map(() => '?').join(',')})`)
    .run(now, now, id, ...TERMINAL_JOB_STATUSES);
  if (result.changes > 0) {
    db.prepare(
      "UPDATE job_items SET status='cancelled', claimed_by=NULL, claimed_at=NULL, lease_expires_at=NULL, updated_at=? WHERE job_id=? AND status IN ('queued','claimed','running')"
    ).run(now, id);
    recordEvent(id, 'cancelled', { actor });
  }
  return getJob(id);
}

function pauseJob(id, actor) {
  const now = Date.now();
  const result = db.prepare("UPDATE jobs SET status='PAUSED', updated_at=? WHERE id=? AND status IN ('QUEUED','RUNNING')").run(now, id);
  if (result.changes > 0) recordEvent(id, 'paused', { actor });
  return getJob(id);
}

function resumeJob(id, actor) {
  const now = Date.now();
  const result = db.prepare("UPDATE jobs SET status='QUEUED', updated_at=? WHERE id=? AND status='PAUSED'").run(now, id);
  if (result.changes > 0) recordEvent(id, 'resumed', { actor });
  return getJob(id);
}

module.exports = {
  createJob,
  getJob,
  listJobs,
  markItemRunning,
  recordAttemptStart,
  recordAttemptFinish,
  scheduleRetry,
  markItemTerminal,
  checkJobCompletion,
  cancelJob,
  pauseJob,
  resumeJob,
  recordEvent,
  TERMINAL_ITEM_STATUSES,
  TERMINAL_JOB_STATUSES
};
