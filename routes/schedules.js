const express = require('express');
const { requirePermission } = require('../lib/auth/middleware');
const { PERMISSIONS } = require('../lib/rbac');
const { validate, createScheduleBody, idParam } = require('../lib/validation/schemas');
const rateLimit = require('../lib/rateLimit');
const { ValidationError, NotFoundError } = require('../lib/errors');
const { recordAudit } = require('../lib/audit');

module.exports = function scheduleRoutes(scheduler) {
  const router = express.Router();

  router.get('/', rateLimit.read, requirePermission(PERMISSIONS.MANAGE_SCHEDULES), (req, res) => {
    res.json(scheduler.list());
  });

  router.post(
    '/',
    rateLimit.scheduleCreate,
    requirePermission(PERMISSIONS.MANAGE_SCHEDULES),
    validate({ body: createScheduleBody }),
    (req, res, next) => {
      try {
        const schedule = scheduler.create({ ...req.body, createdBy: req.user.username });
        recordAudit({
          actor: req.user.username,
          action: 'schedule_create',
          target: schedule.id,
          result: 'success',
          requestId: req.id
        });
        res.json(schedule);
      } catch (err) {
        if (err.name === 'ValidationError') return next(ValidationError(err.message));
        next(err);
      }
    }
  );

  router.delete(
    '/:id',
    rateLimit.read,
    requirePermission(PERMISSIONS.MANAGE_SCHEDULES),
    validate({ params: idParam }),
    (req, res, next) => {
      const removed = scheduler.remove(req.params.id);
      if (!removed) return next(NotFoundError());
      recordAudit({
        actor: req.user.username,
        action: 'schedule_delete',
        target: req.params.id,
        result: 'success',
        requestId: req.id
      });
      res.json({ ok: true });
    }
  );

  return router;
};
