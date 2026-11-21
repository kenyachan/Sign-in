// Account recovery by email link.
//
//   1. POST /api/recovery/request   { email }    -> emails a one-time link (15 minutes)
//   2. The link opens /recover-continue, which offers two ways back in:
//        POST /api/recovery/password { token, password }  set a new password
//        POST /api/recovery/signin   { token }            sign in, then add a passkey
//   3. Either way: every other device is signed out, any password lockout is
//      cleared, and the owner is emailed that recovery happened.
//
// Links only go to confirmed email addresses (an unconfirmed one gets a new
// confirmation link instead), and the reply never says whether an account exists.

import { Router } from 'express';
import argon2 from 'argon2';
import rateLimit, { MemoryStore } from 'express-rate-limit';
import { db } from '../db.js';
import { endAllSessionsForUser, startSession } from '../sessions.js';
import { createEmailToken, peekEmailToken, useEmailToken } from '../email-tokens.js';
import { clearFailures } from '../lockout.js';
import { sendInBackground } from '../mailer.js';
import { accountRecoveredEmail, recoveryEmail } from '../emails.js';
import { checkPassword, isValidEmail, tidyEmail } from '../validation.js';
import { sendVerificationEmailIfDue } from './email.js';
import { cancelEmailChange } from '../email-change.js';

const router = Router();
const LINK_LIFETIME_MS = 15 * 60 * 1000;

const findUserByEmail = db.prepare(`
  SELECT id, first_name, last_name, email, email_verified_at FROM users WHERE email = ?
`);
const getUser = db.prepare('SELECT id, first_name, last_name, email FROM users WHERE id = ?');
const setPassword = db.prepare(`
  UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
`);

const SENT = {
  message: "If that email address belongs to an account, we've sent it a link. It works for 15 minutes.",
};
const BAD_LINK = { error: 'This link is invalid, already used, or expired. Request a new one.' };


// --- Limits ----------------------------------------------------------------
const common = { standardHeaders: 'draft-8', legacyHeaders: false };

// 5 requests an hour from one network...
export const recoveryNetworkLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: { error: 'Too many requests from your network. Try again later.' },
});

// ...and 3 an hour for any one email address (real or not, so it reveals nothing).
export const recoveryEmailStore = new MemoryStore();   // the tests clear this between runs
const recoveryEmailLimiter = rateLimit({
  ...common,
  store: recoveryEmailStore,
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

// --- Routes ----------------------------------------------------------------

// POST /api/recovery/request  { email }
router.post('/recovery/request', requireValidEmail, recoveryNetworkLimiter, recoveryEmailLimiter, (req, res) => {
  const user = findUserByEmail.get(tidyEmail(req.body.email));
  if (user?.email_verified_at) {
    // Making a new link cancels any earlier one.
    const token = createEmailToken(user.id, 'recovery', LINK_LIFETIME_MS);
    sendInBackground({ to: user.email, ...recoveryEmail(user.first_name, token) });
  } else if (user) {
    // Not confirmed yet, so there's nothing to recover: send a new confirmation link instead.
    sendVerificationEmailIfDue(user.id);
  }
  res.json(SENT);   // the same reply either way
});

// POST /api/recovery/check  { token }  -> is the link still good? (doesn't use it up)
router.post('/recovery/check', (req, res) => {
  const userId = peekEmailToken(req.body?.token, 'recovery');
  if (!userId) return res.json({ valid: false });
  const user = getUser.get(userId);
  res.json({ valid: true, firstName: user.first_name, email: user.email });
});

// Signs the user in fresh, everywhere else out, and lets them know.
function finishRecovery(req, res, user, how) {
  cancelEmailChange(user.id);   // in case whoever got in asked to move the account to their address
  endAllSessionsForUser(user.id);
  clearFailures(user.email);
  startSession(req, res, user.id);
  sendInBackground({ to: user.email, ...accountRecoveredEmail(user.first_name, how) });
}

// POST /api/recovery/password  { token, password }
router.post('/recovery/password', async (req, res) => {
  const token = req.body?.token;
  const userId = peekEmailToken(token, 'recovery');
  if (!userId) return res.status(400).json(BAD_LINK);
  const user = getUser.get(userId);

  // Check the new password before using up the link, so a typo doesn't waste it.
  const password = typeof req.body?.password === 'string' ? req.body.password.normalize('NFKC') : req.body?.password;
  const problem = checkPassword(password, { email: user.email, firstName: user.first_name, lastName: user.last_name });
  if (problem) return res.status(400).json({ errors: { password: problem } });

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  // Now use up the link. If it was used in the meantime, stop.
  if (useEmailToken(token, 'recovery') !== userId) return res.status(400).json(BAD_LINK);

  setPassword.run(passwordHash, user.id);
  finishRecovery(req, res, user, 'password');
  res.json({ message: 'Your password has been changed.' });
});

// POST /api/recovery/signin  { token }
router.post('/recovery/signin', (req, res) => {
  const userId = useEmailToken(req.body?.token, 'recovery');
  if (!userId) return res.status(400).json(BAD_LINK);
  finishRecovery(req, res, getUser.get(userId), 'signin');
  res.json({ message: "You're signed in." });
});

export default router;
