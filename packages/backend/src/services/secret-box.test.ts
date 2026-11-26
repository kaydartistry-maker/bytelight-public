// Keys at rest: a stored secret is ciphertext in the table and plain only
// through getSecret; older plain rows still read and get sealed at start,
// once (the boot migration is idempotent); with no key file a sealed row
// reads as unset rather than as garbage.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'secret-box-'));
process.env.BYTELIGHT_SECRETS_KEY_FILE = join(dir, 'keys', 'secrets.key');

const { initDb } = await import('./db/init.js');
const { getConfig, setConfig } = await import('./db.js');
const { getSecret, setSecret, sealPlainSecrets } = await import('./secrets.js');
const { isSealedValue, openValue, sealValue, resetSecretsKeyCache, secretsKeyPath } = await import('./secret-box.js');

initDb(':memory:');
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('a stored key is ciphertext in the table and plain through getSecret', () => {
  setSecret('groq_api_key', 'gsk_live_value');
  const raw = getConfig('secret:groq_api_key');
  assert.ok(isSealedValue(raw), 'the row is sealed');
  assert.ok(!raw!.includes('gsk_live_value'));
  assert.equal(getSecret('groq_api_key'), 'gsk_live_value');
  const mode = statSync(process.env.BYTELIGHT_SECRETS_KEY_FILE!).mode & 0o777;
  assert.equal(mode, 0o600, 'the key file is owner-only');
  assert.equal(secretsKeyPath(), process.env.BYTELIGHT_SECRETS_KEY_FILE);
});

test('a sealed value cannot be moved under another row or opened by another key', () => {
  const raw = getConfig('secret:groq_api_key')!;
  setConfig('secret:tavily_api_key', raw);
  delete process.env.TAVILY_API_KEY;
  assert.equal(getSecret('tavily_api_key'), undefined, 'moved under another name');
  assert.equal(openValue(raw, Buffer.alloc(32, 7), 'secret:groq_api_key'), null, 'another key');
  setConfig('secret:tavily_api_key', '');
});

test('an older plain row still reads, and is sealed at start exactly once', () => {
  setConfig('secret:elevenlabs_voice_id:companion-a', 'voice123');
  setConfig('secret:giphy_api_key', 'plain-giphy');
  assert.equal(getSecret('elevenlabs_voice_id:companion-a'), 'voice123', 'an upgrading house reads its plain rows');
  assert.equal(sealPlainSecrets(), 2);
  assert.ok(isSealedValue(getConfig('secret:elevenlabs_voice_id:companion-a')));
  assert.ok(isSealedValue(getConfig('secret:giphy_api_key')));
  assert.equal(getSecret('elevenlabs_voice_id:companion-a'), 'voice123');
  assert.equal(getSecret('giphy_api_key'), 'plain-giphy');
  const sealedOnce = getConfig('secret:giphy_api_key');
  assert.equal(sealPlainSecrets(), 0, 'nothing left to seal');
  assert.equal(getConfig('secret:giphy_api_key'), sealedOnce, 'a sealed row is never sealed again');
});

test('the key file stays the same across starts', () => {
  const before = readFileSync(process.env.BYTELIGHT_SECRETS_KEY_FILE!, 'utf8');
  resetSecretsKeyCache();
  setSecret('groq_api_key', 'another');
  assert.equal(readFileSync(process.env.BYTELIGHT_SECRETS_KEY_FILE!, 'utf8'), before, 'an existing key file is reused, never replaced');
  assert.equal(getSecret('groq_api_key'), 'another');
});

test('with sealing off, new values are written plain and nothing is sealed', () => {
  setConfig('secrets.at_rest', 'off');
  setSecret('giphy_api_key', 'plain-one');
  assert.equal(getConfig('secret:giphy_api_key'), 'plain-one');
  assert.equal(sealPlainSecrets(), 0);
  setConfig('secrets.at_rest', '');
  setSecret('giphy_api_key', 'sealed-one');
  assert.ok(isSealedValue(getConfig('secret:giphy_api_key')));
});

test('without the key file a sealed row reads as unset, never as ciphertext', () => {
  const saved = process.env.BYTELIGHT_SECRETS_KEY_FILE;
  process.env.BYTELIGHT_SECRETS_KEY_FILE = join(dir, 'missing', 'secrets.key');
  resetSecretsKeyCache();
  const err = console.error; console.error = () => {};
  try {
    delete process.env.GIPHY_API_KEY;
    assert.equal(getSecret('giphy_api_key'), undefined);
  } finally {
    console.error = err;
    process.env.BYTELIGHT_SECRETS_KEY_FILE = saved;
    resetSecretsKeyCache();
  }
  assert.equal(getSecret('giphy_api_key'), 'sealed-one');
  assert.ok(sealValue('x', Buffer.alloc(32), 'n').startsWith('enc1:'));
});
