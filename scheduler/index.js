// Message scheduler — rewritten on the SQLite `schedules` table (schedules.json
// is retired, see lib/migrateSchedulesJson.js) and the durable job system
// (lib/jobs/) instead of calling the transport directly.
//
// The public API (list/create/remove) and the events emitted
// (`scheduleUpdate`/`scheduleRemoved`) are UNCHANGED from the previous
// implementation — same field names, same status vocabulary
// ('scheduled'/'sending'/'done') — so the frontend needed zero changes.
//
// Exactly-once intent: a due occurrence is identified by
// `schedule:<id>:<next_run_at>`, used as the job's idempotency key. If two
// ticks (or, in the future, two worker processes) race to fire the same
// occurrence, the SQLite UNIQUE index on jobs.idempotency_key guarantees only
// one job is ever created — this is exactly-once *job creation*, not a
// guarantee that WhatsApp itself never sees a duplicate if the process
// crashes after the transport call but before the result is recorded. That
// boundary is real and is documented in docs/THREAT_MODEL.md, not hidden.
//
// Missed-run policy: 'catch_up_once' (the only policy implemented this
// session) — after a gap, step forward past every missed occurrence to the
// next one still in the future, and fire once. Never fires a backlog burst.
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const db = require('../lib/db');
const jobService = require('../lib/jobs/jobService');

const REPEAT_UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000, weeks: 7 * 24 * 60 * 60 * 1000 };
const TICK_INTERVAL_MS = 15000;

function rowToSchedule(row) {
  return {
    id: row.id,
    recipients: JSON.parse(row.recipients),
    message: row.message,
    delaySeconds: row.delay_seconds,
    runAt: row.next_run_at,
    repeat: row.repeat_every_value
      ? { everyValue: row.repeat_every_value, everyUnit: row.repeat_every_unit, endAt: row.repeat_end_at }
      : null,
    status: row.status,
    lastResult: row.last_result ? JSON.parse(row.last_result) : null,
    createdAt: row.created_at
  };
}

class Scheduler extends EventEmitter {
  constructor(transport, { logger } = {}) {
    super();
    this.transport = transport;
    this.logger = logger;
    this._interval = null;
  }

  list() {
    return db.prepare('SELECT * FROM schedules ORDER BY next_run_at').all().map(rowToSchedule);
  }

