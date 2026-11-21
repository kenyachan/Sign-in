// Changing the email address an account signs in with.
//
//   1. requestEmailChange: the signed-in user (after re-entering their password or
//      using a passkey, see routes/account.js) asks for a new address. It's saved
//      in users.pending_email, and:
//        - the NEW address gets a confirmation link (24 hours), or, if it already
//          belongs to another account, a notice with no link. The person asking
//          gets the same reply either way, so this can't be used to find accounts.
//        - the OLD address is told straight away, with a link to cancel (7 days).
//   2. Until it's confirmed, nothing changes: they still sign in with the old address.
//   3. confirmEmailChange (the link in the new address's email): the address
//      changes, counts as confirmed, and every device is signed out. Both
//      addresses are emailed.
//   4. Cancelling (account page, the old address's link, or account recovery)
//      clears the pending address, and its confirmation link stops working.

import { db } from './db.js';
import { createEmailToken, useEmailToken } from './email-tokens.js';
import { endAllSessionsForUser } from './sessions.js';
import { clearFailures } from './lockout.js';
import { maskEmail, sendInBackground } from './mailer.js';
import {
  confirmNewEmailEmail, emailChangedNewEmail, emailChangedOldEmail, emailChangeRequestedEmail, emailInUseEmail,
} from './emails.js';

const CONFIRM_LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;
const CANCEL_LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

const getUser = db.prepare('SELECT id, first_name, email, pending_email FROM users WHERE id = ?');
const emailTaken = db.prepare('SELECT 1 FROM users WHERE email = ?');
const setPending = db.prepare('UPDATE users SET pending_email = ?, updated_at = ? WHERE id = ?');
const switchEmail = db.prepare(`
  UPDATE users SET email = pending_email, email_verified_at = ?, pending_email = NULL, updated_at = ?
  WHERE id = ? AND pending_email IS NOT NULL
`);
const deleteLinks = db.prepare(`
  DELETE FROM email_tokens WHERE user_id = ? AND purpose IN ('change_email', 'cancel_email_change') AND used_at IS NULL
`);
const deleteConfirmLinks = db.prepare(`
  DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'change_email' AND used_at IS NULL
`);

// Emails the new address: a confirmation link, or (if it's taken) a notice with none.
function sendConfirmation(user, newEmail) {
  if (emailTaken.get(newEmail)) {
    deleteConfirmLinks.run(user.id);   // an earlier link for another address must stop working too
    sendInBackground({ to: newEmail, ...emailInUseEmail() });
    return;
  }
  const token = createEmailToken(user.id, 'change_email', CONFIRM_LINK_LIFETIME_MS);
  sendInBackground({ to: newEmail, ...confirmNewEmailEmail(user.first_name, token) });
}

// `newEmail` must already be tidied and checked. Replaces any earlier pending change.
export function requestEmailChange(userId, newEmail) {
  const user = getUser.get(userId);
  setPending.run(newEmail, now(), userId);
  sendConfirmation(user, newEmail);
  const cancelToken = createEmailToken(userId, 'cancel_email_change', CANCEL_LINK_LIFETIME_MS);
  sendInBackground({ to: user.email, ...emailChangeRequestedEmail(user.first_name, maskEmail(newEmail), cancelToken) });
  console.info(`Account ${userId} asked to change its email`);
}

// Sends the new address a fresh link. Returns false if there's no pending change.
export function resendEmailChange(userId) {
  const user = getUser.get(userId);
  if (!user?.pending_email) return false;
  sendConfirmation(user, user.pending_email);
  return true;
}

// Returns false if there was no pending change.
export function cancelEmailChange(userId) {
  const user = getUser.get(userId);
  if (!user?.pending_email) return false;
  db.transaction(() => {
    setPending.run(null, now(), userId);
    deleteLinks.run(userId);
  })();
  console.info(`Account ${userId} email change cancelled`);
  return true;
}

// The link from the new address's email.
// Returns { ok: true } or { ok: false, reason: 'bad-link' | 'taken' }.
export function confirmEmailChange(token) {
  const userId = useEmailToken(token, 'change_email');
  if (!userId) return { ok: false, reason: 'bad-link' };
  const user = getUser.get(userId);
  if (!user?.pending_email) return { ok: false, reason: 'bad-link' };   // cancelled in the meantime

  try {
    db.transaction(() => {
      const stamp = now();
      if (switchEmail.run(stamp, stamp, userId).changes !== 1) throw new Error('no pending email');
      endAllSessionsForUser(userId);   // sign in again with the new address, everywhere
    })();
  } catch (err) {
    // Someone else signed up with (or moved to) this address since the request.
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      setPending.run(null, now(), userId);
      return { ok: false, reason: 'taken' };
    }
    throw err;
  }

  clearFailures(user.email);
  clearFailures(user.pending_email);
  console.info(`Account ${userId} changed its email`);
  sendInBackground({ to: user.email, ...emailChangedOldEmail(user.first_name, maskEmail(user.pending_email)) });
  sendInBackground({ to: user.pending_email, ...emailChangedNewEmail(user.first_name) });
  return { ok: true };
}

// The link from the old address's email.
// Returns 'cancelled', 'already-changed', 'nothing-pending' or 'bad-link'.
export function cancelEmailChangeFromOldAddress(token) {
  const userId = useEmailToken(token, 'cancel_email_change');
  if (!userId) return 'bad-link';
  if (cancelEmailChange(userId)) return 'cancelled';
  // The link stays valid after the change is confirmed, just to say this:
  const user = getUser.get(userId);
  return user ? 'already-changed' : 'nothing-pending';
}
