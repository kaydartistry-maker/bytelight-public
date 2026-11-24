import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { initDb, getDb } from './init.js';
import { createWebSession, getWebSession, migrateWebSessionTokens, touchWebSession } from './web-sessions.js';

let dir: string;
before(() => {
  dir = mkdtempSync(join(homedir(), '.virelle-session-security-'));
  chmodSync(dir, 0o700);
  initDb(join(dir, 'test.db'));
});
after(() => { getDb().close(); rmSync(dir, { recursive: true, force: true }); });

test('new bearer tokens are hashed at rest while raw cookies still resolve', () => {
  createWebSession({ id: 'new', token: 'raw-cookie-token', createdAt: '2026-01-01T00:00:00Z', expiresAt: '2027-01-01T00:00:00Z' });
  const stored = getDb().prepare('SELECT token FROM web_sessions WHERE id = ?').get('new') as { token: string };
  assert.match(stored.token, /^sha256:[a-f0-9]{64}$/);
  assert.equal(stored.token.includes('raw-cookie-token'), false);
  assert.equal(getWebSession('raw-cookie-token')?.id, 'new');
  touchWebSession('raw-cookie-token', '2028-01-01T00:00:00Z');
  assert.equal(getWebSession('raw-cookie-token')?.expires_at, '2028-01-01T00:00:00Z');
});

test('legacy plaintext bearer tokens migrate one-way and idempotently', () => {
  getDb().prepare('INSERT INTO web_sessions (id, token, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run('legacy', 'legacy-cookie', '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');
  migrateWebSessionTokens();
  assert.equal(getWebSession('legacy-cookie')?.id, 'legacy');
  migrateWebSessionTokens();
  const stored = getDb().prepare('SELECT token FROM web_sessions WHERE id = ?').get('legacy') as { token: string };
  assert.match(stored.token, /^sha256:[a-f0-9]{64}$/);
});
