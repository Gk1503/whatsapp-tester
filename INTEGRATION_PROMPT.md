# Build Prompt: WhatsApp Web Tester Module

Copy everything below the line into a prompt for an AI coding assistant (or follow it manually) to add this exact feature to another Node.js project. It is self-contained and includes full working code.

---

## PROMPT START

Build a self-hosted "WhatsApp Tester" web dashboard inside this project. It lets a developer log in to WhatsApp Web via QR code, browse their phone's contacts, send a message (optionally to multiple numbers with a delay between sends), bulk-send personalized messages from an uploaded Excel/CSV sheet (one row per recipient, each row can carry its own message), and watch a live feed of incoming messages — all from a browser tab, useful for testing WhatsApp bot/automation flows.

### Tech stack

- Node.js + Express for the HTTP server and REST API
- `whatsapp-web.js` (drives a real WhatsApp Web session via Puppeteer/Chromium) for the WhatsApp connection
- `qrcode` to render the login QR as a data URL
- `socket.io` for pushing connection-state, QR, and incoming-message events to the browser in real time
- Plain HTML/CSS/vanilla JS on the frontend (no build step, no framework)

### Dependencies

```json
{
  "dependencies": {
    "express": "^4.19.2",
    "socket.io": "^4.7.5",
    "whatsapp-web.js": "^1.26.0",
    "qrcode": "^1.5.3",
    "multer": "^2.2.0",
    "xlsx": "^0.18.5"
  }
}
```

Install with: `npm install express socket.io whatsapp-web.js qrcode multer xlsx`

`multer` handles the spreadsheet file upload (in-memory, no temp files on disk); `xlsx` (SheetJS) parses `.xlsx`, `.xls`, and `.csv` into JSON rows. Note: the `xlsx` npm package has known audit advisories (prototype pollution / ReDoS on maliciously crafted files) with no patched release on the npm registry as of writing — acceptable for an internal tool where only trusted users upload their own files, but don't expose the upload endpoint publicly without additional validation.

`whatsapp-web.js` pulls in Puppeteer, which downloads a Chromium binary — first install can take a while and needs ~300MB free.

### File structure to create

```
project-root/
  server.js               <- WhatsApp client + Express API + Socket.IO
  session/                <- auto-created by LocalAuth, gitignore this
  public/
    index.html
    app.js
    style.css
```

Add to `.gitignore`: `node_modules/`, `session/`, `.wwebjs_cache/`, `.wwebjs_auth/`

### Behavior / state machine

The WhatsApp client goes through these states, broadcast to all connected browser tabs over Socket.IO as `{ state, qr, reason }`:

`initializing -> qr -> authenticated -> ready` (or `disconnected` at any point, with a human-readable `reason`).

- `initializing`: client is launching Chromium.
- `qr`: a QR code is available (base64 PNG data URL) and needs to be scanned in WhatsApp's phone app under Linked Devices.
- `authenticated`: QR was scanned, session is being established.
- `ready`: WhatsApp session is fully live — contacts/messages can now be used. **Important gotcha**: `whatsapp-web.js` fires its `ready` event slightly before its internal store finishes hydrating; calling `getContacts()`/`getChats()` immediately after `ready` can hang or time out. Delay exposing the "ready" state to the frontend by ~5 seconds after the event fires.
- `disconnected`: session ended (logged out remotely, auth failure, etc). A full restart is required to get a fresh QR — there's no in-place reconnect flow in this minimal version.

