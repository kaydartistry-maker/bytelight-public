import test from 'node:test';
import assert from 'node:assert/strict';
import { LOOK_KEYS, missingFonts, pickLook, sameLook, thumbSource, uniqueLookName, wearPatch, wornLook, type SavedLook } from './closet.js';
import type { AppTheme } from '../types';

const base = {
  mode: 'dark', id: 'cosmos', skin: 'cosmos', accentPalette: 'Mint',
  glass: { mode: 'texture', texture: 'data:image/webp;base64,AA', opacity: 40 },
  type: { title: 'Magic Retro', text: 'Inter' },
  wallpaper: 'data:image/jpeg;base64,FOREST',
  lockFace: 'classic', lockCards: 'dark', stickyNoteColors: ['#111111'],
  // furniture
  lockShortcuts: ['messages', 'notes'], homeWidgets: ['weather'], lockClockSize: 'small',
} as unknown as AppTheme;

test('a look carries styling and leaves the furniture behind', () => {
  const look = pickLook(base) as Record<string, unknown>;
  assert.equal(look.wallpaper, 'data:image/jpeg;base64,FOREST');
  assert.deepEqual(look.type, { title: 'Magic Retro', text: 'Inter' });
  assert.equal(look.lockFace, 'classic');
  assert.ok(!('lockShortcuts' in look) && !('homeWidgets' in look) && !('lockClockSize' in look));
  for (const k of ['lockShortcuts', 'homeWidgets', 'homeWidgetSpots', 'lockClockPosition', 'lockShow', 'lockSpotify']) {
    assert.ok(!(LOOK_KEYS as readonly string[]).includes(k), `${k} must stay furniture`);
  }
});

test('wearing a look replaces every look setting, clears leftovers, and keeps the furniture', () => {
  const moon = pickLook({ mode: 'dark', id: 'cosmos', movingWallpaper: true, movingPoster: 'data:image/jpeg;base64,MOON' } as AppTheme);
  const worn = { ...base, ...wearPatch(moon) } as AppTheme;
  assert.equal(worn.movingWallpaper, true);
  assert.equal(worn.wallpaper, undefined); // the forest doesn't linger
  assert.equal(worn.glass, undefined);
  assert.equal(worn.type, undefined);
  assert.deepEqual((worn as unknown as Record<string, unknown>).lockShortcuts, ['messages', 'notes']);
  assert.deepEqual((worn as unknown as Record<string, unknown>).homeWidgets, ['weather']);
});

test('she is "wearing" a saved look only when every look setting matches', () => {
  const saved: SavedLook[] = [{ id: 'a', name: 'Forest Retro', look: pickLook(base), thumb: null, hasMoving: false, bytes: 1, createdAt: 1, updatedAt: 1 }];
  assert.equal(wornLook(base, saved)?.name, 'Forest Retro');
  // Furniture changes don't make it "unsaved".
  assert.equal(wornLook({ ...base, homeWidgets: ['day'] } as unknown as AppTheme, saved)?.name, 'Forest Retro');
  // A styling change does.
  assert.equal(wornLook({ ...base, accentPalette: 'Rose' } as AppTheme, saved), null);
  // Key order and empty values don't matter.
  assert.ok(sameLook({ mode: 'dark', glass: { opacity: 40 } }, { glass: { opacity: 40 }, mode: 'dark', textOverride: null }));
});

test('fonts a look needs that are not on this device are named', () => {
  assert.deepEqual(missingFonts(pickLook(base), []), ['Magic Retro']);
  assert.deepEqual(missingFonts(pickLook(base), ['magic retro']), []);
  assert.deepEqual(missingFonts({}, []), []);
});

test('thumbnails come from what she sees most; names stay unique', () => {
  assert.equal(thumbSource(pickLook(base)), 'data:image/jpeg;base64,FOREST');
  assert.equal(thumbSource({ movingWallpaper: true, movingPoster: 'P', wallpaper: 'W' }), 'P');
  assert.equal(thumbSource({ slideshowEnabled: true, wallpapers: ['S1', 'S2'], wallpaper: 'W' }), 'S1');
  assert.equal(thumbSource({}), null);
  const saved = [{ name: 'Moon Chrome' }] as SavedLook[];
  assert.equal(uniqueLookName('moon chrome', saved), 'moon chrome 2');
  assert.equal(uniqueLookName('  ', []), 'My look');
});
