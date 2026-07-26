const express = require('express');
const multer = require('multer');
const path = require('node:path');
const XLSX = require('xlsx');
const { requirePermission } = require('../lib/auth/middleware');
const { PERMISSIONS } = require('../lib/rbac');
const { validate, sendBulkBody, buildSheetBody } = require('../lib/validation/schemas');
const rateLimit = require('../lib/rateLimit');
const { TransportUnavailableError, UploadRejectedError } = require('../lib/errors');
const { recordAudit } = require('../lib/audit');
const { requireOutboundEnabled } = require('../lib/killSwitch');
const { idempotent } = require('../lib/idempotency');
const {
  NAME_KEYS,
  NUMBER_KEYS,
  MESSAGE_KEYS,
  pickField,
  resolveTemplate,
  neutralizeFormula,
  enforceSheetLimits
} = require('../lib/spreadsheet');

const ALLOWED_EXTENSIONS = new Set(['.xlsx', '.xls', '.csv']);
const ALLOWED_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/csv',
  'application/octet-stream' // some browsers send this for .csv/.xls — extension check below still applies
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext) || !ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(UploadRejectedError('Only .xlsx, .xls, or .csv files are accepted.'));
    }
    cb(null, true);
  }
});

module.exports = function bulkRoutes(transport) {
  const router = express.Router();

  router.post(
    '/parse-sheet',
    rateLimit.bulk,
    requirePermission(PERMISSIONS.UPLOAD_SHEET),
    upload.single('file'),
    (req, res, next) => {
      if (!req.file) return next(UploadRejectedError('No file uploaded'));

      try {
        const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

        enforceSheetLimits(rawRows);

        const fieldSet = new Set();
        rawRows.forEach((row) => Object.keys(row).forEach((k) => fieldSet.add(k)));

        const rows = rawRows
          .map((row) => ({
            name: pickField(row, NAME_KEYS),
            number: pickField(row, NUMBER_KEYS).replace(/[^\d]/g, ''),
            message: pickField(row, MESSAGE_KEYS),
            data: row
          }))
          .filter((row) => row.number);

        if (rows.length === 0) {
          return next(UploadRejectedError('No usable rows found. Make sure the sheet has Name, Number and Message columns.'));
        }

        recordAudit({
          actor: req.user.username,
          action: 'sheet_import',
          result: 'success',
          requestId: req.id,
          metadata: { rowCount: rows.length }
        });
        res.json({ rows, fields: Array.from(fieldSet) });
      } catch (err) {
        if (err.name === 'SheetTooLargeError') return next(UploadRejectedError(err.message));
        req.log.warn({ err }, 'parse_sheet_error');
        next(UploadRejectedError('Could not read that file. Use a valid .xlsx, .xls or .csv file.'));
      }
    }
  );

  router.post(
    '/send-bulk',
    rateLimit.bulk,
    requirePermission(PERMISSIONS.BULK_SEND),
    requireOutboundEnabled,
    idempotent('send-bulk'),
    validate({ body: sendBulkBody }),
    async (req, res, next) => {
      const { rows, defaultMessage, delaySeconds } = req.body;
      const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
      const results = [];

      try {
        for (const row of rows) {
          const digits = String(row.number || '').replace(/[^\d]/g, '');
          const template = String(row.message || defaultMessage || '').trim();
          const message = resolveTemplate(template, row.data || {}).trim();
          const label = row.name || digits;

          if (!digits || !message) {
            results.push({ number: row.number, name: label, status: 'skipped', detail: 'missing number or message' });
            continue;
          }

          const [sendResult] = await transport.sendToNumbers([digits], message, 0);
          results.push({ number: digits, name: label, status: sendResult.status, detail: sendResult.detail });
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        }

        recordAudit({
          actor: req.user.username,
          action: 'bulk_send',
          result: 'success',
          requestId: req.id,
          metadata: { rowCount: rows.length }
        });
        res.json({ results });
      } catch (err) {
        if (err.name === 'TransportNotReadyError') return next(TransportUnavailableError());
        recordAudit({ actor: req.user.username, action: 'bulk_send', result: 'failure', requestId: req.id });
        next(err);
      }
    }
  );

  router.post(
    '/build-sheet',
    rateLimit.bulk,
    requirePermission(PERMISSIONS.EXPORT_SHEET),
    validate({ body: buildSheetBody }),
    (req, res, next) => {
      try {
        const { rows, defaultMessage } = req.body;
        const data = rows.map((r) => {
          const template = (r.message && String(r.message).trim()) || String(defaultMessage || '').trim();
          return {
            Name: neutralizeFormula(r.name || ''),
            Number: neutralizeFormula(r.number || ''),
            Message: neutralizeFormula(resolveTemplate(template, r.data || {}).trim())
          };
        });

        const sheet = XLSX.utils.json_to_sheet(data);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, sheet, 'Messages');
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        recordAudit({ actor: req.user.username, action: 'sheet_export', result: 'success', requestId: req.id });
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename="filled-messages.xlsx"');
        res.send(buffer);
      } catch (err) {
        next(err);
      }
    }
  );

  return router;
};
