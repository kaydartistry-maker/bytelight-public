// Tests for stripHouseStickerRefs: app-sticker refs never reach Discord as words.
// Run with: npx tsx --test packages/backend/src/services/discord/utils.house-sticker.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHouseStickerRefs } from './utils.js';

const HOUSE = new Set(['rook/eyebrow_smirk', 'ivy/keeping_that', 'Owner/heart_hands']);
const lookup = (pack: string, name: string) => (HOUSE.has(`${pack}/${name}`) ? { ok: true } : null);

test('drops a known house sticker ref', () => {
  assert.equal(stripHouseStickerRefs('covers it. :rook_eyebrow_smirk:', lookup), 'covers it.');
});

test('drops one mid-sentence and tidies the gap', () => {
  assert.equal(stripHouseStickerRefs('she would :ivy_keeping_that: again', lookup), 'she would again');
});

test('reads a sticker name that has its own underscores', () => {
  assert.equal(stripHouseStickerRefs('love :Owner_heart_hands:', lookup), 'love');
});

test('leaves unknown underscore shorthand alone', () => {
  const t = 'nice :t_judgytea: and :fox_laugh:';
  assert.equal(stripHouseStickerRefs(t, lookup), t);
});

test('never touches a resolved emoji token', () => {
  const t = 'ok <:rook_eyebrow_smirk:111111111111111111> and <a:ivy_keeping_that:222222222222222222>';
  assert.equal(stripHouseStickerRefs(t, lookup), t);
});

test('no refs, text returned unchanged', () => {
  const t = '**🎲 Ivy —** hi\n\n**🌑 Rook —** hello';
  assert.equal(stripHouseStickerRefs(t, lookup), t);
});

import { mentionsToNames } from './utils.js';
const names: Record<string, string> = { '111111111111111111': 'Nim', '222222222222222222': 'Owner' };
const nameOf = (id: string) => names[id] ?? null;

test('mention tokens become @names for the stored copy', () => {
  assert.equal(mentionsToNames('<@111111111111111111> hey Nim', nameOf), '@Nim hey Nim');
  assert.equal(mentionsToNames('hi <@!222222222222222222>!', nameOf), 'hi @Owner!');
});

test('unknown mention ids and role/channel tokens are left alone', () => {
  const t = '<@111111111111111111> <@&222222222222222222> <#333333333333333333>';
  assert.equal(mentionsToNames(t, nameOf), t);
});
