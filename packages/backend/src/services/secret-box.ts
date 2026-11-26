// Keys at rest (Nov 24 2026, the outside re-check: the house's keys sat
// in the database as plain text). Every stored secret (config rows under
// `secret:`) is kept encrypted with AES-256-GCM under a key file that lives
// OUTSIDE the house folder, ~/.config/bytelight/secrets.key, readable only by
// this account. So the database file on its own (a copy, a backup, a tool
// that reads the config table) no longer hands over a single key; somebody
// holding the whole machine still has both halves, and that is said plainly
// rather than promised away.
//
// A stored value reads `enc1:<base64 of iv | tag | ciphertext>`, bound to its
// own row name so a value cannot be moved under another key. A row without the
// prefix is an older plain value and still reads, and the house seals it at
// the next start (sealPlainSecrets). This house has no sealed backup that
// opens them again, so a copy of the database restored on another machine
// needs this key file beside it (docs/KEYS.md says so).

import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const SEALED_PREFIX = 'enc1:';

/** Where the key file lives: BYTELIGHT_SECRETS_KEY_FILE, or ~/.config/bytelight/secrets.key. */
export function secretsKeyPath(): string {
  return process.env.BYTELIGHT_SECRETS_KEY_FILE || join(homedir(), '.config', 'bytelight', 'secrets.key');
}

let cached: { path: string; key: Buffer } | null = null;

/** Forget the cached key (tests point the path somewhere else). */
export function resetSecretsKeyCache(): void {
  cached = null;
}

/**
 * The 32-byte key, or null when there is none. With create, a missing file is
 * made (0600, in a 0700 folder) so the first start of a house seals its keys.
 */
export function loadSecretsKey(opts: { create?: boolean } = {}): Buffer | null {
  const path = secretsKeyPath();
  if (cached && cached.path === path) return cached.key;
  try {
    if (existsSync(path)) {
      const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64');
      if (key.length !== 32) return null;
      cached = { path, key };
      return key;
    }
    if (!opts.create) return null;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const key = randomBytes(32);
    writeFileSync(path, key.toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
    try { chmodSync(path, 0o600); } catch { /* a filesystem without modes */ }
    cached = { path, key };
    return key;
  } catch {
    return null;
  }
}

export function isSealedValue(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}

/** Encrypt one value for the row `name`. */
export function sealValue(plain: string, key: Buffer, name: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(name, 'utf8'));
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return SEALED_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/**
 * The plain value of a stored row. An unsealed value comes back as it is; a
 * sealed one that this key cannot open (another key, a changed byte, moved to
 * another row) comes back null rather than as garbage.
 */
export function openValue(stored: string, key: Buffer | null, name: string): string | null {
  if (!isSealedValue(stored)) return stored;
  if (!key) return null;
  try {
    const raw = Buffer.from(stored.slice(SEALED_PREFIX.length), 'base64');
    if (raw.length < 28) return null;
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(name, 'utf8'));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
