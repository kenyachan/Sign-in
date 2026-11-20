// Sessions: how the server remembers who is signed in.
//
// On sign-in we make a long random token and put it in a cookie. The database
// keeps only a SHA-256 hash of that token, so someone who copied the database
// still couldn't use it to sign in as anyone.

import { createHash, randomBytes } from 'node:crypto';
import { db } from './db.js';
import { isProduction } from './config.js';

// In production the name starts with __Host-, which makes browsers insist the
// cookie is HTTPS-only, set by this exact host, and valid for the whole site.
export const COOKIE_NAME = isProduction ? '__Host-sid' : 'sid';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // signed out after 7 days, whatever happens
const IDLE_MS = 24 * 60 * 60 * 1000;          // ...or after 24 hours without using the site
const TOUCH_EVERY_MS = 5 * 60 * 1000;         // how often to record "last seen"

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

const insertSession = db.prepare(`
  INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, user_agent)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const findSession = db.prepare(`
  SELECT s.id, s.expires_at, s.last_seen_at,
         u.id AS user_id, u.username, u.email, u.email_verified_at, u.delete_after,
         u.password_hash IS NOT NULL AS has_password
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.id = ?
`);
const touchSession = db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?');
const deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?');
const deleteUserSessions = db.prepare('DELETE FROM sessions WHERE user_id = ?');
const deleteExpired = db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?');

function cookieOptions() {
  return {
    httpOnly: true,                                  // page scripts can't read it
    secure: isProduction,                            // HTTPS only once deployed
    sameSite: 'lax',                                 // not sent on other sites' form posts
    path: '/',
  };
}

function readToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE_NAME) {
      try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

// Call after a successful sign-in. Any session the browser already had is
// deleted first, so every sign-in gets a brand-new ID (stops "session fixation").
export function startSession(req, res, userId) {
  const old = readToken(req);
  if (old) deleteSession.run(hashToken(old));

  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const userAgent = String(req.get('user-agent') ?? '').slice(0, 300);
  insertSession.run(hashToken(token), userId, iso(now), iso(now), iso(now + MAX_AGE_MS), userAgent);
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(), maxAge: MAX_AGE_MS });
}

export function endSession(req, res) {
  const token = readToken(req);
  if (token) deleteSession.run(hashToken(token));
  res.clearCookie(COOKIE_NAME, cookieOptions());
}

// Signs a user out everywhere: every browser and device.
export function endAllSessionsForUser(userId) {
  deleteUserSessions.run(userId);
}

// Runs on every request. Sets req.user to the signed-in user, or null.
export function loadSession(req, res, next) {
  req.user = null;
  const token = readToken(req);
  if (!token) return next();

  const id = hashToken(token);
  const row = findSession.get(id);
  const now = Date.now();

  if (!row) {
    res.clearCookie(COOKIE_NAME, cookieOptions());
    return next();
  }

  const lastSeen = Date.parse(row.last_seen_at);
  if (Date.parse(row.expires_at) <= now || lastSeen + IDLE_MS <= now) {
    deleteSession.run(id);
    res.clearCookie(COOKIE_NAME, cookieOptions());
    return next();
  }

  if (now - lastSeen > TOUCH_EVERY_MS) touchSession.run(iso(now), id);
  req.user = {
    id: row.user_id,
    username: row.username,
    email: row.email,
    emailVerified: row.email_verified_at !== null,
    hasPassword: row.has_password === 1,
    deleteAfter: row.delete_after,             // null unless the account is scheduled for deletion
  };
  next();
}

// For API routes: 401 if not signed in.
export function requireSignIn(req, res, next) {
  if (req.user) return next();
  res.status(401).json({ error: 'Please sign in.' });
}

// For pages: send people who aren't signed in to the sign-in page.
export function requireSignInPage(req, res, next) {
  if (req.user) return next();
  res.redirect('/signin');
}

export function deleteExpiredSessions() {
  const now = Date.now();
  deleteExpired.run(iso(now), iso(now - IDLE_MS));
}
