import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { provisionVaultKey, isVaultEnvelope } from './credential-vault.js';
import { initDb, getDb } from './db/init.js';
import { getSecret, setSecret } from './secrets.js';
import { getConfig, setConfig } from './db.js';
import { migrateYamlCredentials } from './credential-migration.js';

let dir: string;
let configPath: string;

before(() => {
  dir = mkdtempSync(join(homedir(), '.virelle-credential-migration-test-'));
  chmodSync(dir, 0o700);
  const keyPath = join(dir, 'vault.key');
  provisionVaultKey(keyPath);
  process.env.VIRELLE_VAULT_KEY_FILE = keyPath;
  initDb(join(dir, 'test.db'));
  configPath = join(dir, 'bytelight.yaml');
});

after(() => {
  getDb().close();
  delete process.env.VIRELLE_VAULT_KEY_FILE;
  rmSync(dir, { recursive: true, force: true });
});

test('provider keys and app password leave YAML and enter authenticated envelopes', () => {
  writeFileSync(configPath, yaml.dump({
    auth: { password: 'house-password' },
    providers: { openai: { api_key: 'provider-key', enabled: true }, ollama: { base_url: 'http://localhost', enabled: false } },
  }), { mode: 0o600 });
  assert.equal(migrateYamlCredentials(configPath), true);
  const parsed = yaml.load(readFileSync(configPath, 'utf8')) as any;
  assert.equal(parsed.auth.password, undefined);
  assert.equal(parsed.providers.openai.api_key, undefined);
  assert.equal(parsed.providers.openai.enabled, true);
  assert.equal(isVaultEnvelope(getConfig('secret:auth_password')!), true);
  assert.equal(isVaultEnvelope(getConfig('secret:provider_openai_api_key')!), true);
  assert.equal(readFileSync(configPath, 'utf8').includes('house-password'), false);
  assert.equal(readFileSync(configPath, 'utf8').includes('provider-key'), false);
  assert.equal(migrateYamlCredentials(configPath), false);
});

test('existing encrypted override wins while plaintext YAML is removed', () => {
  setSecret('provider_xai_api_key', 'existing-encrypted');
  writeFileSync(configPath, yaml.dump({ providers: { xai: { api_key: 'stale-plaintext' } } }), { mode: 0o600 });
  assert.equal(migrateYamlCredentials(configPath), true);
  assert.equal(readFileSync(configPath, 'utf8').includes('stale-plaintext'), false);
  assert.equal(getSecret('provider_xai_api_key'), 'existing-encrypted');
});
