// The stale-wall check end to end: a real launch writes the baseline, a block
// moves, the lane's CLAUDE.md is regenerated to match, and the check still says
// the wall moved. That last step is the whole point: a baseline that followed
// the regenerated file could never disagree with it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../db/init.js';
import { getAllBlocks, initMemoryBlocks, setBlock } from '../memory-blocks.js';
import { PROJECT_ROOT } from '../../config.js';
import { BASELINE_FILE, DRIFT_TEXT_BUDGET, LIVE_WALLS_FILE, baselineFrom } from './block-drift.js';
import { provisionSessionDir } from './provision.js';
import { staleBlockText } from './stale-walls.js';
import { HeartbeatSession } from './supervisor.js';

function house() {
  initDb(':memory:');
  initMemoryBlocks();
  setBlock('shared', 'wall', 'the wall as the room opened');
  const root = mkdtempSync(join(tmpdir(), 'bytelight-stale-walls-'));
  const dir = join(root, 'data', 'heartbeat', 'primary');
  mkdirSync(join(dir, 'io'), { recursive: true });
  return { root, dir, done: () => rmSync(root, { recursive: true, force: true }) };
}

const baseline = (dir: string) => writeFileSync(join(dir, 'io', BASELINE_FILE), JSON.stringify(baselineFrom(getAllBlocks())));

test('nothing moved, nothing said', () => {
  const h = house();
  try {
    baseline(h.dir);
    assert.equal(staleBlockText('primary', h.root), '');
  } finally { h.done(); }
});

test('a moved wall comes back live, even after the lane CLAUDE.md is regenerated with the new text', () => {
  const h = house();
  try {
    baseline(h.dir);
    setBlock('shared', 'wall', 'the wall after a thin');
    provisionSessionDir(h.dir);
    assert.match(readFileSync(join(h.dir, 'CLAUDE.md'), 'utf8'), /the wall after a thin/, 'the file followed the block');
    const text = staleBlockText('primary', h.root);
    assert.match(text, /WALLS MOVED SINCE THIS ROOM OPENED/);
    assert.match(text, /the wall after a thin/);
  } finally { h.done(); }
});

test('no baseline, a bad baseline, or something that is not a lane says nothing', () => {
  const h = house();
  try {
    setBlock('shared', 'wall', 'moved');
    assert.equal(staleBlockText('primary', h.root), '', 'no baseline');
    writeFileSync(join(h.dir, 'io', BASELINE_FILE), '{not json');
    assert.equal(staleBlockText('primary', h.root), '', 'unreadable baseline');
    assert.equal(staleBlockText('../primary', h.root), '', 'a path');
    assert.equal(staleBlockText('tmp', h.root), '', 'not a lane');
    assert.equal(staleBlockText(undefined, h.root), '');
  } finally { h.done(); }
});

test('a real launch writes the baseline from the live blocks, and leaves it alone until the next launch', async () => {
  initDb(':memory:');
  initMemoryBlocks();
  setBlock('shared', 'wall', 'at launch');
  // A stand-in claude on PATH, so the supervisor really launches a child.
  const bin = mkdtempSync(join(tmpdir(), 'bytelight-fake-claude-'));
  const fake = join(bin, 'claude');
  writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n');
  chmodSync(fake, 0o755);
  const realPath = process.env.PATH;
  process.env.PATH = `${bin}:${realPath}`;
  const key = `stale-walls-test-${process.pid}`;
  const session = new HeartbeatSession(key);
  const io = join(PROJECT_ROOT, 'data', 'heartbeat', key, 'io');
  try {
    session.ensure('claude-test-model');
    const path = join(io, BASELINE_FILE);
    assert.ok(existsSync(path), 'written at launch');
    const opened = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(opened, baselineFrom(getAllBlocks()));

    setBlock('shared', 'wall', 'edited mid-room');
    provisionSessionDir(join(PROJECT_ROOT, 'data', 'heartbeat', key));
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), opened, 'the regenerated CLAUDE.md does not touch it');
    assert.match(staleBlockText(key), /edited mid-room/);
    // The session log opens on its own clock; let it land before the folder goes.
    const log = join(PROJECT_ROOT, 'data', 'heartbeat', key, 'session.log');
    while (!existsSync(log)) await new Promise((r) => setTimeout(r, 5));
  } finally {
    session.stop();
    process.env.PATH = realPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(join(PROJECT_ROOT, 'data', 'heartbeat', key), { recursive: true, force: true });
  }
});

test('walls too big to hand back are put in a file with line breaks, and the note names it', () => {
  const h = house();
  try {
    baseline(h.dir);
    const wall = Array.from({ length: 900 }, (_, i) => `2026-11-02 entry ${i} with some words in it`).join('\n');
    assert.ok(wall.length > DRIFT_TEXT_BUDGET);
    setBlock('shared', 'wall', wall);
    const out = staleBlockText('primary', h.root);
    const path = join(h.dir, 'io', LIVE_WALLS_FILE);
    assert.ok(out.length <= DRIFT_TEXT_BUDGET, `note is ${out.length}`);
    assert.ok(out.includes('shared/wall'));
    assert.ok(out.includes(path), 'the note gives the absolute path');
    const onDisk = readFileSync(path, 'utf8');
    assert.ok(onDisk.includes('## [shared] wall\n'));
    assert.ok(onDisk.includes(wall), 'the whole live text, real newlines, one Read page at a time');
  } finally { h.done(); }
});

test('a later squash that fits inline leaves no old walls file behind', () => {
  const h = house();
  try {
    baseline(h.dir);
    setBlock('shared', 'wall', 'z'.repeat(DRIFT_TEXT_BUDGET + 1));
    staleBlockText('primary', h.root);
    const path = join(h.dir, 'io', LIVE_WALLS_FILE);
    assert.ok(existsSync(path));
    setBlock('shared', 'wall', 'small again');
    const out = staleBlockText('primary', h.root);
    assert.ok(out.includes('small again'));
    assert.equal(existsSync(path), false);
  } finally { h.done(); }
});
