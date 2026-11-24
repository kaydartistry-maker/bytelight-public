// The Theater's clock: play, pause, seek, resync, never negative; and the
// lookback window never reaching past the clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clockPosition,
  formatClock,
  lastLines,
  lookbackWindow,
  newClock,
  pauseClock,
  resumeClock,
  resyncClock,
  seekClock,
  setClock,
} from './theater-clock.js';
import type { Cue } from './theater-subtitles.js';

const T0 = 1_700_000_000_000;

test('a new clock waits at zero until she presses play', () => {
  const c = newClock(T0);
  assert.equal(clockPosition(c, T0 + 60_000), 0);
  const running = resumeClock(c, T0 + 1000);
  assert.equal(clockPosition(running, T0 + 11_000), 10);
});

test('pause freezes it, resume carries on from there', () => {
  let c = resumeClock(newClock(T0), T0);
  c = pauseClock(c, T0 + 30_000);
  assert.equal(c.paused, true);
  assert.equal(c.pausedAt, T0 + 30_000);
  assert.equal(clockPosition(c, T0 + 90_000), 30);
  assert.equal(pauseClock(c, T0 + 95_000), c, 'pausing a paused clock changes nothing');
  c = resumeClock(c, T0 + 100_000);
  assert.equal(clockPosition(c, T0 + 105_000), 35);
  assert.equal(resumeClock(c, T0 + 106_000), c, 'playing a running clock changes nothing');
});

test('seek ±5s works running and paused, and never goes below zero', () => {
  let c = resumeClock(newClock(T0), T0);
  c = seekClock(c, 5, T0 + 10_000);
  assert.equal(clockPosition(c, T0 + 10_000), 15);
  assert.equal(clockPosition(c, T0 + 12_000), 17, 'still running after a seek');
  c = seekClock(c, -60, T0 + 12_000);
  assert.equal(clockPosition(c, T0 + 12_000), 0);
  c = pauseClock(c, T0 + 13_000);
  c = seekClock(c, -5, T0 + 14_000);
  assert.equal(clockPosition(c, T0 + 20_000), 0);
  c = seekClock(c, 5, T0 + 20_000);
  assert.equal(clockPosition(c, T0 + 50_000), 5, 'paused seek stays paused');
  assert.equal(clockPosition(setClock(c, -10, T0), T0), 0);
  assert.equal(clockPosition(setClock(c, Number.NaN, T0), T0), 0);
});

test('resync takes the TV time, playing or paused', () => {
  const c = resumeClock(newClock(T0), T0);
  const playing = resyncClock(c, 1421, true, T0 + 5000);
  assert.equal(clockPosition(playing, T0 + 7000), 1423);
  const held = resyncClock(c, 1421, false, T0 + 5000);
  assert.equal(held.paused, true);
  assert.equal(clockPosition(held, T0 + 70_000), 1421);
  assert.equal(clockPosition(resyncClock(c, -3, true, T0), T0 + 1000), 1, 'negative resync starts at zero');
});

test('a clock somehow set below zero still reads zero', () => {
  assert.equal(clockPosition({ startedAt: T0, positionAtStart: -50, paused: false, pausedAt: null }, T0 + 1000), 0);
});

const cues: Cue[] = [
  { start: 10, end: 12, text: 'early' },
  { start: 100, end: 103, text: 'a' },
  { start: 150, end: 152, text: 'b' },
  { start: 189, end: 195, text: 'on screen now' },
  { start: 191, end: 193, text: 'one second later' },
  { start: 400, end: 402, text: 'the twist' },
];

test('the lookback window holds the last 90s behind the clock and nothing after it', () => {
  const heard = lookbackWindow(cues, 190);
  assert.deepEqual(heard.map((c) => c.text), ['a', 'b', 'on screen now']);
  for (let position = 0; position <= 500; position += 0.5) {
    for (const cue of lookbackWindow(cues, position)) {
      assert.ok(cue.start <= position, `cue at ${cue.start} leaked into a window at ${position}`);
      assert.ok(cue.start >= position - 90);
    }
  }
  assert.deepEqual(lookbackWindow(cues, 0), []);
  assert.deepEqual(lastLines(cues, 192).map((c) => c.text), ['on screen now', 'one second later']);
  assert.deepEqual(lastLines(cues, 5), []);
});

test('formatClock', () => {
  assert.equal(formatClock(1421.9), '00:23:41');
  assert.equal(formatClock(-4), '00:00:00');
  assert.equal(formatClock(3 * 3600 + 5), '03:00:05');
});
