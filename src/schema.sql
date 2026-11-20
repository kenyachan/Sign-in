-- Database schema for the sign-in app.
-- Safe to run repeatedly: every statement uses IF NOT EXISTS.
-- Times are stored as ISO-8601 text in UTC, e.g. '2026-11-19T02:00:00Z'.

-- One row per person.
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,
  username          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  email             TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  email_verified_at TEXT,                      -- NULL until they click the verify link
  password_hash     TEXT,                      -- Argon2id hash; NULL for passkey-only accounts
  webauthn_user_id  TEXT    UNIQUE,            -- random ID given to passkeys (never the username)
  delete_after      TEXT,                      -- set when the owner asks to delete the account; erased after this time
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- One row per signed-in browser. The cookie holds a random token;
-- we store only its SHA-256 hash, so a leaked database can't be used to log in.
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT    PRIMARY KEY,            -- SHA-256 hash of the session token
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_seen_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  expires_at   TEXT    NOT NULL,
  user_agent   TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_id    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);

-- One row per passkey. A user can have several (phone, laptop, security key).
CREATE TABLE IF NOT EXISTS passkeys (
  id            INTEGER PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT    NOT NULL UNIQUE,       -- base64url ID chosen by the device
  public_key    BLOB    NOT NULL,              -- used to check signatures; not secret
  sign_count    INTEGER NOT NULL DEFAULT 0,
  transports    TEXT,                          -- JSON list, e.g. ["internal","hybrid"]
  device_type   TEXT,                          -- 'singleDevice' or 'multiDevice'
  backed_up     INTEGER NOT NULL DEFAULT 0,    -- 1 if synced (e.g. iCloud Keychain)
  nickname      TEXT,                          -- shown on the account page
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_used_at  TEXT
);
CREATE INDEX IF NOT EXISTS passkeys_user_id ON passkeys(user_id);

-- One-time links sent by email: verifying an address, or recovering an account.
-- Only the SHA-256 hash of the token is stored.
CREATE TABLE IF NOT EXISTS email_tokens (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT    NOT NULL UNIQUE,
  purpose    TEXT    NOT NULL CHECK (purpose IN ('verify_email', 'recovery')),
  expires_at TEXT    NOT NULL,
  used_at    TEXT,                             -- set when the link is used; it can't be used twice
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS email_tokens_user_id ON email_tokens(user_id);

-- Failed sign-in attempts, per username. Keyed by the username typed in
-- (lower-cased) rather than the user's ID, so usernames that don't exist get
-- locked exactly like real ones: the lockout can't reveal who has an account.
CREATE TABLE IF NOT EXISTS login_attempts (
  username_key    TEXT    PRIMARY KEY,
  failed_attempts INTEGER NOT NULL,
  last_failed_at  TEXT    NOT NULL,
  locked_until    TEXT
);

-- One-time challenges for passkeys. The server makes a random challenge, the
-- user's device signs it, and we check the signature. Each challenge can be
-- used once and only for 5 minutes, so a captured signature can't be replayed.
-- 'confirm' is a signed-in user proving it's them again, e.g. before deleting the account.
CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge  TEXT    PRIMARY KEY,
  purpose    TEXT    NOT NULL CHECK (purpose IN ('register', 'login', 'confirm')),
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,   -- set for 'register' and 'confirm'
  expires_at TEXT    NOT NULL
);
