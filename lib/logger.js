// Structured logging with redaction. Never log passwords, cookies, session
// data, QR payloads, or LocalAuth material — redaction paths cover every
// field name we know could carry one of those, applied recursively.
const pino = require('pino');
const config = require('../config');

const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'password',
      'passwordHash',
      'req.headers.cookie',
      'req.headers.authorization',
      '*.password',
      '*.passwordHash',
      '*.cookie',
      '*.sessionSecret',
      '*.qr',
      '*.qrDataUrl',
      '*.localAuth',
      '*.csrfToken'
    ],
    censor: '[redacted]'
  },
  base: { pid: process.pid }
});

function childLogger(bindings) {
  return logger.child(bindings);
}

module.exports = { logger, childLogger };
