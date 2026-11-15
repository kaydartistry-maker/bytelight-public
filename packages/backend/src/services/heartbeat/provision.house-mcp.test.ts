/**
 * A Claude CLI lane is handed the servers in the house's .mcp.json, the same
 * file Codex CLI and the API lanes are given, alongside its own brain wire.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'provision-house-mcp-test-'));
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');
process.env.MIND_API_URL = 'https://brain.example.dev/';
process.env.MIND_API_KEY = 'not-a-real-key';

const { initDb } = await import('../db.js');
const {
  buildHouseMcpConfig, laneMcpArgs, provisionSessionDir, HOUSE_MCP_FILENAME, NEURALIS_MCP_FILENAME,
} = await import('./provision.js');
const { buildLaunchArgs } = await import('./supervisor.js');
const { readMcpJson } = await import('../mcp-json.js');

before(() => { initDb(join(tmpRoot, 'test.db')); });
after(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

const COMMAND_CENTER = { type: 'http' as const, url: 'http://127.0.0.1:3002/mcp/cc' };

test('every kind of .mcp.json entry is carried over in the shape the CLI reads', () => {
  const config = JSON.parse(buildHouseMcpConfig({
    'command-center': COMMAND_CENTER,
    remote: { type: 'http', url: 'https://tools.example.dev/mcp', headers: { Authorization: 'Bearer ${TOOLS_KEY}' } },
    stream: { type: 'sse', url: 'https://tools.example.dev/sse' },
    local: { type: 'stdio', command: 'node', args: ['server.js'], env: { MODE: 'house' } },
  })!).mcpServers;
  assert.deepEqual(config['command-center'], { type: 'http', url: 'http://127.0.0.1:3002/mcp/cc' });
  assert.deepEqual(config.remote, { type: 'http', url: 'https://tools.example.dev/mcp', headers: { Authorization: 'Bearer ${TOOLS_KEY}' } });
  assert.deepEqual(config.stream, { type: 'sse', url: 'https://tools.example.dev/sse' });
  assert.deepEqual(config.local, { command: 'node', args: ['server.js'], env: { MODE: 'house' } });
});

test('a house entry never replaces the lane brain wire', () => {
  const config = JSON.parse(buildHouseMcpConfig({
    neuralis: { type: 'http', url: 'https://elsewhere.example.dev/mcp' },
    'neuralis-core': { type: 'http', url: 'https://elsewhere.example.dev/mcp/core' },
    'command-center': COMMAND_CENTER,
  })!).mcpServers;
  assert.deepEqual(Object.keys(config), ['command-center']);
});

test('an empty .mcp.json writes nothing', () => {
  assert.equal(buildHouseMcpConfig({}), null);
  assert.equal(buildHouseMcpConfig({ neuralis: { type: 'http', url: 'https://x.example.dev' } }), null);
});

test('the lane launches with its brain wire and the house servers in one flag', () => {
  const dir = join(tmpRoot, 'lane-both');
  provisionSessionDir(dir, null, { mcpJsonServers: { 'command-center': COMMAND_CENTER } });
  const written = JSON.parse(readFileSync(join(dir, HOUSE_MCP_FILENAME), 'utf8')).mcpServers;
  assert.deepEqual(Object.keys(written), ['command-center']);
  assert.deepEqual(laneMcpArgs(dir), [
    '--mcp-config', join(dir, NEURALIS_MCP_FILENAME), join(dir, HOUSE_MCP_FILENAME),
  ]);
  const args = buildLaunchArgs({
    model: 'claude-sonnet-4-6', effort: 'adaptive', sessionId: 'abc', resuming: false,
    freshPrompt: 'hello', resumePrompt: 'again', trailingArgs: laneMcpArgs(dir),
  });
  assert.deepEqual(args.slice(-4), ['hello', '--mcp-config', join(dir, NEURALIS_MCP_FILENAME), join(dir, HOUSE_MCP_FILENAME)]);
});

test('the house servers ride alone when no brain is configured', () => {
  const dir = join(tmpRoot, 'lane-house-only');
  const key = process.env.MIND_API_KEY;
  delete process.env.MIND_API_KEY;
  try {
    provisionSessionDir(dir, null, { mcpJsonServers: { 'command-center': COMMAND_CENTER } });
    assert.deepEqual(laneMcpArgs(dir), ['--mcp-config', join(dir, HOUSE_MCP_FILENAME)]);
  } finally {
    process.env.MIND_API_KEY = key;
  }
});

test('adding, changing or removing a house server is reported so the lane restarts with it', () => {
  const dir = join(tmpRoot, 'lane-change');
  assert.equal(provisionSessionDir(dir, null, { mcpJsonServers: {} }).templateChanged, true);
  assert.equal(provisionSessionDir(dir, null, { mcpJsonServers: {} }).templateChanged, false);
  assert.equal(existsSync(join(dir, HOUSE_MCP_FILENAME)), false);

  assert.equal(provisionSessionDir(dir, null, { mcpJsonServers: { 'command-center': COMMAND_CENTER } }).templateChanged, true);
  assert.equal(provisionSessionDir(dir, null, { mcpJsonServers: { 'command-center': COMMAND_CENTER } }).templateChanged, false);

  const moved = { 'command-center': { type: 'http' as const, url: 'http://127.0.0.1:4000/mcp/cc' } };
  assert.equal(provisionSessionDir(dir, null, { mcpJsonServers: moved }).templateChanged, true);

  assert.equal(provisionSessionDir(dir, null, { mcpJsonServers: {} }).templateChanged, true);
  assert.equal(existsSync(join(dir, HOUSE_MCP_FILENAME)), false);
});

test('the real .mcp.json file on disk is what the lane is given', () => {
  const mcpJsonPath = join(tmpRoot, 'house.mcp.source.json');
  writeFileSync(mcpJsonPath, JSON.stringify({ mcpServers: { 'command-center': { type: 'url', url: 'http://127.0.0.1:3002/mcp/cc' } } }));
  const dir = join(tmpRoot, 'lane-from-file');
  provisionSessionDir(dir, null, { mcpJsonServers: readMcpJson(mcpJsonPath) });
  const written = JSON.parse(readFileSync(join(dir, HOUSE_MCP_FILENAME), 'utf8')).mcpServers;
  assert.deepEqual(written['command-center'], { type: 'http', url: 'http://127.0.0.1:3002/mcp/cc' });
});
