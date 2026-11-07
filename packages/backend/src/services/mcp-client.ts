import { errMessage } from '../util/errors.js';

/**
 * MCP Client — proper MCP protocol handshake for discovery and tool execution.
 *
 * Ported from reference implementation's dual-transport MCP implementation.
 * Supports Streamable HTTP (primary) with SSE fallback.
 *
 * Protocol sequence:
 *   1. POST initialize (with protocolVersion + clientInfo)
 *   2. POST notifications/initialized (required by spec)
 *   3. POST tools/list (discovery) or tools/call (execution)
 */


export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  transport: 'streamable' | 'sse';
}

// ─── Leak diagnostics ───────────────────────────────────────────
//
// Module-scoped counters for the native RSS-leak / claude-cli-wedge hunt
// (2026-07-24). Pure bookkeeping — no behavior change. Read via
// getMcpClientStats(); the memory monitor snapshots these into each spike row.

interface McpClientStats {
  streamableStarted: number;
  streamableCompleted: number;
  streamableFailed: number;
  sseOpened: number;
  sseCompleted: number;
  sseCancelled: number;
  sseCancelFailed: number;
  fetchResponsesOpened: number;
  fetchBodiesConsumed: number;
  fetchBodiesCancelled: number;
  activeOperations: number;
  activeReaders: number;
  discoveryTimeouts: number;
  executionTimeouts: number;
  lastOperation: string | null;
  lastPhase: string | null;
  lastStartedAt: string | null;
  lastDurationMs: number | null;
  lastRssBefore: number | null;
  lastRssAfter: number | null;
}

const mcpStats: McpClientStats = {
  streamableStarted: 0,
  streamableCompleted: 0,
  streamableFailed: 0,
  sseOpened: 0,
  sseCompleted: 0,
  sseCancelled: 0,
  sseCancelFailed: 0,
  fetchResponsesOpened: 0,
  fetchBodiesConsumed: 0,
  fetchBodiesCancelled: 0,
  activeOperations: 0,
  activeReaders: 0,
  discoveryTimeouts: 0,
  executionTimeouts: 0,
  lastOperation: null,
  lastPhase: null,
  lastStartedAt: null,
  lastDurationMs: null,
  lastRssBefore: null,
  lastRssAfter: null,
};

/** Snapshot of the MCP-client lifecycle counters. Shallow copy — safe to log. */
export function getMcpClientStats(): McpClientStats {
  return { ...mcpStats };
}

/** RSS in MB, best-effort — never throws from the diagnostics path. */
function rssMb(): number {
  try { return Math.round(process.memoryUsage().rss / 1024 / 1024); } catch { return -1; }
}

/**
 * Generate a session id for servers that demand an Mcp-Session-Id on the
 * opening initialize request. crypto.randomUUID is available on Node's global
 * crypto (Node 18+); the fallback keeps this from ever throwing.
 */
