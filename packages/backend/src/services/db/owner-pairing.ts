import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { getDb } from './init.js';
import { createWebSession } from './web-sessions.js';

export const OWNER_PAIRING_MIGRATION_PATH = 'migrations/049_owner_pairing.sql' as const;

// Deployment migrations are canonical; this fallback supports fresh databases.
function ensureOwnerPairingSchema(): void {
  getDb().exec(`CREATE TABLE IF NOT EXISTS owner_pairing_tokens (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);`);
}
export const pairingHash = (token: string) => createHash('sha256').update(token).digest('hex');
export function issuePairingToken(now = Date.now()): string {
  ensureOwnerPairingSchema();
  const token = randomBytes(32).toString('hex');
  getDb().prepare('INSERT INTO owner_pairing_tokens (token_hash, created_at, expires_at) VALUES (?, ?, ?)').run(pairingHash(token), now, now + 600_000);
  return token;
}
export function consumePairingToken(token: string, now = Date.now()): string | null {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  ensureOwnerPairingSchema();
  return getDb().transaction(() => {
    const result = getDb().prepare('UPDATE owner_pairing_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').run(now, pairingHash(token), now);
    if (result.changes !== 1) return null;
    const session = randomBytes(32).toString('hex');
    createWebSession({ id: randomUUID(), token: session, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 365 * 86400_000).toISOString() });
    return session;
  }).immediate();
}
