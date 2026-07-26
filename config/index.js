// Central config: parses env, picks a mode, and fails closed on dangerous
// production configuration rather than silently starting insecurely.

function configError(message) {
  const err = new Error(message);
  err.name = 'ConfigError';
  return err;
}

const KNOWN_TEST_SECRET = 'test-only-secret-do-not-use-in-production-0000000000000000';

const NODE_ENV = process.env.NODE_ENV || 'development';
if (!['development', 'test', 'production'].includes(NODE_ENV)) {
  throw configError(`NODE_ENV must be development|test|production, got "${NODE_ENV}"`);
}

const isProduction = NODE_ENV === 'production';

// Transport: mock is the safe default everywhere except production, where it
// must be explicitly requested — there is no implicit "fall back to real".
const rawTransportMode = process.env.TRANSPORT_MODE || (isProduction ? '' : 'mock');
if (!['mock', 'real'].includes(rawTransportMode)) {
  throw configError(
    `TRANSPORT_MODE must be "mock" or "real" (got "${rawTransportMode || '<empty>'}"). Production must set it explicitly.`
  );
}

const config = {
  nodeEnv: NODE_ENV,
  isProduction,
  isTest: NODE_ENV === 'test',
  port: Number(process.env.PORT) || 5050,
  transportMode: rawTransportMode,
  mockSeed: Number(process.env.MOCK_SEED) || 12345,
  sessionSecret: process.env.SESSION_SECRET || '',
  sessionIdleTimeoutMs: Number(process.env.SESSION_IDLE_TIMEOUT_MS) || 30 * 60 * 1000,
  sessionAbsoluteTimeoutMs: Number(process.env.SESSION_ABSOLUTE_TIMEOUT_MS) || 8 * 60 * 60 * 1000,
  logLevel: process.env.LOG_LEVEL || (NODE_ENV === 'test' ? 'silent' : 'info'),
  dbPath: process.env.DB_PATH || 'data/app.db',
  schedulesFile: process.env.SCHEDULES_FILE || 'schedules.json'
};

// ---- Fail-closed startup checks ----
const problems = [];

if (!config.sessionSecret) {
  problems.push('SESSION_SECRET is not set.');
} else if (config.sessionSecret === KNOWN_TEST_SECRET && isProduction) {
  problems.push('SESSION_SECRET is the well-known test value — refusing to run in production with it.');
} else if (config.sessionSecret.length < 32) {
  problems.push('SESSION_SECRET is too short (need at least 32 characters of random data).');
}

if (problems.length > 0) {
  throw configError('Refusing to start due to unsafe configuration:\n' + problems.map((p) => `  - ${p}`).join('\n'));
}

module.exports = config;
