import { getDb } from './init.js';
import { decryptCredential, encryptCredential, isVaultEnvelope, readVaultKey } from '../credential-vault.js';

// ─── Managed MCP servers ────────────────────────────────────────
// Ported from the upstream fork's services/db/mcp-servers.ts, Apache 2.0 —
// adapted to byte-light's monolithic db.ts (NAMED ADAPTATION #3).

export interface McpServerRow {
  id: number;
  name: string;
  url: string;
  api_key: string | null;
  enabled: number;
  tools_cache: string | null;
  last_discovered: string | null;
  created_at: string;
}

export function listMcpServers(): McpServerRow[] {
  return (getDb().prepare('SELECT * FROM mcp_servers ORDER BY created_at').all() as McpServerRow[]).map(decryptRow);
}

export function getMcpServer(id: number): McpServerRow | null {
  const row = getDb().prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined;
  return row ? decryptRow(row) : null;
}

export function addMcpServer(name: string, url: string, apiKey?: string): McpServerRow {
  const db = getDb();
  const id = db.transaction(() => {
    const result = db.prepare('INSERT INTO mcp_servers (name, url, api_key) VALUES (?, ?, ?)').run(name, url, null);
    const insertedId = Number(result.lastInsertRowid);
    if (apiKey) {
      const key = readVaultKey();
      try {
        db.prepare('UPDATE mcp_servers SET api_key = ? WHERE id = ?')
          .run(encryptCredential(`mcp-server:${insertedId}`, apiKey, key), insertedId);
      } finally { key.fill(0); }
    }
    return insertedId;
  }).immediate();
  return getMcpServer(id)!;
}

function decryptRow(row: McpServerRow): McpServerRow {
  if (!row.api_key) return row;
  const key = readVaultKey();
  try { return { ...row, api_key: decryptCredential(`mcp-server:${row.id}`, row.api_key, key) }; }
  finally { key.fill(0); }
}

/** Encrypt every legacy MCP credential atomically before consumers start. */
export function migrateMcpServerCredentials(): void {
  const db = getDb();
  const rows = db.prepare("SELECT id, api_key FROM mcp_servers WHERE api_key IS NOT NULL AND api_key != ''").all() as { id: number; api_key: string }[];
  if (!rows.length) return;
  const key = readVaultKey();
  const prior = db.pragma('synchronous', { simple: true }) as number;
  db.pragma('synchronous = FULL');
  try {
    db.transaction(() => {
      for (const row of rows) {
        if (isVaultEnvelope(row.api_key)) decryptCredential(`mcp-server:${row.id}`, row.api_key, key);
        else db.prepare('UPDATE mcp_servers SET api_key = ? WHERE id = ?').run(encryptCredential(`mcp-server:${row.id}`, row.api_key, key), row.id);
      }
    }).immediate();
  } finally { db.pragma(`synchronous = ${prior}`); key.fill(0); }
}

export function deleteMcpServer(id: number): boolean {
  const result = getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  return result.changes > 0;
}

export function setMcpServerEnabled(id: number, enabled: boolean): boolean {
  const result = getDb().prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  return result.changes > 0;
}

export function updateMcpServerToolsCache(id: number, toolsJson: string, discoveredAt: string): void {
  getDb().prepare('UPDATE mcp_servers SET tools_cache = ?, last_discovered = ? WHERE id = ?').run(toolsJson, discoveredAt, id);
}