Session credentials persist to disk via `LocalAuth` (`whatsapp-web.js`'s built-in auth strategy) at `./session`, so restarting the server does not require re-scanning the QR unless the session was invalidated.

### Bulk send from Excel/CSV

A third tab, "Bulk (Excel)", lets the user upload a spreadsheet with one row per recipient and send each row a personalized message in one go:

- The sheet needs at minimum a **Number** column; **Name** and **Message** columns are optional per row. Header matching is case/spacing-insensitive and recognizes common synonyms (`Phone`, `Mobile`, `Contact Number`, `Msg`, `Text`, etc.) so the user doesn't need exact column names.
- The file is uploaded via `multipart/form-data` to `POST /api/parse-sheet`, parsed server-side with `xlsx`, and returned as normalized `{ name, number, message }` rows — numbers are stripped down to digits only (handles `+`, spaces, dashes).
- The browser renders an editable preview table (each row removable) before anything is sent.
- Rows with no `Message` value fall back to a shared "fallback message" textarea. If a row has neither, sending is blocked with a validation message.
- `POST /api/send-bulk` takes `{ rows, defaultMessage, delaySeconds }` and loops through rows exactly like the single-message send path, applying the same per-row delay, `getNumberId` existence check, and per-row status (`sent` / `not_on_whatsapp` / `error` / `skipped`).

### `server.js` (full implementation)

```js
const express = require('express');
const http = require('http');
const path = require('path');
const qrcode = require('qrcode');
const multer = require('multer');
const XLSX = require('xlsx');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3000;

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
  // hydrating; calling getContacts()/getChats() immediately hangs and times out.
  // A short delay before exposing the app avoids the race.
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

app.post('/api/parse-sheet', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

    const rows = rawRows
      .map((row) => ({
        name: pickField(row, NAME_KEYS),
        number: pickField(row, NUMBER_KEYS).replace(/[^\d]/g, ''),
        message: pickField(row, MESSAGE_KEYS)
      }))
      .filter((row) => row.number);

    if (rows.length === 0) {
      return res.status(400).json({
        error: 'No usable rows found. Make sure the sheet has Name, Number and Message columns.'
      });
    }

    res.json({ rows });
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
    const message = String(row.message || defaultMessage || '').trim();
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

client.initialize();

server.listen(PORT, () => {
  console.log(`WhatsApp tester running at http://localhost:${PORT}`);
});
```

### `public/index.html` (full implementation)

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>WA Tester</title>
<link rel="stylesheet" href="style.css" />
</head>
<body>

<div class="shell">

  <!-- Sidebar -->
  <aside class="sidebar">
    <div class="brand">
      <span class="brand-mark">WA</span>
      <span class="brand-name">Tester</span>
    </div>

    <div class="signal" id="signal">
      <div class="signal-rings"><div class="signal-dot"></div></div>
      <div class="signal-text">
        <div class="signal-label" id="stateLabel">Starting…</div>
        <div class="signal-sub" id="stateSub">–</div>
      </div>
    </div>

    <nav class="nav" id="nav">
      <button class="nav-item active" data-tab="contacts">Contacts</button>
      <button class="nav-item" data-tab="compose">Send message</button>
      <button class="nav-item" data-tab="bulk">Bulk (Excel)</button>
      <button class="nav-item" data-tab="log">Live log</button>
    </nav>
  </aside>

  <!-- Main -->
  <main class="main">

    <!-- QR / connect screen -->
    <section id="connectScreen" class="connect-screen">
      <div class="connect-card">
        <h1>Connect WhatsApp</h1>
        <p class="muted">Open WhatsApp on your phone → Linked Devices → Link a device, then scan.</p>
        <div class="qr-box" id="qrBox">
          <div class="qr-placeholder" id="qrPlaceholder">Waiting for QR code…</div>
          <img id="qrImage" alt="WhatsApp QR code" style="display:none" />
        </div>
        <div class="muted small" id="connectHint">This can take a few seconds on first start.</div>
      </div>
    </section>

    <!-- App screens (shown once connected) -->
    <section id="appScreens" class="app-screens" style="display:none">

      <div class="tab-panel active" data-panel="contacts">
        <div class="panel-header">
          <h2>Contacts</h2>
          <input type="text" id="contactSearch" placeholder="Search name or number…" />
        </div>
        <div class="contact-list" id="contactList"></div>
      </div>

      <div class="tab-panel" data-panel="compose">
        <div class="panel-header">
          <h2>Send message</h2>
        </div>

        <div class="compose-grid">
          <div class="field">
            <label>Recipients</label>
            <div class="chips" id="chips"></div>
            <div class="add-number-row">
              <input type="text" id="manualNumber" placeholder="Add number with country code, e.g. 91987xxxxxxx" />
              <button id="addNumberBtn" class="btn-ghost">Add</button>
            </div>
            <div class="hint">Tip: click contacts on the left to add them here too.</div>
          </div>

          <div class="field">
            <label>Message</label>
            <textarea id="messageBox" rows="6" placeholder="Type your message…"></textarea>
          </div>

          <div class="field inline">
            <label>Delay between sends</label>
            <input type="number" id="delaySeconds" value="2" min="0" style="width:80px" />
            <span class="hint">seconds (keeps sending human-paced)</span>
          </div>

          <button id="sendBtn" class="btn-primary">Send</button>

          <div class="results" id="sendResults"></div>
        </div>
      </div>

      <div class="tab-panel" data-panel="bulk">
        <div class="panel-header">
          <h2>Bulk send from Excel/CSV</h2>
        </div>

        <div class="compose-grid">
          <div class="field">
            <label>Spreadsheet</label>
            <div class="add-number-row">
              <input type="file" id="sheetFile" accept=".xlsx,.xls,.csv" />
              <button id="uploadSheetBtn" class="btn-ghost">Upload &amp; preview</button>
            </div>
            <div class="hint">
              Columns: <strong>Name</strong>, <strong>Number</strong> (with country code), <strong>Message</strong> — one row per recipient, each row can have its own message.
            </div>
          </div>

          <div class="field">
            <label>Fallback message</label>
            <textarea id="bulkDefaultMessage" rows="3" placeholder="Used for rows that have no Message column value…"></textarea>
          </div>

          <div class="field inline">
            <label>Delay between sends</label>
            <input type="number" id="bulkDelaySeconds" value="2" min="0" style="width:80px" />
            <span class="hint">seconds (keeps sending human-paced)</span>
          </div>

          <div class="field" id="bulkPreviewField" style="display:none">
            <label>Preview (<span id="bulkRowCount">0</span> recipients)</label>
            <div class="bulk-table-wrap">
              <table class="bulk-table" id="bulkTable">
                <thead>
                  <tr><th>Name</th><th>Number</th><th>Message</th><th></th></tr>
                </thead>
                <tbody id="bulkTableBody"></tbody>
              </table>
            </div>
          </div>

          <button id="bulkSendBtn" class="btn-primary" disabled>Send to all</button>

          <div class="results" id="bulkResults"></div>
        </div>
      </div>

      <div class="tab-panel" data-panel="log">
        <div class="panel-header">
          <h2>Live incoming log</h2>
        </div>
        <div class="log-list" id="logList">
          <div class="muted">Incoming messages will appear here while this page is open.</div>
        </div>
      </div>

    </section>

  </main>
</div>

<script src="/socket.io/socket.io.js"></script>
<script src="app.js"></script>
</body>
</html>
```

