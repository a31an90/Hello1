'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

// Malaysia has no daylight saving, so a fixed +08:00 offset is exact for Asia/Kuala_Lumpur.
const MYT_OFFSET = '+08:00';
const TIMEZONE = 'Asia/Kuala_Lumpur';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const isValidTime = (s) => typeof s === 'string' && TIME_RE.test(s);

/** Epoch ms of a pickup, interpreted in Malaysia time regardless of server or device timezone. */
const slotEpoch = (date, time) => Date.parse(`${date}T${time}:00${MYT_OFFSET}`);
const cutoffEpoch = (date, time, minutes) => slotEpoch(date, time) - minutes * 60000;

function timeLabel(t) {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
function dateParts(s) {
  const d = new Date(s + 'T00:00:00Z');
  return { day: d.getUTCDate(), month: MONTHS[d.getUTCMonth()], weekday: DAYS[d.getUTCDay()], year: d.getUTCFullYear() };
}
const dateLabel = (s) => { const p = dateParts(s); return `${p.day} ${p.month}`; };

/** Accepts 012-3456789, 012 345 6789, +6012..., 6012... Returns 0123456789 or null. */
function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  let s = input.replace(/[\s\-().]/g, '');
  if (s.startsWith('+')) s = s.slice(1);
  if (s.startsWith('60')) s = '0' + s.slice(2);
  return /^01(?:1\d{8}|[02-9]\d{7})$/.test(s) ? s : null;
}
const formatPhone = (s) => (s ? `${s.slice(0, 3)}-${s.slice(3)}` : '');

function cleanName(input) {
  if (typeof input !== 'string') return null;
  const s = input.normalize('NFC')
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\uFEFF<>]/g, '')
    .replace(/\s+/g, ' ').trim();
  if (s.length < 2 || s.length > 80 || !/\p{L}/u.test(s)) return null;
  return s;
}

function cleanText(input, max) {
  if (input == null) return '';
  if (typeof input !== 'string') return null;
  const s = input.replace(/\r\n/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F<>]/g, '').trim();
  return s.length > max ? null : s;
}

// No 0/O/1/I so IDs are easy to read out over the phone.
const ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeBookingId(date, time) {
  const p = dateParts(date);
  const [h, m] = time.split(':').map(Number);
  const timeCode = `${h % 12 || 12}${m ? String(m).padStart(2, '0') : ''}${h < 12 ? 'A' : 'P'}`;
  let rand = '';
  for (let i = 0; i < 4; i++) rand += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return `BFMS-${p.day}${p.month.slice(0, 3).toUpperCase()}-${timeCode}-${rand}`;
}
function normalizeBookingId(input) {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/\s+/g, '');
  return /^BFMS-\d{1,2}[A-Z]{3}-\d{1,4}[AP]-[A-Z0-9]{4}$/.test(s) ? s : null;
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(key, expected);
}

/** Fixed-window limiter, in memory. Generous by default because event crowds share mobile-carrier IPs. */
class RateLimiter {
  constructor(limit, windowMs) { this.limit = limit; this.windowMs = windowMs; this.hits = new Map(); }
  hit(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || e.reset <= now) { e = { count: 0, reset: now + this.windowMs }; this.hits.set(key, e); }
    e.count += 1;
    if (this.hits.size > 20000) for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    return e.count <= this.limit;
  }
}

/** CSV cell with a formula-injection guard for Excel. */
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

module.exports = {
  TIMEZONE, isValidDate, isValidTime, slotEpoch, cutoffEpoch, timeLabel, dateParts, dateLabel,
  normalizePhone, formatPhone, cleanName, cleanText, makeBookingId, normalizeBookingId,
  safeEqual, sha256, randomToken, hashPassword, verifyPassword, RateLimiter, csvCell,
};
