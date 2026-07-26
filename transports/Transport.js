const { EventEmitter } = require('node:events');

/**
 * Messaging transport interface. Application/route code depends only on
 * this contract, never on `whatsapp-web.js` directly — that's what lets
 * MockTransport stand in for real WhatsApp during tests/benchmarks/dev.
 *
 * Emits:
 *   'state'       { state: 'initializing'|'qr'|'authenticated'|'ready'|'disconnected', qr?: string, reason?: string }
 *   'incoming'    { from: string, body: string, timestamp: number }
 *   'chatMessage' { chatId, id, body, fromMe, author, timestamp, hasMedia }
 *
 * All methods return Promises and reject with a plain Error on failure;
 * callers (routes) are responsible for translating that into an AppError.
 */
class Transport extends EventEmitter {
  async initialize() {
    throw new Error('not implemented');
  }

  getConnectionState() {
    throw new Error('not implemented');
  }

  /** Snapshot sent to a newly-connected, already-authenticated socket. */
  getSnapshot() {
    return { state: this.getConnectionState(), qr: this.lastQrDataUrl || null };
  }

  async getContacts(_search) {
    throw new Error('not implemented');
  }

  async getChats(_search) {
    throw new Error('not implemented');
  }

  /** @returns {Promise<Array|null>} null means "chat not found" */
  async getChatMessages(_chatId) {
    throw new Error('not implemented');
  }

  async sendChatMessage(_chatId, _message) {
    throw new Error('not implemented');
  }

  async sendToNumbers(_numbers, _message, _delaySeconds) {
    throw new Error('not implemented');
  }

  async sendToGroups(_groupIds, _message, _delaySeconds) {
    throw new Error('not implemented');
  }

  /** User-requested logout: invalidates the session, requires a fresh QR next time. */
  async disconnect() {
    throw new Error('not implemented');
  }

  /** Clean process-exit close: closes Chromium (if any) WITHOUT touching LocalAuth. */
  async shutdown() {
    throw new Error('not implemented');
  }

  async healthCheck() {
    throw new Error('not implemented');
  }
}

module.exports = Transport;
