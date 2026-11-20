// CSRF: another website tricking a signed-in visitor's browser into using our API.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { signIn, signUp, startApp } from './helpers.js';

let app;
before(async () => {
  app = await startApp();
  await signUp(app.newClient());
});
after(() => app.close());
beforeEach(() => app.resetRateLimits());

async function signedInClient() {
  const client = app.newClient();
  await signIn(client);
  return client;
}

test('blocks requests that browsers mark as coming from another site', async () => {
  const client = await signedInClient();
  for (const site of ['cross-site', 'same-site']) {
    const res = await client.post('/api/logout', undefined, { headers: { 'sec-fetch-site': site } });
    assert.equal(res.status, 403, `Sec-Fetch-Site: ${site}`);
  }
  assert.equal((await client.get('/api/me')).status, 200, 'still signed in: the attack did nothing');
});

test('blocks requests whose Origin is another website', async () => {
  const client = await signedInClient();
  for (const origin of ['https://evil.example', 'null', 'http://127.0.0.1:1']) {
    const res = await client.post('/api/logout', undefined, { headers: { origin } });
    assert.equal(res.status, 403, `Origin: ${origin}`);
  }
  assert.equal((await client.get('/api/me')).status, 200);
});

test('a cross-site attempt to sign someone in is blocked too', async () => {
  const res = await signIn(app.newClient({ 'sec-fetch-site': 'cross-site' }));
  assert.equal(res.status, 403);
});

test('allows our own pages', async () => {
  const client = await signedInClient();
  const res = await client.post('/api/logout', undefined, {
    headers: { 'sec-fetch-site': 'same-origin', origin: app.base },
  });
  assert.equal(res.status, 204);
});

test('allows reading (GET) from anywhere: only changes are checked', async () => {
  const client = await signedInClient();
  const res = await client.get('/api/me', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(res.status, 200);
});

test('the API only accepts JSON (what an HTML form on another site cannot send)', async () => {
  const client = app.newClient();
  for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
    const res = await client.request('POST', '/api/login', {
      body: 'username=kenya&password=x', headers: { 'content-type': type },
    });
    assert.equal(res.status, 415, type);
  }
});

test('the session cookie is SameSite=Lax', async () => {
  const res = await signIn(app.newClient());
  assert.match(res.setCookies.join(), /SameSite=Lax/i);
});
