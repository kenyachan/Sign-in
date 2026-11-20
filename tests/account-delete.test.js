import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, signIn, signUp, startApp } from './helpers.js';
import { SoftPasskey } from './authenticator.js';

const DAY = 24 * 60 * 60 * 1000;
let app;
let purgeDueAccounts;
before(async () => {
  app = await startApp();
  ({ purgeDueAccounts } = await import('../src/account-deletion.js'));
});
after(() => app.close());
beforeEach(async () => {
  app.db.exec('DELETE FROM users; DELETE FROM webauthn_challenges; DELETE FROM login_attempts');
  app.resetRateLimits();
  await signUp(app.newClient());
  app.sentEmails.length = 0;
});

async function signedIn(username = 'kenya') {
  const client = app.newClient();
  await signIn(client, username);
  return client;
}

const askToDelete = (client, body = { username: 'kenya', password: PASSWORD }) =>
  client.post('/api/account/deletion', body);

async function addPasskey(client) {
  const passkey = new SoftPasskey();
  const { data: options } = await client.post('/api/passkeys/register/options');
  await client.post('/api/passkeys/register/verify', { response: passkey.register(options) });
  return passkey;
}

const userRow = () => app.db.prepare('SELECT id, delete_after FROM users WHERE username = ?').get('kenya');
const count = (table, userId) => app.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id = ?`).get(userId).n;

// --- Asking to delete -------------------------------------------------------

test('asking to delete schedules it 7 days ahead and signs out every device', async () => {
  const laptop = await signedIn();
  const phone = await signedIn();

  const res = await askToDelete(laptop);
  assert.equal(res.status, 200);
  const daysLeft = (Date.parse(res.data.deleteAfter) - Date.now()) / DAY;
  assert.ok(daysLeft > 6.99 && daysLeft <= 7, `deleted in 7 days (got ${daysLeft})`);
  assert.equal(userRow().delete_after, res.data.deleteAfter);

  assert.equal((await laptop.get('/api/me')).status, 401, 'this browser is signed out');
  assert.equal((await phone.get('/api/me')).status, 401, 'and every other one');
  assert.equal(count('sessions', userRow().id), 0);

  assert.equal(app.sentEmails.length, 1);
  const [email] = app.sentEmails;
  assert.equal(email.to, 'kenya@example.com');
  assert.equal(email.subject, 'Your account will be deleted in 7 days');
  assert.match(email.text, /permanent/);
  assert.match(email.text, /no way to recover your account or any of its information/);
});

test('you can sign in during the 7 days and cancel', async () => {
  await askToDelete(await signedIn());

  const client = await signedIn();
  const me = await client.get('/api/me');
  assert.equal(me.status, 200, 'the account still works during the grace period');
  assert.equal(me.data.deleteAfter, userRow().delete_after);
  assert.equal((await askToDelete(client)).status, 409, "can't schedule it twice");

  const cancel = await client.request('DELETE', '/api/account/deletion');
  assert.equal(cancel.status, 200);
  assert.equal(userRow().delete_after, null);
  assert.equal((await client.get('/api/me')).data.deleteAfter, null);
  assert.equal(app.sentEmails.at(-1).subject, 'Your account will not be deleted');

  assert.equal(purgeDueAccounts(Date.now() + 8 * DAY), 0, 'nothing is erased later');
  assert.ok(userRow());
  assert.equal((await client.request('DELETE', '/api/account/deletion')).status, 409, 'nothing left to cancel');
});

test('after 7 days the account and everything in it is erased for good', async () => {
  const client = await signedIn();
  await addPasskey(client);
  const { id } = userRow();
  assert.equal(count('email_tokens', id), 1, 'the sign-up confirmation link');
  await askToDelete(client);
  await signIn(app.newClient(), 'kenya', 'a wrong password');   // leaves a failed-attempt record
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n, 1);

  assert.equal(purgeDueAccounts(Date.now() + 6 * DAY), 0, 'not before the 7 days are up');
  assert.ok(userRow());

  assert.equal(purgeDueAccounts(Date.now() + 7 * DAY + 60_000), 1);
  assert.equal(userRow(), undefined);
  for (const table of ['sessions', 'passkeys', 'email_tokens', 'webauthn_challenges']) {
    assert.equal(count(table, id), 0, `nothing left in ${table}`);
  }
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n, 0);
  assert.equal(app.sentEmails.at(-1).subject, 'Your account has been deleted');
  assert.equal(app.sentEmails.at(-1).to, 'kenya@example.com');

  assert.equal((await signIn(app.newClient())).status, 401, "the old password doesn't work");
  assert.equal((await signUp(app.newClient())).status, 201, 'the username and email are free again');
});

// --- Confirming it's really you ---------------------------------------------

test('a wrong password is refused and nothing changes', async () => {
  const client = await signedIn();
  const res = await askToDelete(client, { username: 'kenya', password: 'not my password' });
  assert.equal(res.status, 401);
  assert.equal(res.data.error, 'Incorrect password.');
  assert.equal(userRow().delete_after, null);
  assert.equal((await client.get('/api/me')).status, 200, 'still signed in');
  assert.equal(app.sentEmails.length, 0);
});

test('a missing password is refused', async () => {
  const res = await askToDelete(await signedIn(), { username: 'kenya' });
  assert.equal(res.status, 400);
  assert.equal(userRow().delete_after, null);
});

test('the username must be typed to confirm', async () => {
  const client = await signedIn();
  for (const username of ['', 'someone', undefined, ['kenya']]) {
    const res = await askToDelete(client, { username, password: PASSWORD });
    assert.equal(res.status, 400);
  }
  assert.equal((await askToDelete(client, { username: ' KENYA ', password: PASSWORD })).status, 200,
    'case and spaces are ignored, as at sign-in');
});

test('wrong passwords count towards the same lockout as signing in', async () => {
  const client = await signedIn();
  for (let i = 0; i < 4; i++) {
    assert.equal((await askToDelete(client, { username: 'kenya', password: `wrong ${i}` })).status, 401);
  }
  const locked = await askToDelete(client, { username: 'kenya', password: 'wrong 5' });
  assert.equal(locked.status, 429);
  assert.ok(locked.headers.get('retry-after'));
  assert.equal((await askToDelete(client)).status, 429, 'even the right password waits');
  assert.equal(userRow().delete_after, null);
});

test('you must be signed in', async () => {
  assert.equal((await askToDelete(app.newClient())).status, 401);
  assert.equal((await app.newClient().request('DELETE', '/api/account/deletion')).status, 401);
  assert.equal((await app.newClient().post('/api/account/confirm-options')).status, 401);
  assert.equal(userRow().delete_after, null);
});

test('requests from other websites are blocked (CSRF)', async () => {
  const client = await signedIn();
  const res = await client.post('/api/account/deletion', { username: 'kenya', password: PASSWORD }, {
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(res.status, 403);
  assert.equal(userRow().delete_after, null);
});

// --- Passkey-only accounts --------------------------------------------------

async function passkeyOnly() {
  const client = await signedIn();
  const passkey = await addPasskey(client);
  app.db.exec("UPDATE users SET password_hash = NULL WHERE username = 'kenya'");
  return { client, passkey };
}

test('an account without a password confirms with a passkey', async () => {
  const { client, passkey } = await passkeyOnly();
  assert.equal((await client.get('/api/me')).data.hasPassword, false);

  const { data: options } = await client.post('/api/account/confirm-options');
  assert.deepEqual(options.allowCredentials.map((c) => c.id), [passkey.id], 'only your own passkeys');
  assert.equal(options.userVerification, 'required');

  const res = await askToDelete(client, { username: 'kenya', passkey: passkey.authenticate(options) });
  assert.equal(res.status, 200);
  assert.ok(userRow().delete_after);
});

test("an account without a password can't skip the check", async () => {
  const { client } = await passkeyOnly();
  assert.equal((await askToDelete(client, { username: 'kenya', password: PASSWORD })).status, 400);
  assert.equal(userRow().delete_after, null);
});

test("someone else's passkey can't confirm", async () => {
  const { client } = await passkeyOnly();
  await signUp(app.newClient(), { username: 'other', email: 'other@example.com' });
  const otherPasskey = await addPasskey(await signedIn('other'));

  const { data: options } = await client.post('/api/account/confirm-options');
  const res = await askToDelete(client, { username: 'kenya', passkey: otherPasskey.authenticate(options) });
  assert.equal(res.status, 401);
  assert.equal(userRow().delete_after, null);
});

test('a sign-in challenge or a used challenge is refused', async () => {
  const { client, passkey } = await passkeyOnly();
  const { data: loginOptions } = await client.post('/api/passkeys/login/options');
  const fromLogin = await askToDelete(client, { username: 'kenya', passkey: passkey.authenticate(loginOptions) });
  assert.equal(fromLogin.status, 400, 'a sign-in challenge is for signing in only');

  const { data: options } = await client.post('/api/account/confirm-options');
  const response = passkey.authenticate(options);
  // Spend the challenge with a wrong username first: it still can't be used again.
  await askToDelete(client, { username: 'kenya', passkey: { ...response, id: 'nope' } });
  assert.equal((await askToDelete(client, { username: 'kenya', passkey: response })).status, 400);
  assert.equal(userRow().delete_after, null);
});

test('broken passkey responses are refused, not crashed on', async () => {
  const { client } = await passkeyOnly();
  for (const passkey of [null, 'x', 42, {}, { response: {} }]) {
    const res = await askToDelete(client, { username: 'kenya', passkey });
    assert.ok([400, 401].includes(res.status), `got ${res.status}`);
  }
  assert.equal(userRow().delete_after, null);
});

test('confirm options need at least one passkey', async () => {
  const res = await (await signedIn()).post('/api/account/confirm-options');
  assert.equal(res.status, 400);
});
