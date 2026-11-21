-- Database schema for the sign-in app.
-- Safe to run repeatedly: every statement uses IF NOT EXISTS.
-- There are no upgrade steps: after changing this file, delete data/app.db and run `npm run db:init`.
-- Times are stored as ISO-8601 text in UTC, e.g. '2026-11-19T02:00:00Z'.

-- One row per person.
CREATE TABLE IF NOT EXISTS users (
  id                INTEGER PRIMARY KEY,
  first_name        TEXT    NOT NULL,          -- used to greet the user in emails
  last_name         TEXT,                      -- optional: some people have only one name
  email             TEXT    NOT NULL UNIQUE COLLATE NOCASE,   -- what they sign in with
  email_verified_at TEXT,                      -- NULL until confirmed; unconfirmed accounts can't sign in,
                                               -- and are deleted after 7 days
  pending_email     TEXT    COLLATE NOCASE,    -- a new address waiting for confirmation (changing email)
  password_hash     TEXT,                      -- Argon2id hash; NULL for passkey-only accounts
  webauthn_user_id  TEXT    UNIQUE,            -- random ID given to passkeys (never the email)
  delete_after      TEXT,                      -- set when the owner asks to delete the account; erased after this time
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS users_delete_after ON users(delete_after) WHERE delete_after IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_unconfirmed  ON users(created_at)   WHERE email_verified_at IS NULL;

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

-- One-time links sent by email:
--   verify_email         confirm the address given at sign-up
--   cancel_signup        "this wasn't me": deletes an unconfirmed sign-up
--   recovery             get back into an account
--   change_email         confirm a new address (sent to the new address)
--   cancel_email_change  stop a change of address (sent to the old address)
-- Only the SHA-256 hash of the token is stored.
CREATE TABLE IF NOT EXISTS email_tokens (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT    NOT NULL UNIQUE,
  purpose    TEXT    NOT NULL CHECK (purpose IN ('verify_email', 'cancel_signup', 'recovery', 'change_email', 'cancel_email_change')),
  expires_at TEXT    NOT NULL,
  used_at    TEXT,                             -- set when the link is used; it can't be used twice
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS email_tokens_user_id ON email_tokens(user_id);

-- Failed sign-in attempts, per email address. Keyed by the address typed in
-- (lower-cased) rather than the user's ID, so addresses without an account get
-- locked exactly like real ones: the lockout can't reveal who has an account.
CREATE TABLE IF NOT EXISTS login_attempts (
  account_key     TEXT    PRIMARY KEY,
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
