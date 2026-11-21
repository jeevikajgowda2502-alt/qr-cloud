const test = require('node:test');
const assert = require('node:assert');
const app = require('../server');

let server, base;
test.before(() => {
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const post = (url, body, headers = {}) =>
  fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('health check returns ok', async () => {
  const res = await fetch(base + '/health');
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { status: 'ok' });
});

test('creating a QR code requires login', async () => {
  const res = await post('/api/qr', { content: 'https://example.com' });
  assert.strictEqual(res.status, 401);
});

test('scan analytics require login', async () => {
  const res = await fetch(base + '/api/stats');
  assert.strictEqual(res.status, 401);
});

test('register rejects an invalid email', async () => {
  const res = await post('/api/auth/register', { email: 'not-an-email', password: 'longenough1' });
  assert.strictEqual(res.status, 400);
});

test('register rejects a short password', async () => {
  const res = await post('/api/auth/register', { email: 'a@b.com', password: 'short' });
  assert.strictEqual(res.status, 400);
});
