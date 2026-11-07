import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validMcpBeltBearer } from './mcp-belt-auth.js';
import { runtimeNeedsRouterToolPayload } from './runtime-tool-delivery.js';
import { codexAppServerArgs } from './codex-app-server-config.js';
import { createSingleFlight } from './single-flight.js';
import { assertUniqueToolNames } from './mcp-bridge.js';

describe('MCP transport ownership policies', () => {
  it('requires the exact private bearer credential', () => {
    assert.equal(validMcpBeltBearer(undefined, 'house-secret'), false);
    assert.equal(validMcpBeltBearer('Bearer wrong', 'house-secret'), false);
    assert.equal(validMcpBeltBearer('Bearer house-secret', 'house-secret'), true);
  });

  it('keeps router payload discovery out of the Codex CLI lane only', () => {
    assert.equal(runtimeNeedsRouterToolPayload('codex-cli'), false);
    assert.equal(runtimeNeedsRouterToolPayload('codex'), true);
    assert.equal(runtimeNeedsRouterToolPayload('api-router'), true);
  });

  it('launches the owned app-server with a private socket and MCP table', () => {
    const args = codexAppServerArgs().join(' ');
    assert.match(args, /app-server --listen unix:\/\//);
    assert.match(args, /\.codex\/app-server-control\/bytelight-app-server\.sock/);
    assert.match(args, /mcp_servers=\{bytelight=/);
    assert.match(args, /bearer_token_env_var="BYTELIGHT_MCP_BELT_TOKEN"/);
  });

  it('gives the owned app-server every .mcp.json server alongside the belt', () => {
    const args = codexAppServerArgs('http://127.0.0.1:3002/mcp/belt', {
      mind: { type: 'stdio', command: 'node', args: ['mind.js', '--port', '9'], env: { MIND_KEY: 'k' } },
      cortex: { type: 'http', url: 'https://cortex.example/mcp', headers: { Authorization: 'Bearer t' } },
      plain: { type: 'stdio', command: 'tool' },
    });
    const table = args[args.indexOf('-c') + 1];
    assert.match(table, /^mcp_servers=\{bytelight=\{url="http:\/\/127\.0\.0\.1:3002\/mcp\/belt"/);
    assert.match(table, /"mind"=\{"command"="node","args"=\["mind\.js","--port","9"\],"env"=\{"MIND_KEY"="k"\}\}/);
    assert.match(table, /"cortex"=\{"url"="https:\/\/cortex\.example\/mcp","http_headers"=\{"Authorization"="Bearer t"\}\}/);
    assert.match(table, /"plain"=\{"command"="tool"\}/);
  });

  it('keeps the bytelight name for the belt and escapes TOML strings', () => {
    const args = codexAppServerArgs('http://belt', {
      bytelight: { type: 'stdio', command: 'impostor' },
      'odd "name"': { type: 'stdio', command: 'C:\\tools\\run' },
    });
    const table = args[args.indexOf('-c') + 1];
    assert.doesNotMatch(table, /impostor/);
    assert.ok(table.includes('"odd \\"name\\""={"command"="C:\\\\tools\\\\run"}'));
  });

  it('rejects ambiguous tool ownership before advertising the catalog', () => {
    assert.doesNotThrow(() => assertUniqueToolNames([
      { name: 'alpha', source: 'belt' },
      { name: 'beta', source: 'managed:mind' },
    ]));
    assert.throws(() => assertUniqueToolNames([
      { name: 'same', source: 'belt' },
      { name: 'same', source: 'managed:mind' },
    ]), /Duplicate MCP tool name "same" from belt and managed:mind/);
  });

  it('single-flights concurrent managed discovery and permits later refresh', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const run = createSingleFlight(async () => {
      calls++;
      await gate;
      return calls;
    });

    const first = run();
    const second = run();
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await Promise.all([first, second]), [1, 1]);
    assert.equal(await run(), 2);
  });
});
