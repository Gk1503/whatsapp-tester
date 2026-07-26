#!/usr/bin/env node
// Quick SQLite integrity check — `npm run db:check`.
const db = require('../lib/db');

const result = db.prepare('PRAGMA integrity_check').get();
const schemaVersion = db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get();

console.log('Schema version:', schemaVersion ? schemaVersion.value : '(none)');
console.log('Integrity check:', result.integrity_check);

if (result.integrity_check !== 'ok') {
  console.error('DATABASE INTEGRITY CHECK FAILED');
  process.exit(1);
}