### `public/app.js` (full implementation)

```js
const socket = io();

// ---------- Elements ----------
const signalEl = document.getElementById('signal');
const stateLabel = document.getElementById('stateLabel');
const stateSub = document.getElementById('stateSub');
const connectScreen = document.getElementById('connectScreen');
const appScreens = document.getElementById('appScreens');
const qrImage = document.getElementById('qrImage');
const qrPlaceholder = document.getElementById('qrPlaceholder');

const nav = document.getElementById('nav');
const panels = document.querySelectorAll('.tab-panel');

const contactSearch = document.getElementById('contactSearch');
const contactList = document.getElementById('contactList');

const chipsEl = document.getElementById('chips');
const manualNumber = document.getElementById('manualNumber');
const addNumberBtn = document.getElementById('addNumberBtn');
const messageBox = document.getElementById('messageBox');
const delaySeconds = document.getElementById('delaySeconds');
const sendBtn = document.getElementById('sendBtn');
const sendResults = document.getElementById('sendResults');

const logList = document.getElementById('logList');

const sheetFile = document.getElementById('sheetFile');
const uploadSheetBtn = document.getElementById('uploadSheetBtn');
const bulkDefaultMessage = document.getElementById('bulkDefaultMessage');
const bulkDelaySeconds = document.getElementById('bulkDelaySeconds');
const bulkPreviewField = document.getElementById('bulkPreviewField');
const bulkRowCount = document.getElementById('bulkRowCount');
const bulkTableBody = document.getElementById('bulkTableBody');
const bulkSendBtn = document.getElementById('bulkSendBtn');
const bulkResults = document.getElementById('bulkResults');

let bulkRows = []; // [{ name, number, message }]

let recipients = new Map(); // number -> label

// ---------- Connection state ----------

const STATE_TEXT = {
  initializing: ['Starting…', 'launching client'],
  qr: ['Scan to connect', 'waiting for scan'],
  authenticated: ['Authenticating…', 'almost there'],
  ready: ['Connected', 'live'],
  disconnected: ['Disconnected', 'restart the app']
};

socket.on('state', ({ state, qr, reason }) => {
  signalEl.dataset.state = state;
  const [label, sub] = STATE_TEXT[state] || [state, ''];
  stateLabel.textContent = label;
  stateSub.textContent = reason || sub;

  if (state === 'ready') {
    connectScreen.style.display = 'none';
    appScreens.style.display = 'block';
    loadContacts();
  } else {
    connectScreen.style.display = 'flex';
    appScreens.style.display = 'none';

    if (qr) {
      qrImage.src = qr;
      qrImage.style.display = 'block';
      qrPlaceholder.style.display = 'none';
    } else {
      qrImage.style.display = 'none';
      qrPlaceholder.style.display = 'block';
      qrPlaceholder.textContent =
        state === 'disconnected' ? 'Disconnected — restart the server to get a new QR.' : 'Waiting for QR code…';
    }
  }
});

// ---------- Tabs ----------

nav.addEventListener('click', (e) => {
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  const tab = btn.dataset.tab;

  nav.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b === btn));
  panels.forEach((p) => p.classList.toggle('active', p.dataset.panel === tab));
});

// ---------- Contacts ----------

async function loadContacts(search = '') {
  contactList.innerHTML = '<div class="muted" style="padding:16px">Loading…</div>';
  try {
    const res = await fetch(`/api/contacts?search=${encodeURIComponent(search)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load contacts');

    if (data.length === 0) {
      contactList.innerHTML = '<div class="muted" style="padding:16px">No contacts found.</div>';
      return;
    }

    contactList.innerHTML = '';
    data.forEach((c) => {
      const row = document.createElement('div');
      row.className = 'contact-row';
      row.innerHTML = `
        <span class="contact-name">${escapeHtml(c.name)}</span>
        <span class="contact-number">${escapeHtml(c.number)}</span>
      `;
      row.addEventListener('click', () => {
        addRecipient(c.number, c.name);
        // jump to compose tab so the click feels immediate
        document.querySelector('.nav-item[data-tab="compose"]').click();
      });
      contactList.appendChild(row);
    });
  } catch (err) {
    contactList.innerHTML = `<div class="muted" style="padding:16px">${escapeHtml(err.message)}</div>`;
  }
}

