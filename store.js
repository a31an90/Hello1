'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const U = require('./util');

const ROUTES = {
  SIC_MOP: { code: 'SIC_MOP', from: 'Petronas SIC', to: 'Mitsui Outlet Park' },
  MOP_SIC: { code: 'MOP_SIC', from: 'Mitsui Outlet Park', to: 'Petronas SIC' },
};
const routeLabel = (code) => (ROUTES[code] ? `${ROUTES[code].from} → ${ROUTES[code].to}` : code);

// Initial configuration. Stored in the settings table on first run; admins change dates from /admin.
const DEFAULT_SETTINGS = {
  event_dates: ['2026-10-03', '2026-10-04'],
  time_slots: {
    morning: ['07:00', '07:30', '08:00', '08:30', '09:00', '09:30', '10:00'],
    evening: ['16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00'],
  },
  cutoff_minutes: 60,
  fare: 30,
  max_active_per_phone: 4,
  pickup_notes: { SIC_MOP: '', MOP_SIC: '' },
};

const MESSAGES = {
  VALIDATION: 'Please complete all required fields.',
  INVALID_NAME: 'Please enter your full name.',
  INVALID_PHONE: 'Please enter a valid Malaysian mobile number, for example 012-3456789.',
  CITIZEN_REQUIRED: 'Please confirm that you are a Malaysian citizen.',
  INVALID_SLOT: 'This date, route or time is not open for booking.',
  SLOT_TAKEN: 'This slot is no longer available. Please select another time.',
  BOOKING_CLOSED: 'Booking is closed for this time slot. Bookings close 1 hour before pickup.',
  NOT_FOUND: "We couldn't find a matching booking. Please check your Booking ID and phone number.",
  ALREADY_CANCELLED: 'This booking has already been cancelled.',
};

