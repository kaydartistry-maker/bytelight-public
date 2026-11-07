import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import ccMcpRouter from './cc-mcp.js';

// Hand-rolled MCP endpoints must answer notifications (no id) with 202 and no
// body. Codex's strict client (rmcp) drops a server that sends a JSON-RPC body
// instead, which is how command-center vanished from the Codex lane (483aac08).

const servers: HttpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function startCc(): Promise<URL> {
  const app = express();
  app.use(express.json());
  app.use('/mcp/cc', ccMcpRouter);
  const http = createServer(app);
  servers.push(http);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return new URL(`http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp/cc`);
}

const post = (url: URL, body: unknown) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
  body: JSON.stringify(body),
});

describe('command-center MCP endpoint', () => {
  it('answers every notification with 202 and an empty body', async () => {
    const url = await startCc();
    for (const method of ['notifications/initialized', 'notifications/cancelled', 'notifications/progress']) {
      const res = await post(url, { jsonrpc: '2.0', method, params: {} });
      assert.equal(res.status, 202, method);
      assert.equal(await res.text(), '', method);
    }
  });

  it('still answers requests (with an id) as JSON-RPC', async () => {
    const url = await startCc();
    const res = await post(url, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(res.status, 200);
    const body = await res.json() as { id: number; result: { serverInfo: { name: string } } };
    assert.equal(body.id, 1);
    assert.equal(body.result.serverInfo.name, 'command-center');
  });

  it('completes a full handshake and tools/list with the official MCP client', async () => {
    const url = await startCc();
    const client = new Client({ name: 'strict-test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(url));
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);
    assert.ok(tools.every((t) => t.name.startsWith('cc_')));
    await client.close();
  });
});
