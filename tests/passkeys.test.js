import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { signIn, signUp, startApp } from './helpers.js';
import { SoftPasskey } from './authenticator.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());
beforeEach(async () => {
  app.db.exec('DELETE FROM users; DELETE FROM webauthn_challenges; DELETE FROM login_attempts');
  app.resetRateLimits();
  await signUp(app.newClient());
});

async function signedIn(username = 'kenya') {
  const client = app.newClient({ 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' });
  await signIn(client, username);
  return client;
}

async function addPasskey(client, passkey = new SoftPasskey()) {
  const { data: options } = await client.post('/api/passkeys/register/options');
  const res = await client.post('/api/passkeys/register/verify', { response: passkey.register(options) });
  return { res, passkey, options };
}

async function passkeySignIn(passkey, client = app.newClient(), extra = {}) {
  const { data: options } = await client.post('/api/passkeys/login/options');
  const response = passkey.authenticate(options, extra);
  return { res: await client.post('/api/passkeys/login/verify', { response }), client, options, response };
}

// --- Adding a passkey ------------------------------------------------------

test('registration options ask for a real passkey for this site', async () => {
  const client = await signedIn();
  const { data } = await client.post('/api/passkeys/register/options');
  assert.equal(data.rp.id, 'localhost');
  assert.equal(data.user.name, 'kenya');
  const { webauthn_user_id } = app.db.prepare('SELECT webauthn_user_id FROM users').get();
  assert.equal(data.user.id, webauthn_user_id, 'random ID, not the username');
  assert.equal(data.authenticatorSelection.residentKey, 'required');
  assert.equal(data.authenticatorSelection.userVerification, 'required');
  assert.ok(data.challenge.length >= 43, 'long random challenge');
});

test('adding a passkey stores its public key', async () => {
  const client = await signedIn();
  const { res, passkey } = await addPasskey(client);
  assert.equal(res.status, 201);
  assert.equal(res.data.nickname, 'Passkey on Mac');
  assert.equal(res.data.synced, true);

  const row = app.db.prepare('SELECT * FROM passkeys').get();
  assert.equal(row.credential_id, passkey.id);
  assert.ok(row.public_key.length > 60);
  assert.deepEqual(JSON.parse(row.transports), ['internal', 'hybrid']);
});

test('adding a passkey needs you to be signed in', async () => {
  const client = app.newClient();
  assert.equal((await client.post('/api/passkeys/register/options')).status, 401);
  assert.equal((await client.post('/api/passkeys/register/verify', { response: {} })).status, 401);
  assert.equal((await client.get('/api/passkeys')).status, 401);
});

test('a device that already has a passkey for the account is excluded', async () => {
  const client = await signedIn();
  const { passkey } = await addPasskey(client);
  const { data } = await client.post('/api/passkeys/register/options');
  assert.deepEqual(data.excludeCredentials.map((c) => c.id), [passkey.id]);
});

test('the same passkey cannot be added twice', async () => {
  const client = await signedIn();
  const { passkey } = await addPasskey(client);
  const { res } = await addPasskey(client, passkey);
  assert.equal(res.status, 409);
});

test('each registration challenge works once', async () => {
  const client = await signedIn();
  const passkey = new SoftPasskey();
  const { data: options } = await client.post('/api/passkeys/register/options');
  const response = passkey.register(options);
  assert.equal((await client.post('/api/passkeys/register/verify', { response })).status, 201);
  assert.equal((await client.post('/api/passkeys/register/verify', { response })).status, 400);
});

test('challenges expire after 5 minutes', async () => {
  const client = await signedIn();
  const { data: options } = await client.post('/api/passkeys/register/options');
  app.db.exec("UPDATE webauthn_challenges SET expires_at = '2000-01-01T00:00:00Z'");
  const res = await client.post('/api/passkeys/register/verify', { response: new SoftPasskey().register(options) });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /expired/);
});

test("you can't finish adding a passkey with someone else's challenge", async () => {
  await signUp(app.newClient(), { username: 'other', email: 'other@example.com' });
  const victim = await signedIn('kenya');
  const attacker = await signedIn('other');
  const { data: options } = await victim.post('/api/passkeys/register/options');
  const res = await attacker.post('/api/passkeys/register/verify', { response: new SoftPasskey().register(options) });
  assert.equal(res.status, 400);
});

test('a passkey made on another website is refused', async () => {
  const client = await signedIn();
  const { data: options } = await client.post('/api/passkeys/register/options');
  const response = new SoftPasskey().register(options, { origin: 'https://evil.example' });
  assert.equal((await client.post('/api/passkeys/register/verify', { response })).status, 400);
});

test('broken registration responses are refused, not crashed on', async () => {
  const client = await signedIn();
  for (const response of [undefined, {}, { response: {} }, { response: { clientDataJSON: '!!!' } }, 'x']) {
    const res = await client.post('/api/passkeys/register/verify', { response });
    assert.equal(res.status, 400, JSON.stringify(response));
  }
});

// --- Signing in with a passkey --------------------------------------------

test('signing in with a passkey starts a session', async () => {
  const { passkey } = await addPasskey(await signedIn());
  const { res, client } = await passkeySignIn(passkey);
  assert.equal(res.status, 200);
  assert.equal(res.data.username, 'kenya');
  assert.equal((await client.get('/api/me')).data.username, 'kenya');

  const row = app.db.prepare('SELECT sign_count, last_used_at FROM passkeys').get();
  assert.equal(row.sign_count, 1);
  assert.ok(row.last_used_at);
});

test('login options let the device pick the passkey (no username needed)', async () => {
  const { data } = await app.newClient().post('/api/passkeys/login/options');
  assert.equal(data.rpId, 'localhost');
  assert.equal(data.userVerification, 'required');
  assert.ok(!data.allowCredentials || data.allowCredentials.length === 0);
});

test('passkey sign-in still works while the password is locked out', async () => {
  const { passkey } = await addPasskey(await signedIn());
  for (let i = 0; i < 5; i++) await signIn(app.newClient(), 'kenya', 'wrong password!');
  assert.equal((await signIn(app.newClient())).status, 429, 'password sign-in is locked');
  assert.equal((await passkeySignIn(passkey)).res.status, 200, 'passkey still works');
});

test('a passkey the server has never seen is refused', async () => {
  const { res } = await passkeySignIn(new SoftPasskey());
  assert.equal(res.status, 401);
});

test('a sign-in from a look-alike website is refused (phishing)', async () => {
  const { passkey } = await addPasskey(await signedIn());
  const { res } = await passkeySignIn(passkey, app.newClient(), { origin: 'https://kenyachan-login.example' });
  assert.equal(res.status, 401);
  assert.equal(res.setCookies.length, 0);
});

test('a forged signature is refused', async () => {
  const { passkey } = await addPasskey(await signedIn());
  const impostor = new SoftPasskey();
  impostor.credentialId = passkey.credentialId;   // same ID, different private key
  impostor.userHandle = passkey.userHandle;
  assert.equal((await passkeySignIn(impostor)).res.status, 401);
});

test('a captured sign-in cannot be replayed', async () => {
  const { passkey } = await addPasskey(await signedIn());
  const first = await passkeySignIn(passkey);
  assert.equal(first.res.status, 200);
  const replay = await app.newClient().post('/api/passkeys/login/verify', { response: first.response });
  assert.equal(replay.status, 400, 'challenge already used');
});

test('a counter going backwards (a copied passkey) is refused', async () => {
  const { passkey } = await addPasskey(await signedIn());
  assert.equal((await passkeySignIn(passkey, app.newClient(), { counter: 5 })).res.status, 200);
  assert.equal((await passkeySignIn(passkey, app.newClient(), { counter: 3 })).res.status, 401);
});

test("the passkey's account ID must match", async () => {
  const { passkey } = await addPasskey(await signedIn());
  passkey.userHandle = 'c29tZW9uZS1lbHNl';
  assert.equal((await passkeySignIn(passkey)).res.status, 401);
});

test('broken sign-in responses are refused, not crashed on', async () => {
  const client = app.newClient();
  for (const response of [undefined, {}, { id: 5, response: {} }, 'x']) {
    const res = await client.post('/api/passkeys/login/verify', { response });
    assert.ok([400, 401].includes(res.status), JSON.stringify(response));
  }
});

// --- Managing passkeys ----------------------------------------------------

test('listing passkeys shows names and dates, never keys', async () => {
  const client = await signedIn();
  await addPasskey(client);
  await addPasskey(client, new SoftPasskey({ synced: false }));
  const { data } = await client.get('/api/passkeys');
  assert.equal(data.length, 2);
  assert.deepEqual(Object.keys(data[0]).sort(), ['createdAt', 'id', 'lastUsedAt', 'nickname', 'synced']);
  assert.deepEqual(data.map((p) => p.synced), [true, false]);
});

test('removing a passkey means it can no longer sign in', async () => {
  const client = await signedIn();
  const { res: added, passkey } = await addPasskey(client);
  assert.equal((await client.request('DELETE', `/api/passkeys/${added.data.id}`)).status, 204);
  assert.equal((await passkeySignIn(passkey)).res.status, 401);
});

test("you can't remove someone else's passkey", async () => {
  const { res: added } = await addPasskey(await signedIn('kenya'));
  await signUp(app.newClient(), { username: 'other', email: 'other@example.com' });
  const other = await signedIn('other');
  assert.equal((await other.request('DELETE', `/api/passkeys/${added.data.id}`)).status, 404);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM passkeys').get().n, 1);
});

test("you can't remove your last passkey if you have no password", async () => {
  const client = await signedIn();
  const { res: added } = await addPasskey(client);
  app.db.exec('UPDATE users SET password_hash = NULL');
  const res = await client.request('DELETE', `/api/passkeys/${added.data.id}`);
  assert.equal(res.status, 409);
  assert.match(res.data.error, /only way to sign in/);
});

test('removing a passkey is protected against other websites (CSRF)', async () => {
  const client = await signedIn();
  const { res: added } = await addPasskey(client);
  const res = await client.request('DELETE', `/api/passkeys/${added.data.id}`, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(res.status, 403);
});

test('the browser library is served from our own site', async () => {
  const res = await app.newClient().get('/vendor/simplewebauthn/index.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
});

// --- Naming passkeys --------------------------------------------------------

const rename = (client, id, nickname) =>
  client.request('PATCH', `/api/passkeys/${id}`, { json: { nickname } });

test('a passkey can be renamed', async () => {
  const client = await signedIn();
  const { res: added } = await addPasskey(client);
  const res = await rename(client, added.data.id, '  1Password   on  MacBook ');
  assert.equal(res.status, 200);
  assert.equal(res.data.nickname, '1Password on MacBook', 'trimmed, spaces squeezed');
  assert.equal((await client.get('/api/passkeys')).data[0].nickname, '1Password on MacBook');
});

test('names must be 1–50 characters of real text', async () => {
  const client = await signedIn();
  const { res: added } = await addPasskey(client);
  for (const nickname of ['', '   ', '​​', 'x'.repeat(51), 42, null, ['a']]) {
    const res = await rename(client, added.data.id, nickname);
    assert.equal(res.status, 400, JSON.stringify(nickname));
  }
  assert.equal((await rename(client, added.data.id, '🔑'.repeat(50))).status, 200, 'emoji count as one character');
});

test('invisible and control characters are removed from names', async () => {
  const client = await signedIn();
  const { res: added } = await addPasskey(client);
  const res = await rename(client, added.data.id, 'iPhone\u0000‮​\n');
  assert.equal(res.data.nickname, 'iPhone');
});

test('names are stored as plain text, never run as HTML', async () => {
  const client = await signedIn();
  const { res: added } = await addPasskey(client);
  const res = await rename(client, added.data.id, '<img src=x onerror=alert(1)>');
  assert.equal(res.data.nickname, '<img src=x onerror=alert(1)>');
  // (The account page shows names with textContent, so this displays as text.)
});

test("you can't rename someone else's passkey", async () => {
  const { res: added } = await addPasskey(await signedIn('kenya'));
  await signUp(app.newClient(), { username: 'other', email: 'other@example.com' });
  const other = await signedIn('other');
  assert.equal((await rename(other, added.data.id, 'mine now')).status, 404);
  assert.notEqual(app.db.prepare('SELECT nickname FROM passkeys').get().nickname, 'mine now');
});

test('renaming needs sign-in and is protected against other websites', async () => {
  const client = await signedIn();
  const { res: added } = await addPasskey(client);
  assert.equal((await rename(app.newClient(), added.data.id, 'x')).status, 401);
  const crossSite = await client.request('PATCH', `/api/passkeys/${added.data.id}`, {
    json: { nickname: 'x' }, headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(crossSite.status, 403);
});
