import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { signIn, signUp, startApp } from './helpers.js';

let app;
before(async () => {
  app = await startApp();
  await signUp(app.newClient());
});
after(() => app.close());
beforeEach(() => {
  app.db.exec('DELETE FROM login_attempts');
  app.resetRateLimits();
});

test('sign-in: 20 failures per 15 minutes from one network, then blocked', async () => {
  // A different address each time, so the per-address lockout never kicks in.
  for (let i = 1; i <= 20; i++) {
    const res = await signIn(app.newClient(), `user${i}@example.com`, 'wrong password!');
    assert.equal(res.status, 401, `attempt ${i} is allowed`);
  }
  const blocked = await signIn(app.newClient(), 'user21@example.com', 'wrong password!');
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /from your network/);
  assert.ok(blocked.headers.get('ratelimit'), 'tells the client its limit');

  // Even the right password is blocked from this network for now.
  assert.equal((await signIn(app.newClient())).status, 429);
});

test("sign-in: successful sign-ins don't use up the limit", async () => {
  for (let i = 0; i < 25; i++) {
    assert.equal((await signIn(app.newClient())).status, 200);
  }
});

test('sign-up: 10 per hour from one network', async () => {
  for (let i = 1; i <= 10; i++) {
    const res = await signUp(app.newClient(), { firstName: 'Olly', email: `new${i}@example.com` });
    assert.equal(res.status, 201, `sign-up ${i} is allowed`);
  }
  const blocked = await signUp(app.newClient(), { firstName: 'Olly', email: 'new11@example.com' });
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /sign-ups/);
});

test('whole API: 300 requests per 15 minutes from one network', async () => {
  const client = app.newClient();
  for (let i = 0; i < 300; i++) await client.get('/api/me');
  assert.equal((await client.get('/api/me')).status, 429);
});
