import type { WebSession } from '@bytelight/shared';
import { getDb } from './init.js';

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
  stmt.run(params.id, params.token, params.createdAt, params.expiresAt);

  return {
    id: params.id,
    token: params.token,
    created_at: params.createdAt,
    expires_at: params.expiresAt,
  };
}

export function getWebSession(token: string): WebSession | null {
  const stmt = getDb().prepare('SELECT * FROM web_sessions WHERE token = ?');
  const row = stmt.get(token);
  return row ? (row as unknown as WebSession) : null;
}

// Push a live session's expiry further out. Sliding renewal: living in the app
// should never log her out, so an active session keeps buying itself more time.
export function touchWebSession(token: string, expiresAt: string): void {
  const stmt = getDb().prepare('UPDATE web_sessions SET expires_at = ? WHERE token = ?');
  stmt.run(expiresAt, token);
}

export function deleteExpiredSessions(): void {
  const stmt = getDb().prepare('DELETE FROM web_sessions WHERE expires_at < ?');
  stmt.run(new Date().toISOString());
}
