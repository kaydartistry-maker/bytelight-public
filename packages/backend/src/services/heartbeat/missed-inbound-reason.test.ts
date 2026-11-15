// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import assert from 'node:assert/strict';
import test from 'node:test';
import { missedInboundReason } from './runtime.js';

// The old classifier wrote `afterRestart ? 'session-birth' : 'race'`, which
// measured whether the lane had just been born and swept everything else into
// one word. Eleven days of the log showed the "race" bucket sitting at an
// eleven-minute median — nothing that waits eleven minutes lost a race. These
// pin the split that replaced it.

const TURN_END = '2026-09-08T20:00:00.000Z';

test('a lane being born explains itself and nothing else needs asking', () => {
  assert.equal(missedInboundReason(true, '2026-09-08T19:00:00.000Z', TURN_END), 'session-birth');
  assert.equal(missedInboundReason(true, '2026-09-08T21:00:00.000Z', undefined), 'session-birth');
});

test('after the last turn ended means nothing was running to catch it', () => {
  assert.equal(missedInboundReason(false, '2026-09-08T20:00:00.001Z', TURN_END), 'idle-lane');
  assert.equal(missedInboundReason(false, '2026-09-08T20:11:00.000Z', TURN_END), 'idle-lane');
});

// This is the one worth separating: side notes exist for a message that lands
// mid-turn, so one of these is a side-note gap rather than a seam nobody could
// have covered.
test('before the last turn ended means it landed while a turn was in flight', () => {
  assert.equal(missedInboundReason(false, '2026-09-08T19:59:59.000Z', TURN_END), 'during-turn');
  assert.equal(missedInboundReason(false, '2026-09-08T19:40:00.000Z', TURN_END), 'during-turn');
});

test('a lane that has never finished a turn cannot have been mid-turn', () => {
  assert.equal(missedInboundReason(false, '2026-09-08T20:00:00.000Z', undefined), 'idle-lane');
});

test('the boundary itself counts as during the turn rather than after it', () => {
  assert.equal(missedInboundReason(false, TURN_END, TURN_END), 'during-turn');
});

test('the word race is gone — it never described either case', () => {
  const reasons = new Set([
    missedInboundReason(true, TURN_END, TURN_END),
    missedInboundReason(false, '2026-09-08T20:30:00.000Z', TURN_END),
    missedInboundReason(false, '2026-09-08T19:30:00.000Z', TURN_END),
  ]);
  assert.equal(reasons.has('race' as never), false);
  assert.deepEqual([...reasons].sort(), ['during-turn', 'idle-lane', 'session-birth']);
});
