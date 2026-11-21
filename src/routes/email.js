// Confirming the email address given at sign-up.
//
//   POST /api/verify-email         { token }   the link in the email: confirms the address
//   POST /api/cancel-signup        { token }   "this wasn't me": deletes the unconfirmed account
//   POST /api/resend-verification  { email }   a fresh link (no sign-in needed, because
//                                              unconfirmed accounts can't sign in)
//
// Unconfirmed accounts can't sign in, and are deleted after 7 days
// (deleteUnconfirmedAccounts in account-deletion.js).

import { Router } from 'express';
import rateLimit, { MemoryStore } from 'express-rate-limit';
import { db } from '../db.js';
import { createEmailToken, useEmailToken } from '../email-tokens.js';
import { sendInBackground } from '../mailer.js';
import { pendingSignupEmail, verificationEmail } from '../emails.js';
import { isValidEmail, tidyEmail } from '../validation.js';
import { unconfirmedAccountDays } from '../config.js';
import { clearFailures } from '../lockout.js';

const router = Router();
const VERIFY_LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;
const CANCEL_LINK_LIFETIME_MS = unconfirmedAccountDays * 24 * 60 * 60 * 1000;   // as long as the account can exist
const RESEND_GAP_MS = 5 * 60 * 1000;   // at most one automatic new link every 5 minutes

const getUser = db.prepare('SELECT first_name, email, email_verified_at FROM users WHERE id = ?');
const findUnconfirmed = db.prepare('SELECT id FROM users WHERE email = ? AND email_verified_at IS NULL');
const latestLink = db.prepare(`
  SELECT created_at FROM email_tokens
  WHERE user_id = ? AND purpose = 'verify_email' AND used_at IS NULL ORDER BY id DESC LIMIT 1
`);
const markVerified = db.prepare(`
  UPDATE users
  SET email_verified_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      updated_at        = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE id = ? AND email_verified_at IS NULL
`);
const deleteCancelLinks = db.prepare("DELETE FROM email_tokens WHERE user_id = ? AND purpose = 'cancel_signup'");
const deleteUnconfirmedUser = db.prepare('DELETE FROM users WHERE id = ? AND email_verified_at IS NULL RETURNING email');

// Emails a fresh "confirm your email" link (any earlier link stops working),
// along with a link to cancel the sign-up.
// `kind` is 'signup' for the normal email, or 'pending' when someone tried to sign up
// again with an address that's already waiting for confirmation.
export function sendVerificationEmail(userId, kind = 'signup') {
  const user = getUser.get(userId);
  if (!user || user.email_verified_at) return;
  const token = createEmailToken(userId, 'verify_email', VERIFY_LINK_LIFETIME_MS);
  const cancelToken = createEmailToken(userId, 'cancel_signup', CANCEL_LINK_LIFETIME_MS);
  const email = kind === 'pending'
    ? pendingSignupEmail(token, cancelToken)
    : verificationEmail(user.first_name, token, cancelToken);
  sendInBackground({ to: user.email, ...email });
}

// The same, but does nothing if a link was sent in the last 5 minutes, so nobody
// can flood an inbox by pressing a button over and over.
export function sendVerificationEmailIfDue(userId, kind = 'signup') {
  const latest = latestLink.get(userId);
  if (latest && Date.now() - Date.parse(latest.created_at) < RESEND_GAP_MS) return;
  sendVerificationEmail(userId, kind);
}

// POST /api/verify-email  { token }   (sent by the /verify-email page)
router.post('/verify-email', (req, res) => {
  const userId = useEmailToken(req.body?.token, 'verify_email');
  if (!userId) {
    return res.status(400).json({ error: 'This link is invalid, already used, or expired.' });
  }
  markVerified.run(userId);
  deleteCancelLinks.run(userId);   // a confirmed account can't be cancelled
  res.json({ message: 'Your email address is confirmed. You can now sign in.' });
});

// POST /api/cancel-signup  { token }   (sent by the /cancel-signup page)
router.post('/cancel-signup', (req, res) => {
  const userId = useEmailToken(req.body?.token, 'cancel_signup');
  if (!userId) {
    return res.status(400).json({ error: 'This link is invalid, already used, or expired.' });
  }
  const deleted = deleteUnconfirmedUser.get(userId);
  if (!deleted) {
    return res.status(409).json({ error: "This account's email address has already been confirmed, so it wasn't deleted." });
  }
  clearFailures(deleted.email);
  console.info(`Unconfirmed account ${userId} cancelled from its email`);
  res.json({ message: 'The sign-up has been cancelled and the account deleted. You can now sign up with this address.' });
});

// --- Asking for a new link -----------------------------------------------------
const common = { standardHeaders: 'draft-8', legacyHeaders: false };

// 5 requests an hour from one network...
export const resendNetworkLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: { error: 'Too many requests from your network. Try again later.' },
});

// ...and 3 an hour for any one address (real or not, so it reveals nothing).
export const resendStore = new MemoryStore();   // the tests clear this between runs
const resendEmailLimiter = rateLimit({
  ...common,
  store: resendStore,
  windowMs: 60 * 60 * 1000,
  limit: 3,
  keyGenerator: (req) => `email:${tidyEmail(req.body?.email)}`,
  message: { error: 'Several links have been sent to this address recently. Try again in an hour.' },
});

function requireValidEmail(req, res, next) {
  if (!isValidEmail(tidyEmail(req.body?.email))) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  next();
}

const RESENT = { message: "If that address is waiting to be confirmed, we've sent it a new link." };

// POST /api/resend-verification  { email }
router.post('/resend-verification', requireValidEmail, resendNetworkLimiter, resendEmailLimiter, (req, res) => {
  const user = findUnconfirmed.get(tidyEmail(req.body.email));
  if (user) sendVerificationEmailIfDue(user.id);
  res.json(RESENT);   // the same reply whether or not the address has an account
});

export default router;
