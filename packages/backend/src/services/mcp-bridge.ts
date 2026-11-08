/**
 * MCP Bridge — managed MCP server registry + router tool surface.
 *
 * Ported whole from the reference implementation's services/tools-bridge.ts
 * (managed-registry section only, source lines ~581-816). Apache 2.0 —
 * attribution carried in the commit message.
 *
 * NAMED ADAPTATION #1: the source tools-bridge.ts also bundles an in-process
 * tool belt (sandbox tools, codex_exec, search hands — source lines 39-590).
 * That belt is out of scope for byte-light's managed-MCP-registry port, so only
 * the MCP registry section is carried here. The two functions that referenced
 * the in-process belt (getRouterTools / executeRouterTool) drop those references
 * and are otherwise byte-identical to the source.
 *
 * NAMED ADAPTATION #2: the source imports `ToolSchema` from its `router.ts`,
 * which byte-light does not have. The type is redefined locally below,
 * field-for-field identical to the source's router.ts ToolSchema.
 *
 * This module:
 * 1. Loads + discovers DB-managed MCP servers (with 5-min cache)
 * 2. Provides getRouterTools() and executeRouterTool() for the router runtime
 */

import { listMcpServers, getMcpServer, updateMcpServerToolsCache } from './db.js';
import { discoverMcpTools, executeMcpTool } from './mcp-client.js';
import { getBeltToolSchemas, executeBeltTool, getBeltContext } from './chat-tool-belt.js';
import { guestToolRefusal } from './turn-audience.js';
import { createSingleFlight } from './single-flight.js';
import { getMcpJsonTools, executeMcpJsonTool } from './mcp-json-bridge.js';

// ─── Local ToolSchema (NAMED ADAPTATION #2) ─────────────────────────
// Field-for-field identical to the source fork's services/router.ts ToolSchema.
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  server_url?: string;
}

// .mcp.json servers are not bridged here. The Claude lane passes them to the
// SDK directly and the Codex lane gets them natively in its app-server MCP
// table (codex-app-server-config.ts). The old registerHttpMcpServer path had
// no caller and could not carry stdio servers, so it was removed.

// ─── DB-backed managed MCP servers ──────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Failure backoff: a server that fails discovery has NO managedServers entry, so
// its cacheAge is Infinity and loadManagedServers() would re-run the full MCP
// handshake on EVERY getRouterTools() call (every interactive turn) — a wedging
// server (the claude-cli discovery hang) thus churns fresh handshakes without
// bound. We remember the last failed attempt per server id and skip re-discovery
// until this window elapses, capping churn at one attempt per window.
const FAILURE_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes — matches the success TTL cadence
const failedDiscoveryAt: Map<number, number> = new Map();

interface ManagedMcpServer {
  id: number;
  name: string;
  url: string;
  apiKey: string | null;
  tools: ToolSchema[];
  transport: 'streamable' | 'sse';
  lastDiscovered: number;
}

const managedServers: Map<number, ManagedMcpServer> = new Map();

/**
 * Load and discover tools from DB-managed MCP servers.
 * Uses cached schemas with 5-min TTL — re-discovers when stale.
 */
