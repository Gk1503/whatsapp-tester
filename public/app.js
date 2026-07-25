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
