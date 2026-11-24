/** One-way migration from legacy plaintext stores into the native vault. */
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { findBytelightConfigPath, getBytelightConfig, reloadConfig, setConfigReloadHydrator, type BytelightConfig } from '../config.js';
import { deleteConfig, getConfig } from './db.js';
import { migrateMcpServerCredentials } from './db/mcp-servers.js';
import { getSecret, setSecret } from './secrets.js';

const PROVIDERS = ['openai', 'openrouter', 'groq', 'xai', 'huggingface', 'ollama', 'custom', 'anthropic'] as const;
type ProviderName = typeof PROVIDERS[number];

function atomicYamlWrite(path: string, value: unknown): void {
  const tmp = join(dirname(path), `.bytelight-vault-${process.pid}-${Date.now()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, yaml.dump(value, { lineWidth: -1, quotingType: '"', forceQuotes: true }), 'utf8');
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(tmp); } catch { /* renamed or never created */ }
  }
}

/** Populate runtime config from encrypted overrides/environment after DB init. */
export function hydrateVaultCredentials(config: BytelightConfig = getBytelightConfig()): void {
  const providers = (config.providers ??= {}) as Record<string, { api_key?: string } | undefined>;
  for (const provider of PROVIDERS) {
    const value = getSecret(`provider_${provider}_api_key`);
    if (!value) continue;
    providers[provider] ??= {};
    providers[provider]!.api_key = value;
  }
  const password = getSecret('auth_password');
  if (password) config.auth.password = password;
}

// Registration performs no IO. The loader remains independent of the vault/DB
// graph, while every later preference/integration reload uses the same reader.
setConfigReloadHydrator(hydrateVaultCredentials);

/** Move YAML-held credentials first, then atomically replace the YAML file. */
export function migrateYamlCredentials(configPath: string): boolean {
  const parsed = (yaml.load(readFileSync(configPath, 'utf8')) as Record<string, any>) || {};
  let changed = false;
  for (const provider of PROVIDERS) {
    const block = parsed.providers?.[provider];
    if (!block || typeof block.api_key !== 'string' || !block.api_key) continue;
    if (!getConfig(`secret:provider_${provider}_api_key`)) setSecret(`provider_${provider}_api_key`, block.api_key);
    delete block.api_key;
    changed = true;
  }
  if (typeof parsed.auth?.password === 'string' && parsed.auth.password) {
    if (!getConfig('secret:auth_password')) setSecret('auth_password', parsed.auth.password);
    delete parsed.auth.password;
    changed = true;
  }
  if (changed) atomicYamlWrite(configPath, parsed);
  return changed;
}

/**
 * Encrypt legacy YAML, Studio, and MCP credentials. Re-running is safe.
 * Plaintext YAML is replaced only after its values have committed to SQLite.
 */
export function migrateLegacyCredentialStores(runtimeConfig: BytelightConfig = getBytelightConfig()): void {
  const configPath = findBytelightConfigPath();
  if (configPath) migrateYamlCredentials(configPath);

  for (const [legacy, slot] of [
    ['image_gen.openai_api_key', 'studio_openai_api_key'],
    ['image_gen.cloudflare_token', 'studio_cloudflare_token'],
  ] as const) {
    const value = getConfig(legacy);
    if (!value) continue;
    if (!getConfig(`secret:${slot}`)) setSecret(slot, value);
    deleteConfig(legacy);
  }

  migrateMcpServerCredentials();
  const reloaded = configPath ? reloadConfig() : getBytelightConfig();
  hydrateVaultCredentials(reloaded);
  if (runtimeConfig !== reloaded) {
    runtimeConfig.providers = reloaded.providers;
    runtimeConfig.auth.password = reloaded.auth.password;
  }
}
