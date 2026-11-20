import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, signUp, startApp } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());
beforeEach(() => {
  app.db.exec('DELETE FROM users');
  app.resetRateLimits();
});

test('creates an account and stores only an Argon2id hash', async () => {
  const res = await signUp(app.newClient());
  assert.equal(res.status, 201);

  const user = app.db.prepare('SELECT * FROM users').get();
  assert.equal(user.username, 'kenya');
  assert.match(user.password_hash, /^\$argon2id\$/);
  assert.ok(!user.password_hash.includes(PASSWORD), 'the password itself must not be stored');
  assert.equal(user.webauthn_user_id.length, 22, 'gets a random passkey user ID');
});

test('tidies the email: trims spaces and lower-cases it', async () => {
  await signUp(app.newClient(), { email: '  Kenya@Example.COM ' });
  assert.equal(app.db.prepare('SELECT email FROM users').get().email, 'kenya@example.com');
});

test('refuses a username that is taken, whatever the capitals', async () => {
  await signUp(app.newClient());
  const res = await signUp(app.newClient(), { username: 'KeNyA', email: 'other@example.com' });
  assert.equal(res.status, 409);
  assert.match(res.data.errors.username, /taken/);
});

test("doesn't reveal that an email is already registered", async () => {
  const first = await signUp(app.newClient());
  const second = await signUp(app.newClient(), { username: 'someone', email: 'KENYA@example.com' });
  assert.equal(second.status, first.status);
  assert.deepEqual(second.data, first.data, 'same reply as a real sign-up');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'but no second account');
});

test('checks every field on the server, not just in the browser', async () => {
  const res = await signUp(app.newClient(), { username: 'a b', email: 'nope', password: 'short' });
  assert.equal(res.status, 400);
  assert.deepEqual(Object.keys(res.data.errors).sort(), ['email', 'password', 'username']);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
});

test('handles missing, wrong-type and broken input without crashing', async () => {
  const client = app.newClient();
  assert.equal((await client.post('/api/register', {})).status, 400);
  assert.equal((await client.post('/api/register', { username: 1, email: [], password: {} })).status, 400);
  const broken = await client.request('POST', '/api/register', {
    body: '{oops', headers: { 'content-type': 'application/json' },
  });
  assert.equal(broken.status, 400);
  assert.match(broken.data.error, /not valid JSON/);
});

test('refuses request bodies over 10 KB', async () => {
  const res = await signUp(app.newClient(), { password: 'x'.repeat(20_000) });
  assert.equal(res.status, 413);
});