async function loadManagedServers(): Promise<void> {
  const rows = listMcpServers();
  const now = Date.now();

  // Track which DB IDs still exist (for cleanup)
  const activeIds = new Set<number>();

  for (const row of rows) {
    if (!row.enabled) continue;
    activeIds.add(row.id);

    const cached = managedServers.get(row.id);
    const cacheAge = cached ? now - cached.lastDiscovered : Infinity;

    // Use cached if fresh enough AND tools_cache in DB is also populated
    if (cached && cacheAge < CACHE_TTL_MS) continue;

    // Backoff: if this server failed discovery recently and we have no cache to
    // fall back on, skip re-discovery until the window elapses. Without this a
    // wedging/failing server re-handshakes every turn (unbounded churn).
    const lastFail = failedDiscoveryAt.get(row.id);
    if (lastFail !== undefined && now - lastFail < FAILURE_BACKOFF_MS) continue;

    // Try DB cache first (avoids network on restart)
    if (row.tools_cache && row.last_discovered) {
      const dbCacheAge = now - new Date(row.last_discovered).getTime();
      if (dbCacheAge < CACHE_TTL_MS) {
        try {
          const cachedTools = JSON.parse(row.tools_cache);
          managedServers.set(row.id, {
            id: row.id,
            name: row.name,
            url: row.url,
            apiKey: row.api_key,
            tools: cachedTools.map((t: any) => ({
              name: t.name,
              description: t.description || '',
              input_schema: t.inputSchema || t.input_schema || {},
              server_url: row.url,
              _transport: t.transport || 'streamable',
            })),
            transport: cachedTools[0]?.transport || 'streamable',
            lastDiscovered: new Date(row.last_discovered).getTime(),
          });
          continue;
        } catch { /* re-discover */ }
      }
    }

    // Discover fresh
    try {
      const tools = await discoverMcpTools(row.url, row.api_key);
      const toolSchemas: ToolSchema[] = tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
        server_url: row.url,
        _transport: t.transport,
      }));
      const transport = tools[0]?.transport || 'streamable';

      managedServers.set(row.id, {
        id: row.id,
        name: row.name,
        url: row.url,
        apiKey: row.api_key,
        tools: toolSchemas,
        transport,
        lastDiscovered: now,
      });

      // Persist cache to DB
      updateMcpServerToolsCache(row.id, JSON.stringify(tools), new Date().toISOString());
      failedDiscoveryAt.delete(row.id); // recovered — clear any backoff
      console.log(`[MCP] managed:${row.name}: discovered ${tools.length} tools`);
    } catch (err) {
      failedDiscoveryAt.set(row.id, now); // arm backoff so we don't churn every turn
      console.warn(`[MCP] managed:${row.name}: discovery failed —`, err instanceof Error ? err.message : err);
      // Keep stale cache if available
    }
  }

  // Remove servers that were deleted from DB
  for (const id of managedServers.keys()) {
    if (!activeIds.has(id)) managedServers.delete(id);
  }
  // Drop backoff records for servers no longer enabled/present.
  for (const id of failedDiscoveryAt.keys()) {
    if (!activeIds.has(id)) failedDiscoveryAt.delete(id);
  }
}

/** Share one refresh across every caller that arrives while caches are stale. */
const ensureManagedServersLoaded = createSingleFlight(loadManagedServers);

export function assertUniqueToolNames(tools: Array<{ name: string; source: string }>): void {
  const ownerByName = new Map<string, string>();
  for (const tool of tools) {
    const existing = ownerByName.get(tool.name);
    if (existing) {
      throw new Error(`Duplicate MCP tool name "${tool.name}" from ${existing} and ${tool.source}`);
    }
    ownerByName.set(tool.name, tool.source);
  }
}

/** Force re-discovery for a specific managed server. Returns tool count or throws. */
export async function discoverManagedServer(id: number): Promise<number> {
  const row = getMcpServer(id);
  if (!row) throw new Error(`MCP server ${id} not found`);

  const tools = await discoverMcpTools(row.url, row.api_key);
  const toolSchemas: ToolSchema[] = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    server_url: row.url,
    _transport: t.transport,
  }));

  managedServers.set(row.id, {
    id: row.id,
    name: row.name,
    url: row.url,
    apiKey: row.api_key,
    tools: toolSchemas,
    transport: tools[0]?.transport || 'streamable',
    lastDiscovered: Date.now(),
  });

  updateMcpServerToolsCache(row.id, JSON.stringify(tools), new Date().toISOString());
  failedDiscoveryAt.delete(row.id); // explicit re-discovery succeeded — clear backoff
  return tools.length;
}

/** Invalidate cached tools for a managed server (e.g. after toggle/delete). */
export function invalidateManagedServer(id: number): void {
  managedServers.delete(id);
  failedDiscoveryAt.delete(id); // allow immediate re-discovery on next load
}

// ─── Public API ─────────────────────────────────────────────────────

/**
 * Get all available tool schemas for the router runtime.
 * Includes the in-process chat-tool belt + .mcp.json servers + DB-managed servers.
 *
 * H2 "hands": the chat-tool belt (chat-tool-belt.ts) is merged FIRST so its
 * names take precedence over any same-named MCP tool (belt wins collisions,
 * matching executeRouterTool's belt-first routing below). This restores the
 * in-process-belt slot the port dropped as NAMED ADAPTATION #1 — but with
 * NATIVE byte-light tool bodies (localhost `/api/internal/*` calls), not the
 * source's sandbox/exec belt. Pattern lineage: reference implementation reference implementation tools-bridge.ts.
 */
