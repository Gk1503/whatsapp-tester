// Centralized input validation. Every external input (query, body, params)
// goes through a zod schema before touching route logic — unknown/dangerous
// shapes are rejected here, not deep inside business logic.
const { z } = require('zod');
const { ValidationError } = require('../errors');

// ---- Shared bounds (Phase 7: define maximums for everything) ----
const LIMITS = {
  MAX_MESSAGE_LEN: 4096,
  MAX_SEARCH_LEN: 200,
  MAX_RECIPIENTS: 500,
  MAX_GROUPS: 200,
  MAX_BULK_ROWS: 5000,
  MAX_DELAY_SECONDS: 300,
  MAX_REPEAT_VALUE: 1000
};

const searchQuery = z.object({
  search: z.string().max(LIMITS.MAX_SEARCH_LEN).optional().default('')
});

const idParam = z.object({ id: z.string().min(1).max(300) });

const messageBody = z.object({
  message: z.string().min(1).max(LIMITS.MAX_MESSAGE_LEN)
});

const delaySeconds = z.coerce.number().min(0).max(LIMITS.MAX_DELAY_SECONDS).optional().default(0);

const sendBody = z.object({
  numbers: z.array(z.string().min(1).max(40)).min(1).max(LIMITS.MAX_RECIPIENTS),
  message: z.string().min(1).max(LIMITS.MAX_MESSAGE_LEN),
  delaySeconds
});

const sendGroupsBody = z.object({
  groupIds: z.array(z.string().min(1).max(300)).min(1).max(LIMITS.MAX_GROUPS),
  message: z.string().min(1).max(LIMITS.MAX_MESSAGE_LEN),
  delaySeconds
});

const bulkRow = z.object({
  name: z.string().max(200).optional(),
  number: z.string().max(40).optional(),
  message: z.string().max(LIMITS.MAX_MESSAGE_LEN).optional(),
  data: z.record(z.unknown()).optional()
});

const sendBulkBody = z.object({
  rows: z.array(bulkRow).min(1).max(LIMITS.MAX_BULK_ROWS),
  defaultMessage: z.string().max(LIMITS.MAX_MESSAGE_LEN).optional().default(''),
  delaySeconds
});

const buildSheetBody = z.object({
  rows: z.array(bulkRow).min(1).max(LIMITS.MAX_BULK_ROWS),
  defaultMessage: z.string().max(LIMITS.MAX_MESSAGE_LEN).optional().default('')
});

const scheduleRepeat = z
  .object({
    everyValue: z.coerce.number().int().min(1).max(LIMITS.MAX_REPEAT_VALUE),
    everyUnit: z.enum(['minutes', 'hours', 'days', 'weeks']),
    endAt: z.string().datetime({ offset: true }).nullable().optional()
  })
  .nullable()
  .optional();

const createScheduleBody = z.object({
  recipients: z
    .array(
      z.object({
        number: z.string().min(1).max(40),
        name: z.string().max(200).optional().default('')
      })
    )
    .min(1)
    .max(LIMITS.MAX_RECIPIENTS),
  message: z.string().min(1).max(LIMITS.MAX_MESSAGE_LEN),
  runAt: z.string().min(1),
  delaySeconds,
  repeat: scheduleRepeat
});

const loginBody = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(512)
});

const killSwitchBody = z.object({
  disabled: z.boolean(),
  reason: z.string().max(500).optional().default('')
});

// Express middleware factory: validate({ query, body, params }).
function validate(schemas) {
  return function validateMiddleware(req, res, next) {
    try {
      if (schemas.query) req.query = schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      const detail = err && err.issues ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : 'Invalid request.';
      next(ValidationError(detail));
    }
  };
}

module.exports = {
  LIMITS,
  validate,
  searchQuery,
  idParam,
  messageBody,
  sendBody,
  sendGroupsBody,
  sendBulkBody,
  buildSheetBody,
  createScheduleBody,
  loginBody,
  killSwitchBody
};
