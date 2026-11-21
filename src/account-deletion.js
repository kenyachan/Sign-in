// Deleting an account, with a 7-day grace period.
//
//   1. The owner asks to delete their account (routes/account.js). We record when
//      it will be erased (users.delete_after), sign them out everywhere, and email them.
//   2. Until then they can sign in and cancel.
//   3. After that, purgeDueAccounts() (run every hour by server.js) erases the user.
//      The database removes their sessions, passkeys, email links and passkey
//      challenges along with them (ON DELETE CASCADE in schema.sql). Failed
//      sign-in counts are kept by email address rather than user, so they're
//      removed here by hand. There is no undo.
//
// Also here: deleteUnconfirmedAccounts() removes sign-ups whose email address
// still isn't confirmed after 7 days (also run every hour).

import { db } from './db.js';
import { deletionGraceDays, unconfirmedAccountDays } from './config.js';
import { endAllSessionsForUser } from './sessions.js';
import { clearFailures } from './lockout.js';
import { sendInBackground } from './mailer.js';
import { accountDeletedEmail, deletionCancelledEmail, deletionScheduledEmail } from './emails.js';

const GRACE_MS = deletionGraceDays * 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

const getUser = db.prepare('SELECT id, first_name, email FROM users WHERE id = ?');
const setDeleteAfter = db.prepare(`
  UPDATE users SET delete_after = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
`);
const clearDeleteAfter = db.prepare(`
  UPDATE users SET delete_after = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE id = ? AND delete_after IS NOT NULL
`);
const findDue = db.prepare('SELECT id, first_name, email FROM users WHERE delete_after IS NOT NULL AND delete_after <= ?');
const deleteUser = db.prepare('DELETE FROM users WHERE id = ?');

// Returns the time the account will be erased.
export function scheduleDeletion(userId) {
  const user = getUser.get(userId);
  const deleteAfter = iso(Date.now() + GRACE_MS);
  db.transaction(() => {
    setDeleteAfter.run(deleteAfter, userId);
    endAllSessionsForUser(userId);
  })();
  console.info(`Account ${userId} scheduled for deletion after ${deleteAfter}`);
  sendInBackground({ to: user.email, ...deletionScheduledEmail(user.first_name, deleteAfter) });
  return deleteAfter;
}

// Returns false if the account wasn't scheduled for deletion.
export function cancelDeletion(userId) {
  if (clearDeleteAfter.run(userId).changes === 0) return false;
  const user = getUser.get(userId);
  console.info(`Account ${userId} deletion cancelled`);
  sendInBackground({ to: user.email, ...deletionCancelledEmail(user.first_name) });
  return true;
}

const eraseUser = db.transaction((user) => {
  clearFailures(user.email);
  deleteUser.run(user.id);
});

// Erases every account whose grace period has ended. Returns how many.
export function purgeDueAccounts(now = Date.now()) {
  const due = findDue.all(iso(now));
  for (const user of due) {
    eraseUser(user);
    console.info(`Account ${user.id} deleted`);   // the ID only: no names or emails in the logs
    sendInBackground({ to: user.email, ...accountDeletedEmail(user.first_name) });
  }
  return due.length;
}

// --- Unconfirmed sign-ups ----------------------------------------------------
const UNCONFIRMED_MS = unconfirmedAccountDays * 24 * 60 * 60 * 1000;
const findUnconfirmed = db.prepare('SELECT id, email FROM users WHERE email_verified_at IS NULL AND created_at <= ?');

// Deletes accounts whose email address still isn't confirmed 7 days after sign-up.
// No email is sent: the address was never confirmed, so it may not belong to
// whoever signed up. Returns how many were deleted.
export function deleteUnconfirmedAccounts(now = Date.now()) {
  const due = findUnconfirmed.all(iso(now - UNCONFIRMED_MS));
  for (const user of due) eraseUser(user);
  if (due.length > 0) console.info(`Deleted ${due.length} unconfirmed account(s)`);   // a count only
  return due.length;
}
