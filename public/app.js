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

const chatSearch = document.getElementById('chatSearch');
const chatListEl = document.getElementById('chatListEl');
const chatEmptyState = document.getElementById('chatEmptyState');
const chatThread = document.getElementById('chatThread');
const chatHeaderAvatar = document.getElementById('chatHeaderAvatar');
const chatHeaderName = document.getElementById('chatHeaderName');
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

let chatListData = [];
let activeChatId = null;
let activeChatName = '';

// Chats is the default active tab, so its wider layout applies from the start.
appScreens.classList.add('wide-panel');

const sheetFile = document.getElementById('sheetFile');
const uploadSheetBtn = document.getElementById('uploadSheetBtn');
const bulkFieldsPanel = document.getElementById('bulkFieldsPanel');
const bulkFieldsEl = document.getElementById('bulkFieldsEl');
const bulkDefaultMessage = document.getElementById('bulkDefaultMessage');
const bulkDelaySeconds = document.getElementById('bulkDelaySeconds');
const bulkPreviewField = document.getElementById('bulkPreviewField');
const bulkRowCount = document.getElementById('bulkRowCount');
const bulkTableBody = document.getElementById('bulkTableBody');
const bulkSendBtn = document.getElementById('bulkSendBtn');
const downloadSheetBtn = document.getElementById('downloadSheetBtn');
const bulkResults = document.getElementById('bulkResults');

let bulkRows = []; // [{ name, number, message, data }]
let bulkFields = []; // column headers available as {Field} placeholders

// Mirrors resolveTemplate() in server.js — keep both in sync.
function resolveTemplate(template, data) {
  if (!template) return '';
  return String(template).replace(/\{([^{}]+)\}/g, (match, key) => {
    const target = key.trim().toLowerCase();
    const foundKey = Object.keys(data || {}).find((k) => k.trim().toLowerCase() === target);
    return foundKey !== undefined ? String(data[foundKey] ?? '') : match;
  });
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart ?? textarea.value.length;
  const end = textarea.selectionEnd ?? textarea.value.length;
  textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
  const cursor = start + text.length;
  textarea.setSelectionRange(cursor, cursor);
  textarea.focus();
}

const schedChips = document.getElementById('schedChips');
const schedManualNumber = document.getElementById('schedManualNumber');
const schedAddNumberBtn = document.getElementById('schedAddNumberBtn');
const schedMessage = document.getElementById('schedMessage');
const schedDateTime = document.getElementById('schedDateTime');
const schedDelaySeconds = document.getElementById('schedDelaySeconds');
const schedRepeatEnabled = document.getElementById('schedRepeatEnabled');
const repeatRow = document.getElementById('repeatRow');
const schedEveryValue = document.getElementById('schedEveryValue');
const schedEveryUnit = document.getElementById('schedEveryUnit');
const schedRepeatUntil = document.getElementById('schedRepeatUntil');
const scheduleBtn = document.getElementById('scheduleBtn');
const scheduleFormResult = document.getElementById('scheduleFormResult');
const scheduleList = document.getElementById('scheduleList');

let schedRecipients = new Map(); // number -> label
let schedules = []; // local mirror of server schedules

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
    loadChats();
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
  appScreens.classList.toggle('wide-panel', tab === 'chats');
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
    bulkFields = data.fields || [];
    renderBulkFields();
    renderBulkTable();
  } catch (err) {
    bulkRows = [];
    bulkFields = [];
    renderBulkFields();
    renderBulkTable();
    bulkResults.innerHTML = `<div class="result-row error">${escapeHtml(err.message)}</div>`;
  } finally {
    uploadSheetBtn.disabled = false;
    uploadSheetBtn.textContent = 'Upload & preview';
  }
});

function renderBulkFields() {
  if (bulkFields.length === 0) {
    bulkFieldsPanel.style.display = 'none';
    bulkFieldsEl.innerHTML = '';
    return;
  }
  bulkFieldsPanel.style.display = 'block';
  bulkFieldsEl.innerHTML = '';
  bulkFields.forEach((field) => {
    const placeholder = `{${field}}`;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'field-chip';
    chip.textContent = placeholder;
    chip.draggable = true;
    chip.addEventListener('click', () => {
      insertAtCursor(bulkDefaultMessage, placeholder);
      renderBulkTable();
    });
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', placeholder);
      e.dataTransfer.effectAllowed = 'copy';
    });
    bulkFieldsEl.appendChild(chip);
  });
}

