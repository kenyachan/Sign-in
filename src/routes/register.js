import { Router } from 'express';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { validateRegistration } from '../validation.js';
import { registerLimiter } from '../rate-limits.js';
import { sendInBackground } from '../mailer.js';
import { alreadyRegisteredEmail } from '../emails.js';
import { sendVerificationEmail } from './email.js';

const router = Router();

const usernameExists = db.prepare('SELECT 1 FROM users WHERE username = ?');
const emailExists = db.prepare('SELECT 1 FROM users WHERE email = ?');
const insertUser = db.prepare(`
  INSERT INTO users (username, email, password_hash, webauthn_user_id)
  VALUES (?, ?, ?, ?)
`);

const SUCCESS = { message: 'Your account is ready. Check your email to confirm your address.' };

// Someone signed up with an email that's already registered. Tell the real owner,
// but reply to the visitor exactly as if it worked.
function emailAlreadyRegistered(res, email) {
  sendInBackground({ to: email, ...alreadyRegisteredEmail() });
  return res.status(201).json(SUCCESS);
}

// POST /api/register  { username, email, password }
router.post('/register', registerLimiter, async (req, res) => {
  const body = req.body ?? {};
  const username = typeof body.username === 'string' ? body.username.trim() : body.username;
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : body.email;
  // NFKC makes visually identical passwords (e.g. different accent encodings) match at sign-in.
  const password = typeof body.password === 'string' ? body.password.normalize('NFKC') : body.password;

  const errors = validateRegistration({ username, email, password });
  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ errors });
  }

  // Hash before looking anything up, so every request takes about the same time
  // and the response time doesn't hint at which emails are registered.
  // argon2id with the library's defaults: 64 MiB memory, 3 passes, unique salt per hash.
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  if (usernameExists.get(username)) {
    return res.status(409).json({ errors: { username: 'That username is taken.' } });
  }

  // Don't reveal that an email is already registered: reply exactly as if it worked.
  if (emailExists.get(email)) {
    return emailAlreadyRegistered(res, email);
  }

  // A random ID for passkeys, so the device never learns the username.
  const webauthnUserId = randomBytes(16).toString('base64url');

  let userId;
  try {
    userId = Number(insertUser.run(username, email, passwordHash, webauthnUserId).lastInsertRowid);
  } catch (err) {
    // Two sign-ups at the same moment can both pass the checks above;
    // the database's UNIQUE rules catch the second one.
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      if (err.message.includes('users.username')) {
        return res.status(409).json({ errors: { username: 'That username is taken.' } });
      }
      return emailAlreadyRegistered(res, email);
    }
    throw err;
  }

  sendVerificationEmail(userId);
  res.status(201).json(SUCCESS);
});

export default router;
