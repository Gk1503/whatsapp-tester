const express = require('express');
const { requirePermission } = require('../lib/auth/middleware');
const { PERMISSIONS } = require('../lib/rbac');
const { validate, searchQuery } = require('../lib/validation/schemas');
const rateLimit = require('../lib/rateLimit');
const { TransportUnavailableError } = require('../lib/errors');

module.exports = function contactsRoutes(transport) {
  const router = express.Router();

  router.get(
    '/',
    rateLimit.read,
    requirePermission(PERMISSIONS.VIEW_CHATS),
    validate({ query: searchQuery }),
    async (req, res, next) => {
      try {
        const result = await transport.getContacts(req.query.search);
        res.json(result);
      } catch (err) {
        if (err.name === 'TransportNotReadyError') return next(TransportUnavailableError());
        next(err);
      }
    }
  );

  return router;
};
