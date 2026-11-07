import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitMessage } from './split-message.js';

test('short text is one chunk', () => {
  assert.deepEqual(splitMessage('hello', 10, 0.5), ['hello']);
});

test('prefers a paragraph break past the floor', () => {
  assert.deepEqual(splitMessage('aaaaaaa\n\nbbbbbbb', 12, 0.5), ['aaaaaaa', 'bbbbbbb']);
});

test('falls back to a space, then a hard cut', () => {
  assert.deepEqual(splitMessage('aaaaaaa bbbbbbb', 10, 0.5), ['aaaaaaa', 'bbbbbbb']);
  assert.deepEqual(splitMessage('abcdefghijklmno', 10, 0.5), ['abcdefghij', 'klmno']);
});

test('a break below the floor is skipped', () => {
  // The only space sits at index 2: under 0.5 x 10, over 0.1 x 10.
  assert.deepEqual(splitMessage('ab cdefghijklmn', 10, 0.5), ['ab cdefghi', 'jklmn']);
  assert.deepEqual(splitMessage('ab cdefghijklmn', 10, 0.1), ['ab', 'cdefghijkl', 'mn']);
});
