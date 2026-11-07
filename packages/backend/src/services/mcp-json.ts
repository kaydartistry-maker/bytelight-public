import { existsSync, readFileSync } from 'fs';

/**
 * One .mcp.json entry, normalized the way the Claude lane has always read it:
 * `url`/`http` and `sse` entries are remote, untyped or `stdio` entries spawn
 * a command. Unknown types are skipped.
 */
export type McpJsonServer =
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> };

/** Read the operator's .mcp.json. Missing or unreadable file yields {}. */
export function readMcpJson(path: string): Record<string, McpJsonServer> {
  const servers: Record<string, McpJsonServer> = {};
  if (!existsSync(path)) return servers;
  try {
    const mcpJson = JSON.parse(readFileSync(path, 'utf-8'));
    if (!mcpJson.mcpServers) return servers;
    for (const [name, mcpCfg] of Object.entries(mcpJson.mcpServers) as [string, any][]) {
      if (mcpCfg.type === 'url' || mcpCfg.type === 'http') {
        servers[name] = { type: 'http', url: mcpCfg.url, headers: mcpCfg.headers };
      } else if (mcpCfg.type === 'sse') {
        servers[name] = { type: 'sse', url: mcpCfg.url, headers: mcpCfg.headers };
      } else if (!mcpCfg.type || mcpCfg.type === 'stdio') {
        servers[name] = { type: 'stdio', command: mcpCfg.command, args: mcpCfg.args, env: mcpCfg.env };
      }
    }
  } catch (err) {
    console.warn('Failed to load .mcp.json:', err instanceof Error ? err.message : err);
  }
  return servers;
}
