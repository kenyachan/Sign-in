// Changing the email address an account signs in with.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { EMAIL, PASSWORD, signIn, signUp, startApp } from './helpers.js';
import { SoftPasskey } from './authenticator.js';

const NEW = 'kenya.new@example.org';
let app;
before(async () => { app = await startApp(); });
after(() => app.close());
beforeEach(async () => {
  app.db.exec('DELETE FROM users; DELETE FROM webauthn_challenges; DELETE FROM login_attempts');
  app.resetRateLimits();
  await signUp(app.newClient());
  app.sentEmails.length = 0;
});

async function signedIn(email = EMAIL) {
  const client = app.newClient();
  await signIn(client, email);
  return client;
}
const askToChange = (client, body = { newEmail: NEW, password: PASSWORD }) => client.post('/api/account/email', body);
const confirm = (token) => app.newClient().post('/api/account/email/confirm', { token });
const cancelFromOld = (token) => app.newClient().post('/api/account/email/cancel', { token });
const user = () => app.db.prepare('SELECT id, email, email_verified_at, pending_email FROM users WHERE id = (SELECT MIN(id) FROM users)').get();
const emailTo = (to) => app.sentEmails.filter((m) => m.to === to).at(-1);
const tokenIn = (email, page) => email.text.match(new RegExp(`${page}#token=([A-Za-z0-9_-]+)`))[1];

// --- Asking -------------------------------------------------------------------

test('asking saves the new address as pending and emails both addresses', async () => {
  const client = await signedIn();
  const res = await askToChange(client, { newEmail: '  Kenya.NEW@Example.org ', password: PASSWORD });
  assert.equal(res.status, 200);
  assert.equal(res.data.pendingEmail, NEW);
  assert.match(res.data.message, /won't change until/);

  assert.equal(user().email, EMAIL, 'nothing changes yet');
  assert.equal(user().pending_email, NEW);
  assert.equal((await client.get('/api/me')).data.pendingEmail, NEW);

  const toNew = emailTo(NEW);
  assert.equal(toNew.subject, 'Confirm your new email address');
  assert.match(toNew.text, /^Hi Kenya,/);
  assert.match(toNew.text, /\/confirm-email-change#token=/);

  const toOld = emailTo(EMAIL);
  assert.equal(toOld.subject, 'Your sign-in email is being changed');
  assert.match(toOld.text, /k\*\*\*@example\.org/, 'shows a hint of the new address, not all of it');
  assert.doesNotMatch(toOld.text, /kenya\.new/);
  assert.match(toOld.text, /\/cancel-email-change#token=/);

  assert.equal((await signIn(app.newClient(), EMAIL)).status, 200, 'still signs in with the old address');
  assert.equal((await signIn(app.newClient(), NEW)).status, 401, 'not with the new one yet');
});

test('you must confirm it is you: a wrong or missing password changes nothing', async () => {
  const client = await signedIn();
  assert.equal((await askToChange(client, { newEmail: NEW, password: 'not my password' })).status, 401);
  assert.equal((await askToChange(client, { newEmail: NEW })).status, 400);
  assert.equal(user().pending_email, null);
  assert.equal(app.sentEmails.length, 0);
});

test('wrong passwords count towards the sign-in lockout', async () => {
  const client = await signedIn();
  for (let i = 0; i < 4; i++) await askToChange(client, { newEmail: NEW, password: `wrong ${i}` });
  const locked = await askToChange(client, { newEmail: NEW, password: 'wrong 5' });
  assert.equal(locked.status, 429);
  assert.equal((await signIn(app.newClient())).status, 429, 'the sign-in form is locked too');
});

test('an account without a password confirms with one of its passkeys', async () => {
  const client = await signedIn();
  const passkey = new SoftPasskey();
  const { data: regOptions } = await client.post('/api/passkeys/register/options');
  await client.post('/api/passkeys/register/verify', { response: passkey.register(regOptions) });
  app.db.exec('UPDATE users SET password_hash = NULL');

  assert.equal((await askToChange(client, { newEmail: NEW, password: PASSWORD })).status, 400);
  const { data: options } = await client.post('/api/account/confirm-options');
  const res = await askToChange(client, { newEmail: NEW, passkey: passkey.authenticate(options) });
  assert.equal(res.status, 200);
  assert.equal(user().pending_email, NEW);
});

test('the new address must be a valid, different address', async () => {
  const client = await signedIn();
  for (const newEmail of ['nope', '', undefined, 42, ['a@b.co'], ' KENYA@example.com ']) {
    const res = await askToChange(client, { newEmail, password: PASSWORD });
    assert.equal(res.status, 400, `should refuse ${JSON.stringify(newEmail)}`);
    assert.ok(res.data.errors.newEmail);
  }
  assert.equal(user().pending_email, null);
});

test('you must be signed in, and requests from other websites are blocked', async () => {
  assert.equal((await askToChange(app.newClient())).status, 401);
  const client = await signedIn();
  const res = await client.post('/api/account/email', { newEmail: NEW, password: PASSWORD },
    { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(res.status, 403);
  assert.equal(user().pending_email, null);
});

test('at most 5 requests an hour per account', async () => {
  const client = await signedIn();
  for (let i = 0; i < 5; i++) assert.equal((await askToChange(client, { newEmail: `n${i}@example.org`, password: PASSWORD })).status, 200);
  assert.equal((await askToChange(client)).status, 429);
});

test("an address that already has an account gets the same reply, but no link", async () => {
  await signUp(app.newClient(), { firstName: 'Olly', email: 'olly@example.com' });
  app.sentEmails.length = 0;
  const client = await signedIn();

  const taken = await askToChange(client, { newEmail: 'olly@example.com', password: PASSWORD });
  app.resetRateLimits();
  const free = await askToChange(client, { newEmail: NEW, password: PASSWORD });
  assert.equal(taken.status, free.status);
  assert.deepEqual(Object.keys(taken.data), Object.keys(free.data));

  const toOlly = emailTo('olly@example.com');
  assert.equal(toOlly.subject, 'Someone tried to use your email address');
  assert.doesNotMatch(toOlly.text, /token=/, 'no link that could change anything');
  assert.doesNotMatch(toOlly.text, /Kenya/);
});

test('asking again replaces the earlier request, and its link stops working', async () => {
  const client = await signedIn();
  await askToChange(client, { newEmail: 'first@example.org', password: PASSWORD });
  const firstToken = tokenIn(emailTo('first@example.org'), 'confirm-email-change');
  await askToChange(client);
  assert.equal(user().pending_email, NEW);
  assert.equal((await confirm(firstToken)).status, 400);
  assert.equal(user().email, EMAIL);
});

test('asking for a different address that is taken also stops the earlier link', async () => {
  await signUp(app.newClient(), { firstName: 'Olly', email: 'olly@example.com' });
  const client = await signedIn();
  await askToChange(client);
  const firstToken = tokenIn(emailTo(NEW), 'confirm-email-change');
  await askToChange(client, { newEmail: 'olly@example.com', password: PASSWORD });
  assert.equal((await confirm(firstToken)).status, 400);
});

test('no change while the account is scheduled for deletion', async () => {
  const client = await signedIn();
  app.db.exec("UPDATE users SET delete_after = '2999-01-01T00:00:00Z'");
  assert.equal((await askToChange(client)).status, 409);
});

// --- Confirming ---------------------------------------------------------------

test('confirming switches the address, marks it confirmed and signs out every device', async () => {
  const laptop = await signedIn();
  const phone = await signedIn();
  await askToChange(laptop);
  app.db.exec('UPDATE users SET email_verified_at = \'2026-01-01T00:00:00Z\'');
  const token = tokenIn(emailTo(NEW), 'confirm-email-change');
  app.sentEmails.length = 0;

  const res = await laptop.post('/api/account/email/confirm', { token });
  assert.equal(res.status, 200);
  assert.match(res.data.message, /Sign in with your new address/);
  assert.equal(laptop.cookies.has('sid'), false, "this browser's cookie is cleared");

  const row = user();
  assert.equal(row.email, NEW);
  assert.equal(row.pending_email, null);
  assert.notEqual(row.email_verified_at, '2026-01-01T00:00:00Z', 'confirmed again, just now');
  assert.equal((await phone.get('/api/me')).status, 401, 'every device is signed out');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);

  assert.equal((await signIn(app.newClient(), NEW)).status, 200, 'signs in with the new address');
  assert.equal((await signIn(app.newClient(), EMAIL)).status, 401, 'not the old one');

  assert.equal(emailTo(EMAIL).subject, 'Your sign-in email was changed');
  assert.match(emailTo(EMAIL).text, /k\*\*\*@example\.org/);
  assert.equal(emailTo(NEW).subject, 'Your email address has been changed');
});

test('the link can be opened on another device without signing in, and works once', async () => {
  await askToChange(await signedIn());
  const token = tokenIn(emailTo(NEW), 'confirm-email-change');
  assert.equal((await confirm(token)).status, 200);
  assert.equal((await confirm(token)).status, 400);
});

test('confirm links expire after 24 hours, and made-up ones are refused', async () => {
  await askToChange(await signedIn());
  const token = tokenIn(emailTo(NEW), 'confirm-email-change');
  for (const bad of ['x'.repeat(43), '', undefined, 7, tokenIn(emailTo(EMAIL), 'cancel-email-change')]) {
    assert.equal((await confirm(bad)).status, 400, `token: ${JSON.stringify(bad)}`);
  }
  app.db.exec("UPDATE email_tokens SET expires_at = '2000-01-01T00:00:00Z' WHERE purpose = 'change_email'");
  assert.equal((await confirm(token)).status, 400);
  assert.equal(user().email, EMAIL);
});

test('if someone else takes the address in the meantime, nothing changes', async () => {
  await askToChange(await signedIn());
  const token = tokenIn(emailTo(NEW), 'confirm-email-change');
  await signUp(app.newClient(), { firstName: 'Olly', email: NEW });

  const res = await confirm(token);
  assert.equal(res.status, 409);
  assert.match(res.data.error, /another account/);
  assert.equal(user().email, EMAIL);
  assert.equal(user().pending_email, null);
  assert.equal((await signIn(app.newClient())).status, 200, 'the account still works as before');
});

test('the lockout follows the new address', async () => {
  await askToChange(await signedIn());
  await signIn(app.newClient(), EMAIL, 'a wrong password');
  await confirm(tokenIn(emailTo(NEW), 'confirm-email-change'));
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n, 0);
});

// --- Cancelling ---------------------------------------------------------------

test('the change can be cancelled from the account page, and its link stops working', async () => {
  const client = await signedIn();
  await askToChange(client);
  const token = tokenIn(emailTo(NEW), 'confirm-email-change');

  const res = await client.request('DELETE', '/api/account/email/pending');
  assert.equal(res.status, 200);
  assert.equal(user().pending_email, null);
  assert.equal((await confirm(token)).status, 400);
  assert.equal((await client.request('DELETE', '/api/account/email/pending')).status, 409, 'nothing left to cancel');
});

test('the old address can cancel the change with its link', async () => {
  await askToChange(await signedIn());
  const confirmToken = tokenIn(emailTo(NEW), 'confirm-email-change');
  const res = await cancelFromOld(tokenIn(emailTo(EMAIL), 'cancel-email-change'));
  assert.equal(res.status, 200);
  assert.match(res.data.message, /cancelled/);
  assert.equal(user().pending_email, null);
  assert.equal((await confirm(confirmToken)).status, 400, 'the new address can no longer confirm');
});

test("once confirmed, the old address's link says it's too late", async () => {
  await askToChange(await signedIn());
  const cancelToken = tokenIn(emailTo(EMAIL), 'cancel-email-change');
  await confirm(tokenIn(emailTo(NEW), 'confirm-email-change'));
  const res = await cancelFromOld(cancelToken);
  assert.equal(res.status, 409);
  assert.match(res.data.error, /already been confirmed/);
  assert.equal(user().email, NEW);
});

test('made-up cancel tokens are refused', async () => {
  await askToChange(await signedIn());
  for (const bad of ['x'.repeat(43), '', undefined, tokenIn(emailTo(NEW), 'confirm-email-change')]) {
    assert.equal((await cancelFromOld(bad)).status, 400, `token: ${JSON.stringify(bad)}`);
  }
  assert.equal(user().pending_email, NEW);
});

test('account recovery cancels a pending change', async () => {
  await askToChange(await signedIn());
  const confirmToken = tokenIn(emailTo(NEW), 'confirm-email-change');
  await app.newClient().post('/api/recovery/request', { email: EMAIL });
  const recoveryToken = tokenIn(emailTo(EMAIL), 'recover-continue');
  assert.equal((await app.newClient().post('/api/recovery/signin', { token: recoveryToken })).status, 200);
  assert.equal(user().pending_email, null);
  assert.equal((await confirm(confirmToken)).status, 400);
});

// --- Sending the link again -----------------------------------------------------

test('the link can be sent again to the pending address', async () => {
  const client = await signedIn();
  assert.equal((await client.post('/api/account/email/resend')).status, 409, 'nothing pending yet');
  await askToChange(client);
  const oldToken = tokenIn(emailTo(NEW), 'confirm-email-change');
  const res = await client.post('/api/account/email/resend');
  assert.equal(res.status, 200);
  assert.equal((await confirm(oldToken)).status, 400, 'the earlier link stops working');
  assert.equal((await confirm(tokenIn(emailTo(NEW), 'confirm-email-change'))).status, 200);
});
