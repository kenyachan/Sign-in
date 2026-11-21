import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNames, validateRegistration } from '../src/validation.js';

const good = { firstName: 'Kenya', lastName: 'Chan', email: 'kenya@example.com', password: 'correct horse battery' };

test('accepts a valid sign-up', () => {
  assert.deepEqual(validateRegistration(good), {});
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

test("passwords can't contain the email address", () => {
  assert.match(validateRegistration({ ...good, password: 'my-KENYA-chan-pw' }).password, /name|email/);
  assert.match(validateRegistration({ ...good, firstName: 'Mei', lastName: undefined, password: 'my-KENYA-password' }).password,
    /email address/, 'the part before the @');
});

test('missing or wrong-type fields are rejected, not crashed on', () => {
  const errors = validateRegistration({});
  assert.deepEqual(Object.keys(errors).sort(), ['email', 'firstName', 'password']);
  assert.ok(validateRegistration({ ...good, password: ['array'] }).password);
});

test('names: letters from any language, spaces, hyphens, apostrophes', () => {
  for (const firstName of ["O'Brien", 'Nguyễn', 'José María', 'Jean-Luc', 'D’Angelo', 'J. R.', 'Zoë', '李', 'Ólafur']) {
    assert.equal(validateRegistration({ ...good, firstName }).firstName, undefined, `should accept ${firstName}`);
  }
  for (const firstName of ['', '   ', 'a'.repeat(51), 'Kenya2', '<script>', 'evil.com/login', 'http://x.co',
    'me@example.com', 'Kenya\u0000', 'Ken\u200bya', "'-.", null, 42, ['Kenya']]) {
    assert.ok(validateRegistration({ ...good, firstName }).firstName, `should reject ${JSON.stringify(firstName)}`);
  }
});

test('first name is required, last name is optional', () => {
  assert.match(validateRegistration({ ...good, firstName: undefined }).firstName, /first name/);
  assert.equal(validateRegistration({ ...good, lastName: undefined }).lastName, undefined);
  assert.equal(validateRegistration({ ...good, lastName: '' }).lastName, undefined);
  assert.ok(validateRegistration({ ...good, lastName: 'Chan3' }).lastName, 'a given last name is still checked');
});

test('names are tidied: trimmed, spaces squeezed, empty last name becomes null', () => {
  assert.deepEqual(checkNames({ firstName: '  José   María ', lastName: '  ' }),
    { firstName: 'José María', lastName: null, errors: {} });
  // The same letter typed two different ways (é as one character, or e + accent) is stored the same way.
  assert.equal(checkNames({ firstName: 'Jose\u0301' }).firstName, 'Jos\u00e9');
  // Line breaks and tabs become ordinary spaces, so they can never reach an email.
  assert.equal(checkNames({ firstName: 'Kenya\r\nMei\t' }).firstName, 'Kenya Mei');
});

test("passwords can't contain the first or last name", () => {
  const user = { ...good, email: 'someone@example.com' };
  assert.match(validateRegistration({ ...user, password: 'my-kenya-password' }).password, /name/);
  assert.match(validateRegistration({ ...user, password: 'chan-the-man-1234' }).password, /name/);
  // Very short names are ignored, or almost every password would be refused.
  assert.equal(validateRegistration({ ...user, firstName: 'Al', password: 'always correct horse' }).password, undefined);
});
