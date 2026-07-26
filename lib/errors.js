// Centralized error taxonomy. Every thrown AppError carries a safe,
// user-facing message and an HTTP status; anything else (a genuine bug) is
// logged in full server-side and reduced to a generic INTERNAL_ERROR for the
// client — never a raw stack trace or exception message.
class AppError extends Error {
  constructor(category, message, status) {
    super(message);
    this.name = 'AppError';
    this.category = category;
    this.status = status;
  }
}

const ValidationError = (message) => new AppError('VALIDATION_ERROR', message, 400);
const AuthenticationError = (message = 'Authentication required') =>
  new AppError('AUTHENTICATION_ERROR', message, 401);
const AuthorizationError = (message = 'Not permitted') => new AppError('AUTHORIZATION_ERROR', message, 403);
const RateLimitedError = (message = 'Too many requests') => new AppError('RATE_LIMITED', message, 429);
const TransportUnavailableError = (message = 'WhatsApp is not connected yet') =>
  new AppError('TRANSPORT_UNAVAILABLE', message, 409);
const RecipientNotFoundError = (message = 'Recipient not found') =>
  new AppError('RECIPIENT_NOT_FOUND', message, 404);
const UploadRejectedError = (message) => new AppError('UPLOAD_REJECTED', message, 400);
const NotFoundError = (message = 'Not found') => new AppError('NOT_FOUND', message, 404);
const OutboundDisabledError = (message = 'Outbound messaging is currently disabled by an administrator.') =>
  new AppError('OUTBOUND_DISABLED', message, 423);

// Express error-handling middleware — mount last, after all routes.
function errorHandler(err, req, res, _next) {
  const log = req.log || require('./logger').logger;

  if (err instanceof AppError) {
    log.warn({ err: { category: err.category, message: err.message }, requestId: req.id }, 'request_error');
    return res.status(err.status).json({ error: err.message, category: err.category, requestId: req.id });
  }

  // Unrecognized/unexpected error: log full detail, leak nothing to the client.
  log.error({ err, requestId: req.id }, 'unhandled_error');
  res.status(500).json({ error: 'Something went wrong.', category: 'INTERNAL_ERROR', requestId: req.id });
}

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  RateLimitedError,
  TransportUnavailableError,
  RecipientNotFoundError,
  UploadRejectedError,
  NotFoundError,
  OutboundDisabledError,
  errorHandler
};
