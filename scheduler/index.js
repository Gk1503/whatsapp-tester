// Message scheduler. Persistence stays as schedules.json for this session
// (SQLite migration is a ROADMAP item, see docs/ROADMAP.md) — but sending
// now goes through the Transport abstraction instead of importing
// whatsapp-web.js directly, same as every other route.
//
// A schedule fires at `runAt`. If `repeat` is set, after firing it computes the
// next `runAt` by stepping forward until it's in the future again (this collapses
// any occurrences missed while the server was down into a single catch-up send,
// instead of firing a burst of backlogged sends).
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const crypto = require('node:crypto');

const REPEAT_UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000, weeks: 7 * 24 * 60 * 60 * 1000 };
const TICK_INTERVAL_MS = 15000;

class Scheduler extends EventEmitter {
  constructor(transport, { file = 'schedules.json', logger } = {}) {
    super();
    this.transport = transport;
    this.file = file;
    this.logger = logger;
    this.schedules = this._load();
    this._interval = null;
  }

  _load() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return [];
    }
  }

  _save() {
    fs.writeFileSync(this.file, JSON.stringify(this.schedules, null, 2));
  }

  list() {
    return this.schedules;
  }

  create({ recipients, message, runAt, delaySeconds, repeat }) {
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

    const schedule = {
      id: crypto.randomUUID(),
      recipients: normalizedRecipients,
      message: String(message),
      delaySeconds: Math.max(0, Number(delaySeconds) || 0),
      runAt: runAtMs,
      repeat: normalizedRepeat,
      status: 'scheduled',
      lastResult: null,
      createdAt: Date.now()
    };

    this.schedules.push(schedule);
    this._save();
    this.emit('scheduleUpdate', schedule);
    return schedule;
  }

  remove(id) {
    const index = this.schedules.findIndex((s) => s.id === id);
    if (index === -1) return false;
    this.schedules.splice(index, 1);
    this._save();
    this.emit('scheduleRemoved', id);
    return true;
  }

  async _fire(schedule) {
    schedule.status = 'sending';
    this.emit('scheduleUpdate', schedule);

    const numbers = schedule.recipients.map((r) => r.number);
    const raw = await this.transport.sendToNumbers(numbers, schedule.message, schedule.delaySeconds);
    const results = raw.map((r, i) => ({
      number: r.number,
      name: schedule.recipients[i] ? schedule.recipients[i].name : '',
      status: r.status,
      detail: r.detail
    }));
    schedule.lastResult = { ranAt: Date.now(), results };

    if (schedule.repeat) {
      const unitMs = REPEAT_UNIT_MS[schedule.repeat.everyUnit] || REPEAT_UNIT_MS.minutes;
      const stepMs = unitMs * Math.max(1, Number(schedule.repeat.everyValue) || 1);
      let next = schedule.runAt;
      do {
        next += stepMs;
      } while (next <= Date.now());

      if (schedule.repeat.endAt && next > schedule.repeat.endAt) {
        schedule.status = 'done';
      } else {
        schedule.runAt = next;
        schedule.status = 'scheduled';
      }
    } else {
      schedule.status = 'done';
    }

    this._save();
    this.emit('scheduleUpdate', schedule);
  }

  runTickIfReady() {
    if (this.transport.getConnectionState() !== 'ready') return;
    const now = Date.now();
    for (const schedule of this.schedules) {
      if (schedule.status === 'scheduled' && schedule.runAt <= now) {
        this._fire(schedule).catch((err) => this.logger && this.logger.error({ err }, 'schedule_fire_error'));
      }
    }
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