function generateSessionId(): string {
  try {
    return globalThis.crypto.randomUUID();
  } catch {
    return `bytelight-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

// ─── Timeouts ───────────────────────────────────────────────────
//
// Hoisted from the inline literals that already lived on the streamable fetches
// (10s handshake init, 5s initialized notif, 15s tools/list + SSE read, 30s
// tools/call, 10s SSE connect). Same values — now shared so every fetch in the
// file (including the SSE POSTs that previously carried no signal) is bounded.
const TIMEOUT_INIT_MS = 10_000;
const TIMEOUT_NOTIFY_MS = 5_000;
const TIMEOUT_LIST_MS = 15_000;
const TIMEOUT_CALL_MS = 30_000;
const TIMEOUT_SSE_CONNECT_MS = 10_000;
const TIMEOUT_SSE_READ_MS = 15_000;

/**
 * Fully drain-or-cancel a fetch Response body so no socket/stream is stranded.
 * Cannot throw. Used for responses whose payload we don't parse (SSE POST acks)
 * and for cleanup on error paths. Counts against the fetchBodiesCancelled meter.
 */
async function disposeBody(res: Response | null | undefined): Promise<void> {
  try {
    if (res?.body) {
      await res.body.cancel();
      mcpStats.fetchBodiesCancelled++;
    }
  } catch { /* best-effort — never throw from cleanup */ }
}

// ─── Content block helpers ──────────────────────────────────────

/**
 * Serialize MCP content blocks to a string.
 *
 * When image blocks are present, returns the full content array as JSON
 * so downstream consumers (e.g. codex runtime's parseToolResultContent)
 * can extract base64 data and convert to proper image content blocks.
 *
 * When no images are present, returns plain text for readability.
 */
function serializeContentBlocks(content: any[]): string {
  const hasImages = content.some(
    (c: any) => c.type === 'image' || c.type === 'image_url',
  );
  if (hasImages) {
    // Preserve the raw content array as JSON — image data intact
    return JSON.stringify(content);
  }
  // Text-only: join as readable text
  return content.map(contentBlockToText).join('\n');
}

function contentBlockToText(c: any): string {
  if (c.text) return c.text;
  if (c.type === 'resource' && c.resource?.blob) {
    const mime = c.resource.mimeType || 'binary';
    return `[resource: ${mime}]`;
  }
  return JSON.stringify(c);
}

// ─── Streamable HTTP helpers ────────────────────────────────────

/**
 * Parse a Streamable HTTP response that may be JSON or SSE-wrapped JSON.
 * MCP 2025-03-26 servers can negotiate response format via Accept header.
 */
async function parseStreamableResponse(resp: Response): Promise<any> {
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('text/event-stream')) {
    const text = await resp.text();
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      try {
        return JSON.parse(trimmed.slice(5).trim());
      } catch { /* skip non-JSON lines */ }
    }
    throw new Error('streamable SSE response had no JSON-RPC payload');
  }
  return await resp.json();
}

function buildHeaders(apiKey?: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Streamable-HTTP servers may answer initialize/tools with either a unary
    // application/json body OR an SSE event-stream. We accept both — the
    // response parser (parseStreamableResponse) branches on the actual
    // Content-Type, so a JSON-responding server is fully supported.
    'Accept': 'application/json, text/event-stream',
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  return headers;
}

/**
 * True when an initialize response indicates the server requires an
 * Mcp-Session-Id to be present on the *opening* request (the Lovense case).
 * Some Streamable-HTTP servers are stateful and refuse to bootstrap a session
 * unless the client presents an id up front, rather than minting one for us.
 */
function needsBootstrapSessionId(status: number, body: string): boolean {
  if (status !== 400 && status !== 401 && status !== 403 && status !== 406) return false;
  return /mcp-session-id/i.test(body) &&
    /(required|missing|must|provide|expected|no session)/i.test(body);
}

/**
 * Send the initialize POST for the Streamable-HTTP handshake.
 * Returns the raw Response plus the JSON-RPC result parsed from the body.
 * Accepts BOTH a unary application/json response and an SSE-wrapped one.
 */
async function postInitialize(
  url: string,
  headers: Record<string, string>,
): Promise<{ resp: Response; result: any | null; errBody: string | null }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bytelight', version: '1.0.0' },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_INIT_MS),
  });
  mcpStats.fetchResponsesOpened++;

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    mcpStats.fetchBodiesConsumed++;
    return { resp, result: null, errBody };
  }

  // Parse (not just drain) the initialize body so a unary application/json
  // Streamable-HTTP server is explicitly validated. parseStreamableResponse
  // transparently unwraps an SSE-framed JSON-RPC payload too.
  const result = await parseStreamableResponse(resp).catch(() => null);
  mcpStats.fetchBodiesConsumed++;
  return { resp, result, errBody: null };
}

async function mcpHandshake(
  url: string,
  headers: Record<string, string>,
): Promise<Record<string, string>> {
  mcpStats.lastPhase = 'handshake:initialize';

  let init = await postInitialize(url, headers);

  // Lovense-style servers reject the opening initialize because it carries no
  // Mcp-Session-Id. Bootstrap one client-side and retry ONCE. Standard servers
  // never take this branch (their initialize succeeds without a session id), so
  // SSE/stateless servers are unaffected.
  if (!init.resp.ok && needsBootstrapSessionId(init.resp.status, init.errBody || '')) {
    mcpStats.lastPhase = 'handshake:initialize:bootstrap-session';
    const bootstrapId = generateSessionId();
    const bootstrapHeaders = { ...headers, 'Mcp-Session-Id': bootstrapId };
    init = await postInitialize(url, bootstrapHeaders);
    if (init.resp.ok) headers = bootstrapHeaders;
  }

  if (!init.resp.ok) {
    throw new Error(`initialize ${init.resp.status}: ${(init.errBody || '').slice(0, 200)}`);
  }

  // A JSON-RPC initialize MUST return a result object. If the body was neither
  // valid JSON-RPC nor SSE-wrapped JSON-RPC, treat discovery as failed here
  // (rather than silently falling through to tools/list on a broken server).
  if (!init.result || typeof init.result !== 'object' || (!init.result.result && !init.result.error)) {
    throw new Error('initialize returned no JSON-RPC result');
  }
  if (init.result.error) {
    throw new Error(`initialize error: ${init.result.error.message || JSON.stringify(init.result.error)}`);
  }

  // Adopt the server-minted session id when present; otherwise keep any id we
  // bootstrapped onto `headers` above (headers already carries Mcp-Session-Id
  // in the bootstrap case).
  const serverSessionId = init.resp.headers.get('mcp-session-id');
  const sessionHeaders = { ...headers };
  if (serverSessionId) sessionHeaders['mcp-session-id'] = serverSessionId;

  // notifications/initialized — required by spec before any other request
  mcpStats.lastPhase = 'handshake:initialized';
  const notifResp = await fetch(url, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(TIMEOUT_NOTIFY_MS),
  });
  mcpStats.fetchResponsesOpened++;
  await disposeBody(notifResp);

  return sessionHeaders;
}

/**
 * Terminate a Streamable-HTTP session (MCP 2025-03-26 streamable-http spec:
 * DELETE with the Mcp-Session-Id header). Each discovery/execution opens a fresh
 * handshake, so without this the server accumulates one session per operation.
 * Only fires when the server actually handed us a session id — many MCP servers
 * (including stateless ones) return none, in which case there is nothing to end.
 * Best-effort: a failed teardown must never surface to the caller.
 */
async function terminateSession(url: string, sessionHeaders: Record<string, string>): Promise<void> {
  const sessionId = sessionHeaders['mcp-session-id'];
  if (!sessionId) return; // stateless server — no session to terminate
  try {
    mcpStats.lastPhase = 'session:delete';
    const res = await fetch(url, {
      method: 'DELETE',
      headers: sessionHeaders,
      signal: AbortSignal.timeout(TIMEOUT_NOTIFY_MS),
    });
    mcpStats.fetchResponsesOpened++;
    await disposeBody(res);
  } catch { /* best-effort — teardown failure is non-fatal */ }
}

// ─── Streamable HTTP transport ──────────────────────────────────

async function discoverViaStreamableHTTP(
  url: string,
  apiKey?: string | null,
): Promise<McpToolSchema[]> {
  const startedAt = Date.now();
  mcpStats.streamableStarted++;
  mcpStats.activeOperations++;
  mcpStats.lastOperation = 'discoverViaStreamableHTTP';
  mcpStats.lastStartedAt = new Date(startedAt).toISOString();
  mcpStats.lastRssBefore = rssMb();
  let sessionHeaders: Record<string, string> | null = null;
  try {
    const headers = buildHeaders(apiKey);
    sessionHeaders = await mcpHandshake(url, headers);

    mcpStats.lastPhase = 'streamable:tools/list';
    const listResp = await fetch(url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(TIMEOUT_LIST_MS),
    });
    mcpStats.fetchResponsesOpened++;

    if (!listResp.ok) {
      const errBody = await listResp.text().catch(() => '');
      mcpStats.fetchBodiesConsumed++;
      throw new Error(`tools/list ${listResp.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await parseStreamableResponse(listResp);
    mcpStats.fetchBodiesConsumed++;
    const tools = data?.result?.tools || [];
    mcpStats.streamableCompleted++;
    return tools.map((t: any) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      transport: 'streamable' as const,
    }));
  } catch (e) {
    mcpStats.streamableFailed++;
    throw e;
  } finally {
    if (sessionHeaders) await terminateSession(url, sessionHeaders);
    mcpStats.activeOperations--;
    mcpStats.lastDurationMs = Date.now() - startedAt;
    mcpStats.lastRssAfter = rssMb();
  }
}

