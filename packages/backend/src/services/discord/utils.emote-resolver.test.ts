// Tests for resolveEmoteShorthand — the outbound :name: → <:name:id> resolver.
// Verifies token no-double-wrap, animated vs static, unknown-name passthrough,
// case sensitivity, and sticker-ref safety.
//
// Run with: npx tsx --test packages/backend/src/services/discord/utils.emote-resolver.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEmoteShorthand } from './utils.js';

type Emoji = { name: string; id: string; animated: boolean };

const INDEX: Emoji[] = [
  { name: 'kekw', id: '111111111111111111', animated: false },
  { name: 'catjam', id: '222222222222222222', animated: true },
  { name: 'companion_a_wink', id: '333333333333333333', animated: false },
];

test('static emoji becomes <:name:id>', () => {
  assert.equal(
    resolveEmoteShorthand('lol :kekw: yeah', INDEX),
    'lol <:kekw:111111111111111111> yeah',
  );
});

test('animated emoji becomes <a:name:id>', () => {
  assert.equal(
    resolveEmoteShorthand('vibe :catjam:', INDEX),
    'vibe <a:catjam:222222222222222222>',
  );
});

test('unknown name is left untouched (unicode shortcode)', () => {
  assert.equal(resolveEmoteShorthand('feeling :smile: today', INDEX), 'feeling :smile: today');
});

test('does NOT double-wrap a complete static token', () => {
  const already = 'here <:kekw:111111111111111111> stays';
  assert.equal(resolveEmoteShorthand(already, INDEX), already);
});

test('does NOT double-wrap a complete animated token', () => {
  const already = 'here <a:catjam:222222222222222222> stays';
  assert.equal(resolveEmoteShorthand(already, INDEX), already);
});

test('mixed: resolves bare shorthand while leaving existing token intact', () => {
  const out = resolveEmoteShorthand('<:kekw:111111111111111111> and :catjam:', INDEX);
  assert.equal(out, '<:kekw:111111111111111111> and <a:catjam:222222222222222222>');
});

test('case-sensitive: :KEKW: does not match :kekw:', () => {
  assert.equal(resolveEmoteShorthand('yell :KEKW:', INDEX), 'yell :KEKW:');
});

test('multiple occurrences of the same emoji all resolve', () => {
  assert.equal(
    resolveEmoteShorthand(':kekw: :kekw:', INDEX),
    '<:kekw:111111111111111111> <:kekw:111111111111111111>',
  );
});

test('sticker ref :companion_a_wink: only rewrites on a genuine same-name emoji', () => {
  // With a colliding emoji present, it resolves (documented ambiguity).
  assert.equal(
    resolveEmoteShorthand(':companion_a_wink:', INDEX),
    '<:companion_a_wink:333333333333333333>',
  );
  // Without a matching emoji in the index, the sticker ref passes through untouched.
  assert.equal(
    resolveEmoteShorthand(':companion_b_grin:', INDEX),
    ':companion_b_grin:',
  );
});

test('empty index is identity', () => {
  assert.equal(resolveEmoteShorthand(':kekw: :catjam:', []), ':kekw: :catjam:');
});

test('empty text is identity', () => {
  assert.equal(resolveEmoteShorthand('', INDEX), '');
});

test('adjacent emojis both resolve', () => {
  assert.equal(
    resolveEmoteShorthand(':kekw::catjam:', INDEX),
    '<:kekw:111111111111111111><a:catjam:222222222222222222>',
  );
});

test('repairs a hand-typed token with the wrong animated flag', () => {
  assert.equal(
    resolveEmoteShorthand('woo <:catjam:222222222222222222>', INDEX),
    'woo <a:catjam:222222222222222222>',
  );
  assert.equal(
    resolveEmoteShorthand('lol <a:kekw:111111111111111111>', INDEX),
    'lol <:kekw:111111111111111111>',
  );
});

test('repairs a known name typed with a stale id', () => {
  assert.equal(
    resolveEmoteShorthand('vibe <a:catjam:999999999999999999>', INDEX),
    'vibe <a:catjam:222222222222222222>',
  );
});

test('leaves an unknown complete token as written', () => {
  const t = 'other server <a:goos:751117409040990328>';
  assert.equal(resolveEmoteShorthand(t, INDEX), t);
});
