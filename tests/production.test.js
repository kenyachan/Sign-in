// The same app with production settings, as if behind a hosting proxy that handles HTTPS.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { signIn, signUp, startApp } from './helpers.js';

const ORIGIN = 'https://login.example.com';
const viaHttps = { 'x-forwarded-proto': 'https' };

let app;
before(async () => {
  app = await startApp({ NODE_ENV: 'production', TRUST_PROXY: '1', APP_ORIGIN: ORIGIN });
  await signUp(app.newClient(viaHttps));
});
after(() => app.close());
beforeEach(() => app.resetRateLimits());

test('plain HTTP visitors are redirected to HTTPS', async () => {
  const res = await app.newClient({ 'x-forwarded-proto': 'http' }).get('/signin?x=1');
  assert.equal(res.status, 308);
  assert.match(res.headers.get('location'), /^https:\/\/.+\/signin\?x=1$/);
});

test('HSTS tells browsers to use HTTPS for a year', async () => {
  const res = await app.newClient(viaHttps).get('/signin');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains');
  assert.match(res.headers.get('content-security-policy'), /upgrade-insecure-requests/);
});

test('the session cookie is __Host-sid, Secure and HttpOnly', async () => {
  const res = await signIn(app.newClient(viaHttps));
  assert.equal(res.status, 200);
  const cookie = res.setCookies.find((c) => c.startsWith('__Host-sid='));
  assert.ok(cookie, 'uses the __Host- name');
  assert.match(cookie, /;\s*Secure/i);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, /Domain=/i, '__Host- cookies must not set a Domain');
});

test('Origin must match APP_ORIGIN', async () => {
  const ok = await signIn(app.newClient({ ...viaHttps, origin: ORIGIN }));
  assert.equal(ok.status, 200);
  const wrong = await signIn(app.newClient({ ...viaHttps, origin: 'https://login.example.com.evil.example' }));
  assert.equal(wrong.status, 403);
});
