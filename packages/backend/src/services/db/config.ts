import { getDb } from './init.js';

// Config operations
export function getConfig(key: string): string | null {
  const stmt = getDb().prepare('SELECT value FROM config WHERE key = ?');
  const row = stmt.get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setConfig(key: string, value: string): void {
  const stmt = getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  stmt.run(key, value);
}

export function deleteConfig(key: string): void {
  const stmt = getDb().prepare('DELETE FROM config WHERE key = ?');
  stmt.run(key);
}

export function getConfigBool(key: string, defaultValue: boolean): boolean {
  const val = getConfig(key);
  if (val === null) return defaultValue;
  return val === 'true' || val === '1';
}

export function getConfigNumber(key: string, defaultValue: number): number {
  const val = getConfig(key);
  if (val === null) return defaultValue;
  const num = parseFloat(val);
  return isNaN(num) ? defaultValue : num;
}

export function getAllConfig(): Record<string, string> {
  const stmt = getDb().prepare('SELECT key, value FROM config');
  const rows = stmt.all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}