// Allows native browser drag-and-drop of a field chip's text/plain payload directly
// into the textarea at the drop caret position (no manual caret math needed).
bulkDefaultMessage.addEventListener('dragover', (e) => e.preventDefault());
bulkDefaultMessage.addEventListener('drop', () => setTimeout(renderBulkTable, 0));

let bulkPreviewTimer;
bulkDefaultMessage.addEventListener('input', () => {
  clearTimeout(bulkPreviewTimer);
  bulkPreviewTimer = setTimeout(renderBulkTable, 150);
});

function renderBulkTable() {
  bulkRowCount.textContent = bulkRows.length;
  bulkPreviewField.style.display = bulkRows.length ? 'block' : 'none';
  bulkSendBtn.disabled = bulkRows.length === 0;
  downloadSheetBtn.disabled = bulkRows.length === 0;

  const defaultMessage = bulkDefaultMessage.value;

  bulkTableBody.innerHTML = '';
  bulkRows.forEach((row, i) => {
    const template = (row.message && row.message.trim()) || defaultMessage;
    const resolved = resolveTemplate(template, row.data || {});
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(row.name || '—')}</td>
      <td class="mono">${escapeHtml(row.number)}</td>
      <td>${escapeHtml(resolved || '(empty — add a message template above)')}</td>
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

downloadSheetBtn.addEventListener('click', async () => {
  if (bulkRows.length === 0) return;

  downloadSheetBtn.disabled = true;
  downloadSheetBtn.textContent = 'Preparing…';
  bulkResults.innerHTML = '';

  try {
    const res = await fetch('/api/build-sheet', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: bulkRows, defaultMessage: bulkDefaultMessage.value.trim() })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Could not build the sheet');
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'filled-messages.xlsx';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    bulkResults.innerHTML = `<div class="result-row error">${escapeHtml(err.message)}</div>`;
  } finally {
    downloadSheetBtn.disabled = bulkRows.length === 0;
    downloadSheetBtn.textContent = 'Download filled sheet (.xlsx)';
  }
});

// ---------- Scheduler ----------

function addSchedRecipient(number, label) {
  const digits = number.replace(/[^\d]/g, '');
  if (!digits || schedRecipients.has(digits)) return;
  schedRecipients.set(digits, label || digits);
  renderSchedChips();
}

function removeSchedRecipient(digits) {
  schedRecipients.delete(digits);
  renderSchedChips();
}

function renderSchedChips() {
  schedChips.innerHTML = '';
  schedRecipients.forEach((label, digits) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(label)} <button aria-label="Remove">×</button>`;
    chip.querySelector('button').addEventListener('click', () => removeSchedRecipient(digits));
    schedChips.appendChild(chip);
  });
}

schedAddNumberBtn.addEventListener('click', () => {
  const val = schedManualNumber.value.trim();
  if (val) {
    addSchedRecipient(val, val);
    schedManualNumber.value = '';
  }
});

schedManualNumber.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') schedAddNumberBtn.click();
});

schedRepeatEnabled.addEventListener('change', () => {
  repeatRow.style.display = schedRepeatEnabled.checked ? 'flex' : 'none';
});

scheduleBtn.addEventListener('click', async () => {
  const recipientList = Array.from(schedRecipients, ([number, name]) => ({ number, name }));
  const message = schedMessage.value.trim();

  if (recipientList.length === 0 || !message || !schedDateTime.value) {
    scheduleFormResult.innerHTML =
      '<div class="result-row error">Add at least one recipient, a message, and a send time.</div>';
    return;
  }

  const payload = {
    recipients: recipientList,
    message,
    runAt: new Date(schedDateTime.value).toISOString(),
    delaySeconds: Number(schedDelaySeconds.value) || 0,
    repeat: schedRepeatEnabled.checked
      ? {
          everyValue: Number(schedEveryValue.value) || 1,
          everyUnit: schedEveryUnit.value,
          endAt: schedRepeatUntil.value ? new Date(schedRepeatUntil.value).toISOString() : null
        }
      : null
  };

  scheduleBtn.disabled = true;
  scheduleFormResult.innerHTML = '';

  try {
    const res = await fetch('/api/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not create schedule');

    schedRecipients = new Map();
    renderSchedChips();
    schedMessage.value = '';
    schedDateTime.value = '';
    schedRepeatEnabled.checked = false;
    repeatRow.style.display = 'none';
    schedRepeatUntil.value = '';
    scheduleFormResult.innerHTML = '<div class="result-row sent">Scheduled.</div>';
  } catch (err) {
    scheduleFormResult.innerHTML = `<div class="result-row error">${escapeHtml(err.message)}</div>`;
  } finally {
    scheduleBtn.disabled = false;
  }
});

async function loadSchedules() {
  try {
    const res = await fetch('/api/schedules');
    schedules = await res.json();
    renderScheduleList();
  } catch (err) {
    // scheduler tab just stays empty if this fails; not critical to the rest of the app
  }
}

function describeRepeat(schedule) {
  if (!schedule.repeat) return 'One-time';
  const until = schedule.repeat.endAt ? ` until ${new Date(schedule.repeat.endAt).toLocaleString()}` : '';
  return `Every ${schedule.repeat.everyValue} ${schedule.repeat.everyUnit}${until}`;
}

function describeLastResult(schedule) {
  if (!schedule.lastResult) return '';
  const sent = schedule.lastResult.results.filter((r) => r.status === 'sent').length;
  const total = schedule.lastResult.results.length;
  return `Last run ${new Date(schedule.lastResult.ranAt).toLocaleString()} — ${sent}/${total} sent`;
}

function renderScheduleList() {
  if (schedules.length === 0) {
    scheduleList.innerHTML = '<div class="muted" style="padding:16px">No scheduled messages yet.</div>';
    return;
  }

  const sorted = [...schedules].sort((a, b) => a.runAt - b.runAt);

  scheduleList.innerHTML = '';
  sorted.forEach((schedule) => {
    const row = document.createElement('div');
    row.className = 'schedule-row';
    const names = schedule.recipients.map((r) => r.name || r.number).join(', ');
    row.innerHTML = `
      <div class="schedule-main">
        <div class="schedule-top">
          <span class="badge badge-${schedule.status}">${schedule.status}</span>
          <span class="schedule-time">${new Date(schedule.runAt).toLocaleString()}</span>
        </div>
        <div class="schedule-recipients">${escapeHtml(names)}</div>
        <div class="schedule-message">${escapeHtml(schedule.message)}</div>
        <div class="hint">${escapeHtml(describeRepeat(schedule))}${schedule.lastResult ? ' · ' + escapeHtml(describeLastResult(schedule)) : ''}</div>
      </div>
      <button class="btn-ghost schedule-cancel" data-id="${schedule.id}">Cancel</button>
    `;
    row.querySelector('.schedule-cancel').addEventListener('click', async () => {
      await fetch(`/api/schedules/${schedule.id}`, { method: 'DELETE' });
    });
    scheduleList.appendChild(row);
  });
}

socket.on('scheduleUpdate', (schedule) => {
  const i = schedules.findIndex((s) => s.id === schedule.id);
  if (i === -1) schedules.push(schedule);
  else schedules[i] = schedule;
  renderScheduleList();
});

socket.on('scheduleRemoved', (id) => {
  schedules = schedules.filter((s) => s.id !== id);
  renderScheduleList();
});

loadSchedules();

// ---------- Chats (live conversations) ----------

const AVATAR_COLORS = ['#1F9D55', '#B45309', '#2563EB', '#C0362C', '#7C3AED', '#0F766E', '#BE185D'];

function initials(name) {
  const parts = String(name).trim().split(/\s+/);
  const chars = parts.length > 1 ? parts[0][0] + parts[1][0] : parts[0].slice(0, 2);
  return chars.toUpperCase();
}

function avatarColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function formatChatTime(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

function formatDayLabel(ts) {
  const d = new Date(ts * 1000);
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' });
}

async function loadChats(search = '') {
  try {
    const res = await fetch(`/api/chats?search=${encodeURIComponent(search)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load chats');
    chatListData = data;
    renderChatList();
  } catch (err) {
    chatListEl.innerHTML = `<div class="muted" style="padding:16px">${escapeHtml(err.message)}</div>`;
  }
}

let chatSearchTimer;
chatSearch.addEventListener('input', () => {
  clearTimeout(chatSearchTimer);
  chatSearchTimer = setTimeout(() => loadChats(chatSearch.value), 250);
});

function renderChatList() {
  if (chatListData.length === 0) {
    chatListEl.innerHTML = '<div class="muted" style="padding:16px">No chats yet.</div>';
    return;
  }

  chatListEl.innerHTML = '';
  chatListData.forEach((chat) => {
    const row = document.createElement('div');
    row.className = 'chat-item' + (chat.id === activeChatId ? ' active' : '');
    const preview = chat.lastMessage
      ? (chat.lastMessage.fromMe ? 'You: ' : '') + chat.lastMessage.body
      : chat.isGroup
      ? 'Group chat'
      : '';
    row.innerHTML = `
      <div class="chat-avatar" style="background:${avatarColor(chat.name)}">${escapeHtml(initials(chat.name))}</div>
      <div class="chat-item-body">
        <div class="chat-item-top">
          <span class="chat-item-name">${escapeHtml(chat.name)}</span>
          <span class="chat-item-time">${chat.timestamp ? formatChatTime(chat.timestamp) : ''}</span>
        </div>
        <div class="chat-item-bottom">
          <span class="chat-item-preview">${escapeHtml(preview)}</span>
          ${chat.unreadCount ? `<span class="chat-unread-badge">${chat.unreadCount}</span>` : ''}
        </div>
      </div>
    `;
    row.addEventListener('click', () => openChat(chat.id, chat.name));
    chatListEl.appendChild(row);
  });
}

async function openChat(chatId, name) {
  activeChatId = chatId;
  activeChatName = name;
  renderChatList();

  chatEmptyState.style.display = 'none';
  chatThread.style.display = 'flex';
  chatHeaderAvatar.textContent = initials(name);
  chatHeaderAvatar.style.background = avatarColor(name);
  chatHeaderName.textContent = name;
  chatMessages.innerHTML = '<div class="muted" style="padding:16px">Loading…</div>';

  const chatEntry = chatListData.find((c) => c.id === chatId);
  if (chatEntry) chatEntry.unreadCount = 0;

  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load messages');
    renderMessages(data);
  } catch (err) {
    chatMessages.innerHTML = `<div class="muted" style="padding:16px">${escapeHtml(err.message)}</div>`;
  }
}

