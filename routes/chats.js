const express = require('express');
const { requirePermission } = require('../lib/auth/middleware');
const { PERMISSIONS } = require('../lib/rbac');
const { validate, searchQuery, idParam, messageBody } = require('../lib/validation/schemas');
const rateLimit = require('../lib/rateLimit');
const { TransportUnavailableError, NotFoundError } = require('../lib/errors');
const { recordAudit } = require('../lib/audit');
const { requireOutboundEnabled } = require('../lib/killSwitch');

module.exports = function chatsRoutes(transport) {
  const router = express.Router();

  router.get(
    '/',
    rateLimit.read,
    requirePermission(PERMISSIONS.VIEW_CHATS),
    validate({ query: searchQuery }),
    async (req, res, next) => {
      try {
        res.json(await transport.getChats(req.query.search));
      } catch (err) {
        if (err.name === 'TransportNotReadyError') return next(TransportUnavailableError());
        next(err);
      }
    }
  );

  router.get(
    '/:id/messages',
    rateLimit.read,
    requirePermission(PERMISSIONS.VIEW_CHATS),
    validate({ params: idParam }),
    async (req, res, next) => {
      try {
        const messages = await transport.getChatMessages(req.params.id);
        if (messages === null) return next(NotFoundError('Chat not found'));
        res.json(messages);
      } catch (err) {
        if (err.name === 'TransportNotReadyError') return next(TransportUnavailableError());
        next(err);
      }
    }
  );

  router.post(
    '/:id/send',
    rateLimit.send,
    requirePermission(PERMISSIONS.SEND_MESSAGE),
    requireOutboundEnabled,
    validate({ params: idParam, body: messageBody }),
    async (req, res, next) => {
      try {
        await transport.sendChatMessage(req.params.id, req.body.message);
        recordAudit({
          actor: req.user.username,
          action: 'chat_send',
          target: req.params.id,
          result: 'success',
          requestId: req.id
        });
        res.json({ ok: true });
      } catch (err) {
        if (err.name === 'TransportNotReadyError') return next(TransportUnavailableError());
        recordAudit({
          actor: req.user.username,
          action: 'chat_send',
          target: req.params.id,
          result: 'failure',
          requestId: req.id
        });
        next(err);
      }
    }
  );

  return router;
};
