import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { loadConfig, reloadConfig, persistOrchestratorEnabled, findBytelightConfigPath } from '../config.js';
import { hydrateVaultCredentials } from './credential-migration.js';
import { provisionVaultKey, isVaultEnvelope } from './credential-vault.js';
import { initDb, getConfig, setConfig } from './db.js';
import { setSecret, deleteSecret } from './secrets.js';

test('native reload rehydrates the authoritative vault without retaining removed keys or writing plaintext', async t => {
  const directory = mkdtempSync(join(homedir(), '.native-credential-reload-'));
  const configPath = join(directory, 'bytelight.yaml');
  const keyPath = join(directory, 'vault.key');
  const variables = ['VIRELLE_VAULT_KEY_FILE', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY', 'HUGGINGFACE_API_KEY', 'OLLAMA_API_KEY', 'APP_PASSWORD'];
  const saved = Object.fromEntries(variables.map(name => [name, process.env[name]]));
  for (const name of variables) delete process.env[name];
  let database: ReturnType<typeof initDb> | undefined;
  const writeFixture = (providers: Record<string, unknown> | null = {}) => writeFileSync(configPath, yaml.dump({
    server: { port: 4329, db_path: join(directory, 'fixture.db') },
    security: { vault_key_file: keyPath }, auth: { password: '' }, ...(providers === null ? {} : { providers }),
    orchestrator: { enabled: true },
  }), { mode: 0o600 });
  try {
    writeFixture();
    await t.test('imports and reloads safely before DB initialization with no credentials', () => {
      assert.equal(loadConfig(configPath).server.port, 4329);
      const config = reloadConfig();
      assert.equal(config.server.port, 4329);
      assert.equal(config.auth.password, '');
      assert.equal(findBytelightConfigPath(), configPath);
      assert.deepEqual(config.providers, {});
    });
    provisionVaultKey(keyPath); process.env.VIRELLE_VAULT_KEY_FILE = keyPath;
    database = initDb(join(directory, 'fixture.db'));
    const providers = ['openai', 'openrouter', 'groq', 'xai', 'huggingface', 'ollama', 'custom', 'anthropic'];
    for (const provider of providers) setSecret(`provider_${provider}_api_key`, `synthetic-${provider}`);
    setSecret('auth_password', 'synthetic-owner-password');
    await t.test('all existing provider slots and owner password survive a preferences/integration reload', () => {
      const config = reloadConfig();
      for (const provider of providers) {
        assert.equal((config.providers as any)[provider].api_key, `synthetic-${provider}`);
        assert.ok(isVaultEnvelope(getConfig(`secret:provider_${provider}_api_key`)!));
      }
      assert.equal(config.auth.password, 'synthetic-owner-password');
      persistOrchestratorEnabled(false);
      assert.equal(reloadConfig().orchestrator.enabled, false);
      assert.equal((reloadConfig().providers as any).openrouter.api_key, 'synthetic-openrouter');
      assert.equal(reloadConfig().auth.password, 'synthetic-owner-password');
      const contents = readFileSync(configPath, 'utf8');
      assert.ok(!contents.includes('synthetic-'));
      assert.equal((yaml.load(contents) as any).orchestrator.enabled, false);
    });
    await t.test('legitimate removal selects environment fallback then clears the stale runtime value', () => {
      deleteSecret('provider_openrouter_api_key');
      process.env.OPENROUTER_API_KEY = 'synthetic-env-fallback';
      assert.equal((reloadConfig().providers as any).openrouter.api_key, 'synthetic-env-fallback');
      delete process.env.OPENROUTER_API_KEY;
      assert.equal((reloadConfig().providers as any).openrouter?.api_key, undefined);
      deleteSecret('auth_password'); process.env.APP_PASSWORD = 'synthetic-password-fallback';
      assert.equal(reloadConfig().auth.password, 'synthetic-password-fallback');
      delete process.env.APP_PASSWORD;
      assert.equal(reloadConfig().auth.password, '');
    });
    await t.test('missing YAML provider block supports encrypted and environment-only slots', () => {
      writeFixture(null);
      process.env.OPENROUTER_API_KEY = 'synthetic-env-without-provider-block';
      assert.equal((reloadConfig().providers as any).openrouter.api_key, 'synthetic-env-without-provider-block');
      delete process.env.OPENROUTER_API_KEY;
    });
    await t.test('damaged ciphertext fails closed rather than choosing another credential', () => {
      setConfig('secret:provider_openrouter_api_key', 'virelle-vault:1:invalid');
      process.env.OPENROUTER_API_KEY = 'synthetic-must-not-be-used';
      assert.throws(() => reloadConfig());
      deleteSecret('provider_openrouter_api_key'); delete process.env.OPENROUTER_API_KEY;
      hydrateVaultCredentials(reloadConfig());
      assert.ok(!readFileSync(configPath, 'utf8').includes('synthetic-'));
    });
  } finally {
    database?.close();
    for (const name of variables) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    rmSync(directory, { recursive: true, force: true });
  }
});
