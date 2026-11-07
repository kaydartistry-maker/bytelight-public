import { test } from 'node:test';
import assert from 'node:assert';
import { isBackSwipe } from './edge-swipe.js';

const swipe = { startX: 8, dx: 120, dy: 6, elapsedMs: 220 };

test('a flick from the left edge is a back swipe', () => {
  assert.equal(isBackSwipe(swipe), true);
});

test('a swipe that starts away from the edge is not', () => {
  // Otherwise every horizontal scroll inside an app would navigate.
  assert.equal(isBackSwipe({ ...swipe, startX: 140 }), false);
});

test('a short nudge is not', () => {
  assert.equal(isBackSwipe({ ...swipe, dx: 30 }), false);
});

test('a diagonal drag is not', () => {
  assert.equal(isBackSwipe({ ...swipe, dy: 90 }), false);
});

test('a slow drag is not', () => {
  assert.equal(isBackSwipe({ ...swipe, elapsedMs: 1500 }), false);
});

test('a vertical scroll starting at the edge is not', () => {
  assert.equal(isBackSwipe({ startX: 4, dx: 80, dy: -46, elapsedMs: 300 }), false);
});

test('leftward movement is never a back swipe', () => {
  assert.equal(isBackSwipe({ ...swipe, dx: -120 }), false);
});
