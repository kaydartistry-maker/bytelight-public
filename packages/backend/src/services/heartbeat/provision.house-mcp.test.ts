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

const {
  houseKitMcpEntry, HOUSE_KIT_MCP_NAME, HOUSE_KIT_LANE_HEADER,
} = await import('./provision.js');
const { MCP_BELT_TOKEN_ENV, getMcpBeltToken } = await import('../mcp-belt-auth.js');
const { heartbeatLaneTurn, getHeartbeatSession } = await import('./supervisor.js');

test('a lane with a key is wired to the house kit, loaded every session, with its credential by name only', () => {
  const dir = join(tmpRoot, 'lane-kit');
  provisionSessionDir(dir, null, { mcpJsonServers: { 'command-center': COMMAND_CENTER }, laneKey: 'primary' });
  const text = readFileSync(join(dir, HOUSE_MCP_FILENAME), 'utf8');
  const servers = JSON.parse(text).mcpServers;
  assert.deepEqual(Object.keys(servers), [HOUSE_KIT_MCP_NAME, 'command-center']);
  const kit = servers[HOUSE_KIT_MCP_NAME];
  assert.equal(kit.type, 'http');
  assert.match(kit.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp\/belt$/);
  assert.equal(kit.alwaysLoad, true);
  assert.equal(kit.headers.Authorization, 'Bearer ${' + MCP_BELT_TOKEN_ENV + '}');
  assert.equal(kit.headers[HOUSE_KIT_LANE_HEADER], 'primary');
  assert.ok(!text.includes(getMcpBeltToken()), 'the credential itself is never written to the lane folder');
});

test('each lane names itself, so its tools land in its own chat', () => {
  assert.equal((houseKitMcpEntry('companion-a').headers as Record<string, string>)[HOUSE_KIT_LANE_HEADER], 'companion-a');
  assert.equal((houseKitMcpEntry('companion-b').headers as Record<string, string>)[HOUSE_KIT_LANE_HEADER], 'companion-b');
});

test('a house .mcp.json entry cannot take the kit name', () => {
  const config = JSON.parse(buildHouseMcpConfig({
    bytelight: { type: 'http', url: 'https://elsewhere.example.dev/mcp' },
  }, 'primary')!).mcpServers;
  assert.match(config.bytelight.url, /\/mcp\/belt$/);
});

test('the lane is told its kit is in hand, and only when it is wired to it', () => {
  const wired = join(tmpRoot, 'lane-kit-doc');
  provisionSessionDir(wired, null, { mcpJsonServers: {}, laneKey: 'primary' });
  assert.ok(readFileSync(join(wired, 'CLAUDE.md'), 'utf8').includes('mcp__bytelight__'));
  const bare = join(tmpRoot, 'lane-no-kit-doc');
  provisionSessionDir(bare, null, { mcpJsonServers: {} });
  assert.ok(!readFileSync(join(bare, 'CLAUDE.md'), 'utf8').includes('mcp__bytelight__'));
  assert.equal(existsSync(join(bare, HOUSE_MCP_FILENAME)), false);
});

test('a lane turn is read without creating a lane, and only while a turn is running', () => {
  assert.equal(heartbeatLaneTurn('never-started'), null);
  assert.equal(heartbeatLaneTurn('never-started'), null);
  const session = getHeartbeatSession('kit-turn-lane');
  assert.equal(heartbeatLaneTurn('kit-turn-lane'), null);
  session.turnActive = true;
  session.turnThreadId = 'thread-9';
  assert.deepEqual(heartbeatLaneTurn('kit-turn-lane'), { threadId: 'thread-9', audience: null });
  session.turnActive = false;
  assert.equal(heartbeatLaneTurn('kit-turn-lane'), null);
});

test('a .mcp.json server marked alwaysLoad stays always-loaded on the lane', () => {
  const config = JSON.parse(buildHouseMcpConfig({
    core: { type: 'stdio', command: 'node', args: ['core.mjs'], alwaysLoad: true },
    full: { type: 'http', url: 'https://brain.example/mcp' },
  })!);
  assert.equal(config.mcpServers.core.alwaysLoad, true);
  assert.equal('alwaysLoad' in config.mcpServers.full, false);
});
