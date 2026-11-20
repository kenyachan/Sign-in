import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PASSWORD, signIn, signUp, startApp } from './helpers.js';
import { SoftPasskey } from './authenticator.js';

const NEW_PASSWORD = 'a brand new passphrase';
let app;
before(async () => { app = await startApp(); });
after(() => app.close());
beforeEach(async () => {
  app.db.exec('DELETE FROM users; DELETE FROM login_attempts');
  app.resetRateLimits();
  await signUp(app.newClient());
  app.db.exec("UPDATE users SET email_verified_at = '2026-01-01T00:00:00Z'");   // confirmed email
  app.sentEmails.length = 0;
});

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const tokenFrom = (email) => email.text.match(/#token=([A-Za-z0-9_-]+)/)[1];
const requestLink = (email = 'kenya@example.com', client = app.newClient()) =>
  client.post('/api/recovery/request', { email });
async function getToken() {
  await requestLink();
  return tokenFrom(app.sentEmails.at(-1));
}

// --- Asking for a link ------------------------------------------------------

test('sends a one-time recovery link to a confirmed email', async () => {
  const res = await requestLink(' KENYA@Example.com ');
  assert.equal(res.status, 200);
  assert.equal(app.sentEmails.length, 1);
  const [email] = app.sentEmails;
  assert.equal(email.to, 'kenya@example.com');
  assert.equal(email.subject, 'Get back into your account');
  assert.match(email.text, /^http:\/\/localhost:3000\/recover-continue#token=/m);
  assert.match(email.text, /15 minutes/);

  const row = app.db.prepare("SELECT token_hash, expires_at FROM email_tokens WHERE purpose = 'recovery'").get();
  assert.equal(row.token_hash, sha256(tokenFrom(email)), 'only a hash is stored');
  const minutesLeft = (Date.parse(row.expires_at) - Date.now()) / 60000;
  assert.ok(minutesLeft > 14 && minutesLeft <= 15, `expires in 15 minutes (got ${minutesLeft})`);
});

test("the reply is the same whether or not there's an account", async () => {
  const real = await requestLink('kenya@example.com');
  const fake = await requestLink('nobody@example.com');
  assert.equal(fake.status, real.status);
  assert.deepEqual(fake.data, real.data);
  assert.equal(app.sentEmails.length, 1, 'but only the real account gets an email');
});

test('no link for an email address that was never confirmed', async () => {
  app.db.exec('UPDATE users SET email_verified_at = NULL');
  const res = await requestLink();
  assert.equal(res.status, 200, 'same reply as always');
  assert.equal(app.sentEmails.length, 0);
});

test('an invalid email address gets a 400', async () => {
  for (const email of ['nope', '', 42, undefined]) {
    assert.equal((await app.newClient().post('/api/recovery/request', { email })).status, 400);
  }
});

test('asking again cancels the earlier link', async () => {
  const first = await getToken();
  const second = await getToken();
  assert.equal((await app.newClient().post('/api/recovery/signin', { token: first })).status, 400);
  assert.equal((await app.newClient().post('/api/recovery/signin', { token: second })).status, 200);
});

test('at most 3 links an hour for one email address', async () => {
  for (let i = 0; i < 3; i++) assert.equal((await requestLink()).status, 200);
  const blocked = await requestLink();
  assert.equal(blocked.status, 429);
  assert.equal(app.sentEmails.length, 3);
});

test('the per-address limit applies to made-up addresses too (reveals nothing)', async () => {
  for (let i = 0; i < 3; i++) await requestLink('ghost@example.com');
  assert.equal((await requestLink('ghost@example.com')).status, 429);
});

test('at most 5 requests an hour from one network', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await requestLink(`person${i}@example.com`)).status, 200);
  assert.equal((await requestLink('person6@example.com')).status, 429);
});

test('links always use our own address, never one taken from the request', async () => {
  await requestLink('kenya@example.com', app.newClient({ host: 'evil.example', 'x-forwarded-host': 'evil.example' }));
  assert.doesNotMatch(app.sentEmails[0].text, /evil/);
});

// --- Checking a link --------------------------------------------------------

test('checking a link shows the account, without using the link up', async () => {
  const token = await getToken();
  for (let i = 0; i < 2; i++) {
    const res = await app.newClient().post('/api/recovery/check', { token });
    assert.deepEqual(res.data, { valid: true, username: 'kenya' });
  }
  assert.equal((await app.newClient().post('/api/recovery/check', { token: 'x'.repeat(43) })).data.valid, false);
});

// --- Setting a new password ------------------------------------------------

test('setting a new password: old one stops working, new one works, and you are signed in', async () => {
  const token = await getToken();
  const client = app.newClient();
  const res = await client.post('/api/recovery/password', { token, password: NEW_PASSWORD });
  assert.equal(res.status, 200);
  assert.equal((await client.get('/api/me')).data.username, 'kenya', 'signed in straight away');

  assert.equal((await signIn(app.newClient(), 'kenya', PASSWORD)).status, 401, 'old password refused');
  assert.equal((await signIn(app.newClient(), 'kenya', NEW_PASSWORD)).status, 200, 'new password works');
  assert.match(app.db.prepare('SELECT password_hash FROM users').get().password_hash, /^\$argon2id\$/);
});

