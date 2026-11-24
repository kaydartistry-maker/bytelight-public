/** Native credential encryption. No plaintext or key material in errors. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, fstatSync, lstatSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { getBytelightConfig } from '../config.js';

const MAGIC = 'virelle-vault:';
const VERSION = `${MAGIC}1:`;
export class VaultError extends Error {
  constructor() { super('Credential vault unavailable or authentication failed'); }
}

// Parent directories must be real and not writable by other identities. The
// immediate directory must be private and owned by the service identity.
function checkedPath(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) throw new VaultError();
  const rootOwner = lstatSync(parse(path).root).uid;
  let parent = dirname(path);
  const immediate = parent;
  for (;;) {
    const st = lstatSync(parent);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022) || (st.uid !== rootOwner && st.uid !== process.getuid?.())) throw new VaultError();
    if (parent === immediate && (st.uid !== process.getuid?.() || (st.mode & 0o077))) throw new VaultError();
    if (parent === parse(parent).root) break;
    parent = dirname(parent);
  }
  return path;
}

/** Explicit provisioning only; never replaces a lost key. Directory must exist. */
export function provisionVaultKey(path: string): void {
  let fd: number | undefined;
  try {
    checkedPath(path);
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, randomBytes(32));
    fsyncSync(fd);
    const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { throw new VaultError(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

function configuredKeyPath(): string | undefined {
  if (process.env.VIRELLE_VAULT_KEY_FILE) return process.env.VIRELLE_VAULT_KEY_FILE;
  try { return getBytelightConfig().security.vault_key_file || undefined; } catch { return undefined; }
}

export function readVaultKey(path = configuredKeyPath()): Buffer {
  let fd: number | undefined;
  try {
    if (!path) throw new VaultError();
    fd = openSync(checkedPath(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid?.() || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size !== 32) throw new VaultError();
    return readFileSync(fd);
  } catch { throw new VaultError(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function isVaultEnvelope(value: string): boolean { return value.startsWith(MAGIC); }

export function encryptCredential(name: string, value: string, key: Buffer): string {
  try {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(`${VERSION}${name}`));
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return VERSION + Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
  } catch { throw new VaultError(); }
}

export function decryptCredential(name: string, envelope: string, key: Buffer): string {
  try {
    if (!envelope.startsWith(VERSION)) throw new VaultError();
    const encoded = envelope.slice(VERSION.length);
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length < 28 || bytes.toString('base64') !== encoded) throw new VaultError();
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${VERSION}${name}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  } catch { throw new VaultError(); }
}
