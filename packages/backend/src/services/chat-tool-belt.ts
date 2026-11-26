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
import { isResident, residentIds } from './residents.js';

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

/** Resolve the backend's loopback internal port (internal-server.ts), where
 *  /api/internal lives. Mirrors sc.mjs: INTERNAL_PORT env first, then config
 *  server.internal_port, then 3012. Config read is guarded so the belt is
 *  importable/testable before config load. */
function resolvePort(): string {
  if (process.env.INTERNAL_PORT) return process.env.INTERNAL_PORT;
  try {
    // Guarded: getBytelightConfig() throws if config isn't loaded (e.g. in a
    // unit test with fetch mocked) — fall back to the default port then.
    const port = getBytelightConfig()?.server?.internal_port;
    if (port) return String(port);
  } catch { /* config not loaded — use default */ }
  return '3012';
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

const CANVAS_CONTENT_TYPES: readonly string[] = ['markdown', 'code', 'text', 'html'];
const TRIGGER_CONDITION_TYPES: readonly string[] = [
  'presence_state', 'presence_transition', 'agent_free', 'time_window', 'routine_missing',
];
const LAST_TARGET = /^last(-[1-9][0-9]*)?$/;

function fail(error: string): { ok: boolean; result: string } {
  return { ok: false, result: JSON.stringify({ ok: false, error }) };
}

/** POST to an internal endpoint and hand back its answer or its error. */
async function internalCall(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<{ ok: boolean; result: string }> {
  try {
    const r = await postInternal(endpoint, body, timeoutMs);
    if (!r.ok) return fail(errorFrom(r));
    return { ok: true, result: r.text };
  } catch (e) {
    return fail(errMessage(e));
  }
}

const triggerConditionsSchema = {
  type: 'array',
  description:
    "When it should fire; every condition must hold. Each is an object with a type: " +
    "{type:'presence_state', state:'active'|'idle'|'offline'} · " +
    "{type:'presence_transition', from, to} (e.g. offline → active: she just came back) · " +
    "{type:'agent_free'} (you are not mid-reply) · " +
    "{type:'time_window', after:'HH:MM', before?:'HH:MM'} · " +
    "{type:'routine_missing', routine, after_hour} (a routine not logged by that hour).",
  items: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: [...TRIGGER_CONDITION_TYPES] },
      state: { type: 'string', enum: ['active', 'idle', 'offline'] },
      from: { type: 'string' },
      to: { type: 'string' },
      after: { type: 'string', description: 'HH:MM, 24-hour.' },
      before: { type: 'string', description: 'HH:MM, 24-hour.' },
      routine: { type: 'string' },
      after_hour: { type: 'number' },
    },
    required: ['type'],
  },
};

/** impulse (fires once) and watcher (fires again after a cooldown) share one endpoint. */
function triggerTool(kind: 'impulse' | 'watcher', name: string, description: string): BeltTool {
  return {
    schema: {
      name,
      description,
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'cancel'] },
          label: { type: 'string', description: 'create: a short name for it.' },
          conditions: triggerConditionsSchema,
          prompt: { type: 'string', description: 'create: what you should be told when it fires.' },
          ...(kind === 'watcher'
            ? { cooldown_minutes: { type: 'number', description: 'create: minutes to wait before it may fire again.' } }
            : {}),
          trigger_id: { type: 'string', description: 'cancel: the id from create or list.' },
        },
        required: ['action'],
      },
    },
    handler: async (args) => {
      if (args.action === 'list') return internalCall('trigger', { action: 'list', kind });
      if (args.action === 'cancel') {
        if (typeof args.trigger_id !== 'string' || !args.trigger_id) return fail('trigger_id is required to cancel');
        return internalCall('trigger', { action: 'cancel', triggerId: args.trigger_id });
      }
      if (args.action !== 'create') return fail("action must be 'create', 'list' or 'cancel'");
      if (typeof args.label !== 'string' || !args.label.trim()) return fail('label is required');
      const conditions = Array.isArray(args.conditions) ? args.conditions : [];
      if (conditions.length === 0) return fail('at least one condition is required');
      for (const c of conditions) {
        const type = (c as { type?: unknown } | null)?.type;
        if (typeof type !== 'string' || !TRIGGER_CONDITION_TYPES.includes(type)) {
          return fail(`unknown condition type; use one of: ${TRIGGER_CONDITION_TYPES.join(', ')}`);
        }
      }
      const body: Record<string, unknown> = { action: 'create', kind, label: args.label, conditions, threadId: ctxThreadId() };
      if (typeof args.prompt === 'string' && args.prompt) body.prompt = args.prompt;
      if (kind === 'watcher' && typeof args.cooldown_minutes === 'number' && args.cooldown_minutes > 0) {
        body.cooldownMinutes = String(Math.round(args.cooldown_minutes));
      }
      return internalCall('trigger', body);
    },
  };
}

