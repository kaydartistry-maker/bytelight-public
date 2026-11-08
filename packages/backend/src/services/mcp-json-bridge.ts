/**
 * The operator's .mcp.json servers, for the lanes that carry their own tool
 * list: the API router (BYOK providers, Ollama) and Codex over OAuth.
 *
 * The Claude lane hands .mcp.json to the SDK and the Codex daemon puts it in
 * its own mcp_servers table, so both already have these hands. The API lanes
 * only ever got the belt and the DB-managed servers (getRouterTools), so a
 * companion on one of them wore his name without his tools. This closes that.
 *
 * Deliberately NOT part of getRouterTools: /mcp/belt serves that list to the
 * Codex daemon, which already has .mcp.json natively and would see every tool
 * twice.
 *
 * Each server's tools are offered as `<server>__<tool>` (sanitized, ≤64
 * chars), the same server-scoped naming the Claude lane uses, so they never
 * collide with the belt, a managed server, or each other. Clients are opened
 * lazily, kept warm, re-listed every five minutes, and dropped (to reconnect
 * on the next turn) when a call fails at the transport. A server that will
 * not connect is skipped for a while rather than retried every turn, and
 * never takes the other servers' tools down with it.
 */

import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { getBytelightConfig } from '../config.js';
import { readMcpJson, type McpJsonServer } from './mcp-json.js';
import type { ToolSchema } from './mcp-bridge.js';

const TOOLS_TTL_MS = 5 * 60 * 1000;
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_TOOL_NAME = 64;
/** The house belt owns this name on every lane (codex-app-server-config.ts). */
const RESERVED = new Set(['bytelight']);

interface Connection {
  key: string;
  client: Client;
  /** offered name → the server's own tool name */
  names: Map<string, string>;
  tools: ToolSchema[];
  listedAt: number;
}

const connections = new Map<string, Connection>();
const failedAt = new Map<string, number>();
const opening = new Map<string, Promise<Connection | null>>();

/** `<server>__<tool>` in the charset every provider accepts, ≤64 chars. */
export function offeredToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  const full = `${clean(server)}__${clean(tool)}`;
  if (full.length <= MAX_TOOL_NAME) return full;
  const tag = createHash('sha1').update(`${server}\0${tool}`).digest('hex').slice(0, 8);
  return `${full.slice(0, MAX_TOOL_NAME - tag.length - 1)}_${tag}`;
}

/** Identity of a server's config, so an edited entry reconnects. */
function configKey(name: string, server: McpJsonServer): string {
  return `${name}\0${JSON.stringify(server)}`;
}

function stringEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  return { ...env, ...(extra ?? {}) };
}

function transportFor(server: McpJsonServer, cwd: string): Transport {
  if (server.type === 'stdio') {
    // The Claude lane spawns these with the full environment plus the entry's
    // own env, from the agent's working directory; match it so relative
    // commands and inherited keys behave the same on every lane.
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      env: stringEnv(server.env),
      cwd,
      stderr: 'ignore',
    });
  }
  const url = new URL(server.url);
  const requestInit = server.headers ? { headers: server.headers } : undefined;
  return server.type === 'sse'
    ? new SSEClientTransport(url, { requestInit })
    : new StreamableHTTPClientTransport(url, { requestInit });
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

async function listInto(name: string, conn: Connection): Promise<void> {
  const listed = await withTimeout(conn.client.listTools(), CONNECT_TIMEOUT_MS, `${name} tools/list`);
  conn.names.clear();
  conn.tools = listed.tools.map((tool) => {
    const offered = offeredToolName(name, tool.name);
    conn.names.set(offered, tool.name);
    return {
      name: offered,
      description: `[${name}] ${tool.description ?? ''}`.trim(),
      input_schema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    };
  });
  conn.listedAt = Date.now();
}

