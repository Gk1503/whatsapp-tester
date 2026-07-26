// Deterministic synthetic data generator. Same seed -> same output, always.
// Used by MockTransport (so the testing lab never needs a real WhatsApp
// account) and by the benchmark script (so capacity numbers are reproducible).
// Names/numbers are obviously synthetic (fictional "555" numbering block) —
// never intended to resemble real contacts.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = [
  'Aarav', 'Priya', 'Rohan', 'Sara', 'Kabir', 'Meera', 'Dev', 'Anya', 'Ishaan', 'Tara',
  'Vikram', 'Nisha', 'Arjun', 'Zoya', 'Kunal', 'Riya', 'Aditya', 'Sana', 'Rahul', 'Ira'
];
const LAST_NAMES = [
  'Shah', 'Nair', 'Mehta', 'Kapoor', 'Rao', 'Iyer', 'Verma', 'Gupta', 'Singh', 'Das',
  'Patel', 'Reddy', 'Joshi', 'Malhotra', 'Chopra', 'Bose', 'Menon', 'Pillai', 'Saxena', 'Bhatt'
];
const GROUP_WORDS = ['Team', 'Project', 'Family', 'Friends', 'Squad', 'Club', 'Circle', 'Crew'];

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function syntheticNumber(rng, index) {
  const suffix = String(1000000 + Math.floor(rng() * 8999999) + index).slice(-7);
  return `1555${suffix}`;
}

function generateContacts(seed, count) {
  const rng = mulberry32(seed);
  const contacts = [];
  for (let i = 0; i < count; i++) {
    const name = `${pick(rng, FIRST_NAMES)} ${pick(rng, LAST_NAMES)}`;
    const number = syntheticNumber(rng, i);
    contacts.push({ id: `${number}@c.us`, name, number });
  }
  return contacts;
}

function generateChats(seed, count, contacts) {
  const rng = mulberry32(seed + 1);
  const now = Math.floor(Date.now() / 1000);
  const chats = [];
  for (let i = 0; i < count; i++) {
    const isGroup = rng() < 0.2;
    const base = contacts[i % Math.max(1, contacts.length)] || { name: `Contact ${i}`, number: syntheticNumber(rng, i) };
    const name = isGroup ? `${pick(rng, GROUP_WORDS)} ${i}` : base.name;
    const id = isGroup ? `synthetic-group-${i}@g.us` : `${base.number}@c.us`;
    const timestamp = now - Math.floor(rng() * 86400 * 7);
    chats.push({
      id,
      name,
      isGroup,
      unreadCount: rng() < 0.3 ? Math.floor(rng() * 5) + 1 : 0,
      timestamp,
      lastMessage: { body: `Synthetic message ${i}`, timestamp, fromMe: rng() < 0.5 }
    });
  }
  return chats.sort((a, b) => b.timestamp - a.timestamp);
}

function generateMessages(seed, chatId, count) {
  const rng = mulberry32(hashString(chatId) ^ seed);
  const now = Math.floor(Date.now() / 1000);
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      id: `${chatId}-msg-${i}`,
      body: `Synthetic message body #${i}`,
      fromMe: rng() < 0.5,
      author: null,
      timestamp: now - (count - i) * 60,
      hasMedia: false
    });
  }
  return messages;
}

function hashString(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h >>> 0;
}

module.exports = { mulberry32, generateContacts, generateChats, generateMessages, hashString };
