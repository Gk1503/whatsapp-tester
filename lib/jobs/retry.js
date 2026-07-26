// Bounded exponential backoff with jitter. Never retry indefinitely.
const MAX_ATTEMPTS = 5;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60000;

/** attemptNumber is 1-based (the attempt that just failed). Returns ms until the next attempt is eligible. */
function computeBackoffMs(attemptNumber) {
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attemptNumber - 1));
  const jitter = Math.random() * exp * 0.2; // 0-20% jitter, additive
  return Math.round(Math.min(MAX_DELAY_MS, exp + jitter));
}

module.exports = { MAX_ATTEMPTS, BASE_DELAY_MS, MAX_DELAY_MS, computeBackoffMs };
