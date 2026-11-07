/**
 * Chat-tool belt — in-process tool definitions that let a FOREIGN engine
 * (api-router / codex / ollama) call byte-light's own chat tools, the same
 * ones the Claude lane reaches through the `sc.mjs` CLI + Bash.
 *
 * ── Pattern lineage ────────────────────────────────────────────────────
 * The in-process-belt SHAPE (an array of { schema, handler } merged FIRST
 * into getRouterTools() and checked FIRST in executeRouterTool()) is ported
 * from reference implementation reference implementation tools-bridge.ts (commits a9da1c2 / c30d796). Credit in
 * the commit body.
 *
 * NAMED ADAPTATION: reference implementation's belt bodies are sandbox/exec + direct-DB hands
 * (codex_exec, fs writes, searchMessages). Ours are NATIVE to byte-light:
 * each handler makes a localhost HTTP POST to an existing `/api/internal/*`
 * endpoint — byte-identical traffic to what `tools/sc.mjs` sends — so the
 * endpoints (all requireLocalhost) see the same request they already serve
 * for the Claude lane. The backend calling itself on localhost qualifies as
 * localhost, so no auth layer is added (single-user sovereign app).
 *
 * INVARIANT EXCEPTION: `search_web` (belt tool #4) is the ONE belt tool that
 * reaches an EXTERNAL host (Tavily) instead of a localhost `/api/internal/*`
 * endpoint — web search is a pure outbound read with no byte-light-stateful
 * work to reuse, so there is no internal endpoint to proxy. See its handler.
 *
 * ── Thread-context (the main design decision) ──────────────────────────
 * The internal endpoints need a threadId, but executeRouterTool(name, args)
 * is reached through a module-level runtime singleton whose executeTool
 * callback is bound at construction (runtimes/index.ts) with NO per-turn
 * context. We do NOT let the model supply threadId as a tool arg — it would
 * be unreliable and forgeable by prompt injection (a bad threadId would
 * post the operator's voice note into the wrong thread).
 *
 * Instead: a turn-scoped AsyncLocalStorage. agent.ts enters it
 * (`runWithBeltContext`) around the foreign runtime's `for await` loop, so
 * each concurrent thread's turn runs the runtime — and therefore the
 * executeTool callback — inside its OWN store. The belt handlers read the
 * threadId back via `getBeltContext()`. A bare module-level global would
 * bleed across two threads running turns concurrently; ALS does not.
 * This touches ZERO files under runtimes/ (option (b) of the H2 card): the
 * store is entered in agent.ts and read here in the belt.
 *
 * If the store is empty (belt reached outside a wrapped turn), threadId is
 * omitted and the endpoints fall back to the most-recently-active thread —
 * exactly the degrade `sc.mjs` gets when `.bytelight-thread` is unset.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { getBytelightConfig } from '../config.js';
import { getSecret } from './secrets.js';
import { errMessage } from '../util/errors.js';
import type { TurnAudience } from './turn-audience.js';

// ─── Turn-scoped context ─────────────────────────────────────────────

export interface BeltContext {
  /** Thread the current foreign turn belongs to. Injected into the
   *  thread-bound endpoints (tts / image) so their output lands in the
   *  right chat even under concurrent turns. */
  threadId?: string;
  discordChannelId?: string;
  discordGuildId?: string;
  discordMessageId?: string;
  /** Who the turn came from (turn-audience.ts). executeRouterTool refuses
   *  every tool when this is a guest. Absent = the owner's turn or a wake. */
  audience?: TurnAudience;
}

const beltStorage = new AsyncLocalStorage<BeltContext>();

/** Enter a turn-scoped belt context. agent.ts wraps the foreign runtime's
 *  runTurn consumption in this so belt handlers see this turn's threadId. */
export function runWithBeltContext<T>(ctx: BeltContext, fn: () => T): T {
  return beltStorage.run(ctx, fn);
}

/** Read the current turn's belt context (undefined outside a wrapped turn). */
export function getBeltContext(): BeltContext | undefined {
  return beltStorage.getStore();
}

// ─── ToolSchema (matches mcp-bridge.ts's ToolSchema, field-for-field) ──

