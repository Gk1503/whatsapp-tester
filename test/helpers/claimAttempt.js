// Standalone script used by test/jobs.test.js to prove claimNextItem() is
// correct across separate OS processes sharing one SQLite file, not just
// across async callbacks within a single process. Expects DB_PATH (env) and
// a worker id (argv[2]) already set by the parent. Prints one JSON line:
// { claimedId: string|null }.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.TRANSPORT_MODE = process.env.TRANSPORT_MODE || 'mock';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'x'.repeat(32);

const { claimNextItem } = require('../../lib/jobs/claiming');

const workerId = process.argv[2] || `child-${process.pid}`;
const item = claimNextItem(workerId);
process.stdout.write(JSON.stringify({ claimedId: item ? item.id : null }));
