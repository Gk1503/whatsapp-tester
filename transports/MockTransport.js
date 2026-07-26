// Deterministic local WhatsApp simulator. No Puppeteer, no Chromium, no
// network access, no ./session directory touched — safe default for
// development, automated tests, and all benchmark/load work. Same
// MOCK_SEED always produces the same contacts/chats/messages and the same
// per-recipient send outcomes, so results are reproducible run to run.
const qrcode = require('qrcode');
const Transport = require('./Transport');
const { generateContacts, generateChats, generateMessages, hashString } = require('../lib/syntheticData');

const STATE_TIMINGS_MS = { toQr: 150, toAuthenticated: 400, toReady: 700 };

class MockTransport extends Transport {
  constructor({ seed = 12345, contactCount = 30, chatCount = 20 } = {}) {
    super();
    this.seed = seed;
    this.connectionState = 'initializing';
    this.lastQrDataUrl = null;
    this.contacts = generateContacts(seed, contactCount);
    this.chats = generateChats(seed, chatCount, this.contacts);
    this._timers = [];
    this._forcedOutcomes = new Map(); // recipient -> { status, remaining }
  }

  /**
   * Deterministic failure injection for testing retry/circuit-breaker logic
   * without depending on hash-based luck. The next `count` sendToNumbers()
   * calls for `recipient` return `status` instead of the normal outcome;
   * after that it reverts to the deterministic hash-based outcome.
   */
  forceOutcome(recipient, status, count = 1) {
    this._forcedOutcomes.set(recipient, { status, remaining: count });
  }

  clearForcedOutcomes() {
    this._forcedOutcomes.clear();
  }

  _setState(state, extra = {}) {
    this.connectionState = state;
    this.emit('state', { state, qr: this.lastQrDataUrl, ...extra });
  }

  _schedule(fn, ms) {
    this._timers.push(setTimeout(fn, ms));
  }

  async initialize() {
    this._schedule(async () => {
      this.lastQrDataUrl = await qrcode.toDataURL(`mock-qr-seed-${this.seed}-${Date.now()}`);
      this._setState('qr');
    }, STATE_TIMINGS_MS.toQr);

    this._schedule(() => {
      this.lastQrDataUrl = null;
      this._setState('authenticated');
    }, STATE_TIMINGS_MS.toAuthenticated);

    this._schedule(() => {
      this._setState('ready');
    }, STATE_TIMINGS_MS.toReady);
  }

  getConnectionState() {
    return this.connectionState;
  }

  async getContacts(search = '') {
    this._assertReady();
    const needle = (search || '').toLowerCase().trim();
    return this.contacts.filter(
      (c) => !needle || c.name.toLowerCase().includes(needle) || c.number.includes(needle)
    );
  }

  async getChats(search = '') {
    this._assertReady();
    const needle = (search || '').toLowerCase().trim();
    return this.chats.filter((c) => !needle || c.name.toLowerCase().includes(needle));
  }

  async getChatMessages(chatId) {
    this._assertReady();
    const chat = this.chats.find((c) => c.id === chatId);
    if (!chat) return null;
    return generateMessages(this.seed, chatId, 20);
  }

  async sendChatMessage(chatId, message) {
    this._assertReady();
    const chat = this.chats.find((c) => c.id === chatId);
    if (!chat) throw new Error('Chat not found');
    await sleep(20);
    const payload = {
      chatId,
      id: `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      body: message,
      fromMe: true,
      author: null,
      timestamp: Math.floor(Date.now() / 1000),
      hasMedia: false
    };
    this.emit('chatMessage', payload);
  }

  async sendToNumbers(numbers, message, delaySeconds = 0) {
    this._assertReady();
    const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
    const results = [];
    for (const raw of numbers) {
      await sleep(15);
      results.push({ number: raw, status: this._outcomeFor(raw) });
      if (delayMs) await sleep(delayMs);
    }
    return results;
  }

  async sendToGroups(groupIds, message, delaySeconds = 0) {
    this._assertReady();
    const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
    const results = [];
    for (const groupId of groupIds) {
      await sleep(15);
      results.push({ id: groupId, status: this._outcomeFor(groupId) === 'not_on_whatsapp' ? 'error' : 'sent' });
      if (delayMs) await sleep(delayMs);
    }
    return results;
  }

  async disconnect() {
    this._timers.forEach(clearTimeout);
    this._setState('disconnected', { reason: 'Disconnected by user (mock)' });
  }

  async shutdown() {
    this._timers.forEach(clearTimeout);
  }

  async healthCheck() {
    return { ok: this.connectionState === 'ready', detail: `mock:${this.connectionState}` };
  }

  // Deterministic outcome per recipient: ~1 in 7 "not on WhatsApp", ~1 in 13
  // a transient error, everything else "sent" — same recipient always maps
  // to the same outcome for a given seed, so benchmark/test runs are stable.
  _outcomeFor(recipient) {
    const forced = this._forcedOutcomes.get(recipient);
    if (forced && forced.remaining > 0) {
      forced.remaining--;
      if (forced.remaining === 0) this._forcedOutcomes.delete(recipient);
      return forced.status;
    }
    const h = hashString(`${this.seed}:${recipient}`);
    if (h % 7 === 0) return 'not_on_whatsapp';
    if (h % 13 === 0) return 'error';
    return 'sent';
  }

  _assertReady() {
    if (this.connectionState !== 'ready') {
      const err = new Error('WhatsApp is not connected yet');
      err.name = 'TransportNotReadyError';
      throw err;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = MockTransport;
