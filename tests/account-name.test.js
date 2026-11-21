// Changing your name on the account page.
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
  app.db.exec("DELETE FROM sessions; UPDATE users SET first_name = 'Kenya', last_name = 'Chan'");
  app.resetRateLimits();
});

const changeName = (client, body) => client.request('PATCH', '/api/account/name', { json: body });
const storedName = () => app.db.prepare('SELECT first_name, last_name FROM users').get();

async function signedIn() {
  const client = app.newClient();
  await signIn(client);
  return client;
}

test('a signed-in user can change their name', async () => {
  const client = await signedIn();
  const res = await changeName(client, { firstName: ' Kenya  Mei ', lastName: 'Chan-Wong' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data, { firstName: 'Kenya Mei', lastName: 'Chan-Wong' });
  assert.deepEqual(storedName(), { first_name: 'Kenya Mei', last_name: 'Chan-Wong' });

  const me = (await client.get('/api/me')).data;
  assert.equal(me.firstName, 'Kenya Mei');
  assert.equal(me.lastName, 'Chan-Wong');
});

test('the last name can be removed', async () => {
  const res = await changeName(await signedIn(), { firstName: 'Kenya', lastName: '' });
  assert.equal(res.status, 200);
  assert.deepEqual(storedName(), { first_name: 'Kenya', last_name: null });
});

test('the first name is required and both names are checked', async () => {
  const client = await signedIn();
  for (const body of [{}, { firstName: '' }, { firstName: '  ' }, { firstName: 'Kenya1' },
    { firstName: 'Kenya', lastName: '<script>' }, { firstName: 'a'.repeat(51) }, { firstName: ['Kenya'] }]) {
    const res = await changeName(client, body);
    assert.equal(res.status, 400, `should refuse ${JSON.stringify(body)}`);
    assert.ok(res.data.errors);
  }
  assert.deepEqual(storedName(), { first_name: 'Kenya', last_name: 'Chan' }, 'nothing changed');
});

test('you must be signed in', async () => {
  const res = await changeName(app.newClient(), { firstName: 'Intruder' });
  assert.equal(res.status, 401);
  assert.deepEqual(storedName(), { first_name: 'Kenya', last_name: 'Chan' });
});

test('requests from other websites are refused (CSRF)', async () => {
  const client = await signedIn();
  const res = await client.request('PATCH', '/api/account/name', {
    json: { firstName: 'Hacked' },
    headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(res.status, 403);
  assert.deepEqual(storedName(), { first_name: 'Kenya', last_name: 'Chan' });
});

test('emails use the new first name', async () => {
  const client = await signedIn();
  await changeName(client, { firstName: 'Mei' });
  app.sentEmails.length = 0;
  await app.newClient().post('/api/recovery/request', { email: 'kenya@example.com' });
  assert.match(app.sentEmails.at(-1).text, /^Hi Mei,/);
});
