import { Router } from 'express';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { endSession, requireSignIn, startSession } from '../sessions.js';
import { clearFailures, lockedFor, lockedMessage, recordFailure } from '../lockout.js';
import { loginLimiter } from '../rate-limits.js';

const router = Router();

const findUser = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?');
const updateHash = db.prepare(`
  UPDATE users SET password_hash = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
`);

// The same message whether the username or the password was wrong,
// so nobody can use this form to find out which usernames exist.
const WRONG = { error: 'Incorrect username or password.' };

// A real hash of a random password. When the username doesn't exist we still
// check the password against this, so the reply takes just as long.
const dummyHash = await argon2.hash(randomBytes(16).toString('hex'), { type: argon2.argon2id });

function tooMany(res, ms) {
  res.set('Retry-After', String(Math.ceil(ms / 1000)));
  return res.status(429).json(lockedMessage(ms));
}

// POST /api/login  { username, password }
router.post('/login', loginLimiter, async (req, res) => {
  const body = req.body ?? {};
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password.normalize('NFKC') : '';

  if (!username || !password) {
    return res.status(400).json({ error: 'Enter your username and password.' });
  }
  if (username.length > 30 || [...password].length > 128) {
    return res.status(401).json(WRONG);
  }

  // Locked? Don't even check the password, so guesses during a lock are worthless.
  const locked = lockedFor(username);
  if (locked > 0) return tooMany(res, locked);

  const user = findUser.get(username);
  const passwordOk = await argon2.verify(user?.password_hash ?? dummyHash, password);

  if (!user || !user.password_hash || !passwordOk) {
    const lockMs = recordFailure(username);   // counted for unknown usernames too
    if (lockMs > 0) return tooMany(res, lockMs);
    return res.status(401).json(WRONG);
  }

  clearFailures(username);

  // If we ever make the hashing settings stronger, upgrade this user's hash now.
  if (argon2.needsRehash(user.password_hash)) {
    updateHash.run(await argon2.hash(password, { type: argon2.argon2id }), user.id);
  }

  startSession(req, res, user.id);
  res.json({ username: user.username });
});

// POST /api/logout
router.post('/logout', (req, res) => {
  endSession(req, res);
  res.status(204).end();
});

// GET /api/me  -> who is signed in
router.get('/me', requireSignIn, (req, res) => {
  res.set('Cache-Control', 'no-store');
  const { username, email, emailVerified, hasPassword, deleteAfter } = req.user;
  res.json({ username, email, emailVerified, hasPassword, deleteAfter });
});

export default router;
