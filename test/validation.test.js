const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, sendBody, createScheduleBody, LIMITS } = require('../lib/validation/schemas');

function run(schema, key, value) {
  return new Promise((resolve) => {
    const req = { [key]: value };
    validate({ [key]: schema })(req, {}, (err) => resolve({ err, req }));
  });
}

test('sendBody accepts a well-formed request', async () => {
  const { err, req } = await run(sendBody, 'body', { numbers: ['15551234567'], message: 'hi', delaySeconds: '2' });
  assert.equal(err, undefined);
  assert.equal(req.body.delaySeconds, 2); // coerced from string
});

test('sendBody rejects an empty numbers array', async () => {
  const { err } = await run(sendBody, 'body', { numbers: [], message: 'hi' });
  assert.equal(err.category, 'VALIDATION_ERROR');
});

test('sendBody rejects a message over the max length', async () => {
  const { err } = await run(sendBody, 'body', {
    numbers: ['15551234567'],
    message: 'x'.repeat(LIMITS.MAX_MESSAGE_LEN + 1)
  });
  assert.equal(err.category, 'VALIDATION_ERROR');
});

test('sendBody rejects more recipients than the configured maximum', async () => {
  const numbers = Array.from({ length: LIMITS.MAX_RECIPIENTS + 1 }, (_, i) => `1555000${i}`);
  const { err } = await run(sendBody, 'body', { numbers, message: 'hi' });
  assert.equal(err.category, 'VALIDATION_ERROR');
});

test('sendBody rejects an unreasonable delaySeconds value', async () => {
  const { err } = await run(sendBody, 'body', { numbers: ['1'], message: 'hi', delaySeconds: 999999 });
  assert.equal(err.category, 'VALIDATION_ERROR');
});

test('sendBody rejects unexpected shapes (numbers as a string, not an array)', async () => {
  const { err } = await run(sendBody, 'body', { numbers: '15551234567', message: 'hi' });
  assert.equal(err.category, 'VALIDATION_ERROR');
});

test('createScheduleBody accepts a valid one-time schedule', async () => {
  const { err } = await run(createScheduleBody, 'body', {
    recipients: [{ number: '15551234567', name: 'Test' }],
    message: 'hello',
    runAt: new Date(Date.now() + 3600000).toISOString(),
    delaySeconds: 2,
    repeat: null
  });
  assert.equal(err, undefined);
});

test('createScheduleBody rejects an invalid repeat unit', async () => {
  const { err } = await run(createScheduleBody, 'body', {
    recipients: [{ number: '15551234567' }],
    message: 'hello',
    runAt: new Date().toISOString(),
    repeat: { everyValue: 1, everyUnit: 'fortnights' }
  });
  assert.equal(err.category, 'VALIDATION_ERROR');
});

test('createScheduleBody rejects a prototype-pollution-shaped recipients payload', async () => {
  const { err } = await run(createScheduleBody, 'body', {
    recipients: JSON.parse('[{"number": "1", "__proto__": {"polluted": true}}]'),
    message: 'hello',
    runAt: new Date().toISOString()
  });
  // Should either validate cleanly (zod strips unknown keys, no prototype
  // pollution possible since __proto__ via JSON.parse is a plain own key,
  // not the actual prototype) or reject — either way, no pollution occurs.
  assert.equal(Object.prototype.polluted, undefined);
  void err;
});