let searchTimer;
contactSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => loadContacts(contactSearch.value), 250);
});

// ---------- Recipients / chips ----------

function addRecipient(number, label) {
  const digits = number.replace(/[^\d]/g, '');
  if (!digits || recipients.has(digits)) return;
  recipients.set(digits, label || digits);
  renderChips();
}

function removeRecipient(digits) {
  recipients.delete(digits);
  renderChips();
}

function renderChips() {
  chipsEl.innerHTML = '';
  recipients.forEach((label, digits) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(label)} <button aria-label="Remove">×</button>`;
    chip.querySelector('button').addEventListener('click', () => removeRecipient(digits));
    chipsEl.appendChild(chip);
  });
}

addNumberBtn.addEventListener('click', () => {
  const val = manualNumber.value.trim();
  if (val) {
    addRecipient(val, val);
    manualNumber.value = '';
  }
});

manualNumber.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addNumberBtn.click();
});

// ---------- Send ----------

sendBtn.addEventListener('click', async () => {
  const numbers = Array.from(recipients.keys());
  const message = messageBox.value.trim();

  if (numbers.length === 0 || !message) {
    sendResults.innerHTML = '<div class="result-row error">Add at least one recipient and a message.</div>';
    return;
  }

  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending…';
  sendResults.innerHTML = '';

  try {
    const res = await fetch('/api/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ numbers, message, delaySeconds: Number(delaySeconds.value) || 0 })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed');

    sendResults.innerHTML = data.results
      .map(
        (r) =>
          `<div class="result-row ${r.status}">${escapeHtml(r.number)} — ${r.status.replace(/_/g, ' ')}</div>`
      )
      .join('');
  } catch (err) {
    sendResults.innerHTML = `<div class="result-row error">${escapeHtml(err.message)}</div>`;
  } finally {
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
  }
});

// ---------- Bulk send (Excel/CSV) ----------

uploadSheetBtn.addEventListener('click', async () => {
  const file = sheetFile.files[0];
  if (!file) {
    bulkResults.innerHTML = '<div class="result-row error">Choose a .xlsx, .xls or .csv file first.</div>';
    return;
  }

  uploadSheetBtn.disabled = true;
  uploadSheetBtn.textContent = 'Reading…';
  bulkResults.innerHTML = '';

  try {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/parse-sheet', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not read that file');

    bulkRows = data.rows;
    renderBulkTable();
  } catch (err) {
    bulkRows = [];
    renderBulkTable();
    bulkResults.innerHTML = `<div class="result-row error">${escapeHtml(err.message)}</div>`;
  } finally {
    uploadSheetBtn.disabled = false;
    uploadSheetBtn.textContent = 'Upload & preview';
  }
});

function renderBulkTable() {
  bulkRowCount.textContent = bulkRows.length;
  bulkPreviewField.style.display = bulkRows.length ? 'block' : 'none';
  bulkSendBtn.disabled = bulkRows.length === 0;

  bulkTableBody.innerHTML = '';
  bulkRows.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(row.name || '—')}</td>
      <td class="mono">${escapeHtml(row.number)}</td>
      <td>${escapeHtml(row.message || '(uses fallback message)')}</td>
      <td><button class="btn-ghost" data-i="${i}" aria-label="Remove row">×</button></td>
    `;
    tr.querySelector('button').addEventListener('click', () => {
      bulkRows.splice(i, 1);
      renderBulkTable();
    });
    bulkTableBody.appendChild(tr);
  });
}

