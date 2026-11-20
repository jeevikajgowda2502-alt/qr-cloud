const express = require('express');
const QRCode = require('qrcode');
const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'qr.db');

// ---------- Database ----------
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS qr_codes (
    id         TEXT PRIMARY KEY,
    session    TEXT NOT NULL,
    content    TEXT NOT NULL,
    tracked    INTEGER NOT NULL DEFAULT 0,
    dark       TEXT NOT NULL,
    light      TEXT NOT NULL,
    scans      INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_qr_session ON qr_codes(session);
`);

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const isHex = (s) => /^#[0-9a-fA-F]{6}$/.test(s);
const isUrl = (s) => /^https?:\/\/\S+$/i.test(s);
const baseUrl = (req) => process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
const target = (row, req) => (row.tracked ? `${baseUrl(req)}/r/${row.id}` : row.content);
const opts = (row, extra = {}) => ({
  margin: 2,
  errorCorrectionLevel: 'M',
  color: { dark: row.dark, light: row.light },
  ...extra,
});

// Health check (used by load balancers / cloud platforms)
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Create a QR code
app.post('/api/qr', async (req, res) => {
  try {
    const { content, session, tracked = false, dark = '#14202b', light = '#ffffff' } = req.body || {};
    if (typeof content !== 'string' || !content.trim() || content.length > 1000)
      return res.status(400).json({ error: 'Enter text or a URL (max 1000 characters).' });
    if (typeof session !== 'string' || session.length < 8 || session.length > 64)
      return res.status(400).json({ error: 'Missing session id.' });
    if (!isHex(dark) || !isHex(light))
      return res.status(400).json({ error: 'Colors must be hex values like #14202b.' });
    if (tracked && !isUrl(content.trim()))
      return res.status(400).json({ error: 'Scan tracking only works with http(s) URLs.' });

    const row = {
      id: crypto.randomBytes(5).toString('hex'),
      session,
      content: content.trim(),
      tracked: tracked ? 1 : 0,
      dark,
      light,
    };
    db.prepare(
      'INSERT INTO qr_codes (id, session, content, tracked, dark, light) VALUES (@id,@session,@content,@tracked,@dark,@light)'
    ).run(row);

    const image = await QRCode.toDataURL(target(row, req), opts(row, { width: 512 }));
    res.status(201).json({ id: row.id, image });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create the QR code.' });
  }
});

// List history for one browser session
app.get('/api/qr', (req, res) => {
  const session = String(req.query.session || '');
  const rows = db
    .prepare('SELECT id, content, tracked, scans, created_at FROM qr_codes WHERE session = ? ORDER BY created_at DESC, rowid DESC LIMIT 50')
    .all(session);
  res.json(rows);
});

// Download image: /api/qr/:id/image.png or image.svg
app.get('/api/qr/:id/image.:ext', async (req, res) => {
  const row = db.prepare('SELECT * FROM qr_codes WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found.' });
  const download = req.query.download ? `attachment; filename="qr-${row.id}.${req.params.ext}"` : 'inline';
  res.set('Content-Disposition', download);
  if (req.params.ext === 'svg') {
    res.type('image/svg+xml').send(await QRCode.toString(target(row, req), opts(row, { type: 'svg' })));
  } else if (req.params.ext === 'png') {
    res.type('image/png').send(await QRCode.toBuffer(target(row, req), opts(row, { width: 1024 })));
  } else {
    res.status(400).json({ error: 'Use .png or .svg' });
  }
});

// Delete
app.delete('/api/qr/:id', (req, res) => {
  const session = String(req.query.session || '');
  const info = db.prepare('DELETE FROM qr_codes WHERE id = ? AND session = ?').run(req.params.id, session);
  res.status(info.changes ? 200 : 404).json({ deleted: info.changes });
});

// Scan tracking: QR points here, we count the scan and redirect
app.get('/r/:id', (req, res) => {
  const row = db.prepare('SELECT content FROM qr_codes WHERE id = ? AND tracked = 1').get(req.params.id);
  if (!row) return res.status(404).send('This QR code does not exist.');
  db.prepare('UPDATE qr_codes SET scans = scans + 1 WHERE id = ?').run(req.params.id);
  res.redirect(302, row.content);
});

app.listen(PORT, () => console.log(`QR service listening on :${PORT}`));
