// Rate limits per IP address: they slow down anyone hammering the server,
// whichever email addresses they try. (lockout.js handles attacks on one address.)

import rateLimit from 'express-rate-limit';

const common = {
  standardHeaders: 'draft-8',   // tells clients their limit in a RateLimit header
  legacyHeaders: false,
};

// Sign-in: 20 failed attempts per 15 minutes per IP. Successful sign-ins don't count.
export const loginLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 20,
  skipSuccessfulRequests: true,
  message: { error: 'Too many sign-in attempts from your network. Try again in 15 minutes.' },
});

// Sign-up: 10 accounts per hour per IP.
export const registerLimiter = rateLimit({
  ...common,
  windowMs: 60 * 60 * 1000,
  limit: 10,
  message: { error: 'Too many sign-ups from your network. Try again later.' },
});

// Everything under /api: a generous ceiling that normal use never reaches.
export const apiLimiter = rateLimit({
  ...common,
  windowMs: 15 * 60 * 1000,
  limit: 300,
  message: { error: 'Too many requests. Please slow down.' },
});
