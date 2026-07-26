// The real transport — whatsapp-web.js + Puppeteer/Chromium + LocalAuth.
// This is a straight move of the logic that used to live directly in
// server.js: same event handling, same 5s post-"ready" delay workaround,
// same pupPage.evaluate fallbacks for chats/messages (see inline comments
// for why each fallback exists) — reshaped behind the Transport interface
// so nothing else in the app imports whatsapp-web.js directly.
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');
const Transport = require('./Transport');

class WhatsAppWebTransport extends Transport {
  constructor({ sessionPath = './session' } = {}) {
    super();
    this.connectionState = 'initializing';
    this.lastQrDataUrl = null;
    this.client = new Client({
      authStrategy: new LocalAuth({ dataPath: sessionPath }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        protocolTimeout: 300000
      }
    });
    this._wireEvents();
  }

  _setState(state, extra = {}) {
    this.connectionState = state;
    this.emit('state', { state, qr: this.lastQrDataUrl, ...extra });
  }

  _wireEvents() {
    const client = this.client;

    client.on('qr', async (qr) => {
      this.lastQrDataUrl = await qrcode.toDataURL(qr);
      this._setState('qr');
    });

    client.on('authenticated', () => {
      this.lastQrDataUrl = null;
      this._setState('authenticated');
    });

    client.on('ready', () => {
      // whatsapp-web.js fires 'ready' slightly before its internal store finishes
      // hydrating; calling getContacts()/getChats() immediately hangs and times out
      // (see https://github.com/wwebjs/whatsapp-web.js/issues/127050). A short delay
      // before exposing the app avoids the race.
      setTimeout(() => {
        this.lastQrDataUrl = null;
        this._setState('ready');
      }, 5000);
    });

    client.on('auth_failure', (msg) => {
      this._setState('disconnected', { reason: `Auth failed: ${msg}` });
    });

    client.on('disconnected', (reason) => {
      this._setState('disconnected', { reason });
    });

    client.on('loading_screen', (percent, message) => {
      this._setState(this.connectionState, { reason: `Syncing… ${percent}% ${message || ''}`.trim() });
    });

    // Live feed of incoming messages, useful for testing auto-replies later
    client.on('message', (msg) => {
      this.emit('incoming', { from: msg.from, body: msg.body, timestamp: msg.timestamp });
    });

    // message_create fires for BOTH directions (incoming replies and anything sent,
    // including from the linked phone itself), which is what the live chat thread view
    // needs to stay in sync the way real WhatsApp Web does.
    client.on('message_create', (msg) => {
      if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return;
      const chatId = msg.fromMe ? msg.to : msg.from;
      this.emit('chatMessage', {
        chatId,
        id: msg.id._serialized,
        body: msg.body,
        fromMe: msg.fromMe,
        author: msg.author || null,
        timestamp: msg.timestamp,
        hasMedia: msg.hasMedia
      });
    });

    process.on('unhandledRejection', (err) => {
      // whatsapp-web.js/Puppeteer occasionally rejects background promises we
      // don't hold a reference to; don't let that crash the process.
      require('../lib/logger').logger.error({ err }, 'unhandled_rejection');
    });
  }

  async initialize() {
    await this.client.initialize();
  }

  getConnectionState() {
    return this.connectionState;
  }

  async getContacts(search = '') {
    if (this.connectionState !== 'ready') throw new TransportNotReadyError();
    const needle = (search || '').toLowerCase().trim();
    const contacts = await this.client.getContacts();
    return contacts
      .filter((c) => !c.isGroup && c.isMyContact && c.number)
      .map((c) => ({ id: c.id._serialized, name: c.name || c.pushname || c.number, number: c.number }))
      .filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.number.includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getChats(search = '') {
    if (this.connectionState !== 'ready') throw new TransportNotReadyError();
    const needle = (search || '').toLowerCase().trim();

    // whatsapp-web.js's own client.getChats() awaits a live groupMetadata refresh for
    // every group chat in parallel (Promise.all, no per-chat isolation) — one broken/left
    // group throws and takes the whole list down with an opaque minified error. This does
    // the same base serialization without that fragile refresh, and skips any chat that
    // still fails to serialize instead of failing the entire request.
    const chats = await this.client.pupPage.evaluate(() => {
      const models = window.require('WAWebCollections').Chat.getModelsArray();
      const out = [];
      for (const chat of models) {
        try {
          const data = chat.serialize();
          out.push({
            id: data.id._serialized,
            name: chat.formattedTitle || data.name || (data.id && data.id.user) || '',
            isGroup: !!chat.groupMetadata,
            unreadCount: data.unreadCount || 0,
            timestamp: data.t || 0,
            lastMessage: data.lastMessage
              ? {
                  body: data.lastMessage.body || '',
                  timestamp: data.lastMessage.t || 0,
                  fromMe: !!(data.lastMessage.id && data.lastMessage.id.fromMe)
                }
              : null
          });
        } catch {
          // skip chats that fail to serialize rather than failing the whole list
        }
      }
      return out;
    });

    return chats
      .filter((c) => !needle || c.name.toLowerCase().includes(needle))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 100);
  }

