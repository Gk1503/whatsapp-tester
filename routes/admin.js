const express = require('express');
const { requirePermission } = require('../lib/auth/middleware');
const { PERMISSIONS } = require('../lib/rbac');
const { validate, killSwitchBody } = require('../lib/validation/schemas');
const rateLimit = require('../lib/rateLimit');
const { getKillSwitchState, setOutboundDisabled } = require('../lib/killSwitch');

module.exports = function adminRoutes() {
  const router = express.Router();

  router.get('/kill-switch', rateLimit.read, requirePermission(PERMISSIONS.MANAGE_SECURITY), (req, res) => {
    res.json(getKillSwitchState());
  });

  router.post(
    '/kill-switch',
    rateLimit.scheduleCreate,
    requirePermission(PERMISSIONS.MANAGE_SECURITY),
    validate({ body: killSwitchBody }),
    (req, res) => {
      const state = setOutboundDisabled(req.body.disabled, {
        actor: req.user.username,
        reason: req.body.reason,
        requestId: req.id
      });
      res.json(state);
    }
  );

  return router;
};
