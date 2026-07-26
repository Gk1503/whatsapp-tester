// Tiered rate limits — endpoint risk/cost decides the tier, not one global
// number for everything. All return 429 with a Retry-After header (the
// express-rate-limit default) rather than crashing or silently degrading.
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { RateLimitedError } = require('./errors');

function handler(req, res, next) {
  next(RateLimitedError('Too many requests — please slow down and try again shortly.'));
}

// Rate limiting can only be bypassed in test mode, and only with an explicit
// env var — production is never affected by this regardless of the env var,
// so it can't accidentally ship enabled. Exists solely so the capacity
// benchmark script (which intentionally hammers the app) measures real
// endpoint throughput instead of only the rate-limit ceiling.
const benchmarkBypass = config.isTest && process.env.DISABLE_RATE_LIMIT === 'true';

function make(windowMs, max) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => benchmarkBypass,
    handler
  });
}

module.exports = {
  // Login: strict, keyed by default on IP — combined with per-username
  // throttling in lib/auth/middleware.js for the actual lockout logic.
  auth: make(60 * 1000, 10),
  // Anything that dispatches a real/mock WhatsApp message.
  send: make(60 * 1000, 20),
  // Bulk/group operations touch many recipients per call — tighter.
  bulk: make(60 * 1000, 5),
  // Schedule creation.
  scheduleCreate: make(60 * 1000, 15),
  // Read-heavy search/list endpoints.
  read: make(60 * 1000, 120)
};
