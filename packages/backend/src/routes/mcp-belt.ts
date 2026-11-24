// House tool-belt MCP endpoint for byte-light's owned Codex app-server.
//
// This route deliberately delegates protocol negotiation, initialization,
// notification semantics, session validation, GET streaming, and DELETE
// teardown to the official MCP SDK. The previous handwritten JSON-RPC route
// looked MCP-shaped but replied to notifications as requests, which stricter
// Codex clients correctly rejected during startup.
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { getRouterTools, executeRouterTool } from '../services/mcp-bridge.js';
import { runWithBeltContext } from '../services/chat-tool-belt.js';
import type { BeltContext } from '../services/chat-tool-belt.js';
import { isTurnAudience } from '../services/turn-audience.js';
import { codexActiveBeltThread, codexActiveTurnAudience } from '../services/runtimes/codex-daemon.js';
import { getMcpBeltToken, validMcpBeltBearer } from '../services/mcp-belt-auth.js';
import { errMessage } from '../util/errors.js';

const THREAD_BOUND_TOOLS = new Set(['send_voice_note', 'generate_image', 'spellbook_cast', 'spellbook_read']);

interface BeltDependencies {
  getTools: typeof getRouterTools;
  executeTool: typeof executeRouterTool;
  activeThread: typeof codexActiveBeltThread;
  activeAudience?: typeof codexActiveTurnAudience;
  expectedToken: () => string;
  sessionIdleMs: number;
  sweepIntervalMs: number;
  now: () => number;
}

interface BeltSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  lastSeenAt: number;
  context?: BeltContext;
}

export interface BeltMcpRouter {
  router: Router;
  sessionCount(): number;
  closeAll(): Promise<void>;
}

const defaultDependencies: BeltDependencies = {
  getTools: getRouterTools,
  executeTool: executeRouterTool,
  activeThread: codexActiveBeltThread,
  activeAudience: codexActiveTurnAudience,
  expectedToken: getMcpBeltToken,
  sessionIdleMs: 6 * 60 * 60 * 1000,
  sweepIntervalMs: 60 * 1000,
  now: Date.now,
};

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function oneHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function decodeHeader(value: string | undefined, maxBytes = 8000): string | undefined {
  if (!value) return undefined;
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8');
    return Buffer.byteLength(decoded, 'utf8') <= maxBytes ? decoded : undefined;
  } catch { return undefined; }
}

/** A bearer-authenticated foreign CLI binds its MCP session to the current
 * Virelle turn. The model cannot author these headers: the owned runtime and
 * secret-bearing stdio proxy supply them out of band. */
function contextFromHeaders(req: Request): BeltContext | undefined {
  const threadId = oneHeader(req.headers['x-bytelight-thread-id']);
  const rawOwnerMessageText = decodeHeader(oneHeader(req.headers['x-bytelight-owner-message']));
  const audienceRaw = decodeHeader(oneHeader(req.headers['x-bytelight-audience']), 1000);
  let audience: BeltContext['audience'];
  if (audienceRaw) {
    try {
      const parsed = JSON.parse(audienceRaw);
      if (isTurnAudience(parsed)) audience = parsed;
    } catch { /* malformed context is ignored, never promoted */ }
  }
  if (!threadId && !rawOwnerMessageText && !audience) return undefined;
  return {
    ...(threadId ? { threadId: threadId.slice(0, 200) } : {}),
    ...(rawOwnerMessageText ? { rawOwnerMessageText } : {}),
    isAutonomous: oneHeader(req.headers['x-bytelight-is-autonomous']) === '1',
    ...(audience ? { audience } : {}),
  };
}