class AppError extends Error {
  constructor(code, status, message, extra) {
    super(message || MESSAGES[code] || code);
    this.code = code; this.status = status; this.extra = extra;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bookings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id            TEXT    NOT NULL UNIQUE,
  passenger_name        TEXT    NOT NULL,
  phone_number          TEXT    NOT NULL,
  citizenship_confirmed INTEGER NOT NULL CHECK (citizenship_confirmed IN (0, 1)),
  date                  TEXT    NOT NULL,
  route                 TEXT    NOT NULL CHECK (route IN ('SIC_MOP', 'MOP_SIC')),
  pickup_time           TEXT    NOT NULL,
  fare                  INTEGER NOT NULL,
  status                TEXT    NOT NULL CHECK (status IN ('CONFIRMED', 'CANCELLED')),
  source                TEXT    NOT NULL DEFAULT 'customer',
  request_key           TEXT,
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL,
  cancelled_at          TEXT,
  cancelled_reason      TEXT,
  cancelled_by          TEXT,
  admin_notes           TEXT    NOT NULL DEFAULT ''
);
-- The critical rule: at most ONE confirmed booking per date + route + pickup time.
-- Cancelled rows are kept for history and do not hold the slot.
CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_active_slot
  ON bookings (date, route, pickup_time) WHERE status = 'CONFIRMED';
-- Same request submitted twice (double tap, flaky network) returns the same booking.
CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_request_key
  ON bookings (request_key) WHERE request_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_bookings_phone ON bookings (phone_number);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  admin_id   INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  actor      TEXT NOT NULL,
  action     TEXT NOT NULL,
  booking_id TEXT,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_booking ON audit_log (booking_id);
`;

const isUnique = (e, column) => e && /UNIQUE constraint failed/.test(e.message || '') && e.message.includes(column);

function createStore({ file, now = () => Date.now(), whatsapp = '60148154572' } = {}) {
  if (file && file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file || ':memory:');
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);

  const iso = () => new Date(now()).toISOString();
  const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const putSettingStmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    if (!getSettingStmt.get(k)) putSettingStmt.run(k, JSON.stringify(v));
  }

  const q = {
    insert: db.prepare(`INSERT INTO bookings
      (booking_id, passenger_name, phone_number, citizenship_confirmed, date, route, pickup_time, fare, status, source, request_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, ?)`),
    byBid: db.prepare('SELECT * FROM bookings WHERE booking_id = ?'),
    byReqKey: db.prepare('SELECT * FROM bookings WHERE request_key = ?'),
    activeForSlot: db.prepare("SELECT * FROM bookings WHERE date = ? AND route = ? AND pickup_time = ? AND status = 'CONFIRMED'"),
    activeForDateRoute: db.prepare("SELECT * FROM bookings WHERE date = ? AND route = ? AND status = 'CONFIRMED'"),
    activeAll: db.prepare("SELECT date, route, pickup_time FROM bookings WHERE status = 'CONFIRMED'"),
    activeCountForPhone: db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE phone_number = ? AND status = 'CONFIRMED'"),
    cancel: db.prepare(`UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?, cancelled_reason = ?, cancelled_by = ?, updated_at = ?
      WHERE booking_id = ? AND status = 'CONFIRMED'`),
    reconfirm: db.prepare(`UPDATE bookings SET status = 'CONFIRMED', cancelled_at = NULL, cancelled_reason = NULL, cancelled_by = NULL, updated_at = ?
      WHERE booking_id = ? AND status = 'CANCELLED'`),
    notes: db.prepare('UPDATE bookings SET admin_notes = ?, updated_at = ? WHERE booking_id = ?'),
    counts: db.prepare('SELECT status, COUNT(*) AS n FROM bookings GROUP BY status'),
    all: db.prepare('SELECT * FROM bookings ORDER BY date, pickup_time, route, created_at'),
    audit: db.prepare('INSERT INTO audit_log (at, actor, action, booking_id, detail) VALUES (?, ?, ?, ?, ?)'),
    auditFor: db.prepare('SELECT at, actor, action, detail FROM audit_log WHERE booking_id = ? ORDER BY id'),
    adminCount: db.prepare('SELECT COUNT(*) AS n FROM admins'),
    adminByName: db.prepare('SELECT * FROM admins WHERE username = ?'),
    adminById: db.prepare('SELECT * FROM admins WHERE id = ?'),
    insertAdmin: db.prepare('INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?)'),
    setAdminPw: db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?'),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, admin_id, csrf_token, expires_at) VALUES (?, ?, ?, ?)'),
    session: db.prepare('SELECT s.*, a.username FROM sessions s JOIN admins a ON a.id = s.admin_id WHERE s.token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteAdminSessions: db.prepare('DELETE FROM sessions WHERE admin_id = ? AND token_hash != ?'),
    purgeSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  };

  const audit = (actor, action, bookingId, detail) => q.audit.run(iso(), actor, action, bookingId || null, detail || null);

  function settings() {
    const out = {};
    for (const k of Object.keys(DEFAULT_SETTINGS)) out[k] = JSON.parse(getSettingStmt.get(k).value);
    out.event_dates = [...out.event_dates].sort();
    return out;
  }
  const allTimes = (s) => [...s.time_slots.morning, ...s.time_slots.evening];
  const isClosed = (s, date, time) => now() >= U.cutoffEpoch(date, time, s.cutoff_minutes);

  function view(b, s = settings()) {
    const r = ROUTES[b.route];
    return {
      bookingId: b.booking_id,
      passengerName: b.passenger_name,
      phone: U.formatPhone(b.phone_number),
      date: b.date,
      dateLabel: U.dateLabel(b.date),
      weekday: U.dateParts(b.date).weekday,
      route: b.route,
      routeLabel: routeLabel(b.route),
      from: r.from,
      to: r.to,
      time: b.pickup_time,
      timeLabel: U.timeLabel(b.pickup_time),
      fare: b.fare,
      status: b.status,
      payment: 'Pay after reaching destination (cash, online transfer or QR)',
      pickupNote: s.pickup_notes[b.route] || '',
      createdAt: b.created_at,
      cancelledAt: b.cancelled_at,
    };
  }
  function adminView(b, s = settings()) {
    const v = view(b, s);
    Object.assign(v, {
      phoneRaw: b.phone_number,
      citizenshipConfirmed: !!b.citizenship_confirmed,
      source: b.source,
      cancelledReason: b.cancelled_reason,
      cancelledBy: b.cancelled_by,
      adminNotes: b.admin_notes,
      updatedAt: b.updated_at,
    });
    if (b.status === 'CANCELLED') {
      const holder = q.activeForSlot.get(b.date, b.route, b.pickup_time);
      v.slotNowHeldBy = holder ? holder.booking_id : null;
    }
    return v;
  }

  function validateSlot(s, date, route, time) {
    if (!U.isValidDate(date) || !s.event_dates.includes(date)) throw new AppError('INVALID_SLOT', 400);
    if (!ROUTES[route]) throw new AppError('INVALID_SLOT', 400);
    if (!allTimes(s).includes(time)) throw new AppError('INVALID_SLOT', 400);
  }

  // ---------- Customer-facing ----------

  function publicConfig() {
    const s = settings();
    const times = allTimes(s);
    return {
      serviceName: 'Bahrain F1 Motorcycle Shuttle',
      fare: s.fare,
      cutoffMinutes: s.cutoff_minutes,
      timezone: U.TIMEZONE,
      whatsapp,
      routes: Object.values(ROUTES).map((r) => ({ ...r, label: routeLabel(r.code), pickupNote: s.pickup_notes[r.code] || '' })),
      dates: s.event_dates.map((d) => ({
        date: d, label: U.dateLabel(d), weekday: U.dateParts(d).weekday,
        open: times.some((t) => !isClosed(s, d, t)),
      })),
      timeSlots: {
        morning: s.time_slots.morning.map((t) => ({ time: t, label: U.timeLabel(t) })),
        evening: s.time_slots.evening.map((t) => ({ time: t, label: U.timeLabel(t) })),
      },
      serverTime: now(),
    };
  }

  function availability(date, route) {
    const s = settings();
    if (!U.isValidDate(date) || !s.event_dates.includes(date) || !ROUTES[route]) throw new AppError('INVALID_SLOT', 400);
    const booked = new Set(q.activeForDateRoute.all(date, route).map((b) => b.pickup_time));
    const status = (t) => (booked.has(t) ? 'BOOKED' : isClosed(s, date, t) ? 'CLOSED' : 'AVAILABLE');
    const mk = (t) => ({ time: t, label: U.timeLabel(t), status: status(t) });
    return { date, route, morning: s.time_slots.morning.map(mk), evening: s.time_slots.evening.map(mk), serverTime: now() };
  }

  /**
   * Creates a booking. The partial unique index is the source of truth: two simultaneous
   * requests for one slot cannot both insert, whatever the frontend shows.
   */
  function createBooking(input, { source = 'customer', actor = 'customer', overrideCutoff = false } = {}) {
    const s = settings();
    input = input && typeof input === 'object' ? input : {};
    const { date, route, time } = input;
    if (!input.name || !input.phone || !date || !route || !time) throw new AppError('VALIDATION', 400);
    const name = U.cleanName(input.name);
    if (!name) throw new AppError('INVALID_NAME', 400);
    const phone = U.normalizePhone(input.phone);
    if (!phone) throw new AppError('INVALID_PHONE', 400);
    if (input.citizen !== true) throw new AppError('CITIZEN_REQUIRED', 400);
    validateSlot(s, date, route, time);
    if (!overrideCutoff && isClosed(s, date, time)) {
      throw new AppError('BOOKING_CLOSED', 409, `Booking is closed for this time slot. Bookings close ${s.cutoff_minutes / 60 === 1 ? '1 hour' : `${s.cutoff_minutes} minutes`} before pickup.`);
    }

    let requestKey = typeof input.requestKey === 'string' && /^[A-Za-z0-9-]{16,64}$/.test(input.requestKey) ? input.requestKey : null;
    if (requestKey) {
      const ex = q.byReqKey.get(requestKey);
      if (ex) {
        const same = ex.date === date && ex.route === route && ex.pickup_time === time && ex.phone_number === phone && ex.status === 'CONFIRMED';
        if (same) return { booking: view(ex, s), duplicate: true };
        requestKey = null;
      }
    }

    if (source === 'customer' && s.max_active_per_phone > 0) {
      const { n } = q.activeCountForPhone.get(phone);
      if (n >= s.max_active_per_phone) {
        throw new AppError('PHONE_LIMIT', 409, `This phone number already has ${n} active bookings, the maximum allowed. Please WhatsApp us if you need another ride.`);
      }
    }

    for (let attempt = 0; attempt < 10; attempt++) {
      const bid = U.makeBookingId(date, time);
      const at = iso();
      try {
        q.insert.run(bid, name, phone, 1, date, route, time, s.fare, source, requestKey, at, at);
      } catch (e) {
        if (isUnique(e, 'bookings.booking_id')) continue;
        if (isUnique(e, 'bookings.request_key')) return { booking: view(q.byReqKey.get(requestKey), s), duplicate: true };
        if (isUnique(e, 'bookings.pickup_time')) throw new AppError('SLOT_TAKEN', 409);
        throw e;
      }
      audit(actor, 'created', bid, `${source} booking${overrideCutoff ? ' (cutoff overridden)' : ''}`);
      return { booking: view(q.byBid.get(bid), s), duplicate: false };
    }
    throw new Error('Could not allocate a unique booking ID');
  }

  function matchCustomer(bookingId, phoneInput) {
    const bid = U.normalizeBookingId(bookingId);
    const phone = U.normalizePhone(phoneInput);
    const b = bid && phone ? q.byBid.get(bid) : null;
    if (!b || !U.safeEqual(b.phone_number, phone)) throw new AppError('NOT_FOUND', 404);
    return b;
  }
  const findForCustomer = (bookingId, phone) => view(matchCustomer(bookingId, phone));

  function cancelByCustomer(bookingId, phone) {
    const b = matchCustomer(bookingId, phone);
    if (b.status !== 'CONFIRMED') throw new AppError('ALREADY_CANCELLED', 409);
    if (now() >= U.slotEpoch(b.date, b.pickup_time)) {
      throw new AppError('PICKUP_PASSED', 409, 'This pickup time has already passed, so it can no longer be cancelled online. Please WhatsApp us.');
    }
    const at = iso();
    q.cancel.run(at, 'Cancelled by customer', 'customer', at, b.booking_id);
    audit('customer', 'cancelled', b.booking_id, 'Cancelled by customer; slot released');
    return view(q.byBid.get(b.booking_id));
  }

  // ---------- Admin ----------

  function summary() {
    const s = settings();
    const active = new Set(q.activeAll.all().map((r) => `${r.date}|${r.route}|${r.pickup_time}`));
    let totalSlots = 0, bookedSlots = 0, availableSlots = 0, closedSlots = 0;
    for (const d of s.event_dates) for (const r of Object.keys(ROUTES)) for (const t of allTimes(s)) {
      totalSlots++;
      if (active.has(`${d}|${r}|${t}`)) bookedSlots++;
      else if (isClosed(s, d, t)) closedSlots++;
      else availableSlots++;
    }
    const counts = Object.fromEntries(q.counts.all().map((r) => [r.status, r.n]));
    return {
      activeBookings: counts.CONFIRMED || 0,
      cancelled: counts.CANCELLED || 0,
      totalSlots, bookedSlots, availableSlots, closedSlots,
      serverTime: now(),
    };
  }

  function listBookings(f = {}) {
    const where = [], params = [];
    const term = typeof f.q === 'string' ? f.q.trim().slice(0, 80) : '';
    if (term) {
      const like = `%${term.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
      const digits = term.replace(/\D/g, '');
      const parts = ["booking_id LIKE ? ESCAPE '\\'", "passenger_name LIKE ? ESCAPE '\\'"];
      params.push(like.toUpperCase(), like);
      if (digits.length >= 3) {
        let d = digits; if (d.startsWith('60')) d = '0' + d.slice(2);
        parts.push('phone_number LIKE ?'); params.push(`%${d}%`);
      }
      where.push(`(${parts.join(' OR ')})`);
    }
    if (U.isValidDate(f.date)) { where.push('date = ?'); params.push(f.date); }
    if (ROUTES[f.route]) { where.push('route = ?'); params.push(f.route); }
    if (U.isValidTime(f.time)) { where.push('pickup_time = ?'); params.push(f.time); }
    if (f.status === 'CONFIRMED' || f.status === 'CANCELLED') { where.push('status = ?'); params.push(f.status); }
    const sql = `SELECT * FROM bookings ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY date, pickup_time, route, status DESC, created_at LIMIT 2000`;
    const s = settings();
    return db.prepare(sql).all(...params).map((b) => adminView(b, s));
  }

  function getBookingRow(bookingId) {
    const bid = U.normalizeBookingId(bookingId);
    const b = bid && q.byBid.get(bid);
    if (!b) throw new AppError('NOT_FOUND', 404, 'Booking not found.');
    return b;
  }
  function getBooking(bookingId) {
    const b = getBookingRow(bookingId);
    return { ...adminView(b), history: q.auditFor.all(b.booking_id) };
  }

  function setStatus(bookingId, status, reason, actor) {
    const b = getBookingRow(bookingId);
    const at = iso();
    if (status === 'CANCELLED') {
      if (b.status === 'CANCELLED') throw new AppError('ALREADY_CANCELLED', 409);
      const why = U.cleanText(reason, 200) || 'Cancelled by admin';
      q.cancel.run(at, why, `admin:${actor}`, at, b.booking_id);
      audit(`admin:${actor}`, 'cancelled', b.booking_id, `${why}; slot released`);
    } else if (status === 'CONFIRMED') {
      if (b.status === 'CONFIRMED') throw new AppError('ALREADY_CONFIRMED', 409, 'This booking is already confirmed.');
      try {
        q.reconfirm.run(at, b.booking_id);
      } catch (e) {
        if (isUnique(e, 'bookings.pickup_time')) {
          const holder = q.activeForSlot.get(b.date, b.route, b.pickup_time);
          throw new AppError('SLOT_TAKEN', 409, `This slot is already held by ${holder ? holder.booking_id : 'another booking'}. Cancel or reopen that booking first.`);
        }
        throw e;
      }
      audit(`admin:${actor}`, 'reconfirmed', b.booking_id, 'Status changed back to confirmed');
    } else {
      throw new AppError('VALIDATION', 400, 'Status must be CONFIRMED or CANCELLED.');
    }
    return getBooking(b.booking_id);
  }

  /** Frees a date + route + time so customers can book it again. History is kept. */
  function reopenSlot(date, route, time, actor) {
    if (!U.isValidDate(date) || !ROUTES[route] || !U.isValidTime(time)) throw new AppError('INVALID_SLOT', 400);
    const b = q.activeForSlot.get(date, route, time);
    if (!b) return { reopened: false, message: 'This slot is already open.' };
    const at = iso();
    q.cancel.run(at, 'Slot reopened by admin', `admin:${actor}`, at, b.booking_id);
    audit(`admin:${actor}`, 'slot_reopened', b.booking_id, `Slot ${date} ${route} ${time} reopened`);
    return { reopened: true, releasedBookingId: b.booking_id, message: `Slot reopened. ${b.booking_id} was cancelled.` };
  }

  function setNotes(bookingId, notes, actor) {
    const b = getBookingRow(bookingId);
    const text = U.cleanText(notes, 1000);
    if (text === null) throw new AppError('VALIDATION', 400, 'Notes must be under 1000 characters.');
    q.notes.run(text, iso(), b.booking_id);
    audit(`admin:${actor}`, 'notes_updated', b.booking_id, null);
    return getBooking(b.booking_id);
  }

  function slotBoard(date) {
    const s = settings();
    if (!U.isValidDate(date)) throw new AppError('INVALID_SLOT', 400);
    return Object.values(ROUTES).map((r) => {
      const active = new Map(q.activeForDateRoute.all(date, r.code).map((b) => [b.pickup_time, b]));
      const mk = (t) => {
        const b = active.get(t);
        return {
          time: t, label: U.timeLabel(t),
          status: b ? 'BOOKED' : isClosed(s, date, t) ? 'CLOSED' : 'AVAILABLE',
          booking: b ? { bookingId: b.booking_id, passengerName: b.passenger_name, phone: U.formatPhone(b.phone_number) } : null,
        };
      };
      return { route: r.code, label: routeLabel(r.code), morning: s.time_slots.morning.map(mk), evening: s.time_slots.evening.map(mk) };
    });
  }

  function adminSettings() {
    const s = settings();
    return {
      eventDates: s.event_dates,
      pickupNotes: s.pickup_notes,
      cutoffMinutes: s.cutoff_minutes,
      fare: s.fare,
      maxActivePerPhone: s.max_active_per_phone,
      timeSlots: s.time_slots,
      routes: Object.values(ROUTES).map((r) => ({ code: r.code, label: routeLabel(r.code) })),
    };
  }

  function updateSettings(patch, actor) {
    patch = patch && typeof patch === 'object' ? patch : {};
    if (patch.eventDates !== undefined) {
      const dates = Array.isArray(patch.eventDates) ? [...new Set(patch.eventDates)] : null;
      if (!dates || !dates.length || dates.length > 31 || !dates.every(U.isValidDate)) {
        throw new AppError('VALIDATION', 400, 'Add at least one valid event date.');
      }
      const removed = settings().event_dates.filter((d) => !dates.includes(d));
      for (const d of removed) {
        const { n } = db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE date = ? AND status = 'CONFIRMED'").get(d);
        if (n) throw new AppError('VALIDATION', 409, `${U.dateLabel(d)} still has ${n} confirmed booking${n === 1 ? '' : 's'}. Cancel them before removing this date.`);
      }
      putSettingStmt.run('event_dates', JSON.stringify(dates.sort()));
    }
    if (patch.pickupNotes !== undefined) {
      const notes = {};
      for (const code of Object.keys(ROUTES)) {
        const t = U.cleanText(patch.pickupNotes?.[code], 300);
        if (t === null) throw new AppError('VALIDATION', 400, 'Pickup instructions must be under 300 characters.');
        notes[code] = t;
      }
      putSettingStmt.run('pickup_notes', JSON.stringify(notes));
    }
    if (patch.maxActivePerPhone !== undefined) {
      const n = Number(patch.maxActivePerPhone);
      if (!Number.isInteger(n) || n < 0 || n > 50) throw new AppError('VALIDATION', 400, 'Limit per phone must be 0–50 (0 means no limit).');
      putSettingStmt.run('max_active_per_phone', JSON.stringify(n));
    }
    audit(`admin:${actor}`, 'settings_updated', null, Object.keys(patch).join(', '));
    return adminSettings();
  }

  function exportCsv() {
    const cols = ['booking_id', 'passenger_name', 'phone_number', 'citizenship_confirmed', 'date', 'route', 'pickup_time', 'fare',
      'status', 'source', 'created_at', 'cancelled_at', 'cancelled_reason', 'cancelled_by', 'admin_notes'];
    const lines = [cols.join(',')];
    for (const b of q.all.all()) {
      lines.push(cols.map((c) => U.csvCell(c === 'route' ? routeLabel(b.route) : c === 'phone_number' ? U.formatPhone(b.phone_number) : b[c])).join(','));
    }
    return '\uFEFF' + lines.join('\r\n') + '\r\n';
  }

  // ---------- Admin accounts & sessions ----------

  let dummyHash = null;
  async function createAdmin(username, password) {
    const u = typeof username === 'string' ? username.trim() : '';
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(u)) throw new AppError('VALIDATION', 400, 'Username must be 3–40 letters, numbers, dots, dashes or underscores.');
    if (typeof password !== 'string' || password.length < 10) throw new AppError('VALIDATION', 400, 'Password must be at least 10 characters.');
    if (q.adminByName.get(u)) throw new AppError('VALIDATION', 409, 'That username already exists.');
    q.insertAdmin.run(u, await U.hashPassword(password), iso());
    audit('system', 'admin_created', null, u);
  }
  async function verifyLogin(username, password) {
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 200) return null;
    const a = q.adminByName.get(username.trim());
    if (!a) { dummyHash ||= await U.hashPassword('not-a-real-password'); await U.verifyPassword(password, dummyHash); return null; }
    return (await U.verifyPassword(password, a.password_hash)) ? { id: a.id, username: a.username } : null;
  }
  function createSession(adminId, ttlMs) {
    q.purgeSessions.run(Date.now());
    const token = U.randomToken(32);
    const csrf = U.randomToken(24);
    q.insertSession.run(U.sha256(token), adminId, csrf, Date.now() + ttlMs);
    return { token, csrf };
  }
  function getSession(token) {
    if (!token || typeof token !== 'string' || token.length > 100) return null;
    const s = q.session.get(U.sha256(token));
    if (!s || s.expires_at < Date.now()) return null;
    return { adminId: s.admin_id, username: s.username, csrf: s.csrf_token, tokenHash: s.token_hash };
  }
  const deleteSession = (token) => token && q.deleteSession.run(U.sha256(token));
  async function changePassword(session, current, next) {
    const a = q.adminById.get(session.adminId);
    if (!a || !(await U.verifyPassword(String(current || ''), a.password_hash))) throw new AppError('LOGIN_FAILED', 400, 'Current password is incorrect.');
    if (typeof next !== 'string' || next.length < 10 || next.length > 200) throw new AppError('VALIDATION', 400, 'New password must be at least 10 characters.');
    q.setAdminPw.run(await U.hashPassword(next), a.id);
    q.deleteAdminSessions.run(a.id, session.tokenHash); // sign out other devices
    audit(`admin:${a.username}`, 'password_changed', null, null);
  }
  const adminCount = () => q.adminCount.get().n;

  return {
    db, settings, publicConfig, availability, createBooking, findForCustomer, cancelByCustomer,
    summary, listBookings, getBooking, setStatus, reopenSlot, setNotes, slotBoard, adminSettings, updateSettings, exportCsv,
    createAdmin, verifyLogin, createSession, getSession, deleteSession, changePassword, adminCount,
    close: () => db.close(),
  };
}

module.exports = { createStore, AppError, ROUTES, DEFAULT_SETTINGS };
