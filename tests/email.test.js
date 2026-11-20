import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { signIn, signUp, startApp } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());
beforeEach(() => {
  app.db.exec('DELETE FROM users');   // also removes their sessions and email tokens
  app.sentEmails.length = 0;
  app.resetRateLimits();
});

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const tokenFrom = (email) => email.text.match(/#token=([A-Za-z0-9_-]+)/)[1];
const verify = (token) => app.newClient().post('/api/verify-email', { token });
const isVerified = () => app.db.prepare('SELECT email_verified_at FROM users').get().email_verified_at !== null;

test('signing up sends a confirmation email with a one-time link', async () => {
  await signUp(app.newClient());
  assert.equal(app.sentEmails.length, 1);
  const [email] = app.sentEmails;
  assert.equal(email.to, 'kenya@example.com');
  assert.match(email.subject, /confirm/i);
  assert.match(email.text, /http:\/\/localhost:3000\/verify-email#token=/);
  assert.match(email.html, /Confirm email address/);
  assert.equal(isVerified(), false, 'not confirmed until the link is used');
});

test('the database keeps only a hash of the link token', async () => {
  await signUp(app.newClient());
  const token = tokenFrom(app.sentEmails[0]);
  const stored = app.db.prepare('SELECT token_hash, purpose FROM email_tokens').get();
  assert.equal(stored.token_hash, sha256(token));
  assert.equal(stored.purpose, 'verify_email');
});

test('using the link confirms the email', async () => {
  const client = app.newClient();
  await signUp(client);
  const res = await verify(tokenFrom(app.sentEmails[0]));
  assert.equal(res.status, 200);
  assert.equal(isVerified(), true);

  await signIn(client);
  assert.equal((await client.get('/api/me')).data.emailVerified, true);
});

test('each link works only once', async () => {
  await signUp(app.newClient());
  const token = tokenFrom(app.sentEmails[0]);
  assert.equal((await verify(token)).status, 200);
  const again = await verify(token);
  assert.equal(again.status, 400);
  assert.match(again.data.error, /invalid, already used, or expired/);
});

test('links expire after 24 hours', async () => {
  await signUp(app.newClient());
  app.db.exec("UPDATE email_tokens SET expires_at = '2000-01-01T00:00:00Z'");
  assert.equal((await verify(tokenFrom(app.sentEmails[0]))).status, 400);
  assert.equal(isVerified(), false);
});

test('made-up, missing and wrong-type tokens are refused', async () => {
  await signUp(app.newClient());
  for (const token of ['x'.repeat(43), '', undefined, 123, ['a'], 'a'.repeat(500)]) {
    assert.equal((await verify(token)).status, 400, `token: ${JSON.stringify(token)}`);
  }
  assert.equal(isVerified(), false);
});

test("signing up with someone else's email tells them, and sends no confirmation link", async () => {
  await signUp(app.newClient());
  app.sentEmails.length = 0;

  const res = await signUp(app.newClient(), { username: 'intruder', email: 'KENYA@example.com' });
  assert.equal(res.status, 201, 'the visitor still sees "success"');
  assert.equal(app.sentEmails.length, 1);
  assert.equal(app.sentEmails[0].to, 'kenya@example.com');
  assert.match(app.sentEmails[0].subject, /tried to sign up/);
  assert.doesNotMatch(app.sentEmails[0].text, /token=/, 'no link that could confirm anything');
});

test('a new link can be requested, and the old one stops working', async () => {
  const client = app.newClient();
  await signUp(client);
  const oldToken = tokenFrom(app.sentEmails[0]);
  await signIn(client);

  const res = await client.post('/api/resend-verification');
  assert.equal(res.status, 200);
  assert.match(res.data.message, /kenya@example\.com/);
  assert.equal(app.sentEmails.length, 2);

  assert.equal((await verify(oldToken)).status, 400, 'old link no longer works');
  assert.equal((await verify(tokenFrom(app.sentEmails[1]))).status, 200);
});

test('asking for a new link needs you to be signed in', async () => {
  assert.equal((await app.newClient().post('/api/resend-verification')).status, 401);
});

test('no new link once the email is confirmed', async () => {
  const client = app.newClient();
  await signUp(client);
  await verify(tokenFrom(app.sentEmails[0]));
  await signIn(client);
  const res = await client.post('/api/resend-verification');
  assert.match(res.data.message, /already confirmed/);
  assert.equal(app.sentEmails.length, 1);
});

test('new links are limited to 3 per hour per account', async () => {
  const client = app.newClient();
  await signUp(client);
  await signIn(client);
  for (let i = 0; i < 3; i++) assert.equal((await client.post('/api/resend-verification')).status, 200);
  assert.equal((await client.post('/api/resend-verification')).status, 429);
});

test('links always use our own address, never one taken from the request', async () => {
  // A trick attackers use: send a request with a fake Host header, hoping the
  // email's link points to their site (and leaks the token to them).
  await app.newClient({ host: 'evil.example', 'x-forwarded-host': 'evil.example' })
    .post('/api/register', { username: 'kenya', email: 'kenya@example.com', password: 'correct horse battery' });
  assert.equal(app.sentEmails.length, 1);
  assert.doesNotMatch(app.sentEmails[0].text, /evil/);
  assert.match(app.sentEmails[0].text, /^http:\/\/localhost:3000\//m);
});
