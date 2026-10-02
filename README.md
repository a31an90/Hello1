# Bahrain F1 Motorcycle Shuttle — booking site

Customer booking site + admin dashboard for the Petronas SIC ⇄ Mitsui Outlet Park motorcycle shuttle.

- **Zero dependencies.** Node.js 22.13+ only (built-in HTTP server, built-in SQLite, built-in scrypt).
- **One file database** (`bookings.db`) in `DATA_DIR`. It must sit on a **persistent disk**.
- Customer site: `/` — Admin: `/admin`

> Netlify / Vercel static hosting will **not** work: they have no persistent disk or long-running server.
> Use Railway, Fly.io, Render (with a disk), or any VPS.

## Go live fast — Railway (about 10 minutes)

1. Push this folder to a private GitHub repo.
2. Railway → **New Project → Deploy from GitHub repo** → pick the repo. Railway builds the `Dockerfile` automatically.
3. Service → **Variables**, add:
   - `ADMIN_USERNAME` = your admin username
   - `ADMIN_PASSWORD` = a long password (10+ characters)
4. Service → **Volumes → Add volume**, mount path **`/data`**. (Without this, every redeploy wipes all bookings.)
5. Service → **Settings → Networking → Generate domain**. Open it, then open `/admin` and sign in.
6. After the first successful login, **delete `ADMIN_PASSWORD`** from Variables (the hashed password is already in the database). Change it anytime under Admin → Settings.
7. Admin → Settings: fill in **Pickup point instructions** for each route once confirmed. They appear on the site and on every confirmation.

Custom domain: Railway → Settings → Networking → Custom domain, then add the CNAME it shows at your DNS provider.

## Any VPS with Docker

```bash
docker build -t bfms .
docker run -d --name bfms --restart unless-stopped -p 80:3000 \
  -v bfms-data:/data -e ADMIN_USERNAME=admin -e ADMIN_PASSWORD='long-password-here' bfms
```
Put it behind HTTPS (Caddy or Cloudflare). Session cookies are `Secure` when `NODE_ENV=production`, so admin login needs HTTPS.

## Run locally

```bash
ADMIN_USERNAME=admin ADMIN_PASSWORD=local-password-1 NODE_ENV=development npm start
# http://localhost:3000  and  http://localhost:3000/admin
npm test        # runs the acceptance tests (all 10 brief scenarios + security checks)
```
Add another admin later: `npm run create-admin -- username` (prompts for the password).

## How the important rules are enforced

| Rule | Where |
|---|---|
| One confirmed booking per date + route + time | SQLite partial unique index `ux_bookings_active_slot` (`WHERE status='CONFIRMED'`). Two simultaneous requests cannot both insert. |
| Cancelled slot becomes available again | Cancelled rows don't count in that index. Rows are never deleted. |
| 1-hour cutoff | Server checks `now >= pickup − 60 min`, pickup computed in `Asia/Kuala_Lumpur` (+08:00), independent of server/device timezone. |
| Double tap / flaky network | Each confirm sends a `requestKey`; a repeat returns the same booking. |
| Cancelling after the ride / removing a live date | Customers can't cancel online once the pickup time has passed; admins can't remove an event date that still has confirmed bookings. |
| Citizenship checkbox, phone format | Validated on the server, not just the form. |
| One person hogging slots | Max active bookings per phone (default 4, editable in Settings; admin bookings exempt). |
| Admin security | scrypt-hashed passwords, HttpOnly + SameSite=Strict session cookie, CSRF token on every admin change, login rate limit, no credentials in frontend code. |
| Public API hardening | JSON-only bodies, same-origin check on POSTs, per-IP rate limits, strict Content-Security-Policy, no other customer's data ever returned. |

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATA_DIR` | `./data` (`/data` in Docker) | Folder for `bookings.db`. Must be persistent. |
| `PORT` | `3000` | |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | – | Creates the first admin only when none exists. |
| `WHATSAPP_NUMBER` | `60148154572` | International format, no `+`. |
| `NODE_ENV` | `production` in Docker | Enables Secure cookies + HSTS. |
| `TRUST_PROXY` | `true` | Uses `X-Forwarded-For` for rate limits. Set `false` if not behind a proxy. |

Event dates, pickup instructions and the per-phone limit are edited in **Admin → Settings**.
Time slots, fare and cutoff are in `DEFAULT_SETTINGS` in `src/store.js` (stored in the `settings` table on first run).

## Backups

The whole system is one file. Download a CSV anytime from Admin → **Export CSV**. For a full copy, copy `/data/bookings.db` (plus `-wal` file) from the volume.

## Files

```
server.js              HTTP server, routes, security headers, rate limits
src/store.js           Database schema + all booking rules
src/util.js            Malaysia time, phone validation, booking IDs, password hashing
public/                Customer site (index.html, app.js, styles.css)
public/admin/          Admin dashboard
test/acceptance.test.js  The brief's 10 acceptance tests and more
```
