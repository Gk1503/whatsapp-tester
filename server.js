const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const qrcode = require('qrcode');
const multer = require('multer');
const XLSX = require('xlsx');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 5050;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

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
    runSchedulerTick();
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

// message_create fires for BOTH directions (incoming replies and anything sent,
// including from the linked phone itself), which is what the live chat thread view needs
// to stay in sync the way real WhatsApp Web does.
client.on('message_create', (msg) => {
  if (msg.from === 'status@broadcast' || msg.to === 'status@broadcast') return;
  const chatId = msg.fromMe ? msg.to : msg.from;
  io.emit('chatMessage', {
    chatId,
    id: msg.id._serialized,
    body: msg.body,
    fromMe: msg.fromMe,
    author: msg.author || null,
    timestamp: msg.timestamp,
    hasMedia: msg.hasMedia
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

app.get('/api/chats', async (req, res) => {
  if (connectionState !== 'ready') {
    return res.status(409).json({ error: 'WhatsApp is not connected yet' });
  }
  try {
    const search = (req.query.search || '').toLowerCase().trim();

    // whatsapp-web.js's own client.getChats() awaits a live groupMetadata refresh for
    // every group chat in parallel (Promise.all, no per-chat isolation) — one broken/left
    // group throws and takes the whole list down with an opaque minified error. This does
    // the same base serialization without that fragile refresh, and skips any chat that
    // still fails to serialize instead of failing the entire request.
    const chats = await client.pupPage.evaluate(() => {
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

    const result = chats
      .filter((c) => !search || c.name.toLowerCase().includes(search))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, 100);

    res.json(result);
  } catch (err) {
    console.error('chats error:', err);
    res.status(500).json({ error: 'Failed to load chats' });
  }
});

app.get('/api/chats/:id/messages', async (req, res) => {
  if (connectionState !== 'ready') {
    return res.status(409).json({ error: 'WhatsApp is not connected yet' });
  }
  try {
    const chatId = req.params.id;

    // client.getChatById() builds a full "chat model" that also tries to resolve
    // lastMessage through the same fragile serializer that breaks getChats() (see the
    // /api/chats handler above) — it throws for plenty of ordinary 1:1 chats too, not
    // just groups. Bypassing it: fetch the raw chat (getAsModel: false, same path
    // whatsapp-web.js's own chat.fetchMessages() uses internally) and serialize each
    // message individually so one bad message can't take out the whole thread.
    const messages = await client.pupPage.evaluate(async (id) => {
      const chat = await window.WWebJS.getChat(id, { getAsModel: false });
      if (!chat) return null;

      const models = chat.msgs
        .getModelsArray()
        .filter((m) => !m.isNotification)
        .slice(-50);

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

    if (messages === null) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    client.pupPage
      .evaluate((id) => window.WWebJS.sendSeen(id), chatId)
      .catch(() => {});

    res.json(
      messages.map((m) => ({
        id: m.id._serialized,
        body: m.body,
        fromMe: m.id.fromMe,
        author: m.author || null,
        timestamp: m.t,
        hasMedia: !!m.directPath
      }))
    );
  } catch (err) {
    console.error('chat messages error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

app.post('/api/chats/:id/send', async (req, res) => {
  if (connectionState !== 'ready') {
    return res.status(409).json({ error: 'WhatsApp is not connected yet' });
  }
  const message = String(req.body.message || '').trim();
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }
  try {
    await client.sendMessage(req.params.id, message);
    res.json({ ok: true });
  } catch (err) {
    console.error('chat send error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.post('/api/send-groups', async (req, res) => {
  if (connectionState !== 'ready') {
    return res.status(409).json({ error: 'WhatsApp is not connected yet' });
  }

  const { groupIds, message, delaySeconds } = req.body;
  if (!Array.isArray(groupIds) || groupIds.length === 0 || !message) {
    return res.status(400).json({ error: 'groupIds[] and message are required' });
  }

  const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
  const results = [];

  // Group IDs are already valid WhatsApp chat IDs (xxxx@g.us) straight from the chat
  // list, so — unlike /api/send — there's no getNumberId() phone-number lookup needed.
  for (const groupId of groupIds) {
    try {
      await client.sendMessage(groupId, message);
      results.push({ id: groupId, status: 'sent' });
    } catch (err) {
      results.push({ id: groupId, status: 'error', detail: err.message });
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  res.json({ results });
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

// ---- Bulk send from spreadsheet (Excel/CSV) ----

const NAME_KEYS = ['name', 'contactname', 'fullname', 'contact'];
const NUMBER_KEYS = ['number', 'phone', 'mobile', 'phonenumber', 'contactnumber', 'whatsapp', 'whatsappnumber'];
const MESSAGE_KEYS = ['message', 'msg', 'text', 'content'];

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function pickField(row, candidateKeys) {
  const normalizedEntries = Object.keys(row).map((k) => [normalizeKey(k), row[k]]);
  for (const candidate of candidateKeys) {
    const hit = normalizedEntries.find(([k]) => k === candidate);
    if (hit && String(hit[1]).trim()) return String(hit[1]).trim();
  }
  return '';
}

// Resolves {ColumnName} placeholders in a template against a row's raw spreadsheet
// columns (case/whitespace-insensitive match on the header). Unrecognized placeholders
// are left as-is so a typo shows up in the preview instead of silently vanishing.
function resolveTemplate(template, data) {
  if (!template) return '';
  return String(template).replace(/\{([^{}]+)\}/g, (match, key) => {
    const target = key.trim().toLowerCase();
    const foundKey = Object.keys(data || {}).find((k) => k.trim().toLowerCase() === target);
    return foundKey !== undefined ? String(data[foundKey] ?? '') : match;
  });
}

app.post('/api/parse-sheet', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

    const fieldSet = new Set();
    rawRows.forEach((row) => Object.keys(row).forEach((k) => fieldSet.add(k)));

    const rows = rawRows
      .map((row) => ({
        name: pickField(row, NAME_KEYS),
        number: pickField(row, NUMBER_KEYS).replace(/[^\d]/g, ''),
        message: pickField(row, MESSAGE_KEYS),
        data: row
      }))
      .filter((row) => row.number);

    if (rows.length === 0) {
      return res.status(400).json({
        error: 'No usable rows found. Make sure the sheet has Name, Number and Message columns.'
      });
    }

    res.json({ rows, fields: Array.from(fieldSet) });
  } catch (err) {
    console.error('parse-sheet error:', err);
    res.status(400).json({ error: 'Could not read that file. Use a valid .xlsx, .xls or .csv file.' });
  }
});

app.post('/api/send-bulk', async (req, res) => {
  if (connectionState !== 'ready') {
    return res.status(409).json({ error: 'WhatsApp is not connected yet' });
  }

  const { rows, delaySeconds, defaultMessage } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows[] is required' });
  }

  const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
  const results = [];

  for (const row of rows) {
    const digits = String(row.number || '').replace(/[^\d]/g, '');
    const template = String(row.message || defaultMessage || '').trim();
    const message = resolveTemplate(template, row.data || {}).trim();
    const label = row.name || digits;

    if (!digits || !message) {
      results.push({ number: row.number, name: label, status: 'skipped', detail: 'missing number or message' });
      continue;
    }

    try {
      const numberId = await client.getNumberId(digits);
      if (!numberId) {
        results.push({ number: digits, name: label, status: 'not_on_whatsapp' });
        continue;
      }
      await client.sendMessage(numberId._serialized, message);
      results.push({ number: digits, name: label, status: 'sent' });
    } catch (err) {
      results.push({ number: digits, name: label, status: 'error', detail: err.message });
    }
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }

  res.json({ results });
});

app.post('/api/build-sheet', (req, res) => {
  const { rows, defaultMessage } = req.body;
  if (!Array.isArray(rows) || rows.length === 0) {
    return res.status(400).json({ error: 'rows[] is required' });
  }

  const data = rows.map((r) => {
    const template = (r.message && String(r.message).trim()) || String(defaultMessage || '').trim();
    return {
      Name: r.name || '',
      Number: r.number || '',
      Message: resolveTemplate(template, r.data || {}).trim()
    };
  });

  const sheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Messages');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', 'attachment; filename="filled-messages.xlsx"');
  res.send(buffer);
});

// ---- Message scheduler ----
// A schedule fires at `runAt`. If `repeat` is set, after firing it computes the
// next `runAt` by stepping forward until it's in the future again (this collapses
// any occurrences missed while the server was down into a single catch-up send,
// instead of firing a burst of backlogged sends).

const SCHEDULES_FILE = path.join(__dirname, 'schedules.json');
const REPEAT_UNIT_MS = { minutes: 60 * 1000, hours: 60 * 60 * 1000, days: 24 * 60 * 60 * 1000, weeks: 7 * 24 * 60 * 60 * 1000 };

function loadSchedules() {
  try {
    return JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
  } catch {
    return [];
  }
}

let schedules = loadSchedules();

function saveSchedules() {
  fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(schedules, null, 2));
}

function broadcastSchedule(schedule) {
  io.emit('scheduleUpdate', schedule);
}

function repeatStepMs(repeat) {
  const unitMs = REPEAT_UNIT_MS[repeat.everyUnit] || REPEAT_UNIT_MS.minutes;
  return unitMs * Math.max(1, Number(repeat.everyValue) || 1);
}

app.get('/api/schedules', (req, res) => {
  res.json(schedules);
});

app.post('/api/schedules', (req, res) => {
  const { recipients, message, runAt, repeat, delaySeconds } = req.body;

  if (!Array.isArray(recipients) || recipients.length === 0 || !message) {
    return res.status(400).json({ error: 'recipients[] and message are required' });
  }
  const runAtMs = new Date(runAt).getTime();
  if (!runAt || Number.isNaN(runAtMs)) {
    return res.status(400).json({ error: 'A valid runAt date/time is required' });
  }

  let normalizedRepeat = null;
  if (repeat && repeat.everyValue) {
    normalizedRepeat = {
      everyValue: Math.max(1, Number(repeat.everyValue) || 1),
      everyUnit: REPEAT_UNIT_MS[repeat.everyUnit] ? repeat.everyUnit : 'minutes',
      endAt: repeat.endAt ? new Date(repeat.endAt).getTime() : null
    };
  }

  const schedule = {
    id: crypto.randomUUID(),
    recipients: recipients
      .map((r) => ({ number: String(r.number || '').replace(/[^\d]/g, ''), name: r.name || '' }))
      .filter((r) => r.number),
    message: String(message),
    delaySeconds: Math.max(0, Number(delaySeconds) || 0),
    runAt: runAtMs,
    repeat: normalizedRepeat,
    status: 'scheduled',
    lastResult: null,
    createdAt: Date.now()
  };

  if (schedule.recipients.length === 0) {
    return res.status(400).json({ error: 'No valid recipient numbers' });
  }

  schedules.push(schedule);
  saveSchedules();
  broadcastSchedule(schedule);
  res.json(schedule);
});

app.delete('/api/schedules/:id', (req, res) => {
  const index = schedules.findIndex((s) => s.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Not found' });

  schedules.splice(index, 1);
  saveSchedules();
  io.emit('scheduleRemoved', req.params.id);
  res.json({ ok: true });
});

async function fireSchedule(schedule) {
  schedule.status = 'sending';
  broadcastSchedule(schedule);

  const delayMs = schedule.delaySeconds * 1000;
  const results = [];

  for (const r of schedule.recipients) {
    try {
      const numberId = await client.getNumberId(r.number);
      if (!numberId) {
        results.push({ number: r.number, name: r.name, status: 'not_on_whatsapp' });
        continue;
      }
      await client.sendMessage(numberId._serialized, schedule.message);
      results.push({ number: r.number, name: r.name, status: 'sent' });
    } catch (err) {
      results.push({ number: r.number, name: r.name, status: 'error', detail: err.message });
    }
    if (delayMs) await new Promise((r2) => setTimeout(r2, delayMs));
  }

  schedule.lastResult = { ranAt: Date.now(), results };

  if (schedule.repeat) {
    const stepMs = repeatStepMs(schedule.repeat);
    let next = schedule.runAt;
    do {
      next += stepMs;
    } while (next <= Date.now());

    if (schedule.repeat.endAt && next > schedule.repeat.endAt) {
      schedule.status = 'done';
    } else {
      schedule.runAt = next;
      schedule.status = 'scheduled';
    }
  } else {
    schedule.status = 'done';
  }

  saveSchedules();
  broadcastSchedule(schedule);
}

function runSchedulerTick() {
  if (connectionState !== 'ready') return;
  const now = Date.now();
  for (const schedule of schedules) {
    if (schedule.status === 'scheduled' && schedule.runAt <= now) {
      fireSchedule(schedule).catch((err) => console.error('schedule fire error:', err));
    }
  }
}

setInterval(runSchedulerTick, 15000);

client.initialize();

server.listen(PORT, () => {
  console.log(`WhatsApp tester running at http://localhost:${PORT}`);
});
