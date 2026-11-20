// Opens the SQLite database and creates the tables if they don't exist yet.
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DATABASE_PATH ?? path.join(here, '..', 'data', 'app.db');

mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');   // better performance with a web server
db.pragma('foreign_keys = ON');    // SQLite has these off by default

export function migrate() {
  // Databases made before account deletion existed need two small changes.
  // 1. The passkey challenge table only allowed 'register' and 'login'. Its rows
  //    only live for 5 minutes, so it's simply dropped and made again below.
  const challenges = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'webauthn_challenges'").get();
  if (challenges && !challenges.sql.includes("'confirm'")) db.exec('DROP TABLE webauthn_challenges');

  const schema = readFileSync(path.join(here, 'schema.sql'), 'utf8');
  db.exec(schema);

  // 2. users gains delete_after (when an account scheduled for deletion will be erased).
  const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userColumns.includes('delete_after')) db.exec('ALTER TABLE users ADD COLUMN delete_after TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS users_delete_after ON users(delete_after) WHERE delete_after IS NOT NULL');
}

// Create the tables straight away, before any other file prepares queries against them.
migrate();
