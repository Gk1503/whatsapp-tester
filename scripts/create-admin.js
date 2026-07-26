#!/usr/bin/env node
// OWNER-account bootstrap. Refuses to run if an admin already exists. No
// default/hard-coded credentials.
//
// Interactive (normal use): prompts for username, then a masked password.
// Non-interactive (automation/containers): set both ADMIN_USERNAME and
// ADMIN_PASSWORD env vars to skip prompting — still no default value is
// ever assumed, the operator/deployment must supply both explicitly.
const readline = require('node:readline');
const db = require('../lib/db');
const { hashPassword } = require('../lib/auth/passwords');

const CTRL_C = '';
const BACKSPACE = '';

function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    let input = '';
    const onData = (char) => {
      if (char === '\r' || char === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(input);
        return;
      }
      if (char === CTRL_C) process.exit(1);
      if (char === BACKSPACE) {
        input = input.slice(0, -1);
        return;
      }
      input += char;
    };
    stdin.on('data', onData);
  });
}

async function promptCredentials() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const username = await new Promise((resolve) => rl.question('Admin username: ', (a) => resolve(a.trim())));
  rl.close();

  const password = process.stdin.isTTY
    ? await askHidden('Admin password (hidden): ')
    : await new Promise((resolve) => {
        const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl2.question('Admin password: ', (a) => {
          rl2.close();
          resolve(a);
        });
      });

  return { username, password };
}

async function main() {
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (existing.n > 0) {
    console.error('An account already exists. Refusing to create another OWNER via this script.');
    console.error('Use the app itself (once multi-user management ships) to add more accounts.');
    process.exit(1);
  }

  const envUsername = process.env.ADMIN_USERNAME;
  const envPassword = process.env.ADMIN_PASSWORD;
  const { username, password } =
    envUsername && envPassword ? { username: envUsername, password: envPassword } : await promptCredentials();

  if (!username || username.length < 3) {
    console.error('Username must be at least 3 characters.');
    process.exit(1);
  }
  if (!password || password.length < 12) {
    console.error('Password must be at least 12 characters.');
    process.exit(1);
  }

  const passwordHash = hashPassword(password);
  db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run(
    username,
    passwordHash,
    'OWNER',
    Date.now()
  );

  console.log(`OWNER account "${username}" created.`);
}

main().catch((err) => {
  console.error('Failed to create admin account:', err.message);
  process.exit(1);
});
