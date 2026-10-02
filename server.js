'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createStore, AppError } = require('./store');
const U = require('./util');

const PUBLIC_DIR = __dirname;
// Flat layout: only these files are ever served, so server code and the database stay private.
const STATIC_FILES = {
  '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css', '/favicon.svg': 'favicon.svg',
  '/admin': 'admin.html', '/admin/': 'admin.html', '/admin/index.html': 'admin.html', '/admin/admin.js': 'admin.js', '/admin/admin.css': 'admin.css',
};
const SESSION_COOKIE = 'bfms_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY = 16 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'",
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
].join('; ');

function createServer(opts = {}) {
  const env = process.env;
  const dbFile = opts.dbFile || path.join(env.DATA_DIR || path.join(__dirname, 'data'), 'bookings.db');
  const store = opts.store || createStore({ file: dbFile, now: opts.now, whatsapp: env.WHATSAPP_NUMBER || '60148154572' });
  const secureCookies = opts.secureCookies ?? (env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production');
  const trustProxy = opts.trustProxy ?? env.TRUST_PROXY !== 'false';
  const L = opts.rateLimits || {};
  const limiters = {
    read: new U.RateLimiter(L.read ?? 900, 60 * 1000),
    booking: new U.RateLimiter(L.booking ?? 40, 10 * 60 * 1000),
    lookup: new U.RateLimiter(L.lookup ?? 25, 10 * 60 * 1000),
    login: new U.RateLimiter(L.login ?? 8, 15 * 60 * 1000),
  };

  const clientIp = (req) => {
    const xff = trustProxy && req.headers['x-forwarded-for'];
    return (xff ? String(xff).split(',')[0].trim() : req.socket.remoteAddress) || 'unknown';
  };
  const limit = (name, key) => {
    if (!limiters[name].hit(key)) throw new AppError('RATE_LIMITED', 429, 'Too many attempts. Please wait a few minutes and try again.');
  };

  function securityHeaders(res) {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  function json(res, status, data, extraHeaders = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
    res.end(body);
  }
  function sendError(res, err) {
    if (res.headersSent) { res.destroy(); return; }
    if (err instanceof AppError) return json(res, err.status, { error: { code: err.code, message: err.message } });
    console.error(new Date().toISOString(), 'Unhandled error:', err);
    return json(res, 500, { error: { code: 'SERVER', message: 'Something went wrong on our side. Please try again, or WhatsApp us for help.' } });
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        reject(new AppError('UNSUPPORTED', 415, 'Unsupported request.')); req.resume(); return;
      }
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new AppError('TOO_LARGE', 413, 'Request too large.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
          resolve(v);
        } catch { reject(new AppError('VALIDATION', 400, 'Please complete all required fields.')); }
      });
      req.on('error', reject);
    });
  }

  // Blocks cross-site POSTs. JSON-only bodies + this check stand in for CSRF tokens on public endpoints.
  function checkOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return;
    const host = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
    let originHost = null;
    try { originHost = new URL(origin).host; } catch { /* invalid */ }
    if (originHost !== host) throw new AppError('FORBIDDEN', 403, 'Request blocked.');
  }

  function readCookie(req, name) {
    const raw = req.headers.cookie || '';
    for (const part of raw.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  }
  const sessionCookie = (value, maxAgeSec) =>
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secureCookies ? '; Secure' : ''}`;

  async function publicApi(req, res, url, ip) {
    const m = req.method, p = url.pathname;
    if (m === 'GET' && p === '/api/health') return json(res, 200, { ok: true });
    if (m === 'GET' && p === '/api/config') { limit('read', ip); return json(res, 200, store.publicConfig()); }
    if (m === 'GET' && p === '/api/availability') {
      limit('read', ip);
      return json(res, 200, store.availability(url.searchParams.get('date'), url.searchParams.get('route')));
    }
    if (m === 'POST' && p === '/api/bookings') {
      limit('booking', ip);
      const body = await readJson(req);
      const r = store.createBooking({
        name: body.name, phone: body.phone, date: body.date, route: body.route, time: body.time,
        citizen: body.citizen, requestKey: body.requestKey,
      });
      return json(res, r.duplicate ? 200 : 201, { booking: r.booking });
    }
    if (m === 'POST' && p === '/api/bookings/find') {
      limit('lookup', ip);
      const body = await readJson(req);
      return json(res, 200, { booking: store.findForCustomer(body.bookingId, body.phone) });
    }
    if (m === 'POST' && p === '/api/bookings/cancel') {
      limit('lookup', ip);
      const body = await readJson(req);
      return json(res, 200, { booking: store.cancelByCustomer(body.bookingId, body.phone) });
    }
    return null;
  }

  async function adminApi(req, res, url, ip) {
    const m = req.method, p = url.pathname;
    if (m === 'POST' && p === '/api/admin/login') {
      const body = await readJson(req);
      limit('login', ip);
      limit('login', `user:${String(body.username || '').toLowerCase().slice(0, 40)}`);
      const admin = await store.verifyLogin(body.username, body.password);
      if (!admin) throw new AppError('LOGIN_FAILED', 401, 'Incorrect username or password.');
      const s = store.createSession(admin.id, SESSION_TTL_MS);
      return json(res, 200, { username: admin.username, csrfToken: s.csrf }, { 'Set-Cookie': sessionCookie(s.token, SESSION_TTL_MS / 1000) });
    }

    const token = readCookie(req, SESSION_COOKIE);
    const session = store.getSession(token);
    if (!session) throw new AppError('UNAUTHORIZED', 401, 'Please sign in.');
    if (m !== 'GET' && !U.safeEqual(String(req.headers['x-csrf-token'] || ''), session.csrf)) {
      throw new AppError('FORBIDDEN', 403, 'Your session has expired. Refresh the page and sign in again.');
    }
    const actor = session.username;
    const qp = (k) => url.searchParams.get(k) || undefined;

    if (m === 'GET' && p === '/api/admin/session') return json(res, 200, { username: actor, csrfToken: session.csrf });
    if (m === 'POST' && p === '/api/admin/logout') {
      store.deleteSession(token);
      return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
    }
    if (m === 'GET' && p === '/api/admin/summary') return json(res, 200, store.summary());
    if (m === 'GET' && p === '/api/admin/bookings') {
      return json(res, 200, { bookings: store.listBookings({ q: qp('q'), date: qp('date'), route: qp('route'), time: qp('time'), status: qp('status') }) });
    }
    if (m === 'POST' && p === '/api/admin/bookings') {
      const b = await readJson(req);
      const r = store.createBooking(
        { name: b.name, phone: b.phone, date: b.date, route: b.route, time: b.time, citizen: b.citizen, requestKey: b.requestKey },
        { source: 'admin', actor: `admin:${actor}`, overrideCutoff: b.overrideCutoff === true },
      );
      return json(res, 201, { booking: store.getBooking(r.booking.bookingId) });
    }
    const one = p.match(/^\/api\/admin\/bookings\/([A-Za-z0-9-]{8,40})(\/status|\/notes)?$/);
    if (one) {
      const [, bid, sub] = one;
      if (m === 'GET' && !sub) return json(res, 200, { booking: store.getBooking(bid) });
      if (m === 'POST' && sub === '/status') { const b = await readJson(req); return json(res, 200, { booking: store.setStatus(bid, b.status, b.reason, actor) }); }
      if (m === 'POST' && sub === '/notes') { const b = await readJson(req); return json(res, 200, { booking: store.setNotes(bid, b.notes, actor) }); }
    }
    if (m === 'GET' && p === '/api/admin/slots') return json(res, 200, { date: qp('date'), routes: store.slotBoard(qp('date')) });
    if (m === 'POST' && p === '/api/admin/slots/reopen') {
      const b = await readJson(req);
      return json(res, 200, store.reopenSlot(b.date, b.route, b.time, actor));
    }
    if (m === 'GET' && p === '/api/admin/settings') return json(res, 200, store.adminSettings());
    if (m === 'PUT' && p === '/api/admin/settings') { const b = await readJson(req); return json(res, 200, store.updateSettings(b, actor)); }
    if (m === 'POST' && p === '/api/admin/password') {
      const b = await readJson(req);
      await store.changePassword(session, b.currentPassword, b.newPassword);
      return json(res, 200, { ok: true });
    }
    if (m === 'GET' && p === '/api/admin/export.csv') {
      const stamp = new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="bfms-bookings-${stamp}.csv"`,
      });
      return res.end(store.exportCsv());
    }
    return null;
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
    const name = Object.prototype.hasOwnProperty.call(STATIC_FILES, pathname) ? STATIC_FILES[pathname] : null;
    const file = name && path.join(PUBLIC_DIR, name);
    const notFound = () => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); };
    if (!file) return notFound();
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) return notFound();
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Length': st.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(file).pipe(res);
    });
  }

  async function handle(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
    const ip = clientIp(req);
    if (req.method !== 'GET' && req.method !== 'HEAD') checkOrigin(req);
    const handled = url.pathname.startsWith('/api/admin/') ? await adminApi(req, res, url, ip) : await publicApi(req, res, url, ip);
    if (handled === null) throw new AppError('NO_ROUTE', 404, 'Not found.');
  }

  const server = http.createServer((req, res) => { handle(req, res).catch((err) => sendError(res, err)); });
  server.store = store;
  return server;
}

async function bootstrapAdmin(store) {
  if (store.adminCount() > 0) return;
  const { ADMIN_USERNAME, ADMIN_PASSWORD } = process.env;
  if (ADMIN_USERNAME && ADMIN_PASSWORD) {
    await store.createAdmin(ADMIN_USERNAME, ADMIN_PASSWORD);
    console.log(`Admin account "${ADMIN_USERNAME}" created. Remove ADMIN_PASSWORD from the environment now.`);
  } else {
    console.warn('No admin account yet. Set ADMIN_USERNAME and ADMIN_PASSWORD (10+ chars) and restart, or run: npm run create-admin');
  }
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const server = createServer();
  bootstrapAdmin(server.store)
    .then(() => server.listen(port, () => console.log(`Bahrain F1 Motorcycle Shuttle running on http://localhost:${port}`)))
    .catch((e) => { console.error(e.message); process.exit(1); });
  const shutdown = () => server.close(() => { server.store.close(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, bootstrapAdmin };