async function executeViaStreamableHTTP(
  url: string,
  apiKey: string | null,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const startedAt = Date.now();
  mcpStats.streamableStarted++;
  mcpStats.activeOperations++;
  mcpStats.lastOperation = 'executeViaStreamableHTTP';
  mcpStats.lastStartedAt = new Date(startedAt).toISOString();
  mcpStats.lastRssBefore = rssMb();
  let sessionHeaders: Record<string, string> | null = null;
  try {
    const headers = buildHeaders(apiKey);
    sessionHeaders = await mcpHandshake(url, headers);

    mcpStats.lastPhase = 'streamable:tools/call';
    const resp = await fetch(url, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      signal: AbortSignal.timeout(TIMEOUT_CALL_MS),
    });
    mcpStats.fetchResponsesOpened++;

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      mcpStats.fetchBodiesConsumed++;
      throw new Error(`tools/call ${resp.status}: ${errBody.slice(0, 200)}`);
    }

    const data = await parseStreamableResponse(resp);
    mcpStats.fetchBodiesConsumed++;
    mcpStats.streamableCompleted++;
    if (data?.error) {
      return `Tool error: ${data.error.message || JSON.stringify(data.error)}`;
    }
    const content = data?.result?.content || [];
    return (content.length > 0 ? serializeContentBlocks(content) : null) || JSON.stringify(data?.result || {});
  } catch (e) {
    mcpStats.streamableFailed++;
    throw e;
  } finally {
    if (sessionHeaders) await terminateSession(url, sessionHeaders);
    mcpStats.activeOperations--;
    mcpStats.lastDurationMs = Date.now() - startedAt;
    mcpStats.lastRssAfter = rssMb();
  }
}

