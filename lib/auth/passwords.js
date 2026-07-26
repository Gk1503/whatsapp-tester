// Password hashing via Node's built-in scrypt (node:crypto) — no native
// dependency, no argon2/bcrypt binary to compile. scrypt is an accepted
// modern KDF for password storage (OWASP Password Storage Cheat Sheet lists
// it alongside argon2/bcrypt when those aren't available).
const crypto = require('node:crypto');

const N = 16384; // CPU/memory cost
const r = 8;
const p = 1;
const KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const n = Number(nStr);
  const rr = Number(rStr);
  const pp = Number(pStr);
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length, { N: n, r: rr, p: pp, maxmem: 128 * n * rr * 2 });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword };
