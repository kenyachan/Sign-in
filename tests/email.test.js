// Confirming the email address given at sign-up, and what happens until it is.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EMAIL, PASSWORD, signIn, signUp, startApp } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
let app;
let deleteUnconfirmedAccounts;
before(async () => {
  app = await startApp();
  ({ deleteUnconfirmedAccounts } = await import('../src/account-deletion.js'));
});
after(() => app.close());
beforeEach(() => {
  app.db.exec('DELETE FROM users; DELETE FROM login_attempts');   // also removes their sessions and email tokens
  app.sentEmails.length = 0;
  app.resetRateLimits();
});

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const tokenFrom = (email) => email.text.match(/verify-email#token=([A-Za-z0-9_-]+)/)[1];
const cancelTokenFrom = (email) => email.text.match(/cancel-signup#token=([A-Za-z0-9_-]+)/)[1];
const verify = (token) => app.newClient().post('/api/verify-email', { token });
const cancelSignup = (token) => app.newClient().post('/api/cancel-signup', { token });
const resend = (email = EMAIL) => app.newClient().post('/api/resend-verification', { email });
const isVerified = () => app.db.prepare('SELECT email_verified_at FROM users').get().email_verified_at !== null;
const userCount = () => app.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const unconfirmed = (overrides) => signUp(app.newClient(), overrides, { confirm: false });

// --- The confirmation email --------------------------------------------------

test('signing up sends a confirmation email with a one-time link and a cancel link', async () => {
  await unconfirmed();
  assert.equal(app.sentEmails.length, 1);
  const [email] = app.sentEmails;
  assert.equal(email.to, 'kenya@example.com');
  assert.match(email.subject, /confirm/i);
  assert.match(email.text, /http:\/\/localhost:3000\/verify-email#token=/);
  assert.match(email.text, /http:\/\/localhost:3000\/cancel-signup#token=/);
  assert.match(email.text, /within 7 days/);
  assert.match(email.html, /Confirm email address/);
  assert.match(email.html, /Cancel this sign-up/);
  assert.equal(isVerified(), false, 'not confirmed until the link is used');
});

test('the database keeps only hashes of the link tokens', async () => {
  await unconfirmed();
  const stored = app.db.prepare('SELECT token_hash, purpose FROM email_tokens ORDER BY purpose').all();
  assert.deepEqual(stored, [
    { token_hash: sha256(cancelTokenFrom(app.sentEmails[0])), purpose: 'cancel_signup' },
    { token_hash: sha256(tokenFrom(app.sentEmails[0])), purpose: 'verify_email' },
  ]);
});

test('using the link confirms the email, and then you can sign in', async () => {
  await unconfirmed();
  const res = await verify(tokenFrom(app.sentEmails[0]));
  assert.equal(res.status, 200);
  assert.match(res.data.message, /sign in/);
  assert.equal(isVerified(), true);

  const client = app.newClient();
  assert.equal((await signIn(client)).status, 200);
  assert.equal((await client.get('/api/me')).data.emailVerified, true);
});

test('each link works only once', async () => {
  await unconfirmed();
  const token = tokenFrom(app.sentEmails[0]);
  assert.equal((await verify(token)).status, 200);
  const again = await verify(token);
  assert.equal(again.status, 400);
  assert.match(again.data.error, /invalid, already used, or expired/);
});

test('links expire after 24 hours', async () => {
  await unconfirmed();
  app.db.exec("UPDATE email_tokens SET expires_at = '2000-01-01T00:00:00Z' WHERE purpose = 'verify_email'");
  assert.equal((await verify(tokenFrom(app.sentEmails[0]))).status, 400);
  assert.equal(isVerified(), false);
});

test('made-up, missing and wrong-type tokens are refused', async () => {
  await unconfirmed();
  for (const token of ['x'.repeat(43), '', undefined, 123, ['a'], 'a'.repeat(500), cancelTokenFrom(app.sentEmails[0])]) {
    assert.equal((await verify(token)).status, 400, `token: ${JSON.stringify(token)}`);
  }
  assert.equal(isVerified(), false);
});

test('links always use our own address, never one taken from the request', async () => {
  // A trick attackers use: send a request with a fake Host header, hoping the
  // email's link points to their site (and leaks the token to them).
  await app.newClient({ host: 'evil.example', 'x-forwarded-host': 'evil.example' })
    .post('/api/register', { firstName: 'Kenya', email: EMAIL, password: PASSWORD });
  assert.equal(app.sentEmails.length, 1);
  assert.doesNotMatch(app.sentEmails[0].text, /evil/);
  assert.match(app.sentEmails[0].text, /^http:\/\/localhost:3000\//m);
});

test('emails greet the user by first name, and HTML in a name is never treated as HTML', async () => {
  await unconfirmed();
  assert.match(app.sentEmails[0].text, /^Hi Kenya,/);
  assert.match(app.sentEmails[0].html, />Hi Kenya,</);

  const { verificationEmail } = await import('../src/emails.js');
  assert.match(verificationEmail(null, 'x'.repeat(43), 'y'.repeat(43)).text, /^Hi there,/, 'falls back when there is no name');
  assert.match(verificationEmail('<b>Kenya</b>', 'x'.repeat(43), 'y'.repeat(43)).html, /&lt;b&gt;Kenya&lt;\/b&gt;/);
});

test("names never go into the email's To: header", async () => {
  await unconfirmed();
  assert.equal(app.sentEmails[0].to, 'kenya@example.com');
});

// --- Unconfirmed accounts can't sign in ----------------------------------------

test('an unconfirmed account cannot sign in with its password', async () => {
  await unconfirmed();
  app.sentEmails.length = 0;
  const res = await signIn(app.newClient());
  assert.equal(res.status, 403);
  assert.equal(res.data.error, 'unconfirmed');
  assert.match(res.data.message, /confirm your email/);
  assert.equal(res.setCookies.length, 0, 'no session');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
});

test('the "please confirm" reply is only given for the right password', async () => {
  await unconfirmed();
  const wrong = await signIn(app.newClient(), EMAIL, 'not the password');
  const nobody = await signIn(app.newClient(), 'nobody@example.com', 'not the password');
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.data, nobody.data, 'looks exactly like any wrong password');
});

test('signing in unconfirmed sends a new link, but at most one every 5 minutes', async () => {
  await unconfirmed();
  const firstToken = tokenFrom(app.sentEmails[0]);
  app.sentEmails.length = 0;

  await signIn(app.newClient());
  assert.equal(app.sentEmails.length, 0, 'the sign-up email was only just sent');

  app.db.exec("UPDATE email_tokens SET created_at = '2000-01-01T00:00:00Z'");   // 5+ minutes later
  await signIn(app.newClient());
  await signIn(app.newClient());
  assert.equal(app.sentEmails.length, 1, 'one new link, not two');
  assert.equal((await verify(firstToken)).status, 400, 'the old link stops working');
  assert.equal((await verify(tokenFrom(app.sentEmails[0]))).status, 200);
  assert.equal((await signIn(app.newClient())).status, 200, 'and now sign-in works');
});

test("an unconfirmed sign-in doesn't count towards the lockout", async () => {
  await unconfirmed();
  for (let i = 0; i < 6; i++) assert.equal((await signIn(app.newClient())).status, 403);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n, 0);
});

// --- Asking for a new link without signing in ------------------------------------

test('a new link can be requested with just the email address', async () => {
  await unconfirmed();
  const oldToken = tokenFrom(app.sentEmails[0]);
  app.db.exec("UPDATE email_tokens SET created_at = '2000-01-01T00:00:00Z'");
  app.sentEmails.length = 0;

  const res = await resend(' Kenya@Example.com ');
  assert.equal(res.status, 200);
  assert.equal(app.sentEmails.length, 1);
  assert.equal((await verify(oldToken)).status, 400, 'old link no longer works');
  assert.equal((await verify(tokenFrom(app.sentEmails[0]))).status, 200);
});

test("the reply is the same whether the address is unconfirmed, confirmed or unknown", async () => {
  await unconfirmed();
  await signUp(app.newClient(), { firstName: 'Olly', email: 'confirmed@example.com' });
  app.db.exec("UPDATE email_tokens SET created_at = '2000-01-01T00:00:00Z'");
  app.sentEmails.length = 0;

  const replies = [await resend(EMAIL), await resend('confirmed@example.com'), await resend('nobody@example.com')];
  for (const reply of replies) {
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.data, replies[0].data);
  }
  assert.deepEqual(app.sentEmails.map((m) => m.to), [EMAIL], 'only the unconfirmed address gets an email');
});

test('asking for a new link: invalid addresses are refused, and requests are limited', async () => {
  for (const email of ['nope', '', 42, null]) assert.equal((await resend(email)).status, 400);
  app.resetRateLimits();
  for (let i = 0; i < 3; i++) assert.equal((await resend()).status, 200);
  assert.equal((await resend()).status, 429, 'at most 3 an hour for one address');
});

// --- Someone else's address --------------------------------------------------------

test("signing up with a confirmed account's email tells its owner, and sends no link", async () => {
  await signUp(app.newClient());
  app.sentEmails.length = 0;

  const res = await signUp(app.newClient(), { firstName: 'Olly', email: 'KENYA@example.com' }, { confirm: false });
  assert.equal(res.status, 201, 'the visitor still sees "success"');
  assert.equal(app.sentEmails.length, 1);
  assert.equal(app.sentEmails[0].to, 'kenya@example.com');
  assert.match(app.sentEmails[0].subject, /tried to sign up/);
  assert.doesNotMatch(app.sentEmails[0].text, /token=/, 'no link that could confirm anything');
  assert.equal(userCount(), 1);
});

test('signing up again with an unconfirmed address offers to confirm or cancel the first sign-up', async () => {
  await unconfirmed({ firstName: 'Squatter' });
  app.db.exec("UPDATE email_tokens SET created_at = '2000-01-01T00:00:00Z'");
  app.sentEmails.length = 0;

  const res = await unconfirmed();
  assert.equal(res.status, 201, 'the same reply as a new sign-up');
  assert.equal(userCount(), 1, 'no second account');
  const [email] = app.sentEmails;
  assert.match(email.subject, /Confirm or cancel/);
  assert.match(email.text, /^Hi there,/, "doesn't repeat the name the first person typed");
  assert.doesNotMatch(email.text, /Squatter/);

  // The owner of the address cancels it, then signs up themselves.
  assert.equal((await cancelSignup(cancelTokenFrom(email))).status, 200);
  assert.equal(userCount(), 0);
  assert.equal((await signUp(app.newClient())).status, 201);
  assert.equal((await signIn(app.newClient())).status, 200);
});

test('the cancel link deletes an unconfirmed account and everything in it', async () => {
  await unconfirmed();
  await signIn(app.newClient(), EMAIL, 'a wrong password');   // leaves a failed-attempt record
  const res = await cancelSignup(cancelTokenFrom(app.sentEmails[0]));
  assert.equal(res.status, 200);
  assert.match(res.data.message, /cancelled/);
  assert.equal(userCount(), 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM email_tokens').get().n, 0);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n, 0);
  assert.equal((await verify(tokenFrom(app.sentEmails[0]))).status, 400, 'the confirm link is gone too');
});

test('the cancel link can never delete a confirmed account', async () => {
  await unconfirmed();
  const cancelToken = cancelTokenFrom(app.sentEmails[0]);
  await verify(tokenFrom(app.sentEmails[0]));
  const res = await cancelSignup(cancelToken);
  assert.equal(res.status, 400, 'confirming removed the cancel link');
  assert.equal(userCount(), 1);
  assert.equal((await signIn(app.newClient())).status, 200);
});

test('made-up cancel tokens are refused', async () => {
  await unconfirmed();
  for (const token of ['x'.repeat(43), '', undefined, 123, tokenFrom(app.sentEmails[0])]) {
    assert.equal((await cancelSignup(token)).status, 400, `token: ${JSON.stringify(token)}`);
  }
  assert.equal(userCount(), 1);
});

// --- Deleted after 7 days ---------------------------------------------------------

test('unconfirmed accounts are deleted 7 days after sign-up, confirmed ones never', async () => {
  await unconfirmed();
  await signUp(app.newClient(), { firstName: 'Olly', email: 'confirmed@example.com' });
  app.sentEmails.length = 0;
  const now = Date.now() + 2000;   // created_at is stored to the second

  assert.equal(deleteUnconfirmedAccounts(now + 7 * DAY - 60 * 60 * 1000), 0, 'not after 6 days 23 hours');
  assert.equal(userCount(), 2);

  assert.equal(deleteUnconfirmedAccounts(now + 7 * DAY), 1);
  assert.deepEqual(app.db.prepare('SELECT email FROM users').all(), [{ email: 'confirmed@example.com' }]);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM email_tokens WHERE user_id NOT IN (SELECT id FROM users)').get().n, 0);
  assert.equal(app.sentEmails.length, 0, 'no email: the address was never confirmed');

  assert.equal(deleteUnconfirmedAccounts(now + 365 * DAY), 0, 'the confirmed account stays');
  assert.equal((await signUp(app.newClient())).status, 201, 'the address can be used again');
});