// ─── SSE transport (fallback) ───────────────────────────────────

interface SSEEvent {
  event: string;
  data: string;
}

/**
 * Fully release an SSE reader in a finally block. Awaited (so the stream is
 * actually torn down before the operation returns, not stranded on a detached
 * promise) and guarded so a cancel rejection can never throw out of finally.
 * A double-cancel (e.g. the read-timeout path already cancelled) is a no-op.
 */
async function closeSSEReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
    mcpStats.sseCancelled++;
  } catch {
    mcpStats.sseCancelFailed++;
  } finally {
    mcpStats.activeReaders--;
  }
}

/** Route an SSE-read timeout to the right counter based on the live operation. */
function countSSETimeout(): void {
  if (mcpStats.lastOperation && mcpStats.lastOperation.startsWith('execute')) {
    mcpStats.executionTimeouts++;
  } else {
    mcpStats.discoveryTimeouts++;
  }
}

async function readSSEUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: string,
  predicate: (event: SSEEvent) => boolean,
  timeoutMs = TIMEOUT_SSE_READ_MS,
): Promise<{ event: SSEEvent; buffer: string }> {
  let currentEvent = '';
  let currentData = '';

  // Real deadline that fires WHILE blocked in reader.read(): a timer cancels the
  // reader, which rejects/resolves the in-flight read so the loop can't wedge.
  // (The prior `while (Date.now() < deadline)` only checked between reads, so a
  // read() that never returned hung forever — the claude-cli discovery wedge.)
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    reader.cancel().catch(() => {}); // unblock the pending read(); errors are non-fatal
  }, timeoutMs);

  try {
    while (true) {
      let done: boolean;
      let value: Uint8Array | undefined;
      try {
        ({ done, value } = await reader.read());
      } catch {
        // read() rejected — either our cancel() above or a transport error.
        if (timedOut) { countSSETimeout(); throw new Error('SSE read timed out'); }
        throw new Error('SSE stream errored before matching event');
      }
      if (timedOut) { countSSETimeout(); throw new Error('SSE read timed out'); }
      if (done) throw new Error('SSE stream ended before matching event');

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') {
          // End of event
          if (currentData) {
            const evt: SSEEvent = { event: currentEvent || 'message', data: currentData };
            if (predicate(evt)) return { event: evt, buffer };
          }
          currentEvent = '';
          currentData = '';
        } else if (trimmed.startsWith('event:')) {
          currentEvent = trimmed.slice(6).trim();
        } else if (trimmed.startsWith('data:')) {
          currentData += (currentData ? '\n' : '') + trimmed.slice(5).trim();
        }
      }
    }
  } finally {
    clearTimeout(deadline);
  }
}

