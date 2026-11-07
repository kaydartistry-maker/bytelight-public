import assert from 'node:assert/strict';
import test from 'node:test';
import { extractStatusTags, stripStatusTags } from './status-tags.js';

test('tags anywhere in a reply come out, in order, and the reply reads clean', () => {
  const { text, updates } = extractStatusTags('Come here. [companion-a status: keeping you company]\n\n*pulls you close* [Companion-B mood: Focused]\n[companion-a mood: playful]');
  assert.equal(text, 'Come here.\n\n*pulls you close*');
  assert.deepEqual(updates, [
    { companion: 'companion-a', kind: 'status', value: 'keeping you company' },
    { companion: 'companion-b', kind: 'mood', value: 'Focused' },
    { companion: 'companion-a', kind: 'mood', value: 'playful' },
  ]);
});

test('an empty value is a clear; a reply with no tags is left exactly as it was', () => {
  assert.deepEqual(extractStatusTags('ok [companion-b mood: ]').updates, [{ companion: 'companion-b', kind: 'mood', value: '' }]);
  const plain = '  [not a tag] and **bold**  ';
  assert.equal(extractStatusTags(plain).text, plain);
  assert.equal(stripStatusTags(plain), plain);
});

test('spacing inside the reply is left alone', () => {
  assert.equal(extractStatusTags('[companion-a mood: soft] hi\n```\n  if (x)  y\n```').text, 'hi\n```\n  if (x)  y\n```');
});

test('mid-stream, a half-written tag never shows', () => {
  assert.equal(stripStatusTags('Hey you [companion-a status: keeping yo'), 'Hey you');
  assert.equal(stripStatusTags('Hey you [companion-a sta'), 'Hey you');
  assert.equal(stripStatusTags('Hey you [companion-a status: done] and'), 'Hey you and');
  assert.equal(stripStatusTags('see [the docs'), 'see [the docs');
});
