const express = require('express');
const http = require('http');
const path = require('path');
const qrcode = require('qrcode');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- WhatsApp client state ----
// initializing -> qr -> authenticated -> ready  (or disconnected at any point)
let connectionState = 'initializing';
let lastQrDataUrl = null;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: './session' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    protocolTimeout: 300000
  }
});

function broadcastState(extra = {}) {
  io.emit('state', { state: connectionState, qr: lastQrDataUrl, ...extra });
}

client.on('qr', async (qr) => {
  connectionState = 'qr';
  lastQrDataUrl = await qrcode.toDataURL(qr);
  broadcastState();
});

client.on('authenticated', () => {
  connectionState = 'authenticated';
  lastQrDataUrl = null;
  broadcastState();
});

client.on('ready', () => {
  // whatsapp-web.js fires 'ready' slightly before its internal store finishes
  // hydrating; calling getContacts()/getChats() immediately hangs and times out
  // (see https://github.com/wwebjs/whatsapp-web.js/issues/127050). A short delay
  // before exposing the app avoids the race.
  setTimeout(() => {
    connectionState = 'ready';
    lastQrDataUrl = null;
    broadcastState();
  }, 5000);
});

client.on('auth_failure', (msg) => {
  connectionState = 'disconnected';
  broadcastState({ reason: `Auth failed: ${msg}` });
});

client.on('disconnected', (reason) => {
  connectionState = 'disconnected';
  broadcastState({ reason });
});

client.on('loading_screen', (percent, message) => {
  console.log(`Loading WhatsApp: ${percent}% - ${message}`);
  broadcastState({ reason: `Syncing… ${percent}% ${message || ''}`.trim() });
});

client.on('change_state', (state) => {
  console.log('change_state:', state);
});

process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection:', err);
});

// Live feed of incoming messages, useful for testing auto-replies later
client.on('message', (msg) => {
  io.emit('incoming', {
    from: msg.from,
    body: msg.body,
    timestamp: msg.timestamp
  });
});

io.on('connection', (socket) => {
  // send current state immediately to any newly-opened browser tab
  socket.emit('state', { state: connectionState, qr: lastQrDataUrl });
});

// ---- REST API ----

app.get('/api/status', (req, res) => {
  res.json({ state: connectionState });
});

app.get('/api/contacts', async (req, res) => {
  if (connectionState !== 'ready') {
    return res.status(409).json({ error: 'WhatsApp is not connected yet' });
  }
  try {
    const search = (req.query.search || '').toLowerCase().trim();
    const contacts = await client.getContacts();

    const result = contacts
      .filter((c) => !c.isGroup && c.isMyContact && c.number)
      .map((c) => ({
        id: c.id._serialized,
        name: c.name || c.pushname || c.number,
        number: c.number
      }))
      .filter(
        (c) => !search || c.name.toLowerCase().includes(search) || c.number.includes(search)
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json(result);
  } catch (err) {
    console.error('contacts error:', err);
    res.status(500).json({ error: 'Failed to load contacts' });
  }
});

app.post('/api/send', async (req, res) => {
  if (connectionState !== 'ready') {
    return res.status(409).json({ error: 'WhatsApp is not connected yet' });
  }

  const { numbers, message, delaySeconds } = req.body;
  if (!Array.isArray(numbers) || numbers.length === 0 || !message) {
    return res.status(400).json({ error: 'numbers[] and message are required' });
  }

  const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
  const results = [];

  for (const raw of numbers) {
    const digits = String(raw).replace(/[^\d]/g, '');
    try {
      const numberId = await client.getNumberId(digits);
      if (!numberId) {
        results.push({ number: raw, status: 'not_on_whatsapp' });
        continue;
      }
      await client.sendMessage(numberId._serialized, message);
      results.push({ number: raw, status: 'sent' });
    } catch (err) {
      results.push({ number: raw, status: 'error', detail: err.message });
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  res.json({ results });
});

client.initialize();

server.listen(PORT, () => {
  console.log(`WhatsApp tester running at http://localhost:${PORT}`);
});