bulkSendBtn.addEventListener('click', async () => {
  if (bulkRows.length === 0) return;

  const defaultMessage = bulkDefaultMessage.value.trim();
  const missingMessage = bulkRows.some((r) => !r.message && !defaultMessage);
  if (missingMessage) {
    bulkResults.innerHTML =
      '<div class="result-row error">Some rows have no Message value — fill a fallback message or add one to every row.</div>';
    return;
  }

  bulkSendBtn.disabled = true;
  bulkSendBtn.textContent = 'Sending…';
  bulkResults.innerHTML = '';

  try {
    const res = await fetch('/api/send-bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        rows: bulkRows,
        defaultMessage,
        delaySeconds: Number(bulkDelaySeconds.value) || 0
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed');

    bulkResults.innerHTML = data.results
      .map(
        (r) =>
          `<div class="result-row ${r.status}">${escapeHtml(r.name || r.number)} (${escapeHtml(r.number || '')}) — ${r.status.replace(/_/g, ' ')}</div>`
      )
      .join('');
  } catch (err) {
    bulkResults.innerHTML = `<div class="result-row error">${escapeHtml(err.message)}</div>`;
  } finally {
    bulkSendBtn.disabled = false;
    bulkSendBtn.textContent = 'Send to all';
  }
});

// ---------- Live log ----------

socket.on('incoming', ({ from, body, timestamp }) => {
  const empty = logList.querySelector('.muted');
  if (empty) empty.remove();

  const row = document.createElement('div');
  row.className = 'log-row';
  const time = new Date(timestamp * 1000).toLocaleTimeString();
  row.innerHTML = `<div class="log-from">${escapeHtml(from)} · ${time}</div><div>${escapeHtml(body)}</div>`;
  logList.prepend(row);
});

// ---------- Utils ----------

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
```

### `public/style.css` (full implementation)

```css
:root {
  --ink: #14181C;
  --ink-soft: #232A31;
  --canvas: #F7F7F4;
  --panel: #FFFFFF;
  --border: #E7E5DE;
  --text: #1B1E20;
  --muted: #6B7280;
  --accent: #1F9D55;
  --accent-soft: #E4F6EA;
  --amber: #B45309;
  --amber-soft: #FDF1DE;
  --danger: #C0362C;
  --danger-soft: #FBEAE8;

  --font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: var(--font-ui);
  color: var(--text);
  background: var(--canvas);
}

.shell {
  display: flex;
  min-height: 100vh;
}

/* ---------- Sidebar ---------- */

.sidebar {
  width: 260px;
  flex-shrink: 0;
  background: var(--ink);
  color: #E7E9EA;
  display: flex;
  flex-direction: column;
  padding: 24px 20px;
  gap: 28px;
}

.brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
}

