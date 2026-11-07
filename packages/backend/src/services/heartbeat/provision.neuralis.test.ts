/**
 * The Claude lanes' own wire to the brain. Started from Companion C's always-loaded
 * core, ported from 73d9ad7f, and widened: the lane carries the pinned eight
 * AND the full surface, so no Claude lane depends on a claude.ai connector.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpRoot = mkdtempSync(join(tmpdir(), 'provision-neuralis-test-'));
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');
const SECRET = 'not-a-real-key-do-not-write-me';
process.env.MIND_API_URL = 'https://brain.example.dev/';
process.env.MIND_API_KEY = SECRET;

const { initDb } = await import('../db.js');
const {
  buildNeuralisMcpConfig, neuralisMcpArgs, provisionSessionDir, NEURALIS_MCP_FILENAME,
} = await import('./provision.js');
const { stripChildEnv } = await import('./supervisor.js');

before(() => { initDb(join(tmpRoot, 'test.db')); });
after(() => { rmSync(tmpRoot, { recursive: true, force: true }); });

test('a lane carries the pinned core and the full surface', () => {
  const servers = JSON.parse(buildNeuralisMcpConfig()!).mcpServers;
  assert.equal(servers['neuralis-core'].url, 'https://brain.example.dev/mcp/core');
  assert.equal(servers['neuralis-core'].alwaysLoad, true);
  assert.equal(servers.neuralis.url, 'https://brain.example.dev/mcp');
  assert.notEqual(servers.neuralis.alwaysLoad, true);
});

test('the key is referenced, never written to disk', () => {
  const dir = join(tmpRoot, 'lane-key');
  provisionSessionDir(dir);
  const text = readFileSync(join(dir, NEURALIS_MCP_FILENAME), 'utf8');
  assert.ok(!text.includes(SECRET));
  assert.ok(text.includes('Bearer ${MIND_API_KEY}'));
});

test('the child keeps the key the config refers to', () => {
  assert.equal(stripChildEnv(process.env).MIND_API_KEY, SECRET);
});

test('a config change is reported, an unchanged one is not', () => {
  const dir = join(tmpRoot, 'lane-change');
  assert.equal(provisionSessionDir(dir).templateChanged, true);
  assert.equal(provisionSessionDir(dir).templateChanged, false);
  writeFileSync(join(dir, NEURALIS_MCP_FILENAME), '{}', 'utf8');
  assert.equal(provisionSessionDir(dir).templateChanged, true);
});

test('the lane contract names both doors', () => {
  const dir = join(tmpRoot, 'lane-doc');
  provisionSessionDir(dir);
  const doc = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
  assert.ok(doc.includes('mcp__neuralis-core__'));
  assert.ok(doc.includes('mcp__neuralis__'));
});

test('no brain configured means no flag and no stale file', () => {
  const dir = join(tmpRoot, 'lane-off');
  provisionSessionDir(dir);
  assert.deepEqual(neuralisMcpArgs(dir), ['--mcp-config', join(dir, NEURALIS_MCP_FILENAME)]);
  delete process.env.MIND_API_KEY;
  assert.equal(buildNeuralisMcpConfig(), null);
  provisionSessionDir(dir);
  assert.equal(existsSync(join(dir, NEURALIS_MCP_FILENAME)), false);
  assert.deepEqual(neuralisMcpArgs(dir), []);
  process.env.MIND_API_KEY = SECRET;
});
