// Deleting your own account (the 7-day grace period is in account-deletion.js).
//
//   POST   /api/account/confirm-options          a passkey challenge, to prove it's you
//   POST   /api/account/deletion   { email, password }  or  { email, passkey }
//   DELETE /api/account/deletion                 cancel, during the grace period
//   PATCH  /api/account/name       { firstName, lastName }   change your name
//
// Changing your sign-in email (the steps are explained in email-change.js):
//   POST   /api/account/email           { newEmail, password } or { newEmail, passkey }
//   POST   /api/account/email/resend    a fresh link to the new address
//   DELETE /api/account/email/pending   cancel the change
//   POST   /api/account/email/confirm   { token }   the link sent to the new address
//   POST   /api/account/email/cancel    { token }   the link sent to the old address
//
// Being signed in isn't enough to delete an account: someone could be using a
// computer you left signed in. So you type your email address and confirm with your
// password (or a passkey, for accounts without one), just like signing in.

import { Router } from 'express';
import argon2 from 'argon2';
import rateLimit, { MemoryStore } from 'express-rate-limit';
import { generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { db } from '../db.js';
import { endSession, requireSignIn } from '../sessions.js';
import { clearFailures, lockedFor, lockedMessage, recordFailure } from '../lockout.js';
import { loginLimiter } from '../rate-limits.js';
import { deletionGraceDays, expectedOrigin, rpID } from '../config.js';
import {
  challengeFrom, findPasskey, listPasskeys, markPasskeyUsed, parseTransports, saveChallenge, takeChallenge,
} from '../passkeys.js';
import { cancelDeletion, scheduleDeletion } from '../account-deletion.js';
import { checkNames, isValidEmail, tidyEmail } from '../validation.js';
import {
  cancelEmailChange, cancelEmailChangeFromOldAddress, confirmEmailChange, requestEmailChange, resendEmailChange,
} from '../email-change.js';

const router = Router();

const getPasswordHash = db.prepare('SELECT password_hash FROM users WHERE id = ?');
const setName = db.prepare(`
  UPDATE users SET first_name = ?, last_name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
`);
const PASSKEY_FAILED = { error: "That passkey couldn't confirm it's you. Please try again." };

// Each check returns null if it passed, or the error reply to send.
async function checkPassword(password, user) {
  const { password_hash: hash } = getPasswordHash.get(user.id);
  if (!hash) return { status: 400, body: { error: 'Confirm with one of your passkeys.' } };
  if (typeof password !== 'string' || !password) return { status: 400, body: { error: 'Enter your password.' } };

  const locked = lockedFor(user.email);
  if (locked > 0) return { status: 429, body: lockedMessage(locked), retryAfter: locked };

  const normalized = password.normalize('NFKC');
  const ok = [...normalized].length <= 128 && await argon2.verify(hash, normalized);
  if (!ok) {
    const lockMs = recordFailure(user.email);   // same lockout as the sign-in form
    if (lockMs > 0) return { status: 429, body: lockedMessage(lockMs), retryAfter: lockMs };
    return { status: 401, body: { error: 'Incorrect password.' } };
  }
  clearFailures(user.email);
  return null;
}

async function checkPasskey(response, user) {
  const challenge = challengeFrom(response);
  if (!challenge || !takeChallenge(challenge, 'confirm', user.id)) {
    return { status: 400, body: { error: 'This request has expired. Please try again.' } };
  }
  const passkey = findPasskey(response?.id);
  if (!passkey || passkey.user_id !== user.id) return { status: 401, body: PASSKEY_FAILED };
  const userHandle = response.response?.userHandle;
  if (userHandle && userHandle !== passkey.webauthn_user_id) return { status: 401, body: PASSKEY_FAILED };

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: passkey.credential_id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: passkey.sign_count,
        transports: parseTransports(passkey.transports),
      },
    });
  } catch {
    return { status: 401, body: PASSKEY_FAILED };
  }
  if (!verification.verified) return { status: 401, body: PASSKEY_FAILED };
  markPasskeyUsed(passkey.id, verification.authenticationInfo.newCounter, verification.authenticationInfo.credentialBackedUp);
  return null;
}

// POST /api/account/confirm-options  -> only this user's passkeys can answer it
router.post('/account/confirm-options', requireSignIn, async (req, res) => {
  const passkeys = listPasskeys(req.user.id);
  if (passkeys.length === 0) {
    return res.status(400).json({ error: "You don't have any passkeys. Confirm with your password instead." });
  }
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: passkeys.map((p) => ({ id: p.credential_id, transports: parseTransports(p.transports) })),
  });
  saveChallenge(options.challenge, 'confirm', req.user.id);
  res.json(options);
});

// POST /api/account/deletion  { email, password } or { email, passkey }
router.post('/account/deletion', loginLimiter, requireSignIn, async (req, res) => {
  const user = req.user;
  if (user.deleteAfter) {
    return res.status(409).json({ error: 'Your account is already scheduled for deletion.' });
  }

  if (tidyEmail(req.body?.email) !== user.email.toLowerCase()) {
    return res.status(400).json({ error: "That isn't your email address. Type it exactly to confirm." });
  }

  if (!await confirmItsYou(req, res)) return;

  const deleteAfter = scheduleDeletion(user.id);   // also signs out every device
  endSession(req, res);                            // and clears this browser's cookie
  res.json({
    deleteAfter,
    message: `Your account will be deleted in ${deletionGraceDays} days. Sign in before then to cancel.`,
  });
});

