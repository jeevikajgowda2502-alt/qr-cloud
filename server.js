const express = require('express');
const QRCode = require('qrcode');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-secret-change-me';
const DATABASE_URL = process.env.DATABASE_URL;

// ---------- Database (PostgreSQL) ----------
const isLocal = !DATABASE_URL || /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      email         TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS qr_codes (
      id         TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      content    TEXT NOT NULL,
      tracked    BOOLEAN NOT NULL DEFAULT false,
      dark       TEXT NOT NULL,
      light      TEXT NOT NULL,
      scans      INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_qr_user ON qr_codes(user_id);
    CREATE TABLE IF NOT EXISTS scan_events (
      id         BIGSERIAL PRIMARY KEY,
      qr_id      TEXT NOT NULL REFERENCES qr_codes(id) ON DELETE CASCADE,
      scanned_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_scan_qr_time ON scan_events(qr_id, scanned_at);
  `);
}

// ---------- Helpers ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: 'Server error. Please try again.' });
  });

const isHex = (s) => /^#[0-9a-fA-F]{6}$/.test(s);
const isUrl = (s) => /^https?:\/\/\S+$/i.test(s);
const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
const target = (row, req) => (row.tracked ? `${baseUrl(req)}/r/${row.id}` : row.content);
const opts = (row, extra = {}) => ({
  margin: 2,
  errorCorrectionLevel: 'M',
  color: { dark: row.dark, light: row.light },
  ...extra,
});

// Simple in-memory rate limiter (per IP + path)
const hits = new Map();
const limit = (max, windowMs) => (req, res, next) => {
  const key = req.ip + req.path;
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= max) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  recent.push(now);
  hits.set(key, recent);
  next();
};

const sign = (user) => jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

function auth(req, res, next) {
  const header = req.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    next();
  } catch {
    res.status(401).json({ error: 'Please log in.' });
  }
}

// ---------- Routes ----------
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/api/auth/register', limit(10, 15 * 60 * 1000), wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 72)
    return res.status(400).json({ error: 'Password must be 8 to 72 characters.' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email.toLowerCase(), hash]
    );
    res.status(201).json({ token: sign(rows[0]), email: rows[0].email });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That email is already registered. Log in instead.' });
    throw e;
  }
}));

app.post('/api/auth/login', limit(10, 15 * 60 * 1000), wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!isEmail(email) || typeof password !== 'string')
    return res.status(400).json({ error: 'Enter your email and password.' });
  const { rows } = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email.toLowerCase()]);
  const ok = rows[0] && (await bcrypt.compare(password, rows[0].password_hash));
  if (!ok) return res.status(401).json({ error: 'Wrong email or password.' });
  res.json({ token: sign(rows[0]), email: rows[0].email });
}));

app.post('/api/qr', auth, wrap(async (req, res) => {
  const { content, tracked = false, dark = '#14202b', light = '#ffffff' } = req.body || {};
  if (typeof content !== 'string' || !content.trim() || content.length > 1000)
    return res.status(400).json({ error: 'Enter text or a URL (max 1000 characters).' });
  if (!isHex(dark) || !isHex(light)) return res.status(400).json({ error: 'Colors must be hex values like #14202b.' });
  if (tracked && !isUrl(content.trim())) return res.status(400).json({ error: 'Scan tracking only works with http(s) URLs.' });

  const row = { id: crypto.randomBytes(5).toString('hex'), content: content.trim(), tracked: !!tracked, dark, light };
  await pool.query(
    'INSERT INTO qr_codes (id, user_id, content, tracked, dark, light) VALUES ($1,$2,$3,$4,$5,$6)',
    [row.id, req.userId, row.content, row.tracked, row.dark, row.light]
  );
  res.status(201).json({ id: row.id, image: await QRCode.toDataURL(target(row, req), opts(row, { width: 512 })) });
}));

app.get('/api/qr', auth, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, content, tracked, scans, created_at FROM qr_codes WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
    [req.userId]
  );
  res.json(rows);
}));

app.get('/api/qr/:id/image.:ext', auth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM qr_codes WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  const row = rows[0];
  if (!row) return res.status(404).json({ error: 'Not found.' });
  if (req.params.ext === 'svg') {
    res.type('image/svg+xml').send(await QRCode.toString(target(row, req), opts(row, { type: 'svg' })));
  } else if (req.params.ext === 'png') {
    res.type('image/png').send(await QRCode.toBuffer(target(row, req), opts(row, { width: 1024 })));
  } else {
    res.status(400).json({ error: 'Use .png or .svg' });
  }
}));

app.delete('/api/qr/:id', auth, wrap(async (req, res) => {
  const r = await pool.query('DELETE FROM qr_codes WHERE id = $1 AND user_id = $2', [req.params.id, req.userId]);
  res.status(r.rowCount ? 200 : 404).json({ deleted: r.rowCount });
}));

// Scan analytics for the logged-in user: last 14 days plus totals
app.get('/api/stats', auth, wrap(async (req, res) => {
  const days = await pool.query(
    `SELECT to_char(d::date, 'YYYY-MM-DD') AS day, COALESCE(c.n, 0)::int AS scans
     FROM generate_series(current_date - 13, current_date, interval '1 day') d
     LEFT JOIN (
       SELECT e.scanned_at::date AS day, count(*) AS n
       FROM scan_events e JOIN qr_codes q ON q.id = e.qr_id
       WHERE q.user_id = $1
       GROUP BY 1
     ) c ON c.day = d::date
     ORDER BY d`,
    [req.userId]
  );
  const totals = await pool.query(
    'SELECT count(*)::int AS codes, COALESCE(sum(scans), 0)::int AS scans FROM qr_codes WHERE user_id = $1',
    [req.userId]
  );
  const top = await pool.query(
    'SELECT content, scans FROM qr_codes WHERE user_id = $1 AND tracked = true AND scans > 0 ORDER BY scans DESC LIMIT 1',
    [req.userId]
  );
  res.json({ days: days.rows, totalCodes: totals.rows[0].codes, totalScans: totals.rows[0].scans, top: top.rows[0] || null });
}));

// Scan tracking: public link that counts the scan then redirects
app.get('/r/:id', wrap(async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE qr_codes SET scans = scans + 1 WHERE id = $1 AND tracked = true RETURNING id, content',
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).send('This QR code does not exist.');
  await pool.query('INSERT INTO scan_events (qr_id) VALUES ($1)', [rows[0].id]);
  res.redirect(302, rows[0].content);
}));

// ---------- Start ----------
async function start() {
  if (!DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }
  if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    console.error('JWT_SECRET is not set.'); process.exit(1);
  }
  await initDb();
  app.listen(PORT, () => console.log(`QR service listening on :${PORT}`));
}

module.exports = app;
if (require.main === module) start().catch((e) => { console.error(e); process.exit(1); });