let currentThreadLastDay = null;

function renderMessages(list) {
  chatMessages.innerHTML = '';
  currentThreadLastDay = null;
  list.forEach((msg) => appendBubble(msg));
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function appendBubble(msg) {
  const dayLabel = formatDayLabel(msg.timestamp);
  if (dayLabel !== currentThreadLastDay) {
    const divider = document.createElement('div');
    divider.className = 'chat-day-divider';
    divider.textContent = dayLabel;
    chatMessages.appendChild(divider);
    currentThreadLastDay = dayLabel;
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble ' + (msg.fromMe ? 'bubble-out' : 'bubble-in');
  const text = msg.body || (msg.hasMedia ? '[media]' : '');
  bubble.innerHTML = `${escapeHtml(text)}<span class="bubble-time">${formatChatTime(msg.timestamp)}</span>`;
  chatMessages.appendChild(bubble);
}

async function sendChatMessage() {
  const message = chatInput.value.trim();
  if (!message || !activeChatId) return;

  chatInput.value = '';
  chatSendBtn.disabled = true;
  try {
    const res = await fetch(`/api/chats/${encodeURIComponent(activeChatId)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed');
    // the sent message arrives back through the 'chatMessage' socket event and renders then
  } catch (err) {
    chatMessages.insertAdjacentHTML(
      'beforeend',
      `<div class="result-row error">${escapeHtml(err.message)}</div>`
    );
  } finally {
    chatSendBtn.disabled = false;
  }
}

chatSendBtn.addEventListener('click', sendChatMessage);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});

socket.on('chatMessage', (msg) => {
  const existing = chatListData.find((c) => c.id === msg.chatId);
  if (existing) {
    existing.lastMessage = { body: msg.body, timestamp: msg.timestamp, fromMe: msg.fromMe };
    existing.timestamp = msg.timestamp;
    if (msg.chatId !== activeChatId && !msg.fromMe) existing.unreadCount = (existing.unreadCount || 0) + 1;
  } else {
    // brand-new conversation we don't know about yet — refresh the whole list to pick it up
    loadChats(chatSearch.value);
  }
  renderChatList();

  if (msg.chatId === activeChatId) {
    appendBubble(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
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
