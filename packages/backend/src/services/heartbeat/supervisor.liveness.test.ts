/**
 * Watchdog liveness — regression cover for the two recycles Tris reported:
 * completed turns killed mid-generation because the watchdog measured them
 * from files written before the message ever arrived (reported ages 412s and
 * 1387s, both landing in the same second as their own turn-complete line).
 * See livenessMark's docblock. Ported from Aerie's supervisor-activity tests
 * (her 9e393e6e).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.CLAUDE_CLI_HEARTBEAT_ENABLED = 'true';

import { livenessMark, activityTailIsOpen } from './supervisor.js';

// --- livenessMark ------------------------------------------------------------

test('liveness takes the newest of tick, outbox and activity', () => {
  assert.equal(livenessMark({ tick: 100, outboxMtime: 300, activityMtime: 200 }), 300);
  assert.equal(livenessMark({ tick: 400, outboxMtime: 300, activityMtime: 200 }), 400);
});

test('a live turn is measured from its own start, not from a stale file', () => {
  // Hook stopped ticking at 1000 when it handed the message over; the turn began
  // at 5000 and is still running. Without turnStartedAt the watchdog would charge
  // the turn for the 4000ms of quiet that happened before it existed.
  assert.equal(
    livenessMark({ tick: 1000, outboxMtime: 900, activityMtime: 0, turnActive: true, turnStartedAt: 5000 }),
    5000,
  );
});

test('turn start never rewinds a newer file write', () => {
  assert.equal(
    livenessMark({ tick: 0, outboxMtime: 9000, activityMtime: 0, turnActive: true, turnStartedAt: 5000 }),
    9000,
  );
});

test('turn start is ignored once the turn is over', () => {
  // The runtime zeroes turnStartedAt in its finally, but belt and braces: an
  // inactive turn must never hold a session open on a mark it no longer owns.
  assert.equal(
    livenessMark({ tick: 1000, outboxMtime: 0, activityMtime: 0, turnActive: false, turnStartedAt: 5000 }),
    1000,
  );
});

// --- activityTailIsOpen ------------------------------------------------------

test('an unanswered pre means a tool is in flight', () => {
  const tail = [
    JSON.stringify({ phase: 'pre', tool: 'Bash' }),
  ].join('\n');
  assert.equal(activityTailIsOpen(tail), true);
});

test('a post closes the tool', () => {
  const tail = [
    JSON.stringify({ phase: 'pre', tool: 'Bash' }),
    JSON.stringify({ phase: 'post', tool: 'Bash' }),
  ].join('\n');
  assert.equal(activityTailIsOpen(tail), false);
});

test('a torn last line is walked past, not trusted', () => {
  const tail = [
    JSON.stringify({ phase: 'pre', tool: 'Bash' }),
    '{"phase":"po', // torn mid-write
  ].join('\n');
  assert.equal(activityTailIsOpen(tail), true);
});

test('an empty tail is not an open tool', () => {
  assert.equal(activityTailIsOpen(''), false);
  assert.equal(activityTailIsOpen('\n\n'), false);
});
