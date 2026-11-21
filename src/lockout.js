// Account lockout: after 5 wrong passwords in a row for an email address, that
// address can't sign in with a password for a while. Each further 5 failures
// doubles the wait: 15 min, 30 min, 1 h ... up to 24 h. A successful sign-in
// clears the count. Passkey sign-in (added later) isn't affected, so a locked-out
// owner still has a way in.

import { db } from './db.js';

const FAILURES_BEFORE_LOCK = 5;
const FIRST_LOCK_MS = 15 * 60 * 1000;
const LONGEST_LOCK_MS = 24 * 60 * 60 * 1000;
const FORGET_AFTER_MS = 24 * 60 * 60 * 1000;   // a quiet day wipes the slate

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const keyFor = (email) => email.trim().toLowerCase();

const getRow = db.prepare('SELECT failed_attempts, last_failed_at, locked_until FROM login_attempts WHERE account_key = ?');
const saveRow = db.prepare(`
  INSERT INTO login_attempts (account_key, failed_attempts, last_failed_at, locked_until)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (account_key) DO UPDATE SET
    failed_attempts = excluded.failed_attempts,
    last_failed_at  = excluded.last_failed_at,
    locked_until    = excluded.locked_until
`);
const deleteRow = db.prepare('DELETE FROM login_attempts WHERE account_key = ?');
const deleteOld = db.prepare('DELETE FROM login_attempts WHERE last_failed_at <= ? AND (locked_until IS NULL OR locked_until <= ?)');

// How many milliseconds this email address is still locked for (0 = not locked).
export function lockedFor(email) {
  const row = getRow.get(keyFor(email));
  if (!row?.locked_until) return 0;
  return Math.max(0, Date.parse(row.locked_until) - Date.now());
}

// Call after a wrong password. Returns how long the address is now locked for (0 = not locked).
export function recordFailure(email) {
  const key = keyFor(email);
  const now = Date.now();
  const row = getRow.get(key);
  const recent = row && now - Date.parse(row.last_failed_at) < FORGET_AFTER_MS;
  const failures = recent ? row.failed_attempts + 1 : 1;

  let lockMs = 0;
  if (failures % FAILURES_BEFORE_LOCK === 0) {
    const lockNumber = failures / FAILURES_BEFORE_LOCK;            // 1st lock, 2nd lock...
    lockMs = Math.min(FIRST_LOCK_MS * 2 ** (lockNumber - 1), LONGEST_LOCK_MS);
  }

  saveRow.run(key, failures, iso(now), lockMs ? iso(now + lockMs) : null);
  return lockMs;
}

export function clearFailures(email) {
  deleteRow.run(keyFor(email));
}

export function deleteOldAttempts() {
  const now = Date.now();
  deleteOld.run(iso(now - FORGET_AFTER_MS), iso(now));
}

export function lockedMessage(ms) {
  const minutes = Math.ceil(ms / 60000);
  const wait = minutes >= 60
    ? `${Math.ceil(minutes / 60)} hour${minutes > 60 ? 's' : ''}`
    : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return { error: `Too many failed attempts. Try again in ${wait}.` };
}
