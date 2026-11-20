// Deleting your own account (the 7-day grace period is in account-deletion.js).
//
//   POST   /api/account/confirm-options          a passkey challenge, to prove it's you
//   POST   /api/account/deletion   { username, password }  or  { username, passkey }
//   DELETE /api/account/deletion                 cancel, during the grace period
//
// Being signed in isn't enough to delete an account: someone could be using a
// computer you left signed in. So you type your username and confirm with your
// password (or a passkey, for accounts without one), just like signing in.

import { Router } from 'express';
import argon2 from 'argon2';
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

const router = Router();

const getPasswordHash = db.prepare('SELECT password_hash FROM users WHERE id = ?');
const PASSKEY_FAILED = { error: "That passkey couldn't confirm it's you. Please try again." };

// Each check returns null if it passed, or the error reply to send.
async function checkPassword(password, user) {
  const { password_hash: hash } = getPasswordHash.get(user.id);
  if (!hash) return { status: 400, body: { error: 'Confirm with one of your passkeys.' } };
  if (typeof password !== 'string' || !password) return { status: 400, body: { error: 'Enter your password.' } };

  const locked = lockedFor(user.username);
  if (locked > 0) return { status: 429, body: lockedMessage(locked), retryAfter: locked };

  const normalized = password.normalize('NFKC');
  const ok = [...normalized].length <= 128 && await argon2.verify(hash, normalized);
  if (!ok) {
    const lockMs = recordFailure(user.username);   // same lockout as the sign-in form
    if (lockMs > 0) return { status: 429, body: lockedMessage(lockMs), retryAfter: lockMs };
    return { status: 401, body: { error: 'Incorrect password.' } };
  }
  clearFailures(user.username);
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

// POST /api/account/deletion  { username, password } or { username, passkey }
router.post('/account/deletion', loginLimiter, requireSignIn, async (req, res) => {
  const user = req.user;
  if (user.deleteAfter) {
    return res.status(409).json({ error: 'Your account is already scheduled for deletion.' });
  }

  const typed = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  if (typed !== user.username.toLowerCase()) {
    return res.status(400).json({ error: "That isn't your username. Type it exactly to confirm." });
  }

  const problem = req.body?.passkey !== undefined
    ? await checkPasskey(req.body.passkey, user)
    : await checkPassword(req.body?.password, user);
  if (problem) {
    if (problem.retryAfter) res.set('Retry-After', String(Math.ceil(problem.retryAfter / 1000)));
    return res.status(problem.status).json(problem.body);
  }

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

export default router;
