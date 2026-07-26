// Append-only audit trail for privileged actions. Never pass message bodies,
// passwords, cookies, or LocalAuth material as metadata — this is for "who
// did what, when, with what result", not a content log.
const db = require('./db');

const insert = db.prepare(
  `INSERT INTO audit_log (ts, actor, action, target, result, request_id, metadata)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

function recordAudit({ actor, action, target = null, result = 'success', requestId = null, metadata = null }) {
  insert.run(Date.now(), actor || null, action, target, result, requestId, metadata ? JSON.stringify(metadata) : null);
}

function listAudit({ limit = 100 } = {}) {
  return db
    .prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?')
    .all(Math.min(Math.max(1, limit), 1000))
    .map((row) => ({ ...row, metadata: row.metadata ? JSON.parse(row.metadata) : null }));
}

module.exports = { recordAudit, listAudit };