async function openSSESession(url: string, apiKey?: string | null): Promise<{
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  buffer: string;
  endpointUrl: string;
  postHeaders: Record<string, string>;
}> {
  const sseHeaders: Record<string, string> = { Accept: 'text/event-stream' };
  if (apiKey) sseHeaders['Authorization'] = `Bearer ${apiKey}`;

  mcpStats.lastPhase = 'sse:connect';
  const sseResp = await fetch(url, { headers: sseHeaders, signal: AbortSignal.timeout(TIMEOUT_SSE_CONNECT_MS) });
  mcpStats.fetchResponsesOpened++;
  if (!sseResp.ok || !sseResp.body) {
    const errBody = await sseResp.text().catch(() => '');
    mcpStats.fetchBodiesConsumed++;
    throw new Error(`sse connect ${sseResp.status}: ${errBody.slice(0, 200)}`);
  }

  const ct = sseResp.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    try { await sseResp.body.cancel(); mcpStats.fetchBodiesCancelled++; } catch {}
    throw new Error(`sse expected event-stream, got ${ct || 'unknown'}`);
  }

  const reader = sseResp.body.getReader();
  mcpStats.sseOpened++;
  mcpStats.activeReaders++;
  const decoder = new TextDecoder();
  let buffer = '';

  // First event is `event: endpoint` with the POST path
  const endpointRead = await readSSEUntil(reader, decoder, buffer, e => e.event === 'endpoint');
  buffer = endpointRead.buffer;
  const endpointUrl = new URL(endpointRead.event.data.trim(), url).toString();

  const postHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) postHeaders['Authorization'] = `Bearer ${apiKey}`;

  return { reader, decoder, buffer, endpointUrl, postHeaders };
}

async function readSSEJsonRpc(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  buffer: string,
  id: number,
): Promise<{ data: any; buffer: string }> {
  const read = await readSSEUntil(reader, decoder, buffer, e => {
    try { return JSON.parse(e.data).id === id; } catch { return false; }
  });
  return { data: JSON.parse(read.event.data), buffer: read.buffer };
}