async function open(name: string, server: McpJsonServer, key: string, cwd: string): Promise<Connection | null> {
  const client = new Client({ name: 'bytelight-api-lane', version: '1.0.0' });
  try {
    await withTimeout(client.connect(transportFor(server, cwd)), CONNECT_TIMEOUT_MS, `${name} connect`);
    const conn: Connection = { key, client, names: new Map(), tools: [], listedAt: 0 };
    await listInto(name, conn);
    connections.set(name, conn);
    failedAt.delete(name);
    console.log(`[MCP] .mcp.json:${name}: ${conn.tools.length} tools for the API lanes`);
    return conn;
  } catch (err) {
    failedAt.set(name, Date.now());
    console.warn(`[MCP] .mcp.json:${name}: unavailable to the API lanes —`, err instanceof Error ? err.message : err);
    await client.close().catch(() => {});
    return null;
  }
}

async function drop(name: string): Promise<void> {
  const conn = connections.get(name);
  connections.delete(name);
  if (conn) await conn.client.close().catch(() => {});
}

/**
 * Every reachable .mcp.json server's tools, server-scoped. Re-reads the file
 * each time, so an added or removed server shows up on the next turn.
 */
export async function getMcpJsonTools(path?: string): Promise<ToolSchema[]> {
  let mcpPath = path;
  let cwd = process.cwd();
  try {
    const cfg = getBytelightConfig();
    mcpPath ??= cfg.agent.mcp_json_path;
    cwd = cfg.agent.cwd || cwd;
  } catch {
    if (!mcpPath) return [];
  }
  const servers = readMcpJson(mcpPath!);
  const now = Date.now();

  // A server removed from (or edited in) the file lets go of its client.
  for (const [name, conn] of connections) {
    const server = servers[name];
    if (!server || configKey(name, server) !== conn.key) await drop(name);
  }

  const lists = await Promise.all(Object.entries(servers).map(async ([name, server]) => {
    if (RESERVED.has(name)) return [];
    const key = configKey(name, server);
    let conn: Connection | null | undefined = connections.get(name);
    if (!conn) {
      const failed = failedAt.get(name);
      if (failed !== undefined && now - failed < FAILURE_BACKOFF_MS) return [];
      let pending = opening.get(name);
      if (!pending) {
        pending = open(name, server, key, cwd).finally(() => opening.delete(name));
        opening.set(name, pending);
      }
      conn = await pending;
      if (!conn) return [];
    } else if (now - conn.listedAt > TOOLS_TTL_MS) {
      try {
        await listInto(name, conn);
      } catch {
        await drop(name);
        return [];
      }
    }
    return conn.tools;
  }));
  return lists.flat();
}

function textOf(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return JSON.stringify(result ?? null);
  return content
    .map((part: { type?: string; text?: string }) => (part?.type === 'text' && typeof part.text === 'string' ? part.text : JSON.stringify(part)))
    .join('\n');
}

/**
 * Run a server-scoped .mcp.json tool. Returns null when the name is not one
 * of ours, so the caller falls through to the belt and managed servers.
 */
export async function executeMcpJsonTool(offered: string, args: Record<string, unknown>): Promise<{ ok: boolean; result: string } | null> {
  for (const [name, conn] of connections) {
    const tool = conn.names.get(offered);
    if (!tool) continue;
    try {
      const result = await withTimeout(conn.client.callTool({ name: tool, arguments: args }), CALL_TIMEOUT_MS, `${name}/${tool}`);
      return { ok: !(result as { isError?: boolean }).isError, result: textOf(result) };
    } catch (err) {
      // A dead transport reconnects next turn; a tool's own error does not
      // come through here (it arrives as isError above).
      await drop(name);
      return { ok: false, result: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }) };
    }
  }
  return null;
}

/** Close every client (and stop every spawned server) — on shutdown. */
export async function closeMcpJsonClients(): Promise<void> {
  const names = [...connections.keys()];
  await Promise.all(names.map((name) => drop(name)));
  failedAt.clear();
}
