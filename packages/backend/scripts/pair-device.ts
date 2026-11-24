// Explicit offline administrative CLI. No config/dotenv import and no HTTP issuer.
import { existsSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { initDb } from '../src/services/db/init.js';
import { issuePairingToken } from '../src/services/db/owner-pairing.js';
const [database, override] = process.argv.slice(2);
if (!database) throw new Error('Usage: tsx packages/backend/scripts/pair-device.ts /absolute/database.sqlite [https://base]');
if (!isAbsolute(database) || !existsSync(database)) throw new Error('An existing absolute database path is required');
const base = new URL(override || 'https://64.225.47.42.nip.io');
if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Base must be a bare HTTPS origin');
// Keep stdout suitable for a single private URL; migration diagnostics use stderr.
console.log = console.error;
const db = initDb(resolve(database));
try {
  const token = issuePairingToken();
  process.stdout.write(`${base.origin}/pair#token=${token}\n`);
} finally { db.close(); }
