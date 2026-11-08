import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getMcpJsonTools, executeMcpJsonTool, closeMcpJsonClients, offeredToolName } from './mcp-json-bridge.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '__fixtures__', 'echo-mcp-server.mjs');
const root = mkdtempSync(join(tmpdir(), 'mcp-json-'));

function writeMcpJson(servers: Record<string, unknown>): string {
  const path = join(root, '.mcp.json');
  writeFileSync(path, JSON.stringify({ mcpServers: servers }));
  return path;
}

after(async () => {
  await closeMcpJsonClients();
  rmSync(root, { recursive: true, force: true });
});

describe('.mcp.json servers on the API lanes', () => {
  it('scopes tool names by server, in the provider charset, at most 64 chars', () => {
    assert.equal(offeredToolName('jukebox', 'spotify_play'), 'jukebox__spotify_play');
    assert.equal(offeredToolName('My Server!', 'do.thing'), 'My_Server___do_thing');
    const long = offeredToolName('a'.repeat(40), 'b'.repeat(40));
    assert.ok(long.length <= 64);
    assert.notEqual(long, offeredToolName('a'.repeat(40), 'b'.repeat(41)), 'truncated names stay distinct');
  });

  it('spawns a stdio server with its env, offers its tools scoped, and runs them', async () => {
    const path = writeMcpJson({
      echo: { command: process.execPath, args: [fixture], env: { FIXTURE_FLAG: 'from-mcp-json' } },
      bytelight: { command: process.execPath, args: [fixture] },
      ghost: { command: '/nonexistent/mcp-server-binary' },
    });
    const tools = await getMcpJsonTools(path);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['echo__broken', 'echo__echo'], 'the reserved name and a dead server offer nothing');
    assert.match(tools.find((t) => t.name === 'echo__echo')!.description, /^\[echo\] Echo/);

    const ok = await executeMcpJsonTool('echo__echo', { value: 'hi' });
    assert.deepEqual(ok, { ok: true, result: 'echo:hi:from-mcp-json' });
    const failed = await executeMcpJsonTool('echo__broken', {});
    assert.deepEqual(failed, { ok: false, result: 'nope' });
    assert.equal(await executeMcpJsonTool('discord_send', {}), null, 'a name that is not ours falls through');
  });

  it('lets go of a server removed from the file', async () => {
    const path = writeMcpJson({});
    assert.deepEqual(await getMcpJsonTools(path), []);
    assert.equal(await executeMcpJsonTool('echo__echo', { value: 'x' }), null);
  });
});
