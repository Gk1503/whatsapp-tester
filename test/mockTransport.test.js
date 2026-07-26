const test = require('node:test');
const assert = require('node:assert/strict');
const MockTransport = require('../transports/MockTransport');

function waitForState(transport, targetState, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    if (transport.getConnectionState() === targetState) return resolve();
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for state ${targetState}`)), timeoutMs);
    transport.on('state', ({ state }) => {
      if (state === targetState) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

test('MockTransport reaches ready without any Puppeteer/Chromium dependency', async () => {
  const transport = new MockTransport({ seed: 1, contactCount: 5, chatCount: 3 });
  assert.equal(transport.getConnectionState(), 'initializing');
  await transport.initialize();
  await waitForState(transport, 'ready');
  assert.equal(transport.getConnectionState(), 'ready');
  await transport.shutdown();
});

test('same seed produces identical contacts and chats', async () => {
  const a = new MockTransport({ seed: 42, contactCount: 10, chatCount: 5 });
  const b = new MockTransport({ seed: 42, contactCount: 10, chatCount: 5 });
  await a.initialize();
  await b.initialize();
  await waitForState(a, 'ready');
  await waitForState(b, 'ready');

  assert.deepEqual(await a.getContacts(), await b.getContacts());
  assert.deepEqual(await a.getChats(), await b.getChats());
  await a.shutdown();
  await b.shutdown();
});

test('different seeds produce different contacts', async () => {
  const a = new MockTransport({ seed: 1, contactCount: 10 });
  const b = new MockTransport({ seed: 2, contactCount: 10 });
  await a.initialize();
  await b.initialize();
  await waitForState(a, 'ready');
  await waitForState(b, 'ready');

  assert.notDeepEqual(await a.getContacts(), await b.getContacts());
  await a.shutdown();
  await b.shutdown();
});

test('send outcomes are deterministic for the same seed and recipient', async () => {
  const transport = new MockTransport({ seed: 7 });
  await transport.initialize();
  await waitForState(transport, 'ready');

  const first = await transport.sendToNumbers(['15551234567', '15559999999'], 'hi', 0);
  const second = await transport.sendToNumbers(['15551234567', '15559999999'], 'hi', 0);
  assert.deepEqual(
    first.map((r) => r.status),
    second.map((r) => r.status)
  );
  await transport.shutdown();
});

test('methods reject before the transport is ready', async () => {
  const transport = new MockTransport({ seed: 1 });
  await assert.rejects(() => transport.getContacts(), /not connected/);
});

test('getChatMessages returns null for an unknown chat id', async () => {
  const transport = new MockTransport({ seed: 1, chatCount: 2 });
  await transport.initialize();
  await waitForState(transport, 'ready');
  const messages = await transport.getChatMessages('does-not-exist@c.us');
  assert.equal(messages, null);
  await transport.shutdown();
});
