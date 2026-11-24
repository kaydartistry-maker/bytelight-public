import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';

/** Keep explicit operator choices; otherwise prefer a usable standalone install
 * and fall back to PATH, just like the ordinary Codex runtime supervisor. */
export function resolveStudioCodexBin(configured: string | null, environment: string | undefined, home: string): string {
  if (configured) return configured;
  if (environment) return environment;
  const standalone = join(home, '.local', 'bin', 'codex');
  try {
    accessSync(standalone, constants.X_OK);
    if (statSync(standalone).isFile()) return standalone;
  } catch { /* A system-wide install may be the only installed CLI. */ }
  return 'codex';
}