async function discoverViaSSE(url: string, apiKey?: string | null): Promise<McpToolSchema[]> {
  const startedAt = Date.now();
  mcpStats.lastOperation = 'discoverViaSSE';
  mcpStats.lastStartedAt = new Date(startedAt).toISOString();
  mcpStats.lastRssBefore = rssMb();
  const session = await openSSESession(url, apiKey);
  let buffer = session.buffer;
  try {
    // initialize — the JSON-RPC reply arrives on the SSE stream (via readSSEUntil),
    // so the POST ack body itself is unused; bound it with a signal and dispose it.
    mcpStats.lastPhase = 'sse:initialize';
    const initPost = await fetch(session.endpointUrl, {
      method: 'POST', headers: session.postHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bytelight', version: '1.0.0' } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_INIT_MS),
    });
    mcpStats.fetchResponsesOpened++;
    await disposeBody(initPost);
    const initRead = await readSSEJsonRpc(session.reader, session.decoder, buffer, 1);
    buffer = initRead.buffer;

    // notifications/initialized
    mcpStats.lastPhase = 'sse:initialized';
    const notifPost = await fetch(session.endpointUrl, {
      method: 'POST', headers: session.postHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(TIMEOUT_NOTIFY_MS),
    });
    mcpStats.fetchResponsesOpened++;
    await disposeBody(notifPost);

    // tools/list
    mcpStats.lastPhase = 'sse:tools/list';
    const listPost = await fetch(session.endpointUrl, {
      method: 'POST', headers: session.postHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      signal: AbortSignal.timeout(TIMEOUT_LIST_MS),
    });
    mcpStats.fetchResponsesOpened++;
    await disposeBody(listPost);
    const toolsRead = await readSSEJsonRpc(session.reader, session.decoder, buffer, 2);

    const tools = toolsRead.data?.result?.tools || [];
    mcpStats.sseCompleted++;
    return tools.map((t: any) => ({
      name: t.name,
      description: t.description || '',
      inputSchema: t.inputSchema || { type: 'object', properties: {} },
      transport: 'sse' as const,
    }));
  } finally {
    await closeSSEReader(session.reader);
    mcpStats.lastDurationMs = Date.now() - startedAt;
    mcpStats.lastRssAfter = rssMb();
  }
}

async function executeViaSSE(
  url: string,
  apiKey: string | null,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const startedAt = Date.now();
  mcpStats.lastOperation = 'executeViaSSE';
  mcpStats.lastStartedAt = new Date(startedAt).toISOString();
  mcpStats.lastRssBefore = rssMb();
  const session = await openSSESession(url, apiKey);
  let buffer = session.buffer;
  try {
    // POST ack bodies are unused (JSON-RPC replies arrive on the SSE stream);
    // bound each with a signal and dispose it so no stream is stranded.
    mcpStats.lastPhase = 'sse:initialize';
    const initPost = await fetch(session.endpointUrl, {
      method: 'POST', headers: session.postHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bytelight', version: '1.0.0' } },
      }),
      signal: AbortSignal.timeout(TIMEOUT_INIT_MS),
    });
    mcpStats.fetchResponsesOpened++;
    await disposeBody(initPost);
    const initRead = await readSSEJsonRpc(session.reader, session.decoder, buffer, 1);
    buffer = initRead.buffer;

    mcpStats.lastPhase = 'sse:initialized';
    const notifPost = await fetch(session.endpointUrl, {
      method: 'POST', headers: session.postHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      signal: AbortSignal.timeout(TIMEOUT_NOTIFY_MS),
    });
    mcpStats.fetchResponsesOpened++;
    await disposeBody(notifPost);

    mcpStats.lastPhase = 'sse:tools/call';
    const callPost = await fetch(session.endpointUrl, {
      method: 'POST', headers: session.postHeaders,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: toolName, arguments: args } }),
      signal: AbortSignal.timeout(TIMEOUT_CALL_MS),
    });
    mcpStats.fetchResponsesOpened++;
    await disposeBody(callPost);
    const callRead = await readSSEJsonRpc(session.reader, session.decoder, buffer, 2);

    mcpStats.sseCompleted++;
    if (callRead.data?.error) {
      return `Tool error: ${callRead.data.error.message || JSON.stringify(callRead.data.error)}`;
    }
    const content = callRead.data?.result?.content || [];
    return (content.length > 0 ? serializeContentBlocks(content) : null) || JSON.stringify(callRead.data?.result || {});
  } finally {
    await closeSSEReader(session.reader);
    mcpStats.lastDurationMs = Date.now() - startedAt;
    mcpStats.lastRssAfter = rssMb();
  }
}

