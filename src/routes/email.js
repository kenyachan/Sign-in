import { Router } from 'express';
import rateLimit, { MemoryStore } from 'express-rate-limit';
import { db } from '../db.js';
import { requireSignIn } from '../sessions.js';
import { createEmailToken, useEmailToken } from '../email-tokens.js';
import { sendInBackground } from '../mailer.js';
import { verificationEmail } from '../emails.js';

const router = Router();
const VERIFY_LINK_LIFETIME_MS = 24 * 60 * 60 * 1000;

const getUser = db.prepare('SELECT username, email, email_verified_at FROM users WHERE id = ?');
const markVerified = db.prepare(`
  UPDATE users
  SET email_verified_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      updated_at        = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  WHERE id = ? AND email_verified_at IS NULL
`);

// Emails a fresh "confirm your email" link. Any earlier link stops working.
export function sendVerificationEmail(userId) {
  const user = getUser.get(userId);
  const token = createEmailToken(userId, 'verify_email', VERIFY_LINK_LIFETIME_MS);
  sendInBackground({ to: user.email, ...verificationEmail(user.username, token) });
}

// POST /api/verify-email  { token }   (sent by the /verify-email page)
router.post('/verify-email', (req, res) => {
  const userId = useEmailToken(req.body?.token, 'verify_email');
  if (!userId) {
    return res.status(400).json({ error: 'This link is invalid, already used, or expired.' });
  }
  markVerified.run(userId);
  res.json({ message: 'Your email address is confirmed.' });
});

// At most 3 new links per hour for each account.
export const resendStore = new MemoryStore();   // the tests clear this between runs
const resendLimiter = rateLimit({
  store: resendStore,
  windowMs: 60 * 60 * 1000,
  limit: 3,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user.id}`,
  message: { error: "You've asked for several links recently. Try again in an hour." },
});

// POST /api/resend-verification   (signed in)
router.post('/resend-verification', requireSignIn, resendLimiter, (req, res) => {
  const user = getUser.get(req.user.id);
  if (user.email_verified_at) {
    return res.json({ message: 'Your email address is already confirmed.' });
  }
  sendVerificationEmail(req.user.id);
  res.json({ message: `We've sent a new link to ${user.email}.` });
});

export default router;
