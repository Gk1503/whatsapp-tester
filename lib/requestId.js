// Assigns a request ID to every HTTP request and attaches a child logger
// scoped to it, so one operation is traceable across logs/errors/audit
// entries without needing to log sensitive request content.
const crypto = require('node:crypto');
const { childLogger } = require('./logger');

function requestId(req, res, next) {
  const id = req.headers['x-request-id'] || crypto.randomUUID();
  req.id = id;
  req.log = childLogger({ requestId: id });
  res.setHeader('X-Request-Id', id);
  next();
}

module.exports = requestId;
