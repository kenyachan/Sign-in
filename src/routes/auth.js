import { Router } from 'express';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { endSession, requireSignIn, startSession } from '../sessions.js';
import { clearFailures, lockedFor, lockedMessage, recordFailure } from '../lockout.js';
import { loginLimiter } from '../rate-limits.js';
import { EMAIL_MAX, tidyEmail } from '../validation.js';
import { sendVerificationEmailIfDue } from './email.js';

const router = Router();

const findUser = db.prepare('SELECT id, first_name, password_hash, email_verified_at FROM users WHERE email = ?');
const updateHash = db.prepare(`
  UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
`);

// The same message whether the email or the password was wrong,
// so nobody can use this form to find out which addresses have accounts.
const WRONG = { error: 'Incorrect email or password.' };

// Only shown after the right password, so it tells nothing to someone guessing.
export const UNCONFIRMED = {
  error: 'unconfirmed',
  message: 'Please confirm your email address first. Check your inbox for the link we sent you.',
};

// A real hash of a random password. When the email doesn't exist we still
// check the password against this, so the reply takes just as long.
const dummyHash = await argon2.hash(randomBytes(16).toString('hex'), { type: argon2.argon2id });

function tooMany(res, ms) {
  res.set('Retry-After', String(Math.ceil(ms / 1000)));
  return res.status(429).json(lockedMessage(ms));
}

// POST /api/login  { email, password }
router.post('/login', loginLimiter, async (req, res) => {
  const body = req.body ?? {};
  const email = tidyEmail(body.email);
  const password = typeof body.password === 'string' ? body.password.normalize('NFKC') : '';

  if (!email || !password) {
    return res.status(400).json({ error: 'Enter your email and password.' });
  }
  if (email.length > EMAIL_MAX || [...password].length > 128) {
    return res.status(401).json(WRONG);
  }

  // Locked? Don't even check the password, so guesses during a lock are worthless.
  const locked = lockedFor(email);
  if (locked > 0) return tooMany(res, locked);

  const user = findUser.get(email);
  const passwordOk = await argon2.verify(user?.password_hash ?? dummyHash, password);

  if (!user || !user.password_hash || !passwordOk) {
    const lockMs = recordFailure(email);   // counted for unknown addresses too
    if (lockMs > 0) return tooMany(res, lockMs);
    return res.status(401).json(WRONG);
  }

  clearFailures(email);

  // If we ever make the hashing settings stronger, upgrade this user's hash now.
  if (argon2.needsRehash(user.password_hash)) {
    updateHash.run(await argon2.hash(password, { type: argon2.argon2id }), user.id);
  }

  // Right password, but the address isn't confirmed yet: no session. Send a new
  // link (at most one every 5 minutes) in case the first one got lost.
  if (!user.email_verified_at) {
    sendVerificationEmailIfDue(user.id);
    return res.status(403).json(UNCONFIRMED);
  }

  startSession(req, res, user.id);
  res.json({ firstName: user.first_name });
});

// POST /api/logout
router.post('/logout', (req, res) => {
  endSession(req, res);
  res.status(204).end();
});

// GET /api/me  -> who is signed in
router.get('/me', requireSignIn, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { firstName, lastName, email, pendingEmail, webauthnUserId, emailVerified, hasPassword, deleteAfter } = req.user;
  res.json({ firstName, lastName, email, pendingEmail, webauthnUserId, emailVerified, hasPassword, deleteAfter });
});

export default router;