// DELETE /api/account/deletion  -> keep the account after all
router.delete('/account/deletion', requireSignIn, (req, res) => {
  if (!cancelDeletion(req.user.id)) {
    return res.status(409).json({ error: "Your account isn't scheduled for deletion." });
  }
  res.json({ message: 'Deletion cancelled. Your account will be kept.' });
});

// Re-checks it's really the account owner: a password, or a passkey for
// accounts without one. Sends the error reply and returns false if not.
async function confirmItsYou(req, res) {
  const problem = req.body?.passkey !== undefined
    ? await checkPasskey(req.body.passkey, req.user)
    : await checkPassword(req.body?.password, req.user);
  if (!problem) return true;
  if (problem.retryAfter) res.set('Retry-After', String(Math.ceil(problem.retryAfter / 1000)));
  res.status(problem.status).json(problem.body);
  return false;
}

// --- Changing your sign-in email ---------------------------------------------------

// Each account can ask for (or resend) a change 5 times an hour, so this can't
// be used to flood someone's inbox. Only requests that send emails count: typos
// don't, and wrong passwords are already limited by the sign-in lockout.
export const emailChangeStore = new MemoryStore();   // the tests clear this between runs
const emailChangeLimiter = rateLimit({
  store: emailChangeStore,
  windowMs: 60 * 60 * 1000,
  limit: 5,
  skipFailedRequests: true,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: { error: "You've asked to change your email several times recently. Try again in an hour." },
});

const BAD_CHANGE_LINK = { error: 'This link is invalid, already used, or expired.' };

// POST /api/account/email  { newEmail, password } or { newEmail, passkey }
router.post('/account/email', loginLimiter, requireSignIn, emailChangeLimiter, async (req, res) => {
  if (req.user.deleteAfter) {
    return res.status(409).json({ error: 'Your account is scheduled for deletion. Cancel that first.' });
  }
  const newEmail = tidyEmail(req.body?.newEmail);
  if (!isValidEmail(newEmail)) {
    return res.status(400).json({ errors: { newEmail: 'Enter a valid email address.' } });
  }
  if (newEmail === req.user.email.toLowerCase()) {
    return res.status(400).json({ errors: { newEmail: "That's already your email address." } });
  }
  if (!await confirmItsYou(req, res)) return;

  requestEmailChange(req.user.id, newEmail);
  // The same reply whether or not the new address already has an account.
  res.json({
    pendingEmail: newEmail,
    message: `We've sent a confirmation link to ${newEmail}. Your email won't change until you use it.`,
  });
});

// POST /api/account/email/resend
router.post('/account/email/resend', requireSignIn, emailChangeLimiter, (req, res) => {
  if (!resendEmailChange(req.user.id)) {
    return res.status(409).json({ error: "You haven't asked to change your email." });
  }
  res.json({ message: `We've sent a new link to ${req.user.pendingEmail}.` });
});

// DELETE /api/account/email/pending
router.delete('/account/email/pending', requireSignIn, (req, res) => {
  if (!cancelEmailChange(req.user.id)) {
    return res.status(409).json({ error: "You haven't asked to change your email." });
  }
  res.json({ message: 'Cancelled. Your email address stays the same.' });
});

// POST /api/account/email/confirm  { token }   (the /confirm-email-change page)
// No sign-in needed: the link may be opened on a different device.
router.post('/account/email/confirm', (req, res) => {
  const result = confirmEmailChange(req.body?.token);
  if (!result.ok && result.reason === 'taken') {
    return res.status(409).json({ error: 'That address now belongs to another account, so your email has not changed.' });
  }
  if (!result.ok) return res.status(400).json(BAD_CHANGE_LINK);
  if (req.user) endSession(req, res);   // every session has ended; clear this browser's cookie too
  res.json({ message: 'Your email address has been changed. Sign in with your new address.' });
});

// POST /api/account/email/cancel  { token }   (the /cancel-email-change page)
router.post('/account/email/cancel', (req, res) => {
  switch (cancelEmailChangeFromOldAddress(req.body?.token)) {
    case 'cancelled':
      return res.json({
        message: "The change has been cancelled. Your email address stays the same. If you didn't ask for it, change your password now.",
      });
    case 'already-changed':
      return res.status(409).json({
        error: "This change has already been confirmed, so it can't be cancelled here. If you didn't make it, contact support straight away.",
      });
    default:
      return res.status(400).json(BAD_CHANGE_LINK);
  }
});

// PATCH /api/account/name  { firstName, lastName }
// A name isn't a security setting, so being signed in is enough (no password needed).
router.patch('/account/name', requireSignIn, (req, res) => {
  const { firstName, lastName, errors } = checkNames(req.body ?? {});
  if (Object.keys(errors).length > 0) return res.status(400).json({ errors });
  setName.run(firstName, lastName, req.user.id);
  res.json({ firstName, lastName });
});

export default router;
