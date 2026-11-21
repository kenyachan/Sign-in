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

// Creates any missing tables and indexes. There's no upgrade code for older
// databases: if schema.sql changes, delete data/app.db and start fresh.
export function migrate() {
  db.exec(readFileSync(path.join(here, 'schema.sql'), 'utf8'));
}

// Create the tables straight away, before any other file prepares queries against them.
migrate();
