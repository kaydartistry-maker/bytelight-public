import { join } from 'node:path';
import { homedir } from 'node:os';
import { MCP_BELT_TOKEN_ENV } from './mcp-belt-auth.js';
import type { McpJsonServer } from './mcp-json.js';

export const BYTELIGHT_CODEX_SOCKET = process.env.BYTELIGHT_CODEX_SOCKET
  || join(
    process.env.CODEX_HOME || join(homedir(), '.codex'),
    'app-server-control',
    'bytelight-app-server.sock',
  );

export const BYTELIGHT_MCP_BELT_URL = process.env.BYTELIGHT_MCP_BELT_URL
  || 'http://127.0.0.1:3002/mcp/belt';

// TOML basic strings accept JSON's escapes, so JSON.stringify quotes safely.
const tomlString = (value: string): string => JSON.stringify(value);

function tomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(tomlValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value).map(([k, v]) => `${tomlString(k)}=${tomlValue(v)}`).join(',')}}`;
  }
  return tomlString(String(value));
}

/**
 * One .mcp.json server as a Codex `mcp_servers` entry. Codex speaks stdio and
 * streamable HTTP; an SSE entry is passed as a URL and logged, since only
 * servers that also answer streamable HTTP will connect.
 */
function codexServerEntry(name: string, server: McpJsonServer): Record<string, unknown> {
  if (server.type === 'stdio') {
    return {
      command: server.command,
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env && Object.keys(server.env).length ? { env: server.env } : {}),
    };
  }
  if (server.type === 'sse') {
    console.warn(`[codex] MCP server "${name}" is SSE; Codex connects over streamable HTTP only`);
  }
  return {
    url: server.url,
    ...(server.headers && Object.keys(server.headers).length ? { http_headers: server.headers } : {}),
  };
}

/**
 * Override the whole local MCP table for the app-server byte-light owns. This
 * prevents ordinary Codex sessions from inheriting thread-aware byte-light
 * tools while leaving Codex-owned account/app surfaces in Codex's own layer.
 *
 * The table carries the house belt plus every .mcp.json server the Claude lane
 * gets, so a Codex turn has the same hands. The belt owns the `bytelight` name.
 */
export function codexAppServerArgs(
  beltUrl = BYTELIGHT_MCP_BELT_URL,
  mcpJsonServers: Record<string, McpJsonServer> = {},
): string[] {
  const entries = [`bytelight={url=${tomlString(beltUrl)},bearer_token_env_var=${tomlString(MCP_BELT_TOKEN_ENV)}}`];
  for (const [name, server] of Object.entries(mcpJsonServers)) {
    if (name === 'bytelight') {
      console.warn('[codex] .mcp.json server "bytelight" skipped: the name is reserved for the house belt');
      continue;
    }
    entries.push(`${tomlString(name)}=${tomlValue(codexServerEntry(name, server))}`);
  }
  const mcpConfig = `mcp_servers={${entries.join(',')}}`;
  return [
    '--dangerously-bypass-approvals-and-sandbox',
    'app-server',
    '--listen', `unix://${BYTELIGHT_CODEX_SOCKET}`,
    '-c', mcpConfig,
  ];
}
