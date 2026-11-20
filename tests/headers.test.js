import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

let app;
before(async () => { app = await startApp(); });
after(() => app.close());

test('pages get a strict Content Security Policy', async () => {
  const res = await app.newClient().get('/signin');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/, "only our own scripts, no 'unsafe-inline'");
  assert.match(csp, /style-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/, "our pages can't be framed by other sites");
  assert.doesNotMatch(csp, /upgrade-insecure-requests/, 'not on plain-HTTP localhost');
});

test('other security headers', async () => {
  const res = await app.newClient().get('/signin');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null, "doesn't advertise Express");
  assert.equal(res.headers.get('strict-transport-security'), null, 'no HSTS on localhost');
});

test('no page uses inline scripts or styles (they would be blocked by the CSP)', async () => {
  for (const page of ['/', '/signup', '/signin', '/verify-email', '/recover', '/recover-continue']) {
    const html = (await app.newClient().get(page)).data;
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${page}: inline <script>`);
    assert.doesNotMatch(html, /\sstyle=/i, `${page}: style="..."`);
    assert.doesNotMatch(html, /\son[a-z]+=/i, `${page}: onclick= and similar`);
  }
});

test('unknown addresses get a JSON 404', async () => {
  const res = await app.newClient().get('/no-such-page');
  assert.equal(res.status, 404);
  assert.deepEqual(res.data, { error: 'Not found' });
});

test('health check works', async () => {
  const res = await app.newClient().get('/health');
  assert.deepEqual(res.data, { ok: true, users: 0 });
});