test('recovery signs out every other device', async () => {
  const laptop = app.newClient();
  const phone = app.newClient();
  await signIn(laptop);
  await signIn(phone);
  await app.newClient().post('/api/recovery/password', { token: await getToken(), password: NEW_PASSWORD });
  assert.equal((await laptop.get('/api/me')).status, 401);
  assert.equal((await phone.get('/api/me')).status, 401);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1, 'only the new session');
});

test('recovery clears a password lockout', async () => {
  for (let i = 0; i < 5; i++) await signIn(app.newClient(), 'kenya', 'wrong password!');
  assert.equal((await signIn(app.newClient(), 'kenya', NEW_PASSWORD)).status, 429);
  await app.newClient().post('/api/recovery/password', { token: await getToken(), password: NEW_PASSWORD });
  assert.equal((await signIn(app.newClient(), 'kenya', NEW_PASSWORD)).status, 200);
});

test('the owner is emailed when their password is changed this way', async () => {
  await app.newClient().post('/api/recovery/password', { token: await getToken(), password: NEW_PASSWORD });
  const notice = app.sentEmails.at(-1);
  assert.equal(notice.to, 'kenya@example.com');
  assert.equal(notice.subject, 'Your password was changed');
  assert.match(notice.text, /every other device has been signed out/);
  assert.doesNotMatch(notice.text, /token=/, 'contains no link that grants access');
});

test('the new password must follow the usual rules, and a mistake keeps the link usable', async () => {
  const token = await getToken();
  const client = app.newClient();
  const short = await client.post('/api/recovery/password', { token, password: 'short' });
  assert.equal(short.status, 400);
  assert.match(short.data.errors.password, /at least 12/);
  const withName = await client.post('/api/recovery/password', { token, password: 'kenya-forever-123' });
  assert.match(withName.data.errors.password, /username/);
  assert.equal((await client.post('/api/recovery/password', { token, password: NEW_PASSWORD })).status, 200,
    'the link still works after the mistakes');
});

test('each link works only once', async () => {
  const token = await getToken();
  assert.equal((await app.newClient().post('/api/recovery/password', { token, password: NEW_PASSWORD })).status, 200);
  const again = await app.newClient().post('/api/recovery/password', { token, password: 'another new passphrase' });
  assert.equal(again.status, 400);
  assert.equal((await app.newClient().post('/api/recovery/signin', { token })).status, 400);
  assert.equal((await signIn(app.newClient(), 'kenya', NEW_PASSWORD)).status, 200, 'first change stands');
});

test('links expire after 15 minutes', async () => {
  const token = await getToken();
  app.db.exec("UPDATE email_tokens SET expires_at = '2000-01-01T00:00:00Z'");
  assert.equal((await app.newClient().post('/api/recovery/check', { token })).data.valid, false);
  assert.equal((await app.newClient().post('/api/recovery/password', { token, password: NEW_PASSWORD })).status, 400);
  assert.equal((await app.newClient().post('/api/recovery/signin', { token })).status, 400);
});

test('an email-confirmation link cannot be used to recover an account', async () => {
  app.db.exec('UPDATE users SET email_verified_at = NULL');
  await app.newClient().post('/api/register', { username: 'second', email: 'second@example.com', password: PASSWORD });
  const confirmToken = tokenFrom(app.sentEmails.at(-1));
  assert.equal((await app.newClient().post('/api/recovery/signin', { token: confirmToken })).status, 400);
  assert.equal((await app.newClient().post('/api/recovery/password', { token: confirmToken, password: NEW_PASSWORD })).status, 400);
});

test('made-up, missing and wrong-type tokens are refused', async () => {
  for (const token of ['x'.repeat(43), '', undefined, 123, ['a']]) {
    assert.equal((await app.newClient().post('/api/recovery/signin', { token })).status, 400);
    assert.equal((await app.newClient().post('/api/recovery/password', { token, password: NEW_PASSWORD })).status, 400);
  }
});

// --- Signing in to add a passkey -------------------------------------------

test('"sign in and add a passkey" signs you in, everywhere else out, and emails you', async () => {
  const old = app.newClient();
  await signIn(old);
  const client = app.newClient();
  const res = await client.post('/api/recovery/signin', { token: await getToken() });
  assert.equal(res.status, 200);
  assert.equal((await client.get('/api/me')).data.username, 'kenya');
  assert.equal((await old.get('/api/me')).status, 401);
  assert.equal(app.sentEmails.at(-1).subject, 'Your account was recovered');
  assert.equal((await signIn(app.newClient())).status, 200, 'the password is unchanged');
});

test('after recovering, a new passkey can be added and used', async () => {
  const client = app.newClient();
  await client.post('/api/recovery/signin', { token: await getToken() });
  const passkey = new SoftPasskey();
  const { data: options } = await client.post('/api/passkeys/register/options');
  assert.equal((await client.post('/api/passkeys/register/verify', { response: passkey.register(options) })).status, 201);

  const fresh = app.newClient();
  const { data: loginOptions } = await fresh.post('/api/passkeys/login/options');
  const login = await fresh.post('/api/passkeys/login/verify', { response: passkey.authenticate(loginOptions) });
  assert.equal(login.status, 200);
});

test('recovery is protected against other websites (CSRF)', async () => {
  const token = await getToken();
  const crossSite = app.newClient({ 'sec-fetch-site': 'cross-site' });
  assert.equal((await crossSite.post('/api/recovery/signin', { token })).status, 403);
  assert.equal((await crossSite.post('/api/recovery/request', { email: 'kenya@example.com' })).status, 403);
});
