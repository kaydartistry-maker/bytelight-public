import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { provisionVaultKey } from './credential-vault.js';

/** Synthetic vault fixture; never reads or modifies a deployment key. */
export function setupTestVault(prefix: string): () => void {
  const root = mkdtempSync(join(homedir(), `.virelle-${prefix}-vault-test-`));
  chmodSync(root, 0o700);
  const key = join(root, 'vault.key');
  const previous = process.env.VIRELLE_VAULT_KEY_FILE;
  provisionVaultKey(key);
  process.env.VIRELLE_VAULT_KEY_FILE = key;
  return () => {
    if (previous === undefined) delete process.env.VIRELLE_VAULT_KEY_FILE;
    else process.env.VIRELLE_VAULT_KEY_FILE = previous;
    rmSync(root, { recursive: true, force: true });
  };
}