  create({ recipients, message, runAt, delaySeconds, repeat, createdBy = null }) {
    const runAtMs = new Date(runAt).getTime();
    if (Number.isNaN(runAtMs)) {
      const err = new Error('A valid runAt date/time is required');
      err.name = 'ValidationError';
      throw err;
    }

    let normalizedRepeat = null;
    if (repeat && repeat.everyValue) {
      normalizedRepeat = {
        everyValue: Math.max(1, Number(repeat.everyValue) || 1),
        everyUnit: REPEAT_UNIT_MS[repeat.everyUnit] ? repeat.everyUnit : 'minutes',
        endAt: repeat.endAt ? new Date(repeat.endAt).getTime() : null
      };
    }

    const normalizedRecipients = recipients
      .map((r) => ({ number: String(r.number || '').replace(/[^\d]/g, ''), name: r.name || '' }))
      .filter((r) => r.number);

    if (normalizedRecipients.length === 0) {
      const err = new Error('No valid recipient numbers');
      err.name = 'ValidationError';
      throw err;
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO schedules (id, message, recipients, delay_seconds, repeat_every_value, repeat_every_unit, repeat_end_at, status, next_run_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`
    ).run(
      id,
      String(message),
      JSON.stringify(normalizedRecipients),
      Math.max(0, Number(delaySeconds) || 0),
      normalizedRepeat ? normalizedRepeat.everyValue : null,
      normalizedRepeat ? normalizedRepeat.everyUnit : null,
      normalizedRepeat ? normalizedRepeat.endAt : null,
      runAtMs,
      createdBy,
      now,
      now
    );

    const schedule = this._get(id);
    this.emit('scheduleUpdate', schedule);
    return schedule;
  }

  remove(id) {
    const result = db.prepare('DELETE FROM schedules WHERE id = ?').run(id);
    if (result.changes > 0) this.emit('scheduleRemoved', id);
    return result.changes > 0;
  }

  _get(id) {
    const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
    return row ? rowToSchedule(row) : null;
  }

  runTickIfReady() {
    if (this.transport.getConnectionState() !== 'ready') return;
    const now = Date.now();
    const due = db.prepare("SELECT * FROM schedules WHERE status = 'scheduled' AND next_run_at <= ?").all(now);
    for (const row of due) {
      try {
        this._fireDue(row);
      } catch (err) {
        if (this.logger) this.logger.error({ err, scheduleId: row.id }, 'schedule_fire_error');
      }
    }
  }

  _fireDue(row) {
    const idempotencyKey = `schedule:${row.id}:${row.next_run_at}`;
    const recipients = JSON.parse(row.recipients);

    // createJob is itself idempotent (DB UNIQUE constraint on idempotencyKey) —
    // if another tick already created this occurrence's job, this call just
    // returns it (created: false) without inserting a second one.
    jobService.createJob({
      type: 'schedule_fire',
      idempotencyKey,
      items: recipients.map((r) => ({ number: r.number, name: r.name, message: row.message })),
      sourceType: 'schedule',
      sourceId: row.id,
      createdBy: row.created_by,
      metadata: { delaySeconds: row.delay_seconds }
    });

    const now = Date.now();
    db.prepare("UPDATE schedules SET status='sending', updated_at=? WHERE id=? AND status='scheduled'").run(now, row.id);
    const updated = this._get(row.id);
    if (updated) this.emit('scheduleUpdate', updated);
  }

  /** Wired from server.js as the job worker's onJobSettled callback. */
  onJobSettled(job) {
    if (job.source_type !== 'schedule') return;
    const row = db.prepare('SELECT * FROM schedules WHERE id = ?').get(job.source_id);
    if (!row) return; // schedule was deleted while its job was in flight

    const results = job.items.map((item) => ({
      number: item.recipient_number,
      name: item.recipient_name,
      status:
        item.status === 'succeeded'
          ? 'sent'
          : item.status === 'skipped'
            ? 'skipped'
            : item.last_error_category === 'PERMANENT'
              ? 'not_on_whatsapp'
              : 'error',
      detail: item.last_error_message
    }));
    const lastResult = { ranAt: job.completed_at || Date.now(), results };
    const now = Date.now();

    if (row.repeat_every_value) {
      const unitMs = REPEAT_UNIT_MS[row.repeat_every_unit] || REPEAT_UNIT_MS.minutes;
      const stepMs = unitMs * row.repeat_every_value;
      let next = row.next_run_at;
      do {
        next += stepMs;
      } while (next <= Date.now());

      if (row.repeat_end_at && next > row.repeat_end_at) {
        db.prepare("UPDATE schedules SET status='done', last_run_at=?, last_result=?, updated_at=? WHERE id=?").run(
          now,
          JSON.stringify(lastResult),
          now,
          row.id
        );
      } else {
        db.prepare(
          "UPDATE schedules SET status='scheduled', next_run_at=?, last_run_at=?, last_result=?, updated_at=? WHERE id=?"
        ).run(next, now, JSON.stringify(lastResult), now, row.id);
      }
    } else {
      db.prepare("UPDATE schedules SET status='done', last_run_at=?, last_result=?, updated_at=? WHERE id=?").run(
        now,
        JSON.stringify(lastResult),
        now,
        row.id
      );
    }

    const updated = this._get(row.id);
    if (updated) this.emit('scheduleUpdate', updated);
  }

  start() {
    if (this._interval) return;
    this._interval = setInterval(() => this.runTickIfReady(), TICK_INTERVAL_MS);
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
    this._interval = null;
  }
}

module.exports = Scheduler;
