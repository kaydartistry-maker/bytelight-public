import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real disk-backed DB so getConfig/setConfig (which open by path via
// getDb()) have a live `config` table to read/write.
const tmpRoot = mkdtempSync(join(tmpdir(), 'secrets-test-'));
const dbPath = join(tmpRoot, 'test.db');
// Values are sealed at rest; keep the key file in the test's own folder.
process.env.BYTELIGHT_SECRETS_KEY_FILE = join(tmpRoot, 'secrets.key');

const { initDb } = await import('./db.js');
const { getSecret, setSecret, deleteSecret, listSecrets } = await import('./secrets.js');

// tavily_api_key is a pure env-backed slot (no yaml fallback), which
// keeps these assertions independent of config loading.
const SLOT = 'tavily_api_key';
const ENV = 'TAVILY_API_KEY';

before(() => {
  initDb(dbPath);
  delete process.env[ENV];
  deleteSecret(SLOT);
});

after(() => {
  delete process.env[ENV];
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('getSecret resolver', () => {
  it('DB value wins over the env fallback', () => {
    process.env[ENV] = 'from-env';
    setSecret(SLOT, 'from-db');
    assert.equal(getSecret(SLOT), 'from-db');
  });

  it('falls back to the env var when the DB slot is empty', () => {
    deleteSecret(SLOT);
    process.env[ENV] = 'from-env';
    assert.equal(getSecret(SLOT), 'from-env');
  });

  it('returns undefined when both DB and env are unset', () => {
    deleteSecret(SLOT);
    delete process.env[ENV];
    assert.equal(getSecret(SLOT), undefined);
  });

  it('returns undefined for an unknown slot name', () => {
    assert.equal(getSecret('no_such_secret'), undefined);
  });
});

describe('listSecrets', () => {
  it('reports hasValue booleans and NEVER leaks a value', () => {
    delete process.env[ENV];
    setSecret(SLOT, 'super-secret-value');

    const list = listSecrets();
    assert.ok(Array.isArray(list) && list.length > 0);

    for (const entry of list) {
      assert.equal(typeof entry.hasValue, 'boolean');
      // The value must never appear on a list entry, under any key.
      assert.ok(!('value' in entry), 'list entry must not carry a value');
      for (const v of Object.values(entry)) {
        assert.notEqual(v, 'super-secret-value');
      }
    }

    const tavily = list.find((s) => s.name === SLOT);
    assert.ok(tavily);
    assert.equal(tavily.hasValue, true);

    deleteSecret(SLOT);
    const cleared = listSecrets().find((s) => s.name === SLOT);
    assert.equal(cleared?.hasValue, false);
  });

  it('reflects env-var presence in hasValue without exposing the value', () => {
    deleteSecret(SLOT);
    process.env[ENV] = 'env-present';
    const entry = listSecrets().find((s) => s.name === SLOT);
    assert.equal(entry?.hasValue, true);
    assert.ok(!('value' in (entry ?? {})));
  });
});