// ─── API Key resolution ────────────────────────────────────────

async function resolveApiKey(url: string, apiKey?: string | null): Promise<string | null> {
  return apiKey ?? null;
}

// ─── Public API ─────────────────────────────────────────────────

/**
 * Discover tools from an MCP server.
 * Tries Streamable HTTP first, falls back to SSE.
 */
export async function discoverMcpTools(
  url: string,
  apiKey?: string | null,
): Promise<McpToolSchema[]> {
  const resolvedKey = await resolveApiKey(url, apiKey);
  let streamableErr: unknown;
  try {
    return await discoverViaStreamableHTTP(url, resolvedKey);
  } catch (e) {
    // A bare undici "fetch failed" is almost always a transient socket/keep-alive
    // fault (connection reused after the server half-closed it, HTTP/2 reset,
    // etc.) against a server that answers a clean request correctly. Retrying the
    // whole streamable handshake once on a fresh connection recovers it — WITHOUT
    // falling through to the SSE path, which for a JSON-only Streamable-HTTP
    // server just GETs the landing page and throws the misleading
    // "expected event-stream, got text/plain".
    if (isTransientFetchFailure(e)) {
      try {
        return await discoverViaStreamableHTTP(url, resolvedKey);
      } catch (retryErr) {
        streamableErr = retryErr;
      }
    } else {
      streamableErr = e;
    }
  }
  try {
    return await discoverViaSSE(url, resolvedKey);
  } catch (sseErr) {
    throw new Error(
      `MCP discovery failed — streamable: ${streamableErr instanceof Error ? streamableErr.message : streamableErr}; ` +
      `sse: ${sseErr instanceof Error ? sseErr.message : sseErr}`,
    );
  }
}

/**
 * Recognize a transient, connection-level fetch failure worth one retry.
 * Undici surfaces these as a TypeError whose message is "fetch failed"; the
 * useful signal (ECONNRESET, socket hang up, other transport reset) lives on
 * `.cause`. We deliberately do NOT retry HTTP-status errors (4xx/5xx) — those
 * are handled by the handshake logic and shouldn't be masked by a retry.
 */
function isTransientFetchFailure(e: unknown): boolean {
  if (!(e instanceof TypeError)) return false;
  if (!/fetch failed/i.test(e.message)) return false;
  const cause: any = (e as any).cause;
  const causeStr = cause
    ? `${cause.code || ''} ${cause.message || ''}`.toLowerCase()
    : '';
  // Retry on connection resets / hang-ups / DNS blips / timeouts of the socket.
  // An empty cause (bare "fetch failed") is retried too — that's the exact
  // production signature the streamable path hit.
  return causeStr === '' ||
    /econnreset|epipe|econnrefused|enotfound|eai_again|socket hang up|other side closed|terminated|und_err/.test(causeStr);
}

/**
 * Execute a tool on an MCP server.
 * Uses the specified transport (defaults to streamable).
 */
export async function executeMcpTool(
  url: string,
  apiKey: string | null,
  toolName: string,
  args: Record<string, unknown>,
  transport: 'streamable' | 'sse' = 'streamable',
): Promise<{ result: string; ok: boolean }> {
  const resolvedKey = await resolveApiKey(url, apiKey);
  try {
    const result = transport === 'sse'
      ? await executeViaSSE(url, resolvedKey, toolName, args)
      : await executeViaStreamableHTTP(url, resolvedKey, toolName, args);
    return { result, ok: !result.startsWith('Tool error') };
  } catch (err) {
    return { result: `Tool error: ${errMessage(err)}`, ok: false };
  }
}
