// Maps a send outcome or thrown exception to one of a small set of retry
// categories. Only TRANSIENT/UNKNOWN are retried — PERMANENT/VALIDATION/
// AUTHORIZATION/CANCELLED terminate immediately, never retried indefinitely.
const CATEGORIES = Object.freeze({
  TRANSIENT: 'TRANSIENT',
  PERMANENT: 'PERMANENT',
  VALIDATION: 'VALIDATION',
  AUTHORIZATION: 'AUTHORIZATION',
  CANCELLED: 'CANCELLED',
  UNKNOWN: 'UNKNOWN'
});

/** @returns {string|null} null means success (no error to classify) */
function classifyOutcome(status) {
  switch (status) {
    case 'sent':
      return null;
    case 'not_on_whatsapp':
      return CATEGORIES.PERMANENT;
    case 'error':
      return CATEGORIES.TRANSIENT;
    case 'skipped':
      return CATEGORIES.VALIDATION;
    default:
      return CATEGORIES.UNKNOWN;
  }
}

function classifyException(err) {
  if (err && err.name === 'TransportNotReadyError') return CATEGORIES.TRANSIENT;
  return CATEGORIES.UNKNOWN;
}

function isRetryable(category) {
  return category === CATEGORIES.TRANSIENT || category === CATEGORIES.UNKNOWN;
}

module.exports = { CATEGORIES, classifyOutcome, classifyException, isRetryable };
