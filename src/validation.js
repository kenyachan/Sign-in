// Rules for sign-up fields. The browser checks these too, but only the
// server's check counts: anyone can send a request without using our page.

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
export const NAME_MAX = 50;
export const EMAIL_MAX = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Email addresses are stored and compared trimmed and lower-cased.
export const tidyEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

// For an address that's already been tidied.
export const isValidEmail = (email) =>
  typeof email === 'string' && email.length <= EMAIL_MAX && EMAIL_PATTERN.test(email);

// Letters and accents from any language, spaces, hyphens, apostrophes and full
// stops: enough for O'Brien, Nguyễn, José María and Jean-Luc. No digits, links
// or symbols, so nobody can use a "name" to put a web address into our emails.
const NAME_PATTERN = /^[\p{L}\p{M} '’.-]+$/u;

// Tidies a typed name. Returns { name, error }: name is null when left empty.
export function checkName(value, { required, label }) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') return { name: null, error: `Enter your ${label}.` };
  const name = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (name === '') return { name: null, error: required ? `Enter your ${label}.` : null };
  if ([...name].length > NAME_MAX) return { name: null, error: `Use at most ${NAME_MAX} characters.` };
  if (!NAME_PATTERN.test(name) || !/\p{L}/u.test(name)) {
    return { name: null, error: 'Use letters, spaces, hyphens and apostrophes only.' };
  }
  return { name, error: null };
}

// Checks both names. Returns { firstName, lastName, errors }.
export function checkNames({ firstName, lastName }) {
  const first = checkName(firstName, { required: true, label: 'first name' });
  const last = checkName(lastName, { required: false, label: 'last name' });
  const errors = {};
  if (first.error) errors.firstName = first.error;
  if (last.error) errors.lastName = last.error;
  return { firstName: first.name, lastName: last.name, errors };
}

export function validateRegistration({ firstName, lastName, email, password }) {
  const names = checkNames({ firstName, lastName });
  const errors = { ...names.errors };

  if (!isValidEmail(email)) errors.email = 'Enter a valid email address.';

  const passwordError = checkPassword(password, { email, firstName: names.firstName, lastName: names.lastName });
  if (passwordError) errors.password = passwordError;

  return errors;
}

const includes = (password, part) =>
  typeof part === 'string' && [...part].length >= 3 && password.toLowerCase().includes(part.toLowerCase());

// The password rules on their own (also used when resetting a password).
// `user` holds the things a password mustn't contain. Returns an error message, or null.
export function checkPassword(password, user = {}) {
  if (typeof password !== 'string' || password.length === 0) return 'Enter a password.';
  const length = [...password].length; // counts emoji and accented letters as one character
  if (length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  // The part of the email before the @, e.g. "kenya" in kenya@example.com.
  const mailbox = typeof user.email === 'string' ? user.email.split('@')[0] : null;
  if (includes(password, mailbox)) return "Don't include your email address in your password.";
  if (includes(password, user.firstName) || includes(password, user.lastName)) {
    return "Don't include your name in your password.";
  }
  return null;
}
