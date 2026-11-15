/**
 * The lane's marks outlive the backend process.
 *
 * A reopened room (--resume) is not handed the 30-message recycle seed, so the
 * only way it learns what it missed is the marks: the handover mark (her
 * messages), the sight mark (when it last finished a turn) and the per-thread
 * other-lane mark (companion replies from other lanes). Every one of them used
 * to live only in the in-memory lane map, which is empty after a restart.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  __bindLaneForTests, __resetLaneStateForTests, HANDED_WATERMARK_FILE, TURN_WATERMARK_FILE,
  otherLaneMarkPath, readHandedWatermark, writeHandedWatermark,
} from './runtime.js';
import { getHeartbeatSession } from './supervisor.js';

const KEY = 'test-lane-marks-persist';

test('a fresh lane map hydrates the handover and sight marks from disk', () => {
  __resetLaneStateForTests();
  const session = getHeartbeatSession(KEY);
  const io = join(session.dir, 'io');
  try {
    mkdirSync(io, { recursive: true });
    writeFileSync(join(io, HANDED_WATERMARK_FILE), '2026-11-10T20:00:00.000Z');
    writeFileSync(join(io, TURN_WATERMARK_FILE), '2026-11-10T20:01:00.000Z');
    const state = __bindLaneForTests(KEY, 'thread-a');
    assert.equal(state.lastHandedUserAt, '2026-11-10T20:00:00.000Z');
    assert.equal(state.lastTurnAt, '2026-11-10T20:01:00.000Z');
    // Marks come back from disk; the manual flag never does. The first turn of a
    // new process carries the orientation manual once, reopened room or not.
    assert.equal(state.manualDelivered, false);
  } finally {
    __resetLaneStateForTests();
    rmSync(session.dir, { recursive: true, force: true });
  }
});

test('damaged marks on disk hydrate as unknown, never as handed', () => {
  __resetLaneStateForTests();
  const session = getHeartbeatSession(`${KEY}-junk`);
  const io = join(session.dir, 'io');
  try {
    mkdirSync(io, { recursive: true });
    writeFileSync(join(io, HANDED_WATERMARK_FILE), 'yesterday');
    writeFileSync(join(io, TURN_WATERMARK_FILE), '');
    const state = __bindLaneForTests(`${KEY}-junk`, 'thread-a');
    assert.equal(state.lastHandedUserAt, undefined);
    assert.equal(state.lastTurnAt, undefined);
  } finally {
    __resetLaneStateForTests();
    rmSync(session.dir, { recursive: true, force: true });
  }
});

test('the other-lane mark is one file per thread, and threads never share one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hb-other-lane-'));
  try {
    const a = otherLaneMarkPath(dir, 'thread-a');
    const b = otherLaneMarkPath(dir, 'thread-b');
    assert.notEqual(a, b);
    assert.ok(!a.includes('thread-a'), 'the thread id is hashed out of the path');
    writeHandedWatermark(a, '2026-11-10T20:00:00.000Z');
    assert.equal(readHandedWatermark(a), '2026-11-10T20:00:00.000Z');
    assert.equal(readHandedWatermark(b), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
