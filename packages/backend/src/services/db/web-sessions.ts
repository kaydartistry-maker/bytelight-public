import type { WebSession } from '@bytelight/shared';
import { getDb } from './init.js';
import { createHash } from 'node:crypto';

const HASH_PREFIX = 'sha256:';
const tokenHash = (token: string): string => HASH_PREFIX + createHash('sha256').update(token, 'utf8').digest('hex');

// Auth operations
export function createWebSession(params: {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}): WebSession {
  const stmt = getDb().prepare(`
    INSERT INTO web_sessions (id, token, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(params.id, tokenHash(params.token), params.createdAt, params.expiresAt);

  return {
    id: params.id,
    token: params.token,
    created_at: params.createdAt,
    expires_at: params.expiresAt,
  };
}

export function getWebSession(token: string): WebSession | null {
  const stmt = getDb().prepare('SELECT * FROM web_sessions WHERE token = ?');
  const row = stmt.get(tokenHash(token)) as WebSession | undefined;
  return row ? { ...row, token } : null;
}

// Push a live session's expiry further out. Sliding renewal: living in the app
// should never log her out, so an active session keeps buying itself more time.
export function touchWebSession(token: string, expiresAt: string): void {
  const stmt = getDb().prepare('UPDATE web_sessions SET expires_at = ? WHERE token = ?');
  stmt.run(expiresAt, tokenHash(token));
}

/** One-way conversion: bearer tokens are verifiers, never recoverable secrets. */
export function migrateWebSessionTokens(): void {
  const db = getDb();
  const rows = db.prepare('SELECT id, token FROM web_sessions').all() as { id: string; token: string }[];
  db.transaction(() => {
    for (const row of rows) {
      if (!row.token.startsWith(HASH_PREFIX)) {
        db.prepare('UPDATE web_sessions SET token = ? WHERE id = ?').run(tokenHash(row.token), row.id);
      }
    }
  }).immediate();
}

export function deleteExpiredSessions(): void {
  const stmt = getDb().prepare('DELETE FROM web_sessions WHERE expires_at < ?');
  stmt.run(new Date().toISOString());
}

export function deleteWebSession(token: string): void {
  getDb().prepare('DELETE FROM web_sessions WHERE token = ?').run(tokenHash(token));
}
