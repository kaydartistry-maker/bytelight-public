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
