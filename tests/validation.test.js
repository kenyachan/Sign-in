import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRegistration } from '../src/validation.js';

const good = { username: 'kenya', email: 'kenya@example.com', password: 'correct horse battery' };

test('accepts a valid sign-up', () => {
  assert.deepEqual(validateRegistration(good), {});
});

test('usernames: 3–30 letters, numbers, dots, dashes, underscores', () => {
  for (const username of ['ab', 'a'.repeat(31), 'has space', 'semi;colon', 'ünïcode', '', null, 42]) {
    assert.ok(validateRegistration({ ...good, username }).username, `should reject ${JSON.stringify(username)}`);
  }
  for (const username of ['abc', 'a'.repeat(30), 'first.last', 'kenya_99', 'k-n']) {
    assert.equal(validateRegistration({ ...good, username }).username, undefined, `should accept ${username}`);
  }
});

test('emails need an @ and a dot, and at most 254 characters', () => {
  for (const email of ['nope', 'a@b', '@example.com', 'a b@example.com', `${'a'.repeat(250)}@x.co`, null]) {
    assert.ok(validateRegistration({ ...good, email }).email, `should reject ${email}`);
  }
});

test('passwords: 12–128 characters, counting emoji as one', () => {
  assert.match(validateRegistration({ ...good, password: 'short' }).password, /at least 12/);
  assert.match(validateRegistration({ ...good, password: 'x'.repeat(129) }).password, /at most 128/);
  // 11 emoji are 22 JavaScript "characters" but only 11 real ones: still too short.
  assert.match(validateRegistration({ ...good, password: '🔒'.repeat(11) }).password, /at least 12/);
  assert.equal(validateRegistration({ ...good, password: '🔒'.repeat(12) }).password, undefined);
});

test("passwords can't contain the username", () => {
  assert.match(validateRegistration({ ...good, password: 'my-KENYA-password' }).password, /username/);
});

test('missing or wrong-type fields are rejected, not crashed on', () => {
  const errors = validateRegistration({});
  assert.deepEqual(Object.keys(errors).sort(), ['email', 'password', 'username']);
  assert.ok(validateRegistration({ ...good, password: ['array'] }).password);
});
