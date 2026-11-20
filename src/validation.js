// Rules for sign-up fields. The browser checks these too, but only the
// server's check counts: anyone can send a request without using our page.

export const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,30}$/;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateRegistration({ username, email, password }) {
  const errors = {};

  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    errors.username = 'Use 3–30 letters, numbers, dots, dashes or underscores.';
  }

  if (typeof email !== 'string' || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    errors.email = 'Enter a valid email address.';
  }

  const passwordError = checkPassword(password, username);
  if (passwordError) errors.password = passwordError;

  return errors;
}

// The password rules on their own (also used when resetting a password).
// Returns an error message, or null if the password is fine.
export function checkPassword(password, username) {
  if (typeof password !== 'string' || password.length === 0) return 'Enter a password.';
  const length = [...password].length; // counts emoji and accented letters as one character
  if (length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (typeof username === 'string' && username.length >= 3 &&
      password.toLowerCase().includes(username.toLowerCase())) {
    return "Don't include your username in your password.";
  }
  return null;
}
