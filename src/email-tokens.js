// One-time links sent by email (confirm your email now; account recovery in step 9).
// The link holds a long random token; the database keeps only its SHA-256 hash.
import { createHash, randomBytes } from 'node:crypto';
import { db } from './db.js';

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const hashToken = (token) => createHash('sha256').update(token).digest('hex');

const insertToken = db.prepare(`
  INSERT INTO email_tokens (user_id, token_hash, purpose, expires_at) VALUES (?, ?, ?, ?)
`);
const deleteUnused = db.prepare(`
  DELETE FROM email_tokens WHERE user_id = ? AND purpose = ? AND used_at IS NULL
`);
const findToken = db.prepare(`
  SELECT id, user_id, expires_at, used_at FROM email_tokens WHERE token_hash = ? AND purpose = ?
`);
const markUsed = db.prepare('UPDATE email_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL');
const deleteOld = db.prepare('DELETE FROM email_tokens WHERE expires_at <= ?');

// Makes a new token. Any older unused link for the same purpose stops working,
// so only the most recent email's link is valid.
export function createEmailToken(userId, purpose, lifetimeMs) {
  deleteUnused.run(userId, purpose);
  const token = randomBytes(32).toString('base64url');
  insertToken.run(userId, hashToken(token), purpose, iso(Date.now() + lifetimeMs));
  return token;
}

// Checks a token without using it up: the user's ID if it's valid, otherwise null.
export function peekEmailToken(token, purpose) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const row = findToken.get(hashToken(token), purpose);
  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) return null;
  return row.user_id;
}

// If the token is real, unused and not expired: marks it used and returns the
// user's ID. Otherwise returns null. Each token works exactly once.
export function useEmailToken(token, purpose) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const row = findToken.get(hashToken(token), purpose);
  if (!row || row.used_at || Date.parse(row.expires_at) <= Date.now()) return null;
  const { changes } = markUsed.run(iso(Date.now()), row.id);
  return changes === 1 ? row.user_id : null;
}

// Expired links are useless; clear out ones more than a week past expiry.
export function deleteOldEmailTokens() {
  deleteOld.run(iso(Date.now() - 7 * 24 * 60 * 60 * 1000));
}
