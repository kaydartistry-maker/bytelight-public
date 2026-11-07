import 'dotenv/config';
import { dirname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { loadConfig } from './config.js';
import { initDb } from './services/db.js';

// Standalone database bootstrap for a fresh install (`npm run db:init`).
//
// This MUST go through initDb() — the same runner the server boots with —
// not read migration files itself. A previous version executed only
// 001_init.sql and built a database twenty migrations behind: every table
// added since (stickers, usage, memory, companions, delivery...) was
// missing, and the first real boot met a half-schema'd file it believed
// was initialized. Aerie hit the identical trap (her f69b7c7e removed the
// file outright); we keep the convenience script but route it through the
// one true runner so it cannot drift again.

const config = loadConfig();
const DB_PATH = config.server.db_path;

const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
  console.log(`Created data directory: ${dataDir}`);
}

console.log(`Initializing database at: ${DB_PATH}`);

const db = initDb(DB_PATH);

// Default quiet hours — INSERT OR IGNORE, so an existing row wins.
const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
stmt.run('dnd_start', '23:00');
stmt.run('dnd_end', '07:00');

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>;
console.log(`\n${tables.length} tables present:`);
tables.forEach(table => {
  console.log(`  - ${table.name}`);
});

db.close();
console.log('\nDatabase initialization complete');