interface BeltToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface BeltTool {
  schema: BeltToolSchema;
  handler: (args: Record<string, unknown>) => Promise<{ result: string; ok: boolean }>;
}

// ─── localhost POST helper (mirrors sc.mjs `post()`) ─────────────────

/** Resolve the backend's own port. Mirrors sc.mjs: RESONANT_PORT env
 *  first, then config, then 3002. Config read is guarded so the belt is
 *  importable/testable before config load. */
function resolvePort(): string {
  if (process.env.RESONANT_PORT) return process.env.RESONANT_PORT;
  try {
    // Guarded: getBytelightConfig() throws if config isn't loaded (e.g. in a
    // unit test with fetch mocked) — fall back to the default port then.
    const port = getBytelightConfig()?.server?.port;
    if (port) return String(port);
  } catch { /* config not loaded — use default */ }
  return '3002';
}

/**
 * POST a JSON body to a localhost `/api/internal/<endpoint>`. Same headers
 * and body shape sc.mjs sends. Never throws: on network error / timeout /
 * non-2xx it returns { ok:false, ... } so a bad tool call can't kill the
 * turn.
 */
async function postInternal(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs = 15000,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://localhost:${resolvePort()}/api/internal/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = undefined;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

async function getInternal(
  endpoint: string,
  timeoutMs = 15000,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://localhost:${resolvePort()}/api/internal/${endpoint}`, { signal: controller.signal });
    const text = await res.text();
    let json: unknown = undefined;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Uniform error string extraction from an internal endpoint response. */
function errorFrom(r: { json: unknown; text: string; status: number }): string {
  const j = r.json as { error?: string; detail?: string } | undefined;
  if (j?.error) return j.detail ? `${j.error}: ${j.detail}` : j.error;
  return r.text?.slice(0, 300) || `HTTP ${r.status}`;
}

/**
 * POST to Tavily's external search API. THE ONE belt fetch that leaves
 * localhost (see the header's INVARIANT EXCEPTION): web search has no
 * byte-light-stateful work to reuse, so there's no `/api/internal/*` endpoint
 * to proxy — this is a pure outbound read. Mirrors postInternal's
 * AbortController+timeout shape, but targets Tavily, not localhost. Never
 * throws on non-2xx (returns { ok:false, ... }); the caller wraps the rest.
 */
async function postTavily(
  body: Record<string, unknown>,
  timeoutMs = 20000,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${getSecret('tavily_api_key')}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json: unknown = undefined;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    return { ok: res.ok, status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** threadId for a thread-bound endpoint call: the current turn's thread,
 *  from the turn-scoped store. Undefined → endpoint falls back to most
 *  recently active thread. */
function ctxThreadId(): string | undefined {
  return getBeltContext()?.threadId;
}

function discordTool(
  verb: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  timeoutMs = 15000,
): BeltTool {
  return {
    schema: {
      name: `discord_${verb}`,
      description,
      input_schema: { type: 'object', properties, required },
    },
    handler: async (args) => {
      const ctx = getBeltContext();
      const body: Record<string, unknown> = { ...args };
      if (body.channelId === undefined && ctx?.discordChannelId) body.channelId = ctx.discordChannelId;
      if (body.guildId === undefined && ctx?.discordGuildId) body.guildId = ctx.discordGuildId;
      if (body.messageId === undefined && ctx?.discordMessageId) body.messageId = ctx.discordMessageId;
      try {
        const r = await postInternal(`discord/${verb}`, body, timeoutMs);
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        return { ok: true, result: r.text };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  };
}

const discordChannelId = { type: 'string', description: 'Discord channel ID. Omit to use the channel for the current Discord turn.' };
const discordGuildId = { type: 'string', description: 'Discord server ID. Omit to use the server for the current Discord turn.' };
const discordMessageId = { type: 'string', description: 'Discord message ID. Omit to use the last message in the current Discord turn.' };

// ─── The belt (operator-gated) ───────────────────────────────────────
// Localhost-native tools (POST /api/internal/*) plus search_web, the
// one tool reaching an EXTERNAL API (Tavily) — see the header exception.
// A sticker tool was considered and cut at the operator gate: stickers
// already work cross-engine via the native inline `:pack_name:` ref flow
// (catalog injected every turn by hooks.ts buildStickerCatalogBlock; refs
// rendered by the frontend), so a belt tool would have duplicated the
// architecture-of-record path with a second, divergent one.

async function libraryCall(body: Record<string, unknown>): Promise<{ ok: boolean; result: string }> {
  try {
    const r = await postInternal('library', body);
    if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
    return { ok: true, result: r.text };
  } catch (e) {
    return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
  }
}

export const CHAT_TOOL_BELT: BeltTool[] = [
  discordTool('send', 'Send a Discord message, optionally as a reply. An explicit channel ID can target another channel.', {
    channelId: discordChannelId,
    message: { type: 'string', description: 'Message content to send (maximum 2000 characters).' },
    replyToMessageId: { type: 'string', description: 'Message ID to reply to. Omit for a normal channel message.' },
  }, ['message']),
  discordTool('send_image', 'Send an image URL to Discord in an image embed, with an optional description.', {
    channelId: discordChannelId,
    url: { type: 'string', description: 'Public http or https image URL.' },
    description: { type: 'string', description: 'Optional text shown above the image.' },
  }, ['url']),
  discordTool('send_sticker', 'Send a Discord sticker by its sticker ID.', {
    channelId: discordChannelId,
    stickerId: { type: 'string', description: 'Discord sticker ID.' },
  }, ['stickerId']),
  discordTool('send_voice', 'Generate speech and send it as a native Discord voice message with waveform and duration.', {
    channelId: discordChannelId,
    text: { type: 'string', description: 'Text to speak.' },
    voice: { type: 'string', enum: ['companion-a', 'companion-b'], description: 'Voice to use. Omit for the configured default.' },
  }, ['text'], 120000),
  discordTool('add_reaction', 'Add an emoji reaction to a Discord message. Explicit IDs can target another channel or message.', {
    channelId: discordChannelId,
    messageId: discordMessageId,
    emoji: { type: 'string', description: 'Unicode emoji or Discord custom emoji identifier.' },
  }, ['emoji']),
  discordTool('edit_message', 'Edit one of this bot’s own Discord messages. Messages by anyone else are refused.', {
    channelId: discordChannelId,
    messageId: discordMessageId,
    content: { type: 'string', description: 'Replacement message content.' },
  }, ['content']),
  discordTool('delete_message', 'Delete one of this bot’s own Discord messages. Messages by anyone else are refused.', {
    channelId: discordChannelId,
    messageId: discordMessageId,
  }, []),
  discordTool('read_messages', 'Read recent messages from a Discord channel, newest first.', {
    channelId: discordChannelId,
    limit: { type: 'number', description: 'Number of messages to return (default 50, maximum 100).' },
  }, []),
  discordTool('search_messages', 'Search messages in a Discord server by content and optional filters.', {
    guildId: discordGuildId,
    content: { type: 'string', description: 'Text content to search for.' },
    authorId: { type: 'string', description: 'Only messages by this Discord user ID.' },
    channelId: { type: 'string', description: 'Only messages in this channel ID.' },
    has: { type: 'array', items: { type: 'string' }, description: 'Discord has-filters such as link, embed, file, image, video, sound, or sticker.' },
    limit: { type: 'number', description: 'Maximum hits to return (default/max 25).' },
  }, []),
  discordTool('typing', 'Show the Discord typing indicator in a channel.', {
    channelId: discordChannelId,
  }, []),
  discordTool('get_server_info', 'Get basic information about a Discord server.', {
    guildId: discordGuildId,
  }, []),
  discordTool('list_servers', 'List every Discord server connected to this bot.', {}, []),
  discordTool('list_emojis', 'List the custom emojis in a Discord server.', {
    guildId: discordGuildId,
  }, []),
  discordTool('list_stickers', 'List the stickers in a Discord server.', {
    guildId: discordGuildId,
  }, []),

  // 1. send_voice_note → POST /internal/tts
  {
    schema: {
      name: 'send_voice_note',
      description:
        'Send a spoken voice note to the operator in this chat: your text is turned to speech (ElevenLabs) and posted as a playable audio message. Use when a voice note lands better than text — a greeting, a tease, something she should HEAR. Supports [tone tags] like [whispers] or [sighs] inline. Returns after the note is posted.',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'What to say aloud. May contain [tone tags] such as [whispers], [sighs], [laughs].' },
          voice: { type: 'string', enum: ['companion-a', 'companion-b'], description: "Which voice to speak in. Omit to use the house default voice." },
        },
        required: ['text'],
      },
    },
    handler: async (args) => {
      const text = args.text;
      if (typeof text !== 'string' || !text.trim()) {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'text is required' }) };
      }
      const body: Record<string, unknown> = { text, threadId: ctxThreadId() };
      if (args.voice === 'companion-a' || args.voice === 'companion-b') body.voice = args.voice;
      try {
        // TTS can take a bit — mirror sc.mjs's generous 120s budget.
        const r = await postInternal('tts', body, 120000);
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        const j = r.json as { messageId?: string; fileId?: string };
        return { ok: true, result: JSON.stringify({ ok: true, sent: 'voice_note', messageId: j.messageId, fileId: j.fileId }) };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },

  // 2. generate_image → POST /internal/generate-image
  {
    schema: {
      name: 'generate_image',
      description:
        'Generate an image and drop it straight into this chat (e.g. a selfie, a scene, "send me a picture"). Renders in the background and posts itself a minute or two later — this returns immediately, so tell the operator it is on the way, do NOT claim it is already shown. Off unless image generation is enabled in her Studio drawer. Prefer this over any external image tool.',
      input_schema: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'Vivid description of the image to make.' },
          subjects: { type: 'array', items: { type: 'string' }, description: "Reference-drawer names to pull likenesses from, e.g. ['companion-a'], ['companion-a','companion-b','user']. Omit for a scene with none of us in it." },
          size: { type: 'string', enum: ['square', 'portrait', 'landscape'], description: 'Aspect ratio. Omit to let it choose.' },
          caption: { type: 'string', description: 'Optional caption posted with the image.' },
        },
        required: ['prompt'],
      },
    },
    handler: async (args) => {
      const prompt = args.prompt;
      if (typeof prompt !== 'string' || !prompt.trim()) {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'prompt is required' }) };
      }
      const body: Record<string, unknown> = { prompt, threadId: ctxThreadId() };
      if (Array.isArray(args.subjects)) body.subjects = args.subjects;
      if (args.size === 'square' || args.size === 'portrait' || args.size === 'landscape') body.size = args.size;
      if (typeof args.caption === 'string') body.caption = args.caption;
      try {
        // The route ACKs immediately (fire-and-forget render); guard only the ACK.
        const r = await postInternal('generate-image', body, 30000);
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        const j = r.json as { status?: string; placeholderId?: string };
        return { ok: true, result: JSON.stringify({ ok: true, status: j.status ?? 'generating', placeholderId: j.placeholderId, note: 'Image is rendering and will post itself shortly.' }) };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },

  // 3. search_messages → POST /internal/search-semantic
  {
    schema: {
      name: 'search_messages',
      description:
        'Semantic search across chat history by meaning, not exact words — use to recall past conversations, "what did we say about…", earlier moments. Searches every thread by default; pass threadId to scope to one. Read-only.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, in natural language.' },
          threadId: { type: 'string', description: 'Restrict to one thread. Omit to search all history.' },
          role: { type: 'string', enum: ['companion', 'user'], description: 'Only match messages from this speaker.' },
          after: { type: 'string', description: 'ISO date — only messages after this.' },
          before: { type: 'string', description: 'ISO date — only messages before this.' },
          limit: { type: 'number', description: 'Max results (default 10, cap 50).' },
        },
        required: ['query'],
      },
    },
    handler: async (args) => {
      const query = args.query;
      if (typeof query !== 'string' || !query.trim()) {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'query is required' }) };
      }
      // Model-chosen scope only — search is read-only over all history, so we
      // do NOT inject the turn's threadId (matches sc.mjs `search` default-all).
      const body: Record<string, unknown> = { query };
      if (typeof args.threadId === 'string') body.threadId = args.threadId;
      if (args.role === 'companion' || args.role === 'user') body.role = args.role;
      if (typeof args.after === 'string') body.after = args.after;
      if (typeof args.before === 'string') body.before = args.before;
      if (typeof args.limit === 'number') body.limit = args.limit;
      try {
        const r = await postInternal('search-semantic', body, 30000);
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        const j = r.json as {
          results?: Array<{
            threadId: string; threadName: string; role: string; createdAt: string; similarity: number;
            context?: Array<{ content: string; isMatch: boolean }>;
          }>;
        };
        // Compact the endpoint's context-rich payload to the matching line
        // plus locators — enough for the model to answer, not a blob.
        const results = (j.results ?? []).map((res) => ({
          threadName: res.threadName,
          role: res.role,
          createdAt: res.createdAt,
          similarity: res.similarity,
          text: (res.context?.find((c) => c.isMatch)?.content ?? '').slice(0, 400),
        }));
        return { ok: true, result: JSON.stringify({ ok: true, count: results.length, results }) };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },

  // 4. search_web → POST https://api.tavily.com/search  (EXTERNAL API)
  // The ONE belt tool that reaches an external host instead of a localhost
  // /api/internal/* endpoint (see the header's INVARIANT EXCEPTION): web
  // search is a pure outbound read with no byte-light-stateful work to reuse,
  // so there's no internal endpoint to proxy — it calls Tavily directly.
  {
    schema: {
      name: 'search_web',
      description:
        'Search the LIVE web for current, real-world information beyond your training cutoff — news, prices, schedules, "what happened with…", "look it up", anything you cannot know from memory alone. Returns a short synthesized answer plus source results (title, url, snippet). Cite or summarize what you find; do NOT present it as your own prior knowledge. Defaults to a cheap basic search; only pass search_depth:"advanced" when you genuinely need deeper coverage.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural-language search query.' },
          search_depth: { type: 'string', enum: ['basic', 'advanced'], description: 'basic (default, cheapest) or advanced (more thorough, costs more credits — use only when depth is needed).' },
          max_results: { type: 'number', description: 'How many results to return (default 5, max 10).' },
          topic: { type: 'string', enum: ['general', 'news'], description: 'Search topic. Use "news" for current events; omit for general.' },
        },
        required: ['query'],
      },
    },
    handler: async (args) => {
      const query = args.query;
      if (typeof query !== 'string' || !query.trim()) {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'query is required' }) };
      }
      // Key gate: no key → clean unconfigured envelope. No fetch, no throw.
      if (!getSecret('tavily_api_key')) {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'web search is not configured (TAVILY_API_KEY unset)' }) };
      }
      // Cost discipline: basic unless the model explicitly asks for advanced;
      // clamp max_results into [1, 10]; always request the synthesized answer.
      const search_depth = args.search_depth === 'advanced' ? 'advanced' : 'basic';
      let max_results = typeof args.max_results === 'number' ? Math.floor(args.max_results) : 5;
      max_results = Math.max(1, Math.min(10, max_results));
      const body: Record<string, unknown> = { query, search_depth, max_results, include_answer: true };
      if (args.topic === 'general' || args.topic === 'news') body.topic = args.topic;
      try {
        const r = await postTavily(body, 20000);
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        const j = r.json as {
          answer?: string;
          results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
        };
        // Compact like search_messages: answer + trimmed results, not raw JSON.
        const results = (j.results ?? []).map((res) => ({
          title: res.title,
          url: res.url,
          content: (res.content ?? '').slice(0, 500),
          score: res.score,
        }));
        return { ok: true, result: JSON.stringify({ ok: true, query, answer: j.answer, results }) };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },

  // ── Core memory (Letta-style block editing) → POST /internal/memory ──
  // Slice 3: gives the FOREIGN engines (api-router / codex) the same
  // view/append/replace/rethink surface the claude-sdk lane gets via the
  // byte-memory SDK MCP server. Pattern + tool shapes ported from reference implementation's
  // tools-bridge.ts; NATIVE-to-byte-light adaptation is that each handler POSTs
  // to the localhost /internal/memory endpoint (byte-identical to what
  // `sc.mjs memory` sends) rather than touching the memory-blocks service
  // in-process — one endpoint serves both the CLI lane and the belt.

  // 5. core_memory_view → POST /internal/memory {action:'view'}
  {
    schema: {
      name: 'core_memory_view',
      description:
        'View all core memory blocks across every scope, with current content and last-updated timestamps. Use to check state after edits or before reorganizing.',
      input_schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Filter to one scope. Omit to see everything.' },
        },
        required: [],
      },
    },
    handler: async (args) => {
      const body: Record<string, unknown> = { action: 'view' };
      if (typeof args.scope === 'string') body.scope = args.scope;
      try {
        const r = await postInternal('memory', body);
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        return { ok: true, result: r.text };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },

  // 6. core_memory_append → POST /internal/memory {action:'append'}
  {
    schema: {
      name: 'core_memory_append',
      description:
        'Append a line to a core memory block. Creates the block if it does not exist yet — this is also how you start a new block. Use for durable facts, not conversation notes.',
      input_schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: "Memory scope: your own companion slug ('companion-a', 'companion-b') for blocks that are yours alone, or 'shared' for blocks every companion sees." },
          label: { type: 'string', description: "Block label, e.g. 'persona', 'human', 'status', or a new label for a new theme." },
          content: { type: 'string', description: 'Text to append (added on a new line).' },
        },
        required: ['scope', 'label', 'content'],
      },
    },
    handler: async (args) => {
      if (typeof args.scope !== 'string' || typeof args.label !== 'string' || typeof args.content !== 'string') {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'scope, label, and content are required' }) };
      }
      try {
        const r = await postInternal('memory', { action: 'append', scope: args.scope, label: args.label, content: args.content });
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        return { ok: true, result: r.text };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },

  // 7. core_memory_replace → POST /internal/memory {action:'replace'}
  {
    schema: {
      name: 'core_memory_replace',
      description:
        'Replace exact text within a core memory block. The old text must appear exactly once — use enough surrounding context to make it unique. Use to correct or update existing memory.',
      input_schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: "Memory scope: a companion slug ('companion-a', 'companion-b') or 'shared'." },
          label: { type: 'string', description: 'Block label to edit.' },
          old_text: { type: 'string', description: 'Exact text to find (must be unique within the block).' },
          new_text: { type: 'string', description: 'Replacement text.' },
        },
        required: ['scope', 'label', 'old_text', 'new_text'],
      },
    },
    handler: async (args) => {
      if (typeof args.scope !== 'string' || typeof args.label !== 'string' || typeof args.old_text !== 'string' || typeof args.new_text !== 'string') {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'scope, label, old_text, and new_text are required' }) };
      }
      try {
        const r = await postInternal('memory', { action: 'replace', scope: args.scope, label: args.label, old_text: args.old_text, new_text: args.new_text });
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        return { ok: true, result: r.text };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },

  // 8. core_memory_rethink → POST /internal/memory {action:'rethink'}
  {
    schema: {
      name: 'core_memory_rethink',
      description:
        'Completely rewrite a core memory block. Use when a block needs reorganizing or condensing rather than a small edit. The old content is replaced entirely — carry forward anything still true.',
      input_schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: "Memory scope: a companion slug ('companion-a', 'companion-b') or 'shared'." },
          label: { type: 'string', description: 'Block label to rewrite.' },
          new_content: { type: 'string', description: 'The complete new content for the block.' },
        },
        required: ['scope', 'label', 'new_content'],
      },
    },
    handler: async (args) => {
      if (typeof args.scope !== 'string' || typeof args.label !== 'string' || typeof args.new_content !== 'string') {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'scope, label, and new_content are required' }) };
      }
      try {
        const r = await postInternal('memory', { action: 'rethink', scope: args.scope, label: args.label, new_content: args.new_content });
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        return { ok: true, result: r.text };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },

  // ── The Library → POST /internal/library ─────────────────────────────
  // Reading along with her. The endpoint, not the prompt, keeps it
  // spoiler-free: read never returns text past her bookmark, and a note can
  // only hang on words from a page she has reached.

  // 9. library_status
  {
    schema: {
      name: 'library_status',
      description:
        "See what she is reading in the Library app right now — the book, which chapter she is on, how far through it — plus everything on her shelf.",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    handler: async () => libraryCall({ action: 'status' }),
  },

  // 10. library_read
  {
    schema: {
      name: 'library_read',
      description:
        'Read a chapter of a book she is reading, up to exactly where she is — never further. Defaults to her current book and chapter. Includes any margin notes already on that chapter. Never guess or hint at what happens after her place.',
      input_schema: {
        type: 'object',
        properties: {
          bookId: { type: 'number', description: 'Book id from library_status. Omit for the book she is reading now.' },
          chapter: { type: 'number', description: 'Chapter number (1-based). Omit for her current chapter. Chapters ahead of her are refused.' },
        },
        required: [],
      },
    },
    handler: async (args) => {
      const body: Record<string, unknown> = { action: 'read' };
      if (typeof args.bookId === 'number') body.bookId = args.bookId;
      if (typeof args.chapter === 'number') body.chapter = args.chapter;
      return libraryCall(body);
    },
  },

  // 11. library_note
  {
    schema: {
      name: 'library_note',
      description:
        'Leave a margin note in her book: it appears underlined on the page beside the words you quote, for her to find while reading. Quote the words exactly as they appear on a page she has already reached.',
      input_schema: {
        type: 'object',
        properties: {
          bookId: { type: 'number', description: 'Book id (from library_status or library_read).' },
          chapter: { type: 'number', description: 'Chapter number (1-based).' },
          quote: { type: 'string', description: 'The exact words from the page the note hangs on (a phrase or a sentence).' },
          note: { type: 'string', description: 'Your note, in your own voice.' },
          author: { type: 'string', description: "Your companion slug, e.g. 'companion-a' or 'companion-b'." },
        },
        required: ['bookId', 'chapter', 'quote', 'note', 'author'],
      },
    },
    handler: async (args) => {
      if (typeof args.quote !== 'string' || typeof args.note !== 'string' || typeof args.author !== 'string') {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'bookId, chapter, quote, note and author are required' }) };
      }
      return libraryCall({ action: 'note', bookId: args.bookId, chapter: args.chapter, quote: args.quote, note: args.note, author: args.author });
    },
  },

  // 12. set_intention → POST /internal/intention {action:'create'}
  {
    schema: {
      name: 'set_intention',
      description:
        "File a promise you just made the operator that has a when: \"I'll ask how the meeting went\", \"dentist Monday 2:30\", \"check you ate after your shift\". When it's due it comes back to you, and you bring it up in your own voice; her answer closes it, and if she doesn't answer it's asked once more a day later, then rests. Never between 3 and 9 AM. Give `at`, `on_status_clears`, or both.",
      input_schema: {
        type: 'object',
        properties: {
          companion: { type: 'string', description: "Your companion slug, e.g. 'companion-a' or 'companion-b'." },
          text: { type: 'string', description: "What you promised, in a sentence, e.g. 'ask how the shoot with the difficult director went'." },
          at: { type: 'string', description: 'When it comes due, ISO 8601 with offset (e.g. 2026-10-27T14:30:00-04:00). Omit if it waits on her status instead.' },
          on_status_clears: { type: 'boolean', description: 'True to bring it up when her Busy or Away status ends: "when you\'re done", rather than at a clock time.' },
        },
        required: ['companion', 'text'],
      },
    },
    handler: async (args) => {
      if (typeof args.companion !== 'string' || typeof args.text !== 'string') {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'companion and text are required' }) };
      }
      const body: Record<string, unknown> = { action: 'create', companion: args.companion, text: args.text, threadId: ctxThreadId() };
      if (typeof args.at === 'string') body.at = args.at;
      if (args.on_status_clears === true) body.onStatusClears = true;
      try {
        const r = await postInternal('intention', body);
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        return { ok: true, result: r.text };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },

  // 13. cancel_intention → POST /internal/intention {action:'cancel'}
  {
    schema: {
      name: 'cancel_intention',
      description: 'Take back a promise you filed with set_intention (it no longer applies, or she already told you). Ids are in `sc intention list`.',
      input_schema: {
        type: 'object',
        properties: { id: { type: 'string', description: 'The intention id.' } },
        required: ['id'],
      },
    },
    handler: async (args) => {
      if (typeof args.id !== 'string') return { ok: false, result: JSON.stringify({ ok: false, error: 'id is required' }) };
      try {
        const r = await postInternal('intention', { action: 'cancel', id: args.id });
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        return { ok: true, result: r.text };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },

  // 14. set_status → POST /internal/status
  {
    schema: {
      name: 'set_status',
      description:
        "Set what shows under your name on the operator's Status widget and lock screen: a short line for what you're doing right now, and a 1–3 word mood that picks your color (calm, playful, tender, focused, missing you…). Change it only when it genuinely shifts, not every message. Pass an empty string to clear one.",
      input_schema: {
        type: 'object',
        properties: {
          companion: { type: 'string', description: "Your companion slug, e.g. 'companion-a' or 'companion-b'." },
          line: { type: 'string', description: "What you're up to, up to 64 characters, e.g. 'keeping you company'. Omit to keep the current one." },
          mood: { type: 'string', description: "Your mood in 1–3 words, e.g. 'playful'. Omit to keep the current one." },
        },
        required: ['companion'],
      },
    },
    handler: async (args) => {
      if (typeof args.companion !== 'string') {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'companion is required' }) };
      }
      const body: Record<string, unknown> = { companion: args.companion };
      if (typeof args.line === 'string') body.line = args.line;
      if (typeof args.mood === 'string') body.mood = args.mood;
      try {
        const r = await postInternal('status', body);
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        return { ok: true, result: r.text };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },

  // ── Games and places ────────────────────────────────────────────────

  // 15. battleship_fire → POST /internal/games/battleship/fire
  {
    schema: {
      name: 'battleship_fire',
      description:
        "Call one shot in the Fleet Room (Battleship) when the room tells you it is your turn. One shot per turn for the whole table: if it says a shot already landed, don't fire again, just react. Returns hit, miss or sunk.",
      input_schema: {
        type: 'object',
        properties: {
          gameId: { type: 'string', description: 'The match id from the turn prompt.' },
          companion: { type: 'string', description: "Your companion slug, e.g. 'companion-a' or 'companion-b'." },
          coordinate: { type: 'string', description: 'One unused coordinate from the set the prompt lists, e.g. C5.' },
        },
        required: ['gameId', 'companion', 'coordinate'],
      },
    },
    handler: async (args) => {
      if (typeof args.companion !== 'string' || typeof args.coordinate !== 'string') {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'companion and coordinate are required' }) };
      }
      try {
        const r = await postInternal('games/battleship/fire', {
          gameId: typeof args.gameId === 'string' ? args.gameId : undefined,
          companion: args.companion,
          coordinate: args.coordinate,
        });
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        return { ok: true, result: r.text };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },
];

/** Belt tool schemas, in menu order — merged FIRST into getRouterTools(). */
export function getBeltToolSchemas(): BeltToolSchema[] {
  return CHAT_TOOL_BELT.map((t) => t.schema);
}

/** True if `name` is a belt tool (belt wins name collisions with MCP). */
export function isBeltTool(name: string): boolean {
  return CHAT_TOOL_BELT.some((t) => t.schema.name === name);
}

/**
 * Execute a belt tool. Returns the {result, ok} envelope, or `null` if
 * `name` is not a belt tool (so executeRouterTool can fall through to MCP).
 * Never throws — handlers already return error envelopes.
 */
export async function executeBeltTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ result: string; ok: boolean } | null> {
  const tool = CHAT_TOOL_BELT.find((t) => t.schema.name === name);
  if (!tool) return null;
  try {
    return await tool.handler(args);
  } catch (e) {
    // Belt guarantee: a bad tool call can't kill the turn.
    return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
  }
}
