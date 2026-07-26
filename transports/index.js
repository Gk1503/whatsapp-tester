const config = require('../config');

// Chromium is only ever required when TRANSPORT_MODE=real — dev/test/CI/
// benchmark runs never launch Puppeteer or touch ./session.
function createTransport() {
  if (config.transportMode === 'real') {
    const WhatsAppWebTransport = require('./WhatsAppWebTransport');
    return new WhatsAppWebTransport();
  }
  const MockTransport = require('./MockTransport');
  return new MockTransport({ seed: config.mockSeed });
}

module.exports = { createTransport };
