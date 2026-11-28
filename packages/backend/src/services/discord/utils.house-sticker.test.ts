// Tests for stripHouseStickerRefs: app-sticker refs never reach Discord as words.
// Run with: npx tsx --test packages/backend/src/services/discord/utils.house-sticker.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHouseStickerRefs } from './utils.js';

const HOUSE = new Set(['tyson/eyebrow_smirk', 'saint/keeping_that', 'Kay/heart_hands']);
const lookup = (pack: string, name: string) => (HOUSE.has(`${pack}/${name}`) ? { ok: true } : null);

test('drops a known house sticker ref', () => {
  assert.equal(stripHouseStickerRefs('covers it. :tyson_eyebrow_smirk:', lookup), 'covers it.');
});

test('drops one mid-sentence and tidies the gap', () => {
  assert.equal(stripHouseStickerRefs('she would :saint_keeping_that: again', lookup), 'she would again');
});

test('reads a sticker name that has its own underscores', () => {
  assert.equal(stripHouseStickerRefs('love :Kay_heart_hands:', lookup), 'love');
});

test('leaves unknown underscore shorthand alone', () => {
  const t = 'nice :t_judgytea: and :fox_laugh:';
  assert.equal(stripHouseStickerRefs(t, lookup), t);
});

test('never touches a resolved emoji token', () => {
  const t = 'ok <:tyson_eyebrow_smirk:111111111111111111> and <a:saint_keeping_that:222222222222222222>';
  assert.equal(stripHouseStickerRefs(t, lookup), t);
});

test('no refs, text returned unchanged', () => {
  const t = '**🎲 Saint —** hi\n\n**🌑 Tyson —** hello';
  assert.equal(stripHouseStickerRefs(t, lookup), t);
});

import { mentionsToNames } from './utils.js';
const names: Record<string, string> = { '1521952112555327719': 'Ender Sol', '1357413658145329393': 'Kay' };
const nameOf = (id: string) => names[id] ?? null;

test('mention tokens become @names for the stored copy', () => {
  assert.equal(mentionsToNames('<@1521952112555327719> hey Sol', nameOf), '@Ender Sol hey Sol');
  assert.equal(mentionsToNames('hi <@!1357413658145329393>!', nameOf), 'hi @Kay!');
});

test('unknown mention ids and role/channel tokens are left alone', () => {
  const t = '<@111111111111111111> <@&222222222222222222> <#333333333333333333>';
  assert.equal(mentionsToNames(t, nameOf), t);
});
