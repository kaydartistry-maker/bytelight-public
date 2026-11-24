import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, chmodSync, symlinkSync, linkSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { provisionVaultKey, readVaultKey, encryptCredential, decryptCredential, VaultError } from './credential-vault.js';
import Database from 'better-sqlite3';
import { initDb, getConfig, setConfig } from './db.js';
import { getSecret, setSecret, deleteSecret, listSecrets, migrateSecrets, getSecretDef } from './secrets.js';

// Generated ephemeral values only. No live paths, config files, or credentials.
test('AEAD round trip, randomized nonce, tamper/wrong key/name/version fail closed and redact', () => {
  const key = randomBytes(32), value = randomBytes(24).toString('hex');
  const encrypted = encryptCredential('test', value, key);
  assert.equal(decryptCredential('test', encrypted, key), value);
  assert.notEqual(encryptCredential('test', value, key), encrypted);
  assert.ok(!encrypted.includes(value));
  const bytes = Buffer.from(encrypted.split(':')[2], 'base64');
  bytes[bytes.length - 1] ^= 1;
  for (const attempt of [
    () => decryptCredential('test', 'virelle-vault:1:' + bytes.toString('base64'), key),
    () => decryptCredential('test', encrypted, randomBytes(32)),
    () => decryptCredential('other', encrypted, key),
    () => decryptCredential('test', encrypted.replace(':1:', ':2:'), key),
  ]) assert.throws(attempt, (e: unknown) => e instanceof VaultError && !e.message.includes(value));
});

test('private files, migration atomic interruption/idempotence, fallback, deletion and masked status', () => {
  // The vault deliberately rejects key paths beneath directories owned by a
  // different identity. Keep the synthetic fixture under the current
  // identity's private home rather than under a checkout that may be owned by
  // the deployment user while tests run as the service user.
  const dir = mkdtempSync(join(homedir(), '.virelle-vault-test-'));
  chmodSync(dir, 0o700);
  const path = join(dir, 'key');
  const oldPath = process.env.VIRELLE_VAULT_KEY_FILE;
  const oldEnv = process.env.TAVILY_API_KEY;
  const dbPath = join(dir, 'synthetic.sqlite');
  const db = initDb(dbPath);
  try {
    assert.throws(() => readVaultKey(path), VaultError);
    provisionVaultKey(path);
    assert.throws(() => provisionVaultKey(path), VaultError);
    assert.equal(readVaultKey(path).length, 32);
    linkSync(path, join(dir, 'hardlink'));
    assert.throws(() => readVaultKey(path), VaultError);
    unlinkSync(join(dir, 'hardlink'));
    const provisioned = readFileSync(path);
    writeFileSync(path, randomBytes(31));
    assert.throws(() => readVaultKey(path), VaultError);
    writeFileSync(path, provisioned);
    chmodSync(path, 0o644);
    assert.throws(() => readVaultKey(path), VaultError);
    chmodSync(path, 0o600);
    symlinkSync(path, join(dir, 'link'));
    assert.throws(() => readVaultKey(join(dir, 'link')), VaultError);
    chmodSync(dir, 0o755);
    assert.throws(() => readVaultKey(path), VaultError);
    chmodSync(dir, 0o700);
    process.env.VIRELLE_VAULT_KEY_FILE = path;
    const value = randomBytes(24).toString('hex');
    process.env.TAVILY_API_KEY = randomBytes(24).toString('hex');
    setConfig('secret:tavily_api_key', value);
    setConfig('secret:unknown', value);
    // SQLite abort after an earlier update models interruption before commit.
    db.exec("CREATE TRIGGER interrupt_vault BEFORE UPDATE ON config WHEN OLD.key = 'secret:unknown' BEGIN SELECT RAISE(ABORT, 'simulated interruption'); END");
    assert.throws(() => migrateSecrets());
    assert.equal(getConfig('secret:tavily_api_key'), value);
    db.exec('DROP TRIGGER interrupt_vault');
    migrateSecrets();
    const envelope = getConfig('secret:tavily_api_key');
    migrateSecrets();
    assert.equal(getConfig('secret:tavily_api_key'), envelope);
    assert.equal(getSecret('tavily_api_key'), value);
    const reader = new Database(dbPath, { readonly: true });
    try { assert.deepEqual(reader.prepare('SELECT value FROM config WHERE key = ?').get('secret:tavily_api_key'), { value: envelope }); }
    finally { reader.close(); }
    assert.ok(!JSON.stringify(listSecrets()).includes(value));
    const original = readFileSync(path);
    writeFileSync(path, randomBytes(32));
    assert.throws(() => getSecret('tavily_api_key'), VaultError);
    assert.throws(() => migrateSecrets(), VaultError);
    writeFileSync(path, original);
    delete process.env.VIRELLE_VAULT_KEY_FILE;
    assert.throws(() => getSecret('tavily_api_key'), VaultError);
    process.env.VIRELLE_VAULT_KEY_FILE = path;
    setSecret('tavily_api_key', value);
    deleteSecret('tavily_api_key');
    assert.equal(getConfig('secret:tavily_api_key'), null);
    assert.equal(getSecret('tavily_api_key'), process.env.TAVILY_API_KEY);
    const def = getSecretDef('elevenlabs_voice_id')!;
    const fallback = def.fallback;
    const voiceEnv = process.env.ELEVENLABS_VOICE_ID;
    delete process.env.ELEVENLABS_VOICE_ID;
    try { def.fallback = () => value; assert.equal(getSecret(def.name), value); }
    finally { def.fallback = fallback; if (voiceEnv !== undefined) process.env.ELEVENLABS_VOICE_ID = voiceEnv; }
  } finally {
    db.close();
    if (oldPath === undefined) delete process.env.VIRELLE_VAULT_KEY_FILE; else process.env.VIRELLE_VAULT_KEY_FILE = oldPath;
    if (oldEnv === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = oldEnv;
    rmSync(dir, { recursive: true, force: true });
  }
});

// Guard placement is a security invariant of the existing composed API router.
test('credential routes stay after session auth, reject passwordless access and disable caching', () => {
  const api = readFileSync(new URL('../routes/api.ts', import.meta.url), 'utf8');
  const route = readFileSync(new URL('../routes/secrets.ts', import.meta.url), 'utf8');
  assert.ok(api.indexOf('router.use(authMiddleware)') < api.indexOf('router.use(secretsRouter)'));
  assert.ok(route.indexOf("router.use('/secrets'") < route.indexOf("router.get('/secrets'"));
  assert.match(route, /if \(!getBytelightConfig\(\).auth.password\) return res.status\(403\)/);
  assert.match(route, /setHeader\('Cache-Control', 'no-store'\)/);
  assert.match(route, /if \(def.readonly\) return res.status\(403\)/);
});
