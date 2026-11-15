/**
 * A reopened room finds out what it missed.
 *
 * A room reopened by --resume after a backend restart is not handed the
 * recycle seed (that saving is the point of resume), so its first turn is the
 * only chance to learn what the restart swallowed. Same one-way doctrine as the
 * handover watermark: too much, never nothing.
 *
 * Adapted to this house's shape. Here the companion replies a lane never heard
 * come through the other-lane net (lane-tagged rows in input.messages, bounded
 * per thread), and her own messages through the missed-inbound net. These pin
 * the start point the net uses on a reopened room, and that marks written by a
 * different room do not bound it. The pieces are driven directly because a
 * whole runTurn here reaches the database and recall.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  InteractiveCliRuntime, otherLaneSinceFor, marksFromAnotherRoom, HANDED_FROM_THE_BEGINNING,
  __bindLaneForTests, __resetLaneStateForTests,
} from './runtime.js';
import { laneTagFor } from './constants.js';

const ME = laneTagFor('claude-cli', 'primary');
const OTHER = laneTagFor('codex-cli', 'primary');
const THREAD = 'thread-resume-catchup';

const HISTORY = [
  { role: 'assistant', content: 'said before the stamp', createdAt: '2026-11-10T19:00:00.000Z', lane: OTHER },
  { role: 'user', content: 'oh boy ... hmmm', createdAt: '2026-11-10T19:30:00.000Z' },
  { role: 'assistant', content: 'said after the stamp', createdAt: '2026-11-10T20:30:00.000Z', lane: OTHER },
  { role: 'assistant', content: 'my own words', createdAt: '2026-11-10T20:31:00.000Z', lane: ME },
];
const STAMP = '2026-11-10T20:00:00.000Z';

function block(reopen: { reopened: boolean; marksForeign: boolean }, lastTurnAt?: string, threadMark?: string): string {
  __resetLaneStateForTests();
  const state = __bindLaneForTests('test-resume-catchup', THREAD);
  state.lastTurnAt = lastTurnAt;
  state.lastReadThreadAt.clear();
  if (threadMark) state.lastReadThreadAt.set(THREAD, threadMark);
  const rt = new InteractiveCliRuntime({ sessionKey: 'primary', companionName: 'Companion', userName: 'Owner' });
  try {
    return (rt as any).buildOtherLaneBlock(state, 'primary', THREAD, HISTORY, undefined, reopen);
  } finally {
    __resetLaneStateForTests();
  }
}

test('a reopened room with no stamp at all is handed the window rather than nothing', () => {
  const out = block({ reopened: true, marksForeign: false });
  assert.match(out, /said before the stamp/);
  assert.match(out, /said after the stamp/);
  assert.doesNotMatch(out, /my own words/, 'its own lane never comes back to it');
});

test('a reopened room with a stamp is bounded by it', () => {
  const out = block({ reopened: true, marksForeign: false }, STAMP);
  assert.match(out, /said after the stamp/, 'the room kept talking and that must be handed over');
  assert.doesNotMatch(out, /said before the stamp/, 'a persisted stamp must bound the catch-up');
});

test('the thread mark wins over the lane-wide stamp when both exist', () => {
  const out = block({ reopened: true, marksForeign: false }, '2026-11-10T18:00:00.000Z', '2026-11-10T20:15:00.000Z');
  assert.match(out, /said after the stamp/);
  assert.doesNotMatch(out, /said before the stamp/);
});

test('a living lane with no thread mark still hears nothing, exactly as before', () => {
  assert.equal(block({ reopened: false, marksForeign: false }, STAMP), '');
});

test('marks written by a different room do not bound a reopened room', () => {
  const out = block({ reopened: true, marksForeign: true }, STAMP, '2026-11-10T20:45:00.000Z');
  assert.match(out, /said before the stamp/);
  assert.match(out, /said after the stamp/);
});

test('the start point, as a rule', () => {
  assert.equal(otherLaneSinceFor({ reopened: false, marksForeign: false }), undefined);
  assert.equal(otherLaneSinceFor({ reopened: false, marksForeign: false, threadMark: STAMP }), STAMP);
  assert.equal(otherLaneSinceFor({ reopened: true, marksForeign: false }), HANDED_FROM_THE_BEGINNING);
  assert.equal(otherLaneSinceFor({ reopened: true, marksForeign: false, lastTurnAt: STAMP }), STAMP);
  assert.equal(otherLaneSinceFor({ reopened: true, marksForeign: true, threadMark: STAMP }), HANDED_FROM_THE_BEGINNING);
});

test('only a named room that differs from the marks room is foreign', () => {
  assert.equal(marksFromAnotherRoom('room-old', 'room-fresh'), true);
  assert.equal(marksFromAnotherRoom('room-fresh', 'room-fresh'), false);
  assert.equal(marksFromAnotherRoom('room-old', ''), false, 'marks from before the marker existed stand');
  assert.equal(marksFromAnotherRoom(null, 'room-fresh'), false, 'an unnamed room proves nothing');
});

test('the missed-inbound block never lists the whole history, however unknown the mark', async () => {
  const { MISSED_INBOUND_CAP } = await import('./runtime.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'hb-missed-cap-'));
  __resetLaneStateForTests();
  const state = __bindLaneForTests('test-missed-cap', THREAD);
  state.lastHandedUserAt = undefined;
  state.lastTurnAt = undefined;
  const users = Array.from({ length: 50 }, (_, i) => ({
    role: 'user', content: `message ${i}`, createdAt: new Date(Date.UTC(2026, 10, 10, 10, i)).toISOString(),
  }));
  const rt = new InteractiveCliRuntime({ sessionKey: 'primary', userName: 'Owner' });
  try {
    const out: string = (rt as any).buildMissedInboundBlock(
      state, users, 'a brand new prompt', true, join(dir, 'missed.jsonl'), join(dir, '.last-handed-user'),
    );
    const listed = out.split('\n').filter((l) => l.startsWith('Owner ('));
    assert.equal(listed.length, MISSED_INBOUND_CAP);
    assert.match(out, /message 49/, 'the newest are kept');
    assert.doesNotMatch(out, /message 0\b/);
    assert.match(out, /40 older messages of hers omitted/);
  } finally {
    __resetLaneStateForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
