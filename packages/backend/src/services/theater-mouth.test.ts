// The Mouth's pure parts: when a moment is a beat, how chatty maps to pace,
// and the skip rules. Subtitles here are made up.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BEAT_GAP_SECONDS,
  KAY_SPOKE_HOLD_MS,
  beatSkipReason,
  detectBeat,
  mouthPace,
  type BeatCheck,
} from './theater-mouth.js';
import type { Cue } from './theater-subtitles.js';

const line = (start: number, text: string, length = 1.5): Cue => ({ start, end: start + length, text });

// A run of three lines ending at 105.5, then a twist line far later.
const RUN: Cue[] = [line(100, 'Where were you?'), line(102, 'Out.'), line(104, 'Out where?'), line(400, 'THE TWIN WAS REAL')];

test('a run of lines then a gap is a beat', () => {
  assert.equal(detectBeat({ cues: RUN, position: 105.5 + BEAT_GAP_SECONDS, lastBeatPosition: 90, capSeconds: 600 }), 'run-then-gap');
});

test('no beat while the gap is too short, or someone is mid-line', () => {
  assert.equal(detectBeat({ cues: RUN, position: 107, lastBeatPosition: 90, capSeconds: 600 }), null);
  assert.equal(detectBeat({ cues: RUN, position: 104.5, lastBeatPosition: 90, capSeconds: 600 }), null, 'mid-line');
});

test('an old gap is not a beat: the moment has passed', () => {
  assert.equal(detectBeat({ cues: RUN, position: 140, lastBeatPosition: 90, capSeconds: 600 }), null);
});

test('too few lines since the last beat is not a run', () => {
  assert.equal(detectBeat({ cues: RUN, position: 110, lastBeatPosition: 101, capSeconds: 600 }), null);
});

test('decided only from lines that have come on: later lines never count or trigger', () => {
  // Two lines heard, a crowd of lines still to come: no run yet.
  const cues = [line(100, 'a'), line(102, 'b'), line(111, 'c'), line(112, 'd'), line(113, 'e')];
  assert.equal(detectBeat({ cues, position: 110, lastBeatPosition: 90, capSeconds: 600 }), null);
  // Nothing has come on yet.
  assert.equal(detectBeat({ cues: [line(500, 'later')], position: 499, lastBeatPosition: 0, capSeconds: 60 }), null);
  // A line about to start right after the clock changes nothing either way.
  const withNext = [...RUN.slice(0, 3), line(110.2, 'NEXT')];
  assert.equal(detectBeat({ cues: withNext, position: 110, lastBeatPosition: 90, capSeconds: 600 }), 'run-then-gap');
});

test('a long stretch without a beat is a beat anyway, but never over a line', () => {
  const cues = [line(10, 'one quiet line')];
  assert.equal(detectBeat({ cues, position: 300, lastBeatPosition: 0, capSeconds: 240 }), 'long-stretch');
  assert.equal(detectBeat({ cues, position: 200, lastBeatPosition: 0, capSeconds: 240 }), null, 'not long enough yet');
  const talking = [line(10, 'x'), { start: 295, end: 305, text: 'a long speech' }];
  assert.equal(detectBeat({ cues: talking, position: 300, lastBeatPosition: 0, capSeconds: 240 }), null);
  // Nothing new said since the last beat: silence isn't a reason to talk.
  assert.equal(detectBeat({ cues, position: 300, lastBeatPosition: 20, capSeconds: 240 }), null);
});

test('rewinding behind the last beat counts from where she is', () => {
  assert.equal(detectBeat({ cues: RUN, position: 110, lastBeatPosition: 900, capSeconds: 600 }), null);
});

test('the chatty curve: 0 is patient, 50 is easy, 100 is a lot, and it only ever gets chattier', () => {
  assert.deepEqual(mouthPace(0), { minGapSeconds: 480, maxPerHour: 5, capSeconds: 1200 });
  assert.deepEqual(mouthPace(50), { minGapSeconds: 180, maxPerHour: 12, capSeconds: 540 });
  assert.deepEqual(mouthPace(100), { minGapSeconds: 75, maxPerHour: 30, capSeconds: 240 });
  assert.deepEqual(mouthPace(-20), mouthPace(0));
  assert.deepEqual(mouthPace(250), mouthPace(100));
  let last = mouthPace(0);
  for (let c = 5; c <= 100; c += 5) {
    const pace = mouthPace(c);
    assert.ok(pace.minGapSeconds <= last.minGapSeconds && pace.maxPerHour >= last.maxPerHour && pace.capSeconds <= last.capSeconds, `at ${c}`);
    last = pace;
  }
});

const NOW = 10_000_000;
function check(over: Partial<Omit<BeatCheck, 'night'>> & { night?: Partial<BeatCheck['night']> } = {}): BeatCheck {
  const { night, ...rest } = over;
  return {
    houseOn: true,
    position: 110,
    turnBusy: false,
    lastSaidAt: null,
    now: NOW,
    ...rest,
    night: {
      status: 'live',
      chatty: 50,
      mouthOn: true,
      cues: RUN,
      lastBeatPosition: 90,
      beatTimes: [],
      clock: { startedAt: NOW - 1000, positionAtStart: 109, paused: false, pausedAt: null },
      ...night,
    },
  };
}

test('the skip rules, each on its own', () => {
  assert.deepEqual(beatSkipReason(check()), { skip: null, kind: 'run-then-gap' });
  assert.deepEqual(beatSkipReason(check({ houseOn: false })), { skip: 'house-off' });
  assert.deepEqual(beatSkipReason(check({ night: { mouthOn: false } })), { skip: 'mouth-off' });
  assert.deepEqual(beatSkipReason(check({ night: { mouthOn: undefined } })), { skip: null, kind: 'run-then-gap' }, 'older nights default on');
  assert.deepEqual(beatSkipReason(check({ night: { status: 'ended' } })), { skip: 'not-live' });
  assert.deepEqual(beatSkipReason(check({ night: { clock: { startedAt: NOW - 1000, positionAtStart: 110, paused: true, pausedAt: NOW } } })), { skip: 'paused' });
  assert.deepEqual(beatSkipReason(check({ night: { cues: [] } })), { skip: 'no-subtitles' });
  assert.deepEqual(beatSkipReason(check({ turnBusy: true })), { skip: 'turn-running' });
  assert.deepEqual(beatSkipReason(check({ lastSaidAt: NOW - 10_000 })), { skip: 'she-spoke' });
  assert.deepEqual(beatSkipReason(check({ lastSaidAt: NOW - KAY_SPOKE_HOLD_MS - 1 })), { skip: null, kind: 'run-then-gap' });
  assert.deepEqual(beatSkipReason(check({ night: { beatTimes: [NOW - 60_000] } })), { skip: 'cooldown' });
  assert.deepEqual(beatSkipReason(check({ position: 107 })), { skip: 'no-beat' });
});

test('never more than the hourly cap, and beats older than an hour fall off', () => {
  // chatty 0: five an hour, eight minutes apart.
  const five = [50, 40, 30, 20, 10].map((m) => NOW - m * 60_000);
  assert.deepEqual(beatSkipReason(check({ night: { chatty: 0, beatTimes: five } })), { skip: 'hourly-cap' });
  const old = five.map((t) => t - 3_600_000);
  assert.deepEqual(beatSkipReason(check({ night: { chatty: 0, beatTimes: old } })), { skip: null, kind: 'run-then-gap' });
});
