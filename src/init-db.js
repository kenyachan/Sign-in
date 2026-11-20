// Run with: npm run db:init
// Creates the database file and tables, then lists what's there.
import { db, migrate } from './db.js';

migrate();

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((row) => row.name);

console.log(`Database ready: ${db.name}`);
console.log(`Tables: ${tables.join(', ')}`);
db.close();
