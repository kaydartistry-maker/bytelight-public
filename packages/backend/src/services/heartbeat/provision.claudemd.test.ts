/**
 * Session-CLAUDE.md core-memory tests — Slice A "blocks ride the doc".
 *
 * The delivery-cap fix moved the core-memory blocks out of the per-message
 * payload and into the heartbeat session's CLAUDE.md, written once at
 * provision/recycle (port of reference implementation frozen session-doc model). These tests
 * pin the provision half of that contract:
 *
 *   • provisionSessionDir writes the blocks into the session CLAUDE.md,
 *   • a memory-block edit refreshes the file ON DISK without flipping
 *     `templateChanged` (no forced recycle — blocks surface at the next
 *     natural recycle),
 *   • an operational-contract change still flips `templateChanged`,
 *   • the per-message payload side: an orientation carrying the exact same
 *     rendered blocks has them stripped before delivery (the pipe carries
 *     the conversation, not the memory).
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mirror db.bridge.test.ts: real disk-backed DB + stable config home, env
// stubbed BEFORE any src module loads config.
const tmpRoot = mkdtempSync(join(tmpdir(), 'provision-claudemd-test-'));
const dbPath = join(tmpRoot, 'test.db');
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

// Dynamic imports AFTER env stub.
const { initDb } = await import('../db.js');
const { setBlock, formatBlocksForPrompt, SHARED_SCOPE, COMPANION_SCOPES } =
  await import('../memory-blocks.js');
const { provisionSessionDir } = await import('./provision.js');
const { stripCoreMemoryFromOrientation } = await import('./runtime.js');

const SENTINEL_V1 = 'SENTINEL-BLOCK-CONTENT-v1: the operator likes tea.';
const SENTINEL_V2 = 'SENTINEL-BLOCK-CONTENT-v2: the operator prefers mornings.';

const sessionDir = join(tmpRoot, 'session');

before(() => {
  initDb(dbPath); // runs all migrations, incl. 013_memory + 017_memory_ledger
  setBlock(SHARED_SCOPE, 'human', SENTINEL_V1, 'test block');
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('provision writes core-memory blocks into the session CLAUDE.md', () => {
  const { templateChanged } = provisionSessionDir(sessionDir);
  assert.equal(templateChanged, true, 'first write counts as a contract change');

  const claudeMdPath = join(sessionDir, 'CLAUDE.md');
  assert.ok(existsSync(claudeMdPath), 'CLAUDE.md must exist after provision');
  const doc = readFileSync(claudeMdPath, 'utf8');
  assert.ok(doc.includes('<core-memory>'), 'blocks section missing');
  assert.ok(doc.includes(SENTINEL_V1), 'block content missing from CLAUDE.md');
  // The operational contract still leads the file.
  assert.ok(doc.indexOf('# Heartbeat operation') !== -1, 'operational contract missing');
  assert.ok(
    doc.indexOf('# Heartbeat operation') < doc.indexOf('<core-memory>'),
    'contract must precede the memory section',
  );
});

test('re-provision with nothing changed — templateChanged stays false', () => {
  const { templateChanged } = provisionSessionDir(sessionDir);
  assert.equal(templateChanged, false);
});

test('memory edit refreshes CLAUDE.md on disk WITHOUT flipping templateChanged', () => {
  setBlock(SHARED_SCOPE, 'human', SENTINEL_V2, 'test block');
  const { templateChanged } = provisionSessionDir(sessionDir);
  assert.equal(templateChanged, false, 'a block edit must not force a session recycle');

  const doc = readFileSync(join(sessionDir, 'CLAUDE.md'), 'utf8');
  assert.ok(doc.includes(SENTINEL_V2), 'edited block content must land on disk');
  assert.ok(!doc.includes(SENTINEL_V1), 'stale block content must be gone');
});

test('operational-contract change still flips templateChanged', () => {
  const claudeMdPath = join(sessionDir, 'CLAUDE.md');
  // Simulate a stale on-disk contract from a previous deploy: perturb the
  // operational half (before the core-memory section) and re-provision.
  const doc = readFileSync(claudeMdPath, 'utf8');
  writeFileSync(claudeMdPath, doc.replace('# Heartbeat operation', '# Stale contract'), 'utf8');
  const { templateChanged } = provisionSessionDir(sessionDir);
  assert.equal(templateChanged, true, 'a contract change must request a recycle');
  // And the file is healed back to the current contract.
  const healed = readFileSync(claudeMdPath, 'utf8');
  assert.ok(healed.includes('# Heartbeat operation'));
});

test('the exact rendered blocks are stripped from the per-message payload', () => {
  // End-to-end shape: build an orientation the way the SDK lane would (same
  // formatBlocksForPrompt output that provision wrote to CLAUDE.md) and
  // assert the heartbeat delivery path strips it whole.
  const rendered = formatBlocksForPrompt([SHARED_SCOPE, ...COMPANION_SCOPES]);
  assert.ok(rendered.includes(SENTINEL_V2), 'sanity: blocks render for the prompt');
  const orientation = `Time: 12:00\n${rendered}\nCHAT TOOLS: sticker catalog...`;
  const { text, stripped } = stripCoreMemoryFromOrientation(orientation);
  assert.ok(!text.includes('<core-memory>'), 'span must be gone from the payload');
  assert.ok(!text.includes(SENTINEL_V2), 'block content must not ride the pipe');
  assert.ok(text.includes('Time: 12:00') && text.includes('CHAT TOOLS:'), 'rest of orientation survives');
  // The stripped span is exactly the <core-memory>…</core-memory> extent.
  const open = orientation.indexOf('<core-memory>');
  const close = orientation.indexOf('</core-memory>') + '</core-memory>'.length;
  assert.equal(stripped, close - open);
});