.brand-mark {
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 15px;
  background: var(--accent);
  color: #08150C;
  padding: 3px 7px;
  border-radius: 4px;
  letter-spacing: 0.5px;
}

.brand-name {
  font-size: 15px;
  color: #9CA3AF;
}

.signal {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px;
  border-radius: 10px;
  background: rgba(255,255,255,0.04);
}

.signal-rings {
  position: relative;
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.signal-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--muted);
  transition: background 0.3s ease;
}

.signal-rings::before,
.signal-rings::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1.5px solid var(--muted);
  opacity: 0;
}

.signal[data-state="qr"] .signal-dot { background: var(--amber); }
.signal[data-state="authenticated"] .signal-dot { background: var(--amber); }
.signal[data-state="disconnected"] .signal-dot { background: var(--danger); }

.signal[data-state="ready"] .signal-dot { background: var(--accent); }
.signal[data-state="ready"] .signal-rings::before,
.signal[data-state="ready"] .signal-rings::after {
  border-color: var(--accent);
  animation: pulse-ring 2.2s ease-out infinite;
}
.signal[data-state="ready"] .signal-rings::after { animation-delay: 1.1s; }

@keyframes pulse-ring {
  0%   { transform: scale(0.5); opacity: 0.6; }
  100% { transform: scale(1.6); opacity: 0; }
}

.signal-label {
  font-size: 13px;
  font-weight: 600;
}

.signal-sub {
  font-size: 11px;
  color: #8B9198;
  font-family: var(--font-mono);
}

.nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.nav-item {
  text-align: left;
  background: none;
  border: none;
  color: #C6CACD;
  padding: 10px 12px;
  border-radius: 8px;
  font-size: 14px;
  cursor: pointer;
}

.nav-item:hover { background: rgba(255,255,255,0.06); }
.nav-item.active { background: rgba(255,255,255,0.1); color: #fff; font-weight: 600; }

/* ---------- Main ---------- */

.main {
  flex: 1;
  padding: 40px;
  display: flex;
  align-items: flex-start;
  justify-content: center;
}

.connect-screen {
  width: 100%;
  display: flex;
  justify-content: center;
  padding-top: 40px;
}

.connect-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 36px 40px;
  text-align: center;
  max-width: 380px;
}

.connect-card h1 {
  font-size: 20px;
  margin: 0 0 8px;
}

.muted { color: var(--muted); font-size: 14px; }
.muted.small { font-size: 12px; margin-top: 12px; }

.qr-box {
  width: 240px;
  height: 240px;
  margin: 24px auto 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #FAFAF8;
}

.qr-placeholder {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
}

.qr-box img { width: 100%; height: 100%; padding: 12px; }

/* ---------- App screens ---------- */

.app-screens {
  width: 100%;
  max-width: 760px;
}

.tab-panel { display: none; }
.tab-panel.active { display: block; }

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 18px;
}

.panel-header h2 { font-size: 18px; margin: 0; }

.panel-header input {
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  width: 220px;
}

.contact-list {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
}

.contact-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}

.contact-row:last-child { border-bottom: none; }
.contact-row:hover { background: var(--accent-soft); }