  async getChatMessages(chatId) {
    if (this.connectionState !== 'ready') throw new TransportNotReadyError();

    // client.getChatById() builds a full "chat model" that also tries to resolve
    // lastMessage through the same fragile serializer that breaks getChats() above —
    // it throws for plenty of ordinary 1:1 chats too, not just groups. Bypassing it:
    // fetch the raw chat (getAsModel: false, same path whatsapp-web.js's own
    // chat.fetchMessages() uses internally) and serialize each message individually
    // so one bad message can't take out the whole thread.
    const messages = await this.client.pupPage.evaluate(async (id) => {
      const chat = await window.WWebJS.getChat(id, { getAsModel: false });
      if (!chat) return null;
      const models = chat.msgs.getModelsArray().filter((m) => !m.isNotification).slice(-50);
      const out = [];
      for (const m of models) {
        try {
          out.push(window.WWebJS.getMessageModel(m));
        } catch {
          // skip messages that fail to serialize rather than failing the whole thread
        }
      }
      return out;
    }, chatId);

    if (messages === null) return null;

    this.client.pupPage.evaluate((id) => window.WWebJS.sendSeen(id), chatId).catch(() => {});

    return messages.map((m) => ({
      id: m.id._serialized,
      body: m.body,
      fromMe: m.id.fromMe,
      author: m.author || null,
      timestamp: m.t,
      hasMedia: !!m.directPath
    }));
  }

  async sendChatMessage(chatId, message) {
    if (this.connectionState !== 'ready') throw new TransportNotReadyError();
    await this.client.sendMessage(chatId, message);
  }

  async sendToNumbers(numbers, message, delaySeconds = 0) {
    if (this.connectionState !== 'ready') throw new TransportNotReadyError();
    const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
    const results = [];
    for (const raw of numbers) {
      const digits = String(raw).replace(/[^\d]/g, '');
      try {
        const numberId = await this.client.getNumberId(digits);
        if (!numberId) {
          results.push({ number: raw, status: 'not_on_whatsapp' });
        } else {
          await this.client.sendMessage(numberId._serialized, message);
          results.push({ number: raw, status: 'sent' });
        }
      } catch (err) {
        results.push({ number: raw, status: 'error', detail: err.message });
      }
      if (delayMs) await sleep(delayMs);
    }
    return results;
  }

  async sendToGroups(groupIds, message, delaySeconds = 0) {
    if (this.connectionState !== 'ready') throw new TransportNotReadyError();
    const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
    const results = [];
    // Group IDs are already valid WhatsApp chat IDs (xxxx@g.us) straight from the chat
    // list, so — unlike sendToNumbers — there's no getNumberId() phone-number lookup needed.
    for (const groupId of groupIds) {
      try {
        await this.client.sendMessage(groupId, message);
        results.push({ id: groupId, status: 'sent' });
      } catch (err) {
        results.push({ id: groupId, status: 'error', detail: err.message });
      }
      if (delayMs) await sleep(delayMs);
    }
    return results;
  }

  async disconnect() {
    await this.client.logout();
    this._setState('disconnected', { reason: 'Disconnected by user' });
  }

  async shutdown() {
    // destroy() closes Chromium cleanly WITHOUT invalidating LocalAuth — a
    // process restart should reconnect without a fresh QR scan.
    await this.client.destroy().catch(() => {});
  }

  async healthCheck() {
    return { ok: this.connectionState === 'ready', detail: this.connectionState };
  }
}

class TransportNotReadyError extends Error {
  constructor() {
    super('WhatsApp is not connected yet');
    this.name = 'TransportNotReadyError';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = WhatsAppWebTransport;
module.exports.TransportNotReadyError = TransportNotReadyError;
