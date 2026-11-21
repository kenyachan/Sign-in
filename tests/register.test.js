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
  assert.equal(user.email, 'kenya@example.com');
  assert.equal('username' in user, false, 'there are no usernames');
  assert.equal(user.first_name, 'Kenya');
  assert.equal(user.last_name, 'Chan');
  assert.match(user.password_hash, /^\$argon2id\$/);
  assert.ok(!user.password_hash.includes(PASSWORD), 'the password itself must not be stored');
  assert.equal(user.webauthn_user_id.length, 22, 'gets a random passkey user ID');
});

test('tidies the email: trims spaces and lower-cases it', async () => {
  await signUp(app.newClient(), { email: '  Kenya@Example.COM ' });
  assert.equal(app.db.prepare('SELECT email FROM users').get().email, 'kenya@example.com');
});

test("doesn't reveal that an email is already registered", async () => {
  const first = await signUp(app.newClient());
  const second = await signUp(app.newClient(), { firstName: 'Olly', email: 'KENYA@example.com' });
  assert.equal(second.status, first.status);
  assert.deepEqual(second.data, first.data, 'same reply as a real sign-up');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'but no second account');
});

test('checks every field on the server, not just in the browser', async () => {
  const res = await signUp(app.newClient(), { firstName: '', email: 'nope', password: 'short' });
  assert.equal(res.status, 400);
  assert.deepEqual(Object.keys(res.data.errors).sort(), ['email', 'firstName', 'password']);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
});

test('handles missing, wrong-type and broken input without crashing', async () => {
  const client = app.newClient();
  assert.equal((await client.post('/api/register', {})).status, 400);
  assert.equal((await client.post('/api/register', { firstName: 1, email: [], password: {} })).status, 400);
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

test('the first name is required; the last name is optional', async () => {
  const noFirst = await signUp(app.newClient(), { firstName: '  ' });
  assert.equal(noFirst.status, 400);
  assert.match(noFirst.data.errors.firstName, /first name/);

  const oneName = await signUp(app.newClient(), { firstName: '  Madonna ', lastName: undefined });
  assert.equal(oneName.status, 201);
  assert.deepEqual(app.db.prepare('SELECT first_name, last_name FROM users').get(),
    { first_name: 'Madonna', last_name: null });
});