export async function getRouterTools(): Promise<ToolSchema[]> {
  // Load DB-managed servers (with caching)
  await ensureManagedServersLoaded();

  const sourcedTools: Array<{ tool: ToolSchema; source: string }> = [
    ...getBeltToolSchemas().map(tool => ({ tool, source: 'native belt' })),
    ...[...managedServers.values()].flatMap(server =>
      server.tools.map(tool => ({ tool, source: `managed:${server.name}` }))),
  ];
  assertUniqueToolNames(sourcedTools.map(({ tool, source }) => ({ name: tool.name, source })));
  return sourcedTools.map(({ tool }) => tool);
}

/**
 * Get just the DB-managed MCP server configs (for merging into SDK path).
 * Returns { name, url, apiKey } for each enabled managed server.
 */
export function getManagedServerConfigs(): Array<{ name: string; url: string; apiKey: string | null }> {
  const rows = listMcpServers();
  return rows
    .filter(r => r.enabled)
    .map(r => ({ name: r.name, url: r.url, apiKey: r.api_key }));
}

/**
 * Execute a tool by name. Routes to the in-process chat-tool belt first,
 * then DB-managed MCP servers.
 *
 * H2 "hands": the belt is checked FIRST so a belt tool name wins any MCP
 * collision (mirrors getRouterTools's belt-first merge and the source's
 * in-process-first routing). executeBeltTool returns null when `name` isn't
 * a belt tool, so we fall through to MCP unchanged. The belt never throws.
 */
export async function executeRouterTool(name: string, args: Record<string, unknown>): Promise<{ result: string; ok: boolean }> {
  // A guest turn gets NO router tools (turn-audience.ts). Every engine that
  // runs house tools through this bridge (API router incl. Ollama, Codex
  // OAuth, the Codex daemon's /mcp/belt) enters a belt context carrying the
  // turn's audience, so this one door refuses for all of them.
  const refused = guestToolRefusal(getBeltContext()?.audience, name);
  if (refused) return refused;

  // Check the in-process chat-tool belt first (belt wins name collisions).
  const beltResult = await executeBeltTool(name, args);
  if (beltResult) return beltResult;

  // Check DB-managed MCP servers
  for (const server of managedServers.values()) {
    const tool = server.tools.find(t => t.name === name);
    if (tool) {
      return executeMcpTool(server.url, server.apiKey, name, args, server.transport);
    }
  }

  return { ok: false, result: `Unknown tool: ${name}` };
}

// ─── Lanes that carry their own tool list ───────────────────────────

/**
 * The full tool surface for the API router (BYOK providers, Ollama) and Codex
 * over OAuth: the router tools above plus the operator's .mcp.json servers,
 * server-scoped (mcp-json-bridge.ts). Kept apart from getRouterTools because
 * /mcp/belt serves that to the Codex daemon, which has .mcp.json natively.
 * A .mcp.json tool whose scoped name somehow matches one already offered is
 * left out rather than failing the whole catalog.
 */
export async function getForeignLaneTools(): Promise<ToolSchema[]> {
  const routerTools = await getRouterTools();
  let jsonTools: ToolSchema[] = [];
  try {
    jsonTools = await getMcpJsonTools();
  } catch (err) {
    console.warn('[MCP] .mcp.json tools unavailable this turn:', err instanceof Error ? err.message : err);
  }
  const taken = new Set(routerTools.map((t) => t.name));
  const extra = jsonTools.filter((t) => {
    if (taken.has(t.name)) {
      console.warn(`[MCP] .mcp.json tool "${t.name}" skipped: the name is already offered`);
      return false;
    }
    taken.add(t.name);
    return true;
  });
  return [...routerTools, ...extra];
}

/** executeRouterTool for those lanes, with .mcp.json tools routed first-class. */
export async function executeForeignLaneTool(name: string, args: Record<string, unknown>): Promise<{ result: string; ok: boolean }> {
  const refused = guestToolRefusal(getBeltContext()?.audience, name);
  if (refused) return refused;
  const fromJson = await executeMcpJsonTool(name, args);
  if (fromJson) return fromJson;
  return executeRouterTool(name, args);
}
