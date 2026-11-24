import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { provisionVaultKey, isVaultEnvelope } from '../credential-vault.js';
import { initDb, getDb } from './init.js';
import { addMcpServer, listMcpServers, migrateMcpServerCredentials } from './mcp-servers.js';

let dir: string;

before(() => {
  dir = mkdtempSync(join(homedir(), '.virelle-mcp-vault-test-'));
  chmodSync(dir, 0o700);
  const keyPath = join(dir, 'vault.key');
  provisionVaultKey(keyPath);
  process.env.VIRELLE_VAULT_KEY_FILE = keyPath;
  initDb(join(dir, 'test.db'));
});

after(() => {
  getDb().close();
  delete process.env.VIRELLE_VAULT_KEY_FILE;
  rmSync(dir, { recursive: true, force: true });
});

test('new MCP keys are encrypted at rest and decrypted for consumers', () => {
  const row = addMcpServer('private', 'https://example.test/mcp', 'top-secret');
  assert.equal(row.api_key, 'top-secret');
  const stored = getDb().prepare('SELECT api_key FROM mcp_servers WHERE id = ?').get(row.id) as { api_key: string };
  assert.equal(isVaultEnvelope(stored.api_key), true);
  assert.equal(stored.api_key.includes('top-secret'), false);
});

test('legacy MCP keys migrate atomically and remain readable', () => {
  const result = getDb().prepare('INSERT INTO mcp_servers (name, url, api_key) VALUES (?, ?, ?)')
    .run('legacy', 'https://legacy.test/mcp', 'old-secret');
  migrateMcpServerCredentials();
  const stored = getDb().prepare('SELECT api_key FROM mcp_servers WHERE id = ?').get(result.lastInsertRowid) as { api_key: string };
  assert.equal(isVaultEnvelope(stored.api_key), true);
  assert.equal(listMcpServers().find((r) => r.name === 'legacy')?.api_key, 'old-secret');
});