export function createBeltMcpRouter(overrides: Partial<BeltDependencies> = {}): BeltMcpRouter {
  const deps = { ...defaultDependencies, ...overrides };
  const router = Router();
  const sessions = new Map<string, BeltSession>();
  const sweepTimer = setInterval(() => {
    const cutoff = deps.now() - deps.sessionIdleMs;
    for (const [sessionId, session] of sessions) {
      if (session.lastSeenAt >= cutoff) continue;
      sessions.delete(sessionId);
      void session.server.close().catch(() => {});
    }
  }, deps.sweepIntervalMs);
  sweepTimer.unref();

  router.use((req, res, next) => {
    if (!validMcpBeltBearer(req.headers.authorization, deps.expectedToken())) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="bytelight-mcp-belt"');
      jsonRpcError(res, 401, -32001, 'Unauthorized');
      return;
    }
    next();
  });

  const createServer = (boundContext?: BeltContext): Server => {
    const server = new Server(
      { name: 'bytelight-belt', version: '2.0.0' },
      { capabilities: { tools: { listChanged: false } } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await deps.getTools();
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.input_schema,
        })),
      };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const name = request.params.name;
      const args = (request.params.arguments || {}) as Record<string, unknown>;
      const threadId = boundContext?.threadId ?? deps.activeThread() ?? undefined;

      if (THREAD_BOUND_TOOLS.has(name) && !threadId) {
        return {
          content: [{ type: 'text', text: `Error: ${name} requires an active byte-light Codex turn.` }],
          isError: true,
        };
      }

      try {
        // The live Codex turn's audience rides along, so a guest's turn is
        // refused belt tools by executeRouterTool (turn-audience.ts).
        const audience = boundContext?.audience ?? deps.activeAudience?.() ?? undefined;
        const context: BeltContext = { ...(boundContext ?? {}), threadId, ...(audience ? { audience } : {}) };
        const { result, ok } = await runWithBeltContext(context, () =>
          deps.executeTool(name, args));
        return {
          content: [{ type: 'text', text: result }],
          ...(ok ? {} : { isError: true }),
        };
      } catch (error) {
        return {
          content: [{
            type: 'text',
            text: `Error: ${errMessage(error)}`,
          }],
          isError: true,
        };
      }
    });

    return server;
  };

  const existingSession = (req: Request): BeltSession | undefined => {
    const sessionId = oneHeader(req.headers['mcp-session-id']);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (session) session.lastSeenAt = deps.now();
    return session;
  };

  router.post('/', async (req, res) => {
    const requestedSessionId = oneHeader(req.headers['mcp-session-id']);
    const existing = existingSession(req);
    if (requestedSessionId && !existing) {
      jsonRpcError(res, 404, -32001, 'Unknown or expired MCP session');
      return;
    }

    if (existing) {
      try {
        await existing.transport.handleRequest(req, res, req.body);
      } catch (error) {
        if (!res.headersSent) {
          jsonRpcError(res, 500, -32603, error instanceof Error ? error.message : 'MCP request failed');
        }
      }
      return;
    }

    if (!isInitializeRequest(req.body)) {
      jsonRpcError(res, 400, -32000, 'Initialization request or valid MCP session required');
      return;
    }

    let transport!: StreamableHTTPServerTransport;
    const boundContext = contextFromHeaders(req);
    const server = createServer(boundContext);
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { server, transport, lastSeenAt: deps.now(), context: boundContext });
      },
    });
    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) sessions.delete(sessionId);
    };

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const sessionId = transport.sessionId;
      if (sessionId) sessions.delete(sessionId);
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, error instanceof Error ? error.message : 'MCP initialization failed');
      }
    }
  });

  const handleEstablished = async (req: Request, res: Response): Promise<void> => {
    const requestedSessionId = oneHeader(req.headers['mcp-session-id']);
    const session = existingSession(req);
    if (!requestedSessionId || !session) {
      jsonRpcError(res, requestedSessionId ? 404 : 400, -32001, 'Valid MCP session required');
      return;
    }
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, error instanceof Error ? error.message : 'MCP request failed');
      }
    }
  };

  router.get('/', (req, res) => { void handleEstablished(req, res); });
  router.delete('/', (req, res) => { void handleEstablished(req, res); });

  return {
    router,
    sessionCount: () => sessions.size,
    closeAll: async () => {
      clearInterval(sweepTimer);
      const active = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(active.map(({ server }) => server.close()));
    },
  };
}

const beltMcp = createBeltMcpRouter();
export const closeBeltMcpSessions = beltMcp.closeAll;
export default beltMcp.router;