.contact-name { font-size: 14px; font-weight: 500; }
.contact-number { font-family: var(--font-mono); font-size: 12px; color: var(--muted); }

/* ---------- Compose ---------- */

.compose-grid {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.field label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  margin-bottom: 8px;
}

.field.inline { display: flex; align-items: center; gap: 10px; }
.field.inline label { margin-bottom: 0; }

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 10px;
  min-height: 20px;
}

.chip {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--accent-soft);
  color: #0B5C2A;
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 999px;
}

.chip button {
  border: none;
  background: none;
  cursor: pointer;
  color: #0B5C2A;
  font-weight: 700;
  line-height: 1;
}

.add-number-row {
  display: flex;
  gap: 8px;
}

.add-number-row input {
  flex: 1;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  font-family: var(--font-mono);
}

textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  font-size: 14px;
  font-family: var(--font-ui);
  resize: vertical;
}

.hint { font-size: 12px; color: var(--muted); margin-top: 6px; }

.btn-primary, .btn-ghost {
  border: none;
  border-radius: 8px;
  padding: 10px 18px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}

.btn-primary {
  background: var(--ink);
  color: #fff;
  align-self: flex-start;
}

.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }

.btn-ghost {
  background: var(--canvas);
  border: 1px solid var(--border);
}

.results { display: flex; flex-direction: column; gap: 6px; }

.result-row {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--canvas);
}

.result-row.sent { background: var(--accent-soft); color: #0B5C2A; }
.result-row.not_on_whatsapp { background: var(--amber-soft); color: var(--amber); }
.result-row.error { background: var(--danger-soft); color: var(--danger); }

/* ---------- Bulk ---------- */

.bulk-table-wrap {
  border: 1px solid var(--border);
  border-radius: 8px;
  max-height: 320px;
  overflow: auto;
}

.bulk-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.bulk-table th {
  position: sticky;
  top: 0;
  text-align: left;
  background: var(--canvas);
  padding: 8px 10px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}

.bulk-table td {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  vertical-align: top;
}

.bulk-table td.mono { font-family: var(--font-mono); }

.bulk-table tr:last-child td { border-bottom: none; }

.bulk-table button {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--danger);
  font-weight: 700;
}

.result-row.skipped { background: var(--amber-soft); color: var(--amber); }

/* ---------- Log ---------- */

.log-list {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 60vh;
  overflow-y: auto;
}

.log-row {
  font-size: 13px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}

.log-row .log-from {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}

@media (max-width: 720px) {
  .shell { flex-direction: column; }
  .sidebar { width: 100%; flex-direction: row; align-items: center; flex-wrap: wrap; }
  .nav { flex-direction: row; }
  .main { padding: 20px; }
}
```

### Integration notes if merging into an existing Express app (instead of a standalone project)

- If the host project already has its own `app`/`server`/`io`, reuse them instead of creating new ones — just add the routes, the `client` setup, and the Socket.IO event wiring shown above onto the existing instances. Mount the static folder and REST routes under a sub-path (e.g. `/wa-tester`) if there's a routing collision risk.
- Only one `whatsapp-web.js` `Client` should exist per Chromium/session — don't instantiate a second one if the host project already drives WhatsApp elsewhere.
- The REST endpoints (`/api/status`, `/api/contacts`, `/api/send`, `/api/parse-sheet`, `/api/send-bulk`) are unauthenticated in this reference implementation. Add auth/session middleware in front of them before exposing this on anything but localhost — anyone who can hit `/api/send` or `/api/send-bulk` can message on behalf of the linked WhatsApp account, and anyone who can hit `/api/parse-sheet` can push arbitrary files through the `xlsx` parser.
- `LocalAuth`'s `dataPath` (`./session`) stores live WhatsApp session credentials — treat it like a secret (gitignore it, don't ship it, don't expose it over the static file server).

### Run it

```bash
npm install
npm start
```

Open `http://localhost:3000`, scan the QR with WhatsApp (phone) → Linked Devices → Link a device. After a few seconds the dashboard unlocks with Contacts / Send message / Live log tabs.

## PROMPT END
