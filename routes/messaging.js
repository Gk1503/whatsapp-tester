const express = require('express');
const { requirePermission } = require('../lib/auth/middleware');
const { PERMISSIONS } = require('../lib/rbac');
const { validate, sendBody, sendGroupsBody } = require('../lib/validation/schemas');
const rateLimit = require('../lib/rateLimit');
const { TransportUnavailableError } = require('../lib/errors');
const { recordAudit } = require('../lib/audit');

module.exports = function messagingRoutes(transport) {
  const router = express.Router();

  router.post(
    '/send',
    rateLimit.send,
    requirePermission(PERMISSIONS.SEND_MESSAGE),
    validate({ body: sendBody }),
    async (req, res, next) => {
      const { numbers, message, delaySeconds } = req.body;
      try {
        const results = await transport.sendToNumbers(numbers, message, delaySeconds);
        recordAudit({
          actor: req.user.username,
          action: 'send',
          result: 'success',
          requestId: req.id,
          metadata: { recipientCount: numbers.length }
        });
        res.json({ results });
      } catch (err) {
        if (err.name === 'TransportNotReadyError') return next(TransportUnavailableError());
        recordAudit({ actor: req.user.username, action: 'send', result: 'failure', requestId: req.id });
        next(err);
      }
    }
  );

  router.post(
    '/send-groups',
    rateLimit.bulk,
    requirePermission(PERMISSIONS.SEND_GROUPS),
    validate({ body: sendGroupsBody }),
    async (req, res, next) => {
      const { groupIds, message, delaySeconds } = req.body;
      try {
        const results = await transport.sendToGroups(groupIds, message, delaySeconds);
        recordAudit({
          actor: req.user.username,
          action: 'send_groups',
          result: 'success',
          requestId: req.id,
          metadata: { groupCount: groupIds.length }
        });
        res.json({ results });
      } catch (err) {
        if (err.name === 'TransportNotReadyError') return next(TransportUnavailableError());
        recordAudit({ actor: req.user.username, action: 'send_groups', result: 'failure', requestId: req.id });
        next(err);
      }
    }
  );

  return router;
};
