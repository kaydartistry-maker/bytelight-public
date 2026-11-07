// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The lock screen's cards: one look for all three, dark, light, or read off
// the wallpaper behind them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LIGHT_WALLPAPER_L, behindTheCards, lockCardsOf, lookFromPixels, readWallpaperLook } from './lock-cards';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

/** `n` pixels of one RGBA color, the way a canvas hands them out. */
const pixels = (rgba: [number, number, number, number], n = 16) => Array.from({ length: n }, () => rgba).flat();

test('the owner switch: dark, light or auto, and anything else is dark, so nothing the owner has changes', () => {
  assert.equal(lockCardsOf(undefined), 'dark', 'unset is the dark cards the owner has always had');
  assert.equal(lockCardsOf('dark'), 'dark');
  assert.equal(lockCardsOf('light'), 'light');
  assert.equal(lockCardsOf('auto'), 'auto');
  for (const junk of ['Light', 'white', true, 1, null, {}]) assert.equal(lockCardsOf(junk), 'dark', `${JSON.stringify(junk)} is dark`);
});

test('auto reads how light the wallpaper is behind the cards', () => {
  assert.equal(lookFromPixels(pixels([255, 255, 255, 255])), 'light', 'white is light');
  assert.equal(lookFromPixels(pixels([230, 220, 205, 255])), 'light', 'cream is light');
  assert.equal(lookFromPixels(pixels([0, 0, 0, 255])), 'dark', 'black is dark');
  assert.equal(lookFromPixels(pixels([128, 128, 128, 255])), 'dark', `mid gray (about L* 54) is under ${LIGHT_WALLPAPER_L}, so dark`);
  assert.equal(lookFromPixels(pixels([20, 30, 70, 255])), 'dark', 'navy is dark');
  assert.equal(lookFromPixels(pixels([255, 255, 255, 0])), 'dark', 'a see-through picture shows the black under it');
  assert.equal(lookFromPixels([...pixels([255, 255, 255, 255], 12), ...pixels([0, 0, 0, 255], 4)]), 'light', 'mostly white is light');
  assert.equal(lookFromPixels([...pixels([255, 255, 255, 255], 4), ...pixels([0, 0, 0, 255], 12)]), 'dark', 'mostly black is dark');
  assert.equal(lookFromPixels([]), 'dark', 'nothing to read is dark');
});

test('what is behind the cards is the lower half of the screen, inside their margins, in the picture as the screen covers it', () => {
  // A picture the screen's own shape, at twice the size: the lower half of the screen is the lower half of the picture.
  assert.deepEqual(behindTheCards({ width: 800, height: 1600 }, { width: 400, height: 800 }), { sx: 40, sy: 800, sw: 720, sh: 800 });
  // A wide picture: scaled up to the screen's height and centered, so only its middle shows.
  const wide = behindTheCards({ width: 2000, height: 1000 }, { width: 400, height: 800 }, 0);
  assert.deepEqual(wide, { sx: 750, sy: 500, sw: 500, sh: 500 });
  assert.equal(behindTheCards({ width: 0, height: 100 }, { width: 400, height: 800 }), null, 'a picture with no size has nothing behind the cards');
});

test('with no way to read a picture, auto stays dark rather than guessing', async () => {
  assert.equal(await readWallpaperLook('/api/files/abc', { width: 400, height: 800 }), null);
});

test('the switch reaches the lock screen cards, from Settings, and nothing is blurred', () => {
  const lock = read('../components/LockScreen.tsx');
  assert.equal((lock.match(/\$\{ink\.card\}/g) ?? []).length, 3, 'the message card, the note card and the status card wear the look');
  assert.match(lock, /const look = useLockCardLook\(cards, wallpaper\);/, 'one look, from the owner switch and the wallpaper behind it');
  assert.doesNotMatch(lock, /rounded-2xl border border-white\/15 bg-black\/45/, 'no card keeps the old fixed dark');
  assert.match(read('../App.tsx'), /cards=\{lockCardsOf\(theme\.lockCards\)\}/, 'the owner switch reaches the lock screen');
  const settings = read('../components/SettingsDashboard.tsx');
  assert.match(settings, /\[\["dark", "Dark"\], \["light", "Light"\], \["auto", "Auto"\]\]/, 'Settings offers dark, light and auto');
  assert.match(settings, /onClick=\{\(\) => onThemeChange\(\{ lockCards: id \}\)\}/, 'and keeps their pick');
  for (const source of [lock, read('./lock-cards.ts')]) {
    assert.doesNotMatch(source, /backdrop-blur|backdrop-filter|backdropFilter/, 'nothing is blurred');
  }
});
