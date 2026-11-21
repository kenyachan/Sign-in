import { Router } from 'express';
import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { db } from '../db.js';
import { checkNames, tidyEmail, validateRegistration } from '../validation.js';
import { registerLimiter } from '../rate-limits.js';
import { sendInBackground } from '../mailer.js';
import { alreadyRegisteredEmail } from '../emails.js';
import { sendVerificationEmail, sendVerificationEmailIfDue } from './email.js';

const router = Router();

const findByEmail = db.prepare('SELECT id, email_verified_at FROM users WHERE email = ?');
const insertUser = db.prepare(`
  INSERT INTO users (first_name, last_name, email, password_hash, webauthn_user_id)
  VALUES (?, ?, ?, ?, ?)
`);

const SUCCESS = { message: "Check your email to confirm your address. You can sign in once it's confirmed." };

// Someone signed up with an email that already has an account. Reply to the
// visitor exactly as if it worked, and email the address instead:
//  - a confirmed account: "someone tried to sign up with your email"
//  - an unconfirmed one: links to confirm that sign-up, or cancel it so the
//    owner of the address can sign up themselves
function emailAlreadyRegistered(res, existing, email) {
  if (existing.email_verified_at) {
    sendInBackground({ to: email, ...alreadyRegisteredEmail() });
  } else {
    sendVerificationEmailIfDue(existing.id, 'pending');
  }
  return res.status(201).json(SUCCESS);
}

// POST /api/register  { firstName, lastName, email, password }
router.post('/register', registerLimiter, async (req, res) => {
  const body = req.body ?? {};
  const email = typeof body.email === 'string' ? tidyEmail(body.email) : body.email;
  // NFKC makes visually identical passwords (e.g. different accent encodings) match at sign-in.
  const password = typeof body.password === 'string' ? body.password.normalize('NFKC') : body.password;

  const errors = validateRegistration({ firstName: body.firstName, lastName: body.lastName, email, password });
  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ errors });
  }
  const { firstName, lastName } = checkNames(body);   // tidied: trimmed, spaces squeezed

  // Hash before looking anything up, so every request takes about the same time
  // and the response time doesn't hint at which emails are registered.
  // argon2id with the library's defaults: 64 MiB memory, 3 passes, unique salt per hash.
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  // Don't reveal that an email is already registered: reply exactly as if it worked.
  const existing = findByEmail.get(email);
  if (existing) return emailAlreadyRegistered(res, existing, email);

  // A random ID for passkeys, so the device never learns anything about the person from it.
  const webauthnUserId = randomBytes(16).toString('base64url');

  let userId;
  try {
    userId = Number(insertUser.run(firstName, lastName, email, passwordHash, webauthnUserId).lastInsertRowid);
  } catch (err) {
    // Two sign-ups at the same moment can both pass the check above;
    // the database's UNIQUE rule catches the second one.
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return emailAlreadyRegistered(res, findByEmail.get(email), email);
    }
    throw err;
  }

  sendVerificationEmail(userId);
  res.status(201).json(SUCCESS);
});

export default router;
