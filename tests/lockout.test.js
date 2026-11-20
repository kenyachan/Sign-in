import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { PASSWORD, signIn, signUp, startApp } from './helpers.js';

let app;
before(async () => {
  app = await startApp();
  await signUp(app.newClient());
});
after(() => app.close());
beforeEach(() => {
  app.db.exec('DELETE FROM login_attempts');
  app.resetRateLimits();   // so the per-IP limit doesn't get in the way here
});

async function failTimes(username, n) {
  const results = [];
  for (let i = 0; i < n; i++) results.push(await signIn(app.newClient(), username, 'wrong password!'));
  return results;
}

test('locks a username for 15 minutes after 5 wrong passwords', async () => {
  const results = await failTimes('kenya', 5);
  assert.deepEqual(results.map((r) => r.status), [401, 401, 401, 401, 429]);
  assert.match(results[4].data.error, /15 minutes/);
  assert.equal(results[4].headers.get('retry-after'), '900');
});

test('the right password is refused while locked', async () => {
  await failTimes('kenya', 5);
  const res = await signIn(app.newClient(), 'kenya', PASSWORD);
  assert.equal(res.status, 429);
  assert.equal(res.setCookies.length, 0);
});

test("lockout counts the username however it's capitalised", async () => {
  await failTimes('kenya', 3);
  await failTimes('KENYA', 2);
  assert.equal((await signIn(app.newClient())).status, 429);
});

test("made-up usernames lock exactly like real ones (can't reveal who exists)", async () => {
  const real = await failTimes('kenya', 6);
  const fake = await failTimes('ghost', 6);
  assert.deepEqual(fake.map((r) => r.status), real.map((r) => r.status));
  assert.deepEqual(fake.map((r) => r.data), real.map((r) => r.data));
});

test('can sign in again once the lock runs out, and the count resets', async () => {
  await failTimes('kenya', 5);
  app.db.exec("UPDATE login_attempts SET locked_until = '2000-01-01T00:00:00Z'");

  assert.equal((await signIn(app.newClient())).status, 200);
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get().n, 0);
});

test('a successful sign-in clears earlier failures', async () => {
  await failTimes('kenya', 4);
  assert.equal((await signIn(app.newClient())).status, 200);
  const after = await failTimes('kenya', 4);
  assert.ok(after.every((r) => r.status === 401), 'needs another 5 failures to lock');
});

test('each further lock doubles: 15 min, then 30 min', async () => {
  await failTimes('kenya', 5);
  app.db.exec("UPDATE login_attempts SET locked_until = '2000-01-01T00:00:00Z'");
  const second = await failTimes('kenya', 5);
  assert.equal(second[4].status, 429);
  assert.match(second[4].data.error, /30 minutes/);
  assert.equal(second[4].headers.get('retry-after'), '1800');
});

test('failures older than a day are forgotten', async () => {
  await failTimes('kenya', 4);
  const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
  app.db.prepare('UPDATE login_attempts SET last_failed_at = ?').run(longAgo);
  const [next] = await failTimes('kenya', 1);
  assert.equal(next.status, 401, 'starts counting again from 1');
});
