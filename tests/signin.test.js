import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EMAIL, signIn, signUp, startApp } from './helpers.js';

let app;
before(async () => {
  app = await startApp();
  await signUp(app.newClient());
});
after(() => app.close());
beforeEach(() => {
  app.db.exec('DELETE FROM sessions; DELETE FROM login_attempts');
  app.resetRateLimits();
});

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

test('signing in sets a secure session cookie', async () => {
  const client = app.newClient();
  const res = await signIn(client);
  assert.equal(res.status, 200);
  assert.equal(res.data.firstName, 'Kenya');

  const cookie = res.setCookies.find((c) => c.startsWith('sid='));
  assert.ok(cookie, 'sets the sid cookie');
  assert.match(cookie, /HttpOnly/i, 'page scripts cannot read it');
  assert.match(cookie, /SameSite=Lax/i, 'not sent on cross-site posts');
  assert.match(cookie, /Path=\//);
});

test('the database stores only a hash of the session token', async () => {
  const client = app.newClient();
  await signIn(client);
  const token = client.cookies.get('sid');
  assert.ok(token.length >= 43, 'token is long and random');

  const ids = app.db.prepare('SELECT id FROM sessions').all().map((r) => r.id);
  assert.deepEqual(ids, [sha256(token)]);
  assert.ok(!ids.includes(token));
});

test('email addresses are not case-sensitive at sign-in, and spaces are ignored', async () => {
  assert.equal((await signIn(app.newClient(), '  KENYA@Example.COM ')).status, 200);
});

test("wrong password and unknown email get exactly the same reply", async () => {
  const wrongPassword = await signIn(app.newClient(), EMAIL, 'not the password');
  const noSuchUser = await signIn(app.newClient(), 'nobody@example.com', 'not the password');
  assert.equal(wrongPassword.status, 401);
  assert.equal(noSuchUser.status, 401);
  assert.deepEqual(wrongPassword.data, noSuchUser.data);
  assert.equal(wrongPassword.setCookies.length, 0, 'no session for a failed sign-in');
});

test('missing email or password is a 400, not a crash', async () => {
  const client = app.newClient();
  assert.equal((await client.post('/api/login', {})).status, 400);
  assert.equal((await client.post('/api/login', { email: EMAIL })).status, 400);
  assert.equal((await client.post('/api/login', { email: [EMAIL], password: 5 })).status, 400);
});

test('/api/me and /account need a session', async () => {
  const client = app.newClient();
  assert.equal((await client.get('/api/me')).status, 401);
  const page = await client.get('/account');
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/signin');

  await signIn(client);
  const me = await client.get('/api/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.data, {
    firstName: 'Kenya', lastName: 'Chan', email: 'kenya@example.com', pendingEmail: null,
    webauthnUserId: app.db.prepare('SELECT webauthn_user_id FROM users').get().webauthn_user_id,
    emailVerified: true, hasPassword: true, deleteAfter: null,
  });
  assert.equal(me.headers.get('cache-control'), 'no-store');

  const account = await client.get('/account');
  assert.equal(account.status, 200);
  assert.equal(account.headers.get('cache-control'), 'no-store', 'not shown from cache after signing out');
});

test('account page is not reachable as a static file', async () => {
  assert.equal((await app.newClient().get('/account.html')).status, 404);
  assert.equal((await app.newClient().get('/views/account.html')).status, 404);
});

test('signed-in visitors are sent from /signin and /signup to /account', async () => {
  const client = app.newClient();
  await signIn(client);
  for (const page of ['/signin', '/signup']) {
    const res = await client.get(page);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/account');
  }
});

test('signing in again replaces the old session (no session fixation)', async () => {
  const client = app.newClient();
  await signIn(client);
  const oldToken = client.cookies.get('sid');
  await signIn(client);
  const newToken = client.cookies.get('sid');

  assert.notEqual(newToken, oldToken);
  const stale = app.newClient();
  stale.cookies.set('sid', oldToken);
  assert.equal((await stale.get('/api/me')).status, 401, 'old token no longer works');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
});

test('signing out ends the session on the server too', async () => {
  const client = app.newClient();
  await signIn(client);
  const token = client.cookies.get('sid');

  const res = await client.post('/api/logout');
  assert.equal(res.status, 204);
  assert.equal(client.cookies.has('sid'), false, 'cookie cleared');
  assert.equal((await client.get('/api/me')).status, 401);

  // Even a copy of the cookie (say, stolen earlier) is now useless.
  const thief = app.newClient();
  thief.cookies.set('sid', token);
  assert.equal((await thief.get('/api/me')).status, 401);
});

test('signing out when not signed in is harmless', async () => {
  assert.equal((await app.newClient().post('/api/logout')).status, 204);
});

test('made-up session cookies are ignored', async () => {
  const client = app.newClient();
  client.cookies.set('sid', 'not-a-real-token');
  assert.equal((await client.get('/api/me')).status, 401);
});

test('sessions end after 7 days', async () => {
  const client = app.newClient();
  await signIn(client);
  app.db.exec("UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z'");
  assert.equal((await client.get('/api/me')).status, 401);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0, 'expired session deleted');
});

test('sessions end after 24 hours without use', async () => {
  const client = app.newClient();
  await signIn(client);
  const yesterday = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  app.db.prepare('UPDATE sessions SET last_seen_at = ?').run(yesterday);
  assert.equal((await client.get('/api/me')).status, 401);
});
