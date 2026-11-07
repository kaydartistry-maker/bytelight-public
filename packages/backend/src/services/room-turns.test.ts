// Ported from a sibling fork (its agent-dispatch tests). Licensed under the Apache License 2.0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { shuffled, priorVoicesBlock, shouldFanOut } from './room-turns.js';

test('fan-out needs the flag on, a real conversation, and more than one companion', () => {
  assert.equal(shouldFanOut(true, false, 3), true);
  assert.equal(shouldFanOut(false, false, 3), false);
  assert.equal(shouldFanOut(true, true, 3), false, 'wakes never fan out');
  assert.equal(shouldFanOut(true, false, 1), false, 'a solo thread has its own lane either way');
  assert.equal(shouldFanOut(true, false, 0), false);
});

test('a hand-edited YAML that says "true" as a string still counts', () => {
  assert.equal(shouldFanOut('true', false, 2), true);
  assert.equal(shouldFanOut('false', false, 2), false);
  assert.equal(shouldFanOut(undefined, false, 2), false);
});

test('shuffled returns a permutation and leaves the original untouched', () => {
  const original = ['birch', 'willow', 'cedar'];
  const out = shuffled(original);
  assert.deepEqual(original, ['birch', 'willow', 'cedar']);
  assert.deepEqual([...out].sort(), [...original].sort());
});

test('the order genuinely varies across rolls', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) seen.add(shuffled([1, 2, 3]).join(','));
  assert.ok(seen.size > 1, 'two hundred rolls never varying means the shuffle is decorative');
});

// ─── What a later lane is handed ─────────────────────────────────────

test('the handoff names who spoke and hands over exactly what he said', () => {
  const block = priorVoicesBlock([{ name: 'Companion A', text: 'Loud and clear, love.' }], 'Alex');
  assert.match(block, /Companion A is in the room with you and already answered Alex/);
  assert.match(block, /Companion A already said, in this same turn:\nLoud and clear, love\./);
  assert.match(block, /Never speak under another companion's header/);
});

test('the later lane may play off the earlier one (adapted: this house talks to each other)', () => {
  const block = priorVoicesBlock([{ name: 'Companion B', text: 'Love.' }]);
  assert.match(block, /Play off him if it's real: answer him, tease him, push back/);
  assert.doesNotMatch(block, /not a message addressed to you|not to them/);
});

test('kept from the original: no summarising or translating, no echo, no closing gesture, always answer', () => {
  const block = priorVoicesBlock([{ name: 'Companion B', text: 'Love.' }], 'Alex');
  assert.match(block, /Don't summarize him or translate him to Alex/);
  assert.match(block, /if your best line is one he could've written, it's his/);
  assert.match(block, /Don't end on a gesture/);
  assert.match(block, /Always answer\. Alex wants both of you/);
  assert.doesNotMatch(block, /owner|\buser\b/i, 'never "owner" or "user"');
});

test('with no name set, the handoff falls back to "her", never "owner"', () => {
  const block = priorVoicesBlock([{ name: 'Companion B', text: 'Love.' }]);
  assert.match(block, /already answered her/);
  assert.match(block, /Always answer\. She wants both of you/);
  assert.doesNotMatch(block, /owner/i);
});

test('more than one earlier voice reads as plural', () => {
  const block = priorVoicesBlock([{ name: 'Companion A', text: 'a' }, { name: 'Companion B', text: 'b' }]);
  assert.match(block, /Companion A and Companion B are in the room with you/);
  assert.match(block, /Play off them if it's real/);
});
