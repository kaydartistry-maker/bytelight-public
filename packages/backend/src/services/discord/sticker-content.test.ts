// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { test } from 'node:test';
import assert from 'node:assert';
import { composeIncomingContent, stickerTokensFor, stickerNamesIn } from './sticker-content.js';

// A tiny stand-in for the shape the gateway actually iterates: message.stickers
// is a Collection, and all this code needs from it is values().
const msg = (stickers: Array<{ name: string; id: string; format: number }>) =>
  ({ stickers: { values: () => stickers[Symbol.iterator]() } }) as never;

test('a sticker-only message still says something', () => {
  const tokens = stickerTokensFor([msg([{ name: 'peacekiss', id: '123', format: 1 }])]);
  const content = composeIncomingContent('', tokens);
  assert.notStrictEqual(content, '', 'a sticker with no text must not arrive as an empty message');
  assert.ok(content.includes('peacekiss'), 'and its name has to be in what we are handed');
});

test('text and sticker both survive, text first', () => {
  const tokens = stickerTokensFor([msg([{ name: 'bruh', id: '9', format: 1 }])]);
  const content = composeIncomingContent('look at this', tokens);
  assert.ok(content.startsWith('look at this'));
  assert.ok(content.includes('<dsticker:bruh:9.png>'));
});

test('animated stickers are gifs, lottie is skipped entirely', () => {
  const tokens = stickerTokensFor([msg([
    { name: 'wiggle', id: '1', format: 4 },
    { name: 'lottiething', id: '2', format: 3 },
    { name: 'still', id: '3', format: 1 },
  ])]);
  assert.deepStrictEqual(tokens, ['<dsticker:wiggle:1.gif>', '<dsticker:still:3.png>']);
});

test('colons and brackets in a name cannot break the token', () => {
  const [token] = stickerTokensFor([msg([{ name: 'we<ird:na>me', id: '7', format: 1 }])]);
  assert.strictEqual(token, '<dsticker:weirdname:7.png>');
  assert.deepStrictEqual(stickerNamesIn(token), ['weirdname']);
});

test('no stickers changes nothing at all', () => {
  assert.strictEqual(composeIncomingContent('just words', []), 'just words');
  assert.deepStrictEqual(stickerTokensFor([msg([])]), []);
});

test('names can be read back out of a composed message', () => {
  const tokens = stickerTokensFor([
    msg([{ name: 'one', id: '1', format: 1 }]),
    msg([{ name: 'two', id: '2', format: 4 }]),
  ]);
  assert.deepStrictEqual(stickerNamesIn(composeIncomingContent('hi', tokens)), ['one', 'two']);
});
