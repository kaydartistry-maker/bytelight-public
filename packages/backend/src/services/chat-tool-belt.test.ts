/**
 * chat-tool belt (H2 "hands") — unit tests.
 *
 * Run with:
 *   npx tsx --test packages/backend/src/services/chat-tool-belt.test.ts
 *
 * Covers: tool-list merge order (belt first), belt-wins-collision (belt
 * routes before MCP), executor error envelope, and thread-context
 * isolation (two concurrent turn contexts don't bleed — the load-bearing
 * correctness proof for the AsyncLocalStorage-through-async-generator
 * mechanism agent.ts uses). All HTTP is mocked — no live endpoints hit.
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_TOOL_BELT,
  getBeltToolSchemas,
  isBeltTool,
  executeBeltTool,
  runWithBeltContext,
  getBeltContext,
} from './chat-tool-belt.js';
import { getRouterTools, executeRouterTool } from './mcp-bridge.js';
import { initDb, addMcpServer, updateMcpServerToolsCache, deleteMcpServer } from './db.js';

const BELT_NAMES = [
  'discord_send', 'discord_send_image', 'discord_send_sticker', 'discord_send_voice',
  'discord_add_reaction', 'discord_edit_message', 'discord_delete_message',
  'discord_read_messages', 'discord_search_messages', 'discord_typing',
  'discord_get_server_info', 'discord_list_servers', 'discord_list_emojis', 'discord_list_stickers',
  'send_voice_note', 'generate_image', 'search_messages', 'search_web',
  'core_memory_view', 'core_memory_append', 'core_memory_replace', 'core_memory_rethink',
  'library_status', 'library_read', 'library_note',
  'set_intention', 'cancel_intention', 'set_status',
  'battleship_fire',
];

// ── fetch mock ───────────────────────────────────────────────────────
type FetchCall = { url: string; body: unknown };
let fetchCalls: FetchCall[] = [];
let fetchImpl: (url: string, init: { body?: string }) => { ok: boolean; status: number; text: string };
const realFetch = globalThis.fetch;

function installFetchMock(): void {
  fetchCalls = [];
  // Default: every internal POST succeeds with an empty JSON object.
  fetchImpl = () => ({ ok: true, status: 200, text: '{}' });
  (globalThis as { fetch: unknown }).fetch = async (url: string, init: { body?: string }) => {
    fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = fetchImpl(url, init);
    return { ok: r.ok, status: r.status, text: async () => r.text } as unknown as Response;
  };
}
function restoreFetch(): void {
  (globalThis as { fetch: unknown }).fetch = realFetch;
}

before(() => {
  // In-memory DB so mcp-bridge's DB reads (listMcpServers) work without
  // touching the real database.
  initDb(':memory:');
});

describe('belt schemas', () => {
  it('exposes exactly the belt tools, in menu order', () => {
    assert.deepEqual(getBeltToolSchemas().map((s) => s.name), BELT_NAMES);
  });

  it('includes search_web (the external-API belt tool)', () => {
    assert.ok(isBeltTool('search_web'));
    assert.ok(getBeltToolSchemas().some((s) => s.name === 'search_web'));
  });

  it('every belt tool has a description and an object input_schema', () => {
    for (const t of CHAT_TOOL_BELT) {
      assert.ok(t.schema.description.length > 10, `${t.schema.name} needs a real description`);
      assert.equal((t.schema.input_schema as { type?: string }).type, 'object');
    }
  });

  it('isBeltTool recognizes belt names and rejects others', () => {
    assert.ok(isBeltTool('send_voice_note'));
    assert.ok(!isBeltTool('some_mcp_tool'));
  });
});

describe('getRouterTools merge order', () => {
  it('lists the belt tools FIRST, in order', async () => {
    const tools = await getRouterTools();
    assert.deepEqual(tools.slice(0, BELT_NAMES.length).map((t) => t.name), BELT_NAMES);
  });
});

describe('tool-name collision quarantine', () => {
  let serverId: number;

  beforeEach(() => {
    installFetchMock();
    // A managed MCP server that ALSO exposes a `search_messages` tool. Seed it
    // via the DB tools-cache path (fresh last_discovered) so loadManagedServers
    // reads it without any network discovery.
    const row = addMcpServer('collide', 'http://mcp.invalid/');
    serverId = row.id;
    updateMcpServerToolsCache(
      serverId,
      JSON.stringify([{ name: 'search_messages', description: 'MCP impostor', inputSchema: { type: 'object' }, transport: 'streamable' }]),
      new Date().toISOString(),
    );
  });
  afterEach(() => {
    deleteMcpServer(serverId);
    restoreFetch();
  });

  it('refuses to advertise an ambiguous tool catalog and names both owners', async () => {
    await assert.rejects(
      getRouterTools(),
      /Duplicate MCP tool name "search_messages" from native belt and managed:collide/,
    );
  });

  it('keeps belt-first execution as defense in depth when called directly', async () => {
    fetchImpl = () => ({ ok: true, status: 200, text: JSON.stringify({ results: [] }) });
    const res = await executeRouterTool('search_messages', { query: 'the beach day' });
    assert.ok(res.ok);
    // Belt path made exactly one localhost /internal/search-semantic POST...
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /\/api\/internal\/search-semantic$/);
    // ...and the MCP path (mcp.invalid) was never touched.
    assert.ok(!fetchCalls.some((c) => c.url.includes('mcp.invalid')));
  });
});

describe('executor error envelope', () => {
  beforeEach(() => installFetchMock());
  afterEach(() => restoreFetch());

  it('executeBeltTool returns null for a non-belt name (falls through to MCP)', async () => {
    assert.equal(await executeBeltTool('not_a_belt_tool', {}), null);
  });

  it('executeRouterTool returns the unknown-tool envelope for an unknown name', async () => {
    const res = await executeRouterTool('totally_unknown', {});
    assert.equal(res.ok, false);
    assert.match(res.result, /Unknown tool/);
  });

  it('a belt handler returns an error envelope (never throws) on bad args', async () => {
    const res = await executeBeltTool('send_voice_note', {}); // missing text
    assert.ok(res);
    assert.equal(res!.ok, false);
    assert.match(res!.result, /text is required/);
    assert.equal(fetchCalls.length, 0, 'bad args should short-circuit before any HTTP');
  });

  it('a belt handler returns an error envelope (never throws) when fetch throws', async () => {
    fetchImpl = () => { throw new Error('econnrefused'); };
    const res = await executeBeltTool('generate_image', { prompt: 'a cat' });
    assert.ok(res);
    assert.equal(res!.ok, false);
    assert.match(res!.result, /econnrefused/);
  });

  it('a belt handler surfaces a non-2xx endpoint error in the envelope', async () => {
    fetchImpl = () => ({ ok: false, status: 503, text: JSON.stringify({ error: 'voice_unavailable', detail: 'no key' }) });
    const res = await executeBeltTool('send_voice_note', { text: 'hi' });
    assert.ok(res);
    assert.equal(res!.ok, false);
    assert.match(res!.result, /voice_unavailable: no key/);
  });
});

describe('search_web (external-API belt tool)', () => {
  const savedKey = process.env.TAVILY_API_KEY;
  beforeEach(() => installFetchMock());
  afterEach(() => {
    restoreFetch();
    if (savedKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = savedKey;
  });

  it('returns the clean unconfigured error (and never fetches) when TAVILY_API_KEY is unset', async () => {
    delete process.env.TAVILY_API_KEY;
    const res = await executeBeltTool('search_web', { query: 'latest news' });
    assert.ok(res);
    assert.equal(res!.ok, false);
    assert.match(res!.result, /TAVILY_API_KEY unset/);
    assert.equal(fetchCalls.length, 0, 'unconfigured key must short-circuit before any HTTP');
  });

  it('hits Tavily (not localhost), clamps max_results to 10, defaults depth basic, requests answer', async () => {
    process.env.TAVILY_API_KEY = 'tvly-test';
    fetchImpl = () => ({ ok: true, status: 200, text: JSON.stringify({ answer: 'an answer', results: [] }) });
    const res = await executeBeltTool('search_web', { query: 'weather', max_results: 999 });
    assert.ok(res!.ok);
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /^https:\/\/api\.tavily\.com\/search$/);
    const body = fetchCalls[0].body as { search_depth: string; max_results: number; include_answer: boolean };
    assert.equal(body.search_depth, 'basic');
    assert.equal(body.max_results, 10);
    assert.equal(body.include_answer, true);
  });
});

describe('thread-context injection', () => {
  beforeEach(() => installFetchMock());
  afterEach(() => restoreFetch());

  it('injects the turn threadId into thread-bound endpoints (tts/image)', async () => {
    await runWithBeltContext({ threadId: 'thread-42' }, async () => {
      await executeBeltTool('send_voice_note', { text: 'hey' });
      await executeBeltTool('generate_image', { prompt: 'a cat' });
    });
    assert.equal(fetchCalls.length, 2);
    for (const c of fetchCalls) {
      assert.equal((c.body as { threadId?: string }).threadId, 'thread-42');
    }
  });

  it('does NOT inject threadId into search (search defaults to all history)', async () => {
    await runWithBeltContext({ threadId: 'thread-42' }, async () => {
      fetchImpl = () => ({ ok: true, status: 200, text: JSON.stringify({ results: [] }) });
      await executeBeltTool('search_messages', { query: 'when did we talk about the beach' });
    });
    assert.equal(fetchCalls.length, 1);
    assert.equal((fetchCalls[0].body as { threadId?: string }).threadId, undefined);
  });

  it('omits threadId when no turn context is entered (endpoint falls back)', async () => {
    await executeBeltTool('send_voice_note', { text: 'hey' });
    assert.equal((fetchCalls[0].body as { threadId?: string }).threadId, undefined);
  });
});

describe('thread-context isolation (concurrent turns)', () => {
  // Mirrors agent.ts: each foreign turn enters runWithBeltContext around an
  // async-generator (runTurn) consumption. A belt tool called between yields
  // must see ITS turn's threadId, even when a second turn runs concurrently.
  async function* fakeRunTurn(steps: number): AsyncGenerator<number> {
    for (let i = 0; i < steps; i++) {
      // Force an await hop (like a real streamed provider turn).
      await new Promise((r) => setTimeout(r, 1));
      yield i;
    }
  }

  async function runTurnScope(threadId: string, sink: string[]): Promise<void> {
    await runWithBeltContext({ threadId }, async () => {
      for await (const _ of fakeRunTurn(5)) {
        // Read context the way the belt handler does, mid-iteration.
        sink.push(getBeltContext()?.threadId ?? '<none>');
        await new Promise((r) => setTimeout(r, 1));
      }
    });
  }

  it('two interleaved turns each see only their own threadId', async () => {
    const a: string[] = [];
    const b: string[] = [];
    await Promise.all([runTurnScope('AAA', a), runTurnScope('BBB', b)]);
    assert.deepEqual(a, ['AAA', 'AAA', 'AAA', 'AAA', 'AAA']);
    assert.deepEqual(b, ['BBB', 'BBB', 'BBB', 'BBB', 'BBB']);
  });

  it('context is empty again after the scope exits', async () => {
    await runWithBeltContext({ threadId: 'X' }, async () => {
      assert.equal(getBeltContext()?.threadId, 'X');
    });
    assert.equal(getBeltContext(), undefined);
  });
});

describe('games and places', () => {
  beforeEach(() => installFetchMock());
  afterEach(() => restoreFetch());

  it('battleship_fire posts one shot to the sealed fire route', async () => {
    const res = await executeBeltTool('battleship_fire', { gameId: 'g1', companion: 'companion-a', coordinate: 'C5' });
    assert.equal(res?.ok, true);
    assert.match(fetchCalls[0].url, /\/api\/internal\/games\/battleship\/fire$/);
    assert.deepEqual(fetchCalls[0].body, { gameId: 'g1', companion: 'companion-a', coordinate: 'C5' });
  });

});
