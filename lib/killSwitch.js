// Global OWNER/ADMIN-only outbound kill switch. Durable (SQLite `settings`
// row, survives restart). Checked by the job worker before claiming and by
// every currently-synchronous send route before dispatch.
const db = require('../lib/db');
const { recordAudit } = require('./audit');
const { OutboundDisabledError } = require('./errors');

const SETTING_KEY = 'outbound_disabled';

function isOutboundDisabled() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTING_KEY);
  return row ? row.value === 'true' : false;
}

function getKillSwitchState() {
  const row = db.prepare('SELECT value, updated_at, updated_by FROM settings WHERE key = ?').get(SETTING_KEY);
  const reasonRow = db.prepare("SELECT value FROM settings WHERE key = 'outbound_disabled_reason'").get();
  return {
    disabled: row ? row.value === 'true' : false,
    updatedAt: row ? row.updated_at : null,
    updatedBy: row ? row.updated_by : null,
    reason: reasonRow ? reasonRow.value : null
  };
}

function setOutboundDisabled(disabled, { actor, reason, requestId } = {}) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(SETTING_KEY, String(disabled), now, actor || null);

  db.prepare(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('outbound_disabled_reason', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
  ).run(reason || '', now, actor || null);

  recordAudit({
    actor,
    action: disabled ? 'kill_switch_enabled' : 'kill_switch_disabled',
    result: 'success',
    requestId,
    metadata: reason ? { reason } : null
  });

  return getKillSwitchState();
}

/** Express middleware — blocks any route it's mounted on while the kill switch is active. */
function requireOutboundEnabled(req, res, next) {
  if (isOutboundDisabled()) return next(OutboundDisabledError());
  next();
}

module.exports = { isOutboundDisabled, getKillSwitchState, setOutboundDisabled, requireOutboundEnabled };
