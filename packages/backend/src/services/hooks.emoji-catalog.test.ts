// Tests for buildEmojiCatalogBlock — the pure helper that renders the connected
// guilds' custom emojis into the Discord-only orientation block. Verifies the
// text block builds without any gateway or hook context.
//
// Run with: npx tsx --test packages/backend/src/services/hooks.emoji-catalog.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEmojiCatalogBlock } from './hooks.js';

type Emoji = { name: string; id: string; animated: boolean; guild: string };

test('returns null on empty input', () => {
  assert.equal(buildEmojiCatalogBlock([]), null);
});

test('renders :name: shorthand for a static emoji', () => {
  const input: Emoji[] = [
    { name: 'kekw', id: '111', animated: false, guild: 'Server A' },
  ];
  const out = buildEmojiCatalogBlock(input);
  assert.ok(out, 'should return non-null');
  assert.match(out!, /:kekw:/);
  assert.doesNotMatch(out!, /animated/); // static emoji carries no animated tag
});

test('flags animated emojis', () => {
  const input: Emoji[] = [
    { name: 'catjam', id: '222', animated: true, guild: 'Server A' },
  ];
  const out = buildEmojiCatalogBlock(input);
  assert.ok(out);
  assert.match(out!, /:catjam: \(animated\)/);
});

test('groups by guild', () => {
  const input: Emoji[] = [
    { name: 'a', id: '1', animated: false, guild: 'Alpha' },
    { name: 'b', id: '2', animated: false, guild: 'Alpha' },
    { name: 'c', id: '3', animated: false, guild: 'Beta' },
  ];
  const out = buildEmojiCatalogBlock(input);
  assert.ok(out);
  assert.match(out!, /Alpha: :a:, :b:/);
  assert.match(out!, /Beta: :c:/);
});

test('teaches the :name: usage rule in the header', () => {
  const input: Emoji[] = [
    { name: 'x', id: '9', animated: false, guild: 'Server A' },
  ];
  const out = buildEmojiCatalogBlock(input);
  assert.ok(out);
  const lines = out!.split('\n');
  assert.ok(lines[0].startsWith('CUSTOM EMOJIS'), 'first line is the CUSTOM EMOJIS header');
  assert.ok(lines[0].includes('case-sensitive'), 'header states case sensitivity');
  assert.equal(lines[1], '  Available now:');
  assert.equal(lines[2], '    Server A: :x:');
});