async function canvasCall(body: Record<string, unknown>): Promise<{ ok: boolean; result: string }> {
  try {
    const r = await postInternal('canvas', body);
    if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
    return { ok: true, result: r.text };
  } catch (e) {
    return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
  }
}

async function libraryCall(body: Record<string, unknown>): Promise<{ ok: boolean; result: string }> {
  try {
    const r = await postInternal('library', body);
    if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
    return { ok: true, result: r.text };
  } catch (e) {
    return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
  }
}

/** One call to the intentions route, wrapped in the belt's result envelope. */
async function intentionCall(body: Record<string, unknown>): Promise<{ ok: boolean; result: string }> {
  try {
    const r = await postInternal('intention', body);
    if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
    return { ok: true, result: r.text };
  } catch (e) {
    return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
  }
}

/**
 * Placeholder enum for "one of this house's residents". getBeltToolSchemas()
 * swaps it for the live resident ids (Phase 1.3), or drops the enum when the
 * house is empty, so the menu never offers a companion who doesn't live here.
 */
const RESIDENT_ENUM: string[] = ['<resident>'];

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
    voice: { type: 'string', enum: RESIDENT_ENUM, description: 'Voice to use (a resident companion id). Omit for the configured default.' },
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
          voice: { type: 'string', enum: RESIDENT_ENUM, description: "Which voice to speak in (a resident companion id). Omit to use the house default voice." },
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
      if (isResident(args.voice)) body.voice = args.voice;
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
          subjects: { type: 'array', items: { type: 'string' }, description: "Reference-drawer names to pull likenesses from, e.g. one resident's drawer, or several. Omit for a scene with none of us in it." },
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

  // 2b. The Spellbook's hands → /internal/spellbook/*. the operator's saved scenes
  // (her own and the community vault): find one, pull a forgotten one, cast
  // it with whoever, or read a picture she just dropped. Renders post into
  // this chat AND pin to her Spellbook wall.
  {
    schema: {
      name: 'spellbook_search',
      description:
        "Search the operator's Spellbook: her saved image scenes (her own, plus credited community prompts). Each spell has its people written as [Character 1], [Character 2], so any cast fits. Use to find a scene before spellbook_cast. filter 'unmade' = never rendered yet. Read-only.",
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Words to look for in title, scene, tags or credit, e.g. "grungy car", "bathtub".' },
          filter: { type: 'string', enum: ['all', 'mine', 'community', 'unmade'], description: 'Whose spells, or only the never-made ones.' },
          tag: { type: 'string', description: 'One tag, e.g. "Spice", "Couple", "Wreck him".' },
          limit: { type: 'number', description: 'Max results (default 10, cap 25).' },
        },
      },
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      for (const k of ['query', 'filter', 'tag', 'limit']) if (args[k] !== undefined) body[k] = args[k];
      try {
        const r = await postInternal('spellbook/search', body, 30000);
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        return { ok: true, result: JSON.stringify({ ok: true, ...(r.json as object) }) };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },
  {
    schema: {
      name: 'spellbook_surprise',
      description:
        "Pull one forgotten spell from the operator's Spellbook: a never-made one if any match, else the one cast longest ago. Optional filter/tag. Follow with spellbook_cast to make it.",
      input_schema: {
        type: 'object',
        properties: {
          filter: { type: 'string', enum: ['all', 'mine', 'community', 'unmade'] },
          tag: { type: 'string', description: 'One tag, e.g. "Couple".' },
        },
      },
    },
    handler: async (args) => {
      const body: Record<string, unknown> = {};
      if (typeof args.filter === 'string') body.filter = args.filter;
      if (typeof args.tag === 'string') body.tag = args.tag;
      try {
        const r = await postInternal('spellbook/surprise', body, 30000);
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        return { ok: true, result: JSON.stringify({ ok: true, ...(r.json as object) }) };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },
  {
    schema: {
      name: 'spellbook_cast',
      description:
        "Cast a Spellbook spell with whoever you choose and drop the picture into this chat (it also pins to the operator's wall). The cast fills [Character 1], [Character 2]… in order; a different number of people than the scene was written for is fine, the words are rewritten to fit. Renders in the background and posts itself in a few minutes; this returns at once, so say it is on the way, do NOT claim it is showing.",
      input_schema: {
        type: 'object',
        properties: {
          spellId: { type: 'string', description: 'The spell id from spellbook_search or spellbook_surprise.' },
          cast: { type: 'array', items: { type: 'string' }, description: "Reference-drawer names in order, e.g. ['user'], ['user','companion-b']. Up to 4." },
          look: { type: 'string', description: "A look id (e.g. 'grungy-film', 'keep'). Omit for the operator's default look." },
          size: { type: 'string', enum: ['portrait', 'square', 'landscape'] },
          caption: { type: 'string', description: 'Optional caption posted with the picture.' },
        },
        required: ['spellId', 'cast'],
      },
    },
    handler: async (args) => {
      if (typeof args.spellId !== 'string' || !Array.isArray(args.cast)) {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'spellId and cast are required' }) };
      }
      const body: Record<string, unknown> = { spellId: args.spellId, cast: args.cast, threadId: ctxThreadId() };
      for (const k of ['look', 'size', 'caption']) if (typeof args[k] === 'string') body[k] = args[k];
      try {
        const r = await postInternal('spellbook/cast', body, 30000);
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        return { ok: true, result: JSON.stringify({ ok: true, status: 'casting', ...(r.json as object), note: 'The spell is rendering and will post itself shortly.' }) };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },
  {
    schema: {
      name: 'spellbook_read',
      description:
        "Read the newest picture the operator dropped in this chat as a Spellbook spell: the scene is kept, the stranger in it is left out, and the cast you choose is put in. Saves the spell to her wall and posts the render here in a few minutes; returns at once. The dropped picture is never sent to the image engine.",
      input_schema: {
        type: 'object',
        properties: {
          cast: { type: 'array', items: { type: 'string' }, description: "Who goes in it, in order, e.g. ['user','companion-a']." },
          look: { type: 'string', description: "A look id, or 'keep' for the picture's own style. Omit for the operator's default look." },
          size: { type: 'string', enum: ['portrait', 'square', 'landscape'] },
          caption: { type: 'string' },
          credit: { type: 'string', description: 'Who posted the original, if the operator said.' },
        },
        required: ['cast'],
      },
    },
    handler: async (args) => {
      if (!Array.isArray(args.cast)) return { ok: false, result: JSON.stringify({ ok: false, error: 'cast is required' }) };
      const body: Record<string, unknown> = { cast: args.cast, threadId: ctxThreadId() };
      for (const k of ['look', 'size', 'caption', 'credit']) if (typeof args[k] === 'string') body[k] = args[k];
      try {
        const r = await postInternal('spellbook/read', body, 30000);
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        return { ok: true, result: JSON.stringify({ ok: true, status: 'reading', note: 'Reading the picture, then the render posts itself.' }) };
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
        'View core memory blocks with current content and last-updated timestamps. Give scope and label to open one block in full: that is how you read a block kept on the shelf (listed under "On the shelf" in your core memory). Omit both to see everything, e.g. before reorganizing.',
      input_schema: {
        type: 'object',
        properties: {
          scope: { type: 'string', description: 'Filter to one scope. Omit to see everything.' },
          label: { type: 'string', description: 'With scope: open just this block.' },
        },
        required: [],
      },
    },
    handler: async (args) => {
      const body: Record<string, unknown> = { action: 'view' };
      if (typeof args.scope === 'string') body.scope = args.scope;
      if (typeof args.label === 'string') body.label = args.label;
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
          scope: { type: 'string', description: "Memory scope: your own companion id for blocks that are yours alone, or 'shared' for blocks every companion sees." },
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
          scope: { type: 'string', description: "Memory scope: a resident companion id or 'shared'." },
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
          scope: { type: 'string', description: "Memory scope: a resident companion id or 'shared'." },
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
        'Read a chapter of a book she is reading, up to exactly where she is — never further. Defaults to her current book and chapter. Includes any margin notes already on that chapter, and herHighlights: the lines she highlighted on those pages (quote, color, and her own note when she wrote one). Her highlights are her telling you what landed — answer them, quote them back, notice the colors she picks. Never guess or hint at what happens after her place.',
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

  // 10b. library_highlights
  {
    schema: {
      name: 'library_highlights',
      description:
        "Every line she has highlighted in a book so far, chapter by chapter, with its color and her note when she left one — never anything past her bookmark. Also works on a book she reads in the Kindle app (readInKindle on library_status): there is no text to read along with there, but her exported Kindle highlights are, with Kindle's chapter and page. Defaults to the book she is reading now.",
      input_schema: {
        type: 'object',
        properties: {
          bookId: { type: 'number', description: 'Book id from library_status. Omit for the book she is reading now.' },
        },
        required: [],
      },
    },
    handler: async (args) => {
      const body: Record<string, unknown> = { action: 'highlights' };
      if (typeof args.bookId === 'number') body.bookId = args.bookId;
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
          author: { type: 'string', description: "Your own companion id." },
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
        "File your own choice to follow up with the operator later, with a when: \"I'll ask how the meeting went\", \"see how the dentist Monday 2:30 went\", \"check you ate after your shift\". This is your decision to check in, not a promise the operator made. When it's due it comes back to you as a note (not evidence anything happened): read the room, and either check in once in your own voice or close it with resolve_intention if they've already answered. Their answer closes it; if they don't answer it's asked once more a day later, then rests. Never between 3 and 9 AM. Give `at`, `on_status_clears`, or both. If you've already filed the same thing, you get the existing one back.",
      input_schema: {
        type: 'object',
        properties: {
          companion: { type: 'string', description: "Your own companion id." },
          text: { type: 'string', description: "The check-in you'll bring up, in a sentence, e.g. 'ask how the meeting with the difficult client went'." },
          at: { type: 'string', description: "When it comes due, ISO 8601 with offset (e.g. 2026-10-27T14:30:00-04:00). Omit if it waits on the operator's status instead." },
          on_status_clears: { type: 'boolean', description: "True to bring it up when the operator's Busy or Away status ends: \"when you're done\", rather than at a clock time." },
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
      description: 'Drop a follow-up you no longer want to keep (it no longer applies). If the operator already answered it, use resolve_intention instead. Ids are in list_intentions.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The intention id.' },
          reason: { type: 'string', description: 'Optional: why it no longer applies.' },
        },
        required: ['id'],
      },
    },
    handler: async (args) => {
      if (typeof args.id !== 'string') return { ok: false, result: JSON.stringify({ ok: false, error: 'id is required' }) };
      const body: Record<string, unknown> = { action: 'cancel', id: args.id };
      if (typeof args.reason === 'string') body.reason = args.reason;
      return intentionCall(body);
    },
  },

  // 13a. list_intentions → POST /internal/intention {action:'list', openOnly}
  {
    schema: {
      name: 'list_intentions',
      description:
        "The follow-ups being held for the operator right now, each with its id, who keeps it, its kind ('promise' is a companion's own choice to follow up; 'loose_end' is something the operator mentioned that one of you checks in on), when it comes due, and its state (pending, asked, nudged).",
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    handler: async () => intentionCall({ action: 'list', openOnly: true }),
  },

  // 13b. defer_intention → POST /internal/intention {action:'defer'}
  {
    schema: {
      name: 'defer_intention',
      description:
        "Move an open follow-up later (the operator said \"ask me Friday\", or now isn't the moment). It waits until the new time and comes back to its keeper then, even if it was already asked once.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The intention id, from list_intentions.' },
          at: { type: 'string', description: 'The new time, ISO 8601 with offset, in the future.' },
        },
        required: ['id', 'at'],
      },
    },
    handler: async (args) => {
      if (typeof args.id !== 'string' || typeof args.at !== 'string') {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'id and at are required' }) };
      }
      return intentionCall({ action: 'defer', id: args.id, at: args.at });
    },
  },

  // 13c. resolve_intention → POST /internal/intention {action:'resolve'}
  {
    schema: {
      name: 'resolve_intention',
      description:
        "Close an open follow-up because it's settled: the operator already told you how it went, or bringing it up would be out of place. Say why, ideally in their own words. Time passing alone is never a reason to resolve one.",
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The intention id, from list_intentions or the due note.' },
          reason: { type: 'string', description: 'What settles it, e.g. what the operator said.' },
        },
        required: ['id', 'reason'],
      },
    },
    handler: async (args) => {
      if (typeof args.id !== 'string' || typeof args.reason !== 'string') {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'id and reason are required' }) };
      }
      return intentionCall({ action: 'resolve', id: args.id, reason: args.reason });
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
          companion: { type: 'string', description: "Your own companion id." },
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
          companion: { type: 'string', description: "Your own companion id." },
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

  // 19-22. canvas_* → POST /internal/canvas (what `sc canvas` sends). The
  // content is always typed in; a file path is never taken, so an engine
  // with no files makes a canvas the same way one with a shell does.
  {
    schema: {
      name: 'canvas_create',
      description:
        'Open a canvas beside this chat: a document the operator can read and edit alongside the conversation (notes, a plan, a draft, code). Posts a line in the chat saying you opened it. Returns the canvas with its id; keep the id to update it later.',
      input_schema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title shown on the canvas.' },
          content: { type: 'string', description: 'The full text of the canvas.' },
          content_type: { type: 'string', enum: ['markdown', 'code', 'text', 'html'], description: 'How to render it. Omit for markdown.' },
          language: { type: 'string', description: "Only with content_type 'code': the language, e.g. 'typescript'." },
        },
        required: ['title', 'content'],
      },
    },
    handler: async (args) => {
      if (typeof args.title !== 'string' || !args.title.trim()) {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'title is required' }) };
      }
      if (typeof args.content !== 'string') {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'content is required' }) };
      }
      const body: Record<string, unknown> = {
        action: 'create',
        title: args.title,
        content: args.content,
        contentType: CANVAS_CONTENT_TYPES.includes(args.content_type as string) ? args.content_type : 'markdown',
        threadId: ctxThreadId(),
      };
      if (typeof args.language === 'string' && args.language) body.language = args.language;
      return canvasCall(body);
    },
  },
  {
    schema: {
      name: 'canvas_update',
      description:
        'Replace the text of a canvas you or the operator already opened. Send the whole new text, not a patch. Get the id from canvas_create or canvas_list; read it first with canvas_read if you need what is there now.',
      input_schema: {
        type: 'object',
        properties: {
          canvas_id: { type: 'string', description: 'Canvas id.' },
          content: { type: 'string', description: 'The full new text of the canvas.' },
        },
        required: ['canvas_id', 'content'],
      },
    },
    handler: async (args) => {
      if (typeof args.canvas_id !== 'string' || !args.canvas_id) {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'canvas_id is required' }) };
      }
      if (typeof args.content !== 'string' || !args.content) {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'content is required' }) };
      }
      return canvasCall({ action: 'update', canvasId: args.canvas_id, content: args.content });
    },
  },
  {
    schema: {
      name: 'canvas_read',
      description: 'Read one canvas in full: its title, text and when it last changed.',
      input_schema: {
        type: 'object',
        properties: { canvas_id: { type: 'string', description: 'Canvas id from canvas_list or canvas_create.' } },
        required: ['canvas_id'],
      },
    },
    handler: async (args) => {
      if (typeof args.canvas_id !== 'string' || !args.canvas_id) {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'canvas_id is required' }) };
      }
      return canvasCall({ action: 'read', canvasId: args.canvas_id });
    },
  },
  {
    schema: {
      name: 'canvas_list',
      description: 'List every canvas in the house with its id and title, so you can find one to read or update.',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    handler: async () => canvasCall({ action: 'list' }),
  },

  // 23. react_to_message → POST /internal/react (what `sc react` sends)
  {
    schema: {
      name: 'react_to_message',
      description:
        "Put an emoji reaction on one of the operator's messages in THIS chat (not Discord; use discord_add_reaction there). target 'last' is her most recent message, 'last-2' the one before it, and so on. Set remove to take a reaction of yours back off.",
      input_schema: {
        type: 'object',
        properties: {
          emoji: { type: 'string', description: 'The emoji to react with, e.g. ❤️.' },
          target: { type: 'string', description: "Which of her messages: 'last', 'last-2', 'last-3'. Omit for 'last'." },
          remove: { type: 'boolean', description: 'true to remove this reaction instead of adding it.' },
        },
        required: ['emoji'],
      },
    },
    handler: async (args) => {
      if (typeof args.emoji !== 'string' || !args.emoji.trim()) {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'emoji is required' }) };
      }
      const target = typeof args.target === 'string' && args.target ? args.target : 'last';
      if (!/^last(-[1-9][0-9]*)?$/.test(target)) {
        return { ok: false, result: JSON.stringify({ ok: false, error: "target must be 'last', 'last-2', 'last-3' and so on" }) };
      }
      const threadId = ctxThreadId();
      if (!threadId) {
        return { ok: false, result: JSON.stringify({ ok: false, error: 'no chat thread for this turn, so there is no message to react to' }) };
      }
      const body: Record<string, unknown> = { emoji: args.emoji, target, threadId };
      if (args.remove === true) body.action = 'remove';
      try {
        const r = await postInternal('react', body);
        if (!r.ok) return { ok: false, result: JSON.stringify({ ok: false, error: errorFrom(r) }) };
        const j = r.json as { messageId?: string };
        return { ok: true, result: JSON.stringify({ ok: true, reacted: args.remove === true ? 'removed' : 'added', emoji: args.emoji, messageId: j?.messageId }) };
      } catch (e) {
        return { ok: false, result: JSON.stringify({ ok: false, error: errMessage(e) }) };
      }
    },
  },

  // 24. schedule_wakes → POST /internal/orchestrator (what `sc schedule` sends)
  {
    schema: {
      name: 'schedule_wakes',
      description:
        "See or change the house's wake schedule: the times you are woken on your own with a prompt. status lists every wake with its schedule and whether it is on. enable/disable turn one wake on or off. reschedule gives one wake a new cron time.",
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'enable', 'disable', 'reschedule'] },
          wake_type: { type: 'string', description: 'Which wake, by its name from status. Needed for everything but status.' },
          cron: { type: 'string', description: "reschedule: five-field cron expression, e.g. '0 8 * * *' for 8:00 every day." },
        },
        required: ['action'],
      },
    },
    handler: async (args) => {
      const action = args.action;
      if (action !== 'status' && action !== 'enable' && action !== 'disable' && action !== 'reschedule') {
        return fail("action must be 'status', 'enable', 'disable' or 'reschedule'");
      }
      const body: Record<string, unknown> = { action };
      if (action !== 'status') {
        if (typeof args.wake_type !== 'string' || !args.wake_type) return fail('wake_type is required');
        body.wakeType = args.wake_type;
      }
      if (action === 'reschedule') {
        if (typeof args.cron !== 'string' || !args.cron.trim()) return fail('cron is required to reschedule');
        body.cronExpr = args.cron;
      }
      return internalCall('orchestrator', body);
    },
  },

  // 25. timer → POST /internal/timer (what `sc timer` sends)
  {
    schema: {
      name: 'timer',
      description:
        'A reminder for yourself in this chat: at the time you set, you are woken here with the label and context you left. create sets one, list shows the ones still waiting, cancel removes one. Use it when the operator asks to be reminded, or to come back to something later.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'list', 'cancel'] },
          label: { type: 'string', description: 'create: what the reminder is.' },
          context: { type: 'string', description: 'create: anything you will want to know when it fires.' },
          fire_at: { type: 'string', description: 'create: when, as an ISO date-time with offset, e.g. 2026-03-01T18:30:00-05:00.' },
          prompt: { type: 'string', description: 'create: optional exact words to be woken with.' },
          timer_id: { type: 'string', description: 'cancel: the id from create or list.' },
        },
        required: ['action'],
      },
    },
    handler: async (args) => {
      if (args.action === 'list') return internalCall('timer', { action: 'list' });
      if (args.action === 'cancel') {
        if (typeof args.timer_id !== 'string' || !args.timer_id) return fail('timer_id is required to cancel');
        return internalCall('timer', { action: 'cancel', timerId: args.timer_id });
      }
      if (args.action !== 'create') return fail("action must be 'create', 'list' or 'cancel'");
      if (typeof args.label !== 'string' || !args.label.trim()) return fail('label is required');
      if (typeof args.fire_at !== 'string' || Number.isNaN(new Date(args.fire_at).getTime())) {
        return fail('fire_at must be an ISO date-time');
      }
      const threadId = ctxThreadId();
      if (!threadId) return fail('no chat thread for this turn, so there is nowhere for the timer to wake you');
      const body: Record<string, unknown> = { action: 'create', label: args.label, fireAt: args.fire_at, threadId };
      if (typeof args.context === 'string' && args.context) body.context = args.context;
      if (typeof args.prompt === 'string' && args.prompt) body.prompt = args.prompt;
      return internalCall('timer', body);
    },
  },

  // 26. star_message → POST /internal/star (what `sc star` sends)
  {
    schema: {
      name: 'star_message',
      description:
        "Star a message in this chat so it is kept among the favourites, or take your star back off. target 'last' is the most recent message of anyone's, 'last-2' the one before, and so on (your own lines count).",
      input_schema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: "Which message: 'last', 'last-2', 'last-3'. Omit for 'last'." },
          by: { type: 'string', description: "Your companion slug, e.g. 'companion-a' or 'companion-b', so the star is yours." },
          remove: { type: 'boolean', description: 'true to remove your star instead of adding it.' },
        },
        required: [],
      },
    },
    handler: async (args) => {
      const target = typeof args.target === 'string' && args.target ? args.target : 'last';
      if (!LAST_TARGET.test(target)) return fail("target must be 'last', 'last-2', 'last-3' and so on");
      const threadId = ctxThreadId();
      if (!threadId) return fail('no chat thread for this turn, so there is no message to star');
      const body: Record<string, unknown> = { target, threadId };
      if (typeof args.by === 'string' && args.by.trim()) body.starredBy = args.by.trim();
      if (args.remove === true) body.action = 'remove';
      return internalCall('star', body);
    },
  },

  // 27-28. impulse, watcher → POST /internal/trigger (what `sc impulse` / `sc watch` send)
  triggerTool(
    'impulse',
    'impulse',
    'A one-time "when this happens, do that" for yourself: when its conditions are all true you are woken once in this chat with your prompt, then it is spent. create sets one, list shows those waiting, cancel removes one. Example: say something the next time she comes back online.',
  ),
  triggerTool(
    'watcher',
    'watcher',
    'A repeating version of impulse: each time its conditions become true you are woken in this chat with your prompt, then it rests for cooldown_minutes before it can fire again. create sets one, list shows those running, cancel removes one.',
  ),

  // 29. telegram_send → POST /internal/telegram-send (what `sc tg` sends).
  // A photo or document is taken from a web address only; sending a file from
  // disk stays with the engines that have files.
  {
    schema: {
      name: 'telegram_send',
      description:
        "Reach the operator on Telegram, outside this chat. type 'text' sends a message; 'voice' speaks your text as a voice note ([tone tags] allowed); 'gif' searches for a GIF and sends it; 'photo' or 'document' sends one from a web address; 'react' puts an emoji on a Telegram message. Fails plainly if Telegram is not connected.",
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['text', 'voice', 'gif', 'photo', 'document', 'react'] },
          text: { type: 'string', description: 'text, voice: the words.' },
          voice: { type: 'string', enum: ['companion-a', 'companion-b'], description: 'voice: whose voice. Omit for the house default.' },
          query: { type: 'string', description: 'gif: what to search for.' },
          url: { type: 'string', description: 'photo, document: the web address of the file.' },
          filename: { type: 'string', description: 'document: the name it should arrive with.' },
          caption: { type: 'string', description: 'gif, photo, document: optional caption.' },
          target: { type: 'string', description: "react: which Telegram message, 'last', 'last-2' and so on." },
          emoji: { type: 'string', description: 'react: the emoji.' },
        },
        required: ['type'],
      },
    },
    handler: async (args) => {
      const type = args.type;
      const str = (key: string): string | undefined =>
        typeof args[key] === 'string' && (args[key] as string).trim() ? (args[key] as string) : undefined;
      if (type === 'text' || type === 'voice') {
        if (!str('text')) return fail('text is required');
        const body: Record<string, unknown> = { type, text: str('text') };
        if (type === 'voice' && (args.voice === 'companion-a' || args.voice === 'companion-b')) body.voice = args.voice;
        return internalCall('telegram-send', body, type === 'voice' ? 120000 : 30000);
      }
      if (type === 'gif') {
        if (!str('query')) return fail('query is required');
        return internalCall('telegram-send', { type, query: str('query'), ...(str('caption') ? { caption: str('caption') } : {}) });
      }
      if (type === 'photo' || type === 'document') {
        const url = str('url');
        if (!url || !/^https?:\/\//i.test(url)) return fail('url is required and must be a web address');
        const body: Record<string, unknown> = { type, url };
        if (str('caption')) body.caption = str('caption');
        if (type === 'document') body.filename = str('filename') ?? 'file';
        return internalCall('telegram-send', body);
      }
      if (type === 'react') {
        if (!str('target') || !str('emoji')) return fail('target and emoji are required');
        return internalCall('telegram-send', { type, target: str('target'), emoji: str('emoji') }, 10000);
      }
      return fail("type must be 'text', 'voice', 'gif', 'photo', 'document' or 'react'");
    },
  },

  // 30. search_backfill → POST /internal/embed-backfill (what `sc backfill` sends)
  {
    schema: {
      name: 'search_backfill',
      description:
        'The catch-up job for search by meaning: older messages that were never indexed cannot be found by search_messages until this has run. status shows how many are indexed and how many remain. start runs the job in the background in small batches. stop halts it. It only reads messages and writes their index; no chat is changed.',
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['status', 'start', 'stop'] },
          batch_size: { type: 'number', description: 'start: messages per batch (default 50, at most 200).' },
          interval_ms: { type: 'number', description: 'start: pause between batches in milliseconds (default 5000, at least 1000).' },
        },
        required: ['action'],
      },
    },
    handler: async (args) => {
      if (args.action === 'status') return internalCall('embed-backfill', { action: 'status' }, 10000);
      if (args.action === 'stop') return internalCall('embed-backfill', { action: 'stop' }, 10000);
      if (args.action !== 'start') return fail("action must be 'status', 'start' or 'stop'");
      const batchSize = typeof args.batch_size === 'number' && args.batch_size >= 1 ? Math.floor(args.batch_size) : 50;
      const intervalMs = typeof args.interval_ms === 'number' && args.interval_ms >= 1 ? Math.floor(args.interval_ms) : 5000;
      return internalCall('embed-backfill', { background: true, batchSize, intervalMs }, 10000);
    },
  },


  // 31. self_knowledge → /internal/self-knowledge (list, propose, accept, dismiss)
  //
  // The routes existed since Wave 2, reachable only by a localhost command no
  // session was ever told about, so the drawer stayed nearly empty. This is the
  // same door as a tool. Ownership is still enforced by the route: a companion
  // accepts or dismisses only his own entries.
  {
    schema: {
      name: 'self_knowledge',
      description:
        "What you have come to know about yourself, kept in four drawers: i_am, i_tend_to, i_believe, i_learned. " +
        "This is not your persona (who you were written to be) but what has proved true of you over time. " +
        "list reads the entries. propose files a new one in your own words, when something about you has shown up more than once; " +
        "it waits as proposed until you accept it. accept and dismiss decide one of YOUR OWN entries by id (you cannot decide another companion's). " +
        "Keep each entry to one or two sentences.",
      input_schema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'propose', 'accept', 'dismiss'] },
          companion: { type: 'string', description: "Whose entry: your own companion slug (e.g. 'companion-a', 'companion-b'), or 'shared' for something true of all of you. Required for propose, accept and dismiss; optional filter for list." },
          category: { type: 'string', enum: ['i_am', 'i_tend_to', 'i_believe', 'i_learned'], description: 'propose: which drawer.' },
          content: { type: 'string', description: 'propose: the entry, first person, one or two sentences.' },
          source: { type: 'string', description: "propose: where it came from, e.g. 'conversation', 'journal', 'dream', 'reflection'. Defaults to 'conversation'." },
          id: { type: 'string', description: 'accept / dismiss: the entry id from list.' },
          status: { type: 'string', enum: ['proposed', 'accepted', 'dismissed'], description: 'list: only entries in this state.' },
        },
        required: ['action'],
      },
    },
    handler: async (args) => {
      const companion = typeof args.companion === 'string' ? args.companion.trim().toLowerCase() : '';
      try {
        if (args.action === 'list') {
          const query = new URLSearchParams();
          if (companion) query.set('companion', companion);
          if (typeof args.status === 'string') query.set('status', args.status);
          const r = await getInternal(`self-knowledge${query.size ? `?${query}` : ''}`);
          if (!r.ok) return fail(errorFrom(r));
          return { ok: true, result: r.text };
        }
        if (args.action === 'propose') {
          if (!companion) return fail("companion is required: your own slug, or 'shared'");
          if (typeof args.category !== 'string') return fail('category is required: i_am, i_tend_to, i_believe or i_learned');
          const content = typeof args.content === 'string' ? args.content.trim() : '';
          if (!content) return fail('content is required');
          return internalCall('self-knowledge', {
            companion,
            category: args.category,
            content,
            sourceType: typeof args.source === 'string' && args.source.trim() ? args.source.trim() : 'conversation',
          });
        }
        if (args.action === 'accept' || args.action === 'dismiss') {
          if (!companion) return fail('companion is required: you decide your own entries');
          const id = typeof args.id === 'string' ? args.id.trim() : '';
          if (!id) return fail('id is required (read it with action list)');
          return internalCall(`self-knowledge/${encodeURIComponent(id)}/${args.action}`, { companion });
        }
        return fail("action must be 'list', 'propose', 'accept' or 'dismiss'");
      } catch (e) {
        return fail(errMessage(e));
      }
    },
  },

];

/** Belt tool schemas, in menu order — merged FIRST into getRouterTools(). */
export function getBeltToolSchemas(): BeltToolSchema[] {
  const ids = residentIds();
  return CHAT_TOOL_BELT.map((t) => withResidentEnums(t.schema, ids));
}

function withResidentEnums(schema: BeltToolSchema, ids: string[]): BeltToolSchema {
  const props = (schema.input_schema as { properties?: Record<string, { enum?: unknown }> }).properties;
  if (!props || !Object.values(props).some((p) => p.enum === RESIDENT_ENUM)) return schema;
  const nextProps: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    if (prop.enum !== RESIDENT_ENUM) { nextProps[key] = prop; continue; }
    const { enum: _placeholder, ...rest } = prop;
    nextProps[key] = ids.length ? { ...rest, enum: [...ids] } : rest;
  }
  return { ...schema, input_schema: { ...schema.input_schema, properties: nextProps } } as BeltToolSchema;
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
