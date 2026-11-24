import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createBeltMcpRouter, type BeltMcpRouter } from './mcp-belt.js';

const TOKEN = 'test-house-token';
const servers: HttpServer[] = [];
const belts: BeltMcpRouter[] = [];

afterEach(async () => {
  await Promise.allSettled(belts.splice(0).map((belt) => belt.closeAll()));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startBelt(overrides: Parameters<typeof createBeltMcpRouter>[0] = {}) {
  const belt = createBeltMcpRouter({ expectedToken: () => TOKEN, ...overrides });
  belts.push(belt);
  const app = express();
  app.use(express.json());
  app.use('/mcp/belt', belt.router);
  const http = createServer(app);
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address() as AddressInfo;
  return { belt, url: new URL(`http://127.0.0.1:${address.port}/mcp/belt`) };
}

async function connect(url: URL) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  const client = new Client({ name: 'bytelight-mcp-test', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

describe('official MCP belt transport', () => {
  it('completes initialize + initialized, lists tools, calls tools, and tears down', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const { belt, url } = await startBelt({
      getTools: async () => [{
        name: 'echo',
        description: 'Echo a value',
        input_schema: { type: 'object', properties: { value: { type: 'string' } } },
      }],
      executeTool: async (name, args) => {
        calls.push({ name, args });
        return { ok: true, result: String(args.value) };
      },
      activeThread: () => 'thread-1',
    });

    const { client, transport } = await connect(url);
    assert.equal(belt.sessionCount(), 1);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['echo']);
    const result = await client.callTool({ name: 'echo', arguments: { value: 'hello' } });
    assert.deepEqual(calls, [{ name: 'echo', args: { value: 'hello' } }]);
    assert.equal((result.content as Array<{ text: string }>)[0].text, 'hello');

    await transport.terminateSession();
    assert.equal(belt.sessionCount(), 0);
    await client.close();
  });

  it('isolates simultaneous MCP sessions', async () => {
    const { belt, url } = await startBelt({ getTools: async () => [] });
    const one = await connect(url);
    const two = await connect(url);
    assert.equal(belt.sessionCount(), 2);
    await one.transport.terminateSession();
    assert.equal(belt.sessionCount(), 1);
    await two.transport.terminateSession();
    assert.equal(belt.sessionCount(), 0);
    await Promise.all([one.client.close(), two.client.close()]);
  });

  it('reaps abandoned sessions that never send DELETE', async () => {
    const { belt, url } = await startBelt({
      getTools: async () => [],
      sessionIdleMs: 25,
      sweepIntervalMs: 10,
    });
    const { client } = await connect(url);
    assert.equal(belt.sessionCount(), 1);
    await client.close();
    // Wait for the sweep rather than a fixed 80ms: under a full parallel test
    // run the 10ms sweep timer can fire late, and the fixed wait lost the race.
    const deadline = Date.now() + 2000;
    while (belt.sessionCount() > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(belt.sessionCount(), 0);
  });

  it('contains tool failures without closing the MCP session', async () => {
    const { belt, url } = await startBelt({
      getTools: async () => [{ name: 'broken', description: '', input_schema: { type: 'object' } }],
      executeTool: async () => { throw new Error('upstream unavailable'); },
    });
    const { client, transport } = await connect(url);
    const failed = await client.callTool({ name: 'broken', arguments: {} });
    assert.equal(failed.isError, true);
    assert.match((failed.content as Array<{ text: string }>)[0].text, /upstream unavailable/);
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), ['broken']);
    assert.equal(belt.sessionCount(), 1);
    await transport.terminateSession();
    await client.close();
  });

  it('refuses unauthenticated clients and thread-bound calls without an app turn', async () => {
    let executed = false;
    const { url } = await startBelt({
      getTools: async () => [{ name: 'send_voice_note', description: '', input_schema: { type: 'object' } }],
      executeTool: async () => { executed = true; return { ok: true, result: 'sent' }; },
      activeThread: () => null,
    });

    const unauthorized = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(unauthorized.status, 401);

    const { client, transport } = await connect(url);
    const refused = await client.callTool({ name: 'send_voice_note', arguments: {} });
    assert.equal(refused.isError, true);
    assert.match((refused.content as Array<{ text: string }>)[0].text, /requires an active byte-light Codex turn/);
    assert.equal(executed, false);
    await transport.terminateSession();
    await client.close();
  });
});

describe('a Claude CLI lane on the house kit', () => {
  async function connectAsLane(url: URL, laneKey: string) {
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}`, 'X-Bytelight-Lane': laneKey } },
    });
    const client = new Client({ name: 'bytelight-lane-test', version: '1.0.0' });
    await client.connect(transport);
    return { client, transport };
  }

  const kit = [
    { name: 'send_voice_note', description: 'voice', input_schema: { type: 'object' } },
    { name: 'react_to_message', description: 'react', input_schema: { type: 'object' } },
  ];
  const everything = [...kit, { name: 'mind_orient', description: 'brain', input_schema: { type: 'object' } }];

  it('is offered the house kit alone, while a session with no lane still gets everything', async () => {
    const { url } = await startBelt({
      getTools: async () => everything,
      getKitTools: () => kit,
      isKitTool: (name) => kit.some((t) => t.name === name),
      laneTurn: () => null,
    });
    const lane = await connectAsLane(url, 'primary');
    const codex = await connect(url);
    assert.deepEqual((await lane.client.listTools()).tools.map((t) => t.name), ['send_voice_note', 'react_to_message']);
    assert.deepEqual((await codex.client.listTools()).tools.map((t) => t.name), ['send_voice_note', 'react_to_message', 'mind_orient']);
    await Promise.all([lane.transport.terminateSession(), codex.transport.terminateSession()]);
    await Promise.all([lane.client.close(), codex.client.close()]);
  });

  it("a tool call lands in that lane's own chat, not the one Codex is in, and two lanes stay apart", async () => {
    const seen: Array<{ name: string; threadId?: string }> = [];
    const { getBeltContext } = await import('../services/chat-tool-belt.js');
    const { url } = await startBelt({
      getTools: async () => everything,
      getKitTools: () => kit,
      isKitTool: (name) => kit.some((t) => t.name === name),
      executeTool: async (name) => { seen.push({ name, threadId: getBeltContext()?.threadId }); return { ok: true, result: 'ok' }; },
      activeThread: () => 'codex-thread',
      laneTurn: (key) => (key === 'companion-a' ? { threadId: 'companion-a-thread', audience: null }
        : key === 'companion-b' ? { threadId: 'companion-b-thread', audience: null } : null),
    });
    const laneA = await connectAsLane(url, 'companion-a');
    const laneB = await connectAsLane(url, 'companion-b');
    const codex = await connect(url);
    await laneA.client.callTool({ name: 'send_voice_note', arguments: {} });
    await laneB.client.callTool({ name: 'react_to_message', arguments: {} });
    await codex.client.callTool({ name: 'send_voice_note', arguments: {} });
    assert.deepEqual(seen, [
      { name: 'send_voice_note', threadId: 'companion-a-thread' },
      { name: 'react_to_message', threadId: 'companion-b-thread' },
      { name: 'send_voice_note', threadId: 'codex-thread' },
    ]);
    await Promise.all([laneA, laneB, codex].map((c) => c.transport.terminateSession()));
    await Promise.all([laneA, laneB, codex].map((c) => c.client.close()));
  });

  it('with no turn running in the lane, a voice note is refused instead of borrowing the Codex chat', async () => {
    let executed = false;
    const { url } = await startBelt({
      getKitTools: () => kit,
      isKitTool: () => true,
      executeTool: async () => { executed = true; return { ok: true, result: 'sent' }; },
      activeThread: () => 'codex-thread',
      laneTurn: () => null,
    });
    const lane = await connectAsLane(url, 'primary');
    const refused = await lane.client.callTool({ name: 'send_voice_note', arguments: {} });
    assert.equal(refused.isError, true);
    assert.match((refused.content as Array<{ text: string }>)[0].text, /requires an active byte-light turn in this lane/);
    assert.equal(executed, false);
    await lane.transport.terminateSession();
    await lane.client.close();
  });

  it('a lane cannot call a tool outside the kit through this door', async () => {
    let executed = false;
    const { url } = await startBelt({
      getKitTools: () => kit,
      isKitTool: (name) => kit.some((t) => t.name === name),
      executeTool: async () => { executed = true; return { ok: true, result: 'ok' }; },
      laneTurn: () => ({ threadId: 't', audience: null }),
    });
    const lane = await connectAsLane(url, 'primary');
    const refused = await lane.client.callTool({ name: 'mind_orient', arguments: {} });
    assert.equal(refused.isError, true);
    assert.equal(executed, false);
    await lane.transport.terminateSession();
    await lane.client.close();
  });

  it("a guest's turn in the lane reaches the kit as a guest", async () => {
    const audiences: unknown[] = [];
    const { getBeltContext } = await import('../services/chat-tool-belt.js');
    const guest = { kind: 'guest', trust: 'limited' } as never;
    const { url } = await startBelt({
      getKitTools: () => kit,
      isKitTool: () => true,
      executeTool: async () => { audiences.push(getBeltContext()?.audience); return { ok: false, result: 'refused' }; },
      laneTurn: () => ({ threadId: 't', audience: guest }),
    });
    const lane = await connectAsLane(url, 'primary');
    await lane.client.callTool({ name: 'react_to_message', arguments: {} });
    assert.deepEqual(audiences, [guest]);
    await lane.transport.terminateSession();
    await lane.client.close();
  });
});
