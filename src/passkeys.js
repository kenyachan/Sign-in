// Database helpers for passkeys and their one-time challenges.
import { randomBytes } from 'node:crypto';
import { db } from './db.js';

const CHALLENGE_LIFETIME_MS = 5 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// --- Challenges ------------------------------------------------------------
const insertChallenge = db.prepare(`
  INSERT INTO webauthn_challenges (challenge, purpose, user_id, expires_at) VALUES (?, ?, ?, ?)
`);
const takeChallengeRow = db.prepare(`
  DELETE FROM webauthn_challenges WHERE challenge = ? AND purpose = ? RETURNING user_id, expires_at
`);
const deleteExpiredChallenges = db.prepare('DELETE FROM webauthn_challenges WHERE expires_at <= ?');

export function saveChallenge(challenge, purpose, userId = null) {
  insertChallenge.run(challenge, purpose, userId, iso(Date.now() + CHALLENGE_LIFETIME_MS));
}

// Removes the challenge (so it can never be used again) and returns it if it
// was still valid. For "register" and "confirm", it must also belong to the signed-in user.
export function takeChallenge(challenge, purpose, userId = null) {
  if (typeof challenge !== 'string' || challenge.length > 200) return false;
  const row = takeChallengeRow.get(challenge, purpose);
  if (!row || Date.parse(row.expires_at) <= Date.now()) return false;
  if ((purpose === 'register' || purpose === 'confirm') && row.user_id !== userId) return false;
  return true;
}

// The browser's response contains the challenge it signed, inside clientDataJSON.
export function challengeFrom(response) {
  try {
    const clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString());
    return typeof clientData.challenge === 'string' ? clientData.challenge : null;
  } catch {
    return null;
  }
}

export function deleteOldChallenges() {
  deleteExpiredChallenges.run(iso(Date.now()));
}

// --- Users -----------------------------------------------------------------
const getUserRow = db.prepare('SELECT id, email, first_name, last_name, webauthn_user_id, password_hash FROM users WHERE id = ?');
const setWebauthnId = db.prepare('UPDATE users SET webauthn_user_id = ? WHERE id = ?');

// Every user gets a random passkey ID; it's what the device stores instead of anything personal.
export function getPasskeyUser(userId) {
  const user = getUserRow.get(userId);
  if (user && !user.webauthn_user_id) {
    user.webauthn_user_id = randomBytes(16).toString('base64url');
    setWebauthnId.run(user.webauthn_user_id, userId);
  }
  return user;
}

// --- Passkeys --------------------------------------------------------------
const listForUser = db.prepare(`
  SELECT id, credential_id, transports, nickname, backed_up, created_at, last_used_at
  FROM passkeys WHERE user_id = ? ORDER BY created_at, id
`);
const insertPasskey = db.prepare(`
  INSERT INTO passkeys (user_id, credential_id, public_key, sign_count, transports, device_type, backed_up, nickname)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
const findByCredentialId = db.prepare(`
  SELECT p.id, p.user_id, p.credential_id, p.public_key, p.sign_count, p.transports, u.first_name, u.email_verified_at, u.webauthn_user_id
  FROM passkeys p JOIN users u ON u.id = p.user_id
  WHERE p.credential_id = ?
`);
const recordUse = db.prepare(`
  UPDATE passkeys SET sign_count = ?, backed_up = ?, last_used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?
`);
const deleteOwn = db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?');
const renameOwn = db.prepare('UPDATE passkeys SET nickname = ? WHERE id = ? AND user_id = ?');
const countForUser = db.prepare('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?');

export const parseTransports = (json) => {
  try { return JSON.parse(json ?? '[]'); } catch { return []; }
};

export function listPasskeys(userId) {
  return listForUser.all(userId);
}

// What the account page sees. Never includes keys or credential IDs.
export function describePasskey(row) {
  return {
    id: row.id,
    nickname: row.nickname,
    synced: row.backed_up === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

export function addPasskey(userId, { credential, credentialDeviceType, credentialBackedUp }, nickname) {
  const { lastInsertRowid } = insertPasskey.run(
    userId,
    credential.id,
    Buffer.from(credential.publicKey),
    credential.counter,
    JSON.stringify(credential.transports ?? []),
    credentialDeviceType,
    credentialBackedUp ? 1 : 0,
    nickname,
  );
  return Number(lastInsertRowid);
}

export function findPasskey(credentialId) {
  if (typeof credentialId !== 'string' || credentialId.length > 1400) return null;
  return findByCredentialId.get(credentialId);
}

export function markPasskeyUsed(id, newCounter, backedUp) {
  recordUse.run(newCounter, backedUp ? 1 : 0, id);
}

export function removePasskey(id, userId) {
  return deleteOwn.run(id, userId).changes === 1;
}

export const NICKNAME_MAX = 50;

// Tidies a name typed by the user: trims it, removes invisible control
// characters, and squeezes repeated spaces. Returns null if it isn't usable.
export function cleanNickname(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length === 0 || [...name].length > NICKNAME_MAX) return null;
  return name;
}

export function renamePasskey(id, userId, nickname) {
  return renameOwn.run(nickname, id, userId).changes === 1;
}

export function passkeyCount(userId) {
  return countForUser.get(userId).n;
}

// A friendly default name, e.g. "Passkey on Mac", if the passkey provider
// (iCloud Keychain, Google Password Manager...) doesn't tell us its own name.
export function guessDeviceName(userAgent = '') {
  const devices = [
    [/iPhone/, 'iPhone'], [/iPad/, 'iPad'], [/Android/, 'Android'], [/CrOS/, 'Chromebook'],
    [/Macintosh|Mac OS X/, 'Mac'], [/Windows/, 'Windows'], [/Linux/, 'Linux'],
  ];
  const match = devices.find(([pattern]) => pattern.test(userAgent));
  return match ? `Passkey on ${match[1]}` : 'Passkey';
}
