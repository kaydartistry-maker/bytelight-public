import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppTheme } from '../types';
import { reconcileThemeSnapshot, themeFirstPaintCache } from './theme-state';

const defaults: AppTheme = { mode: 'dark', id: 'cobalt' };
test('complete saved looks clear removed wallpapers and overrides on other devices', () => {
  const previous: AppTheme = { mode: 'dark', id: 'magenta', wallpaper: 'old-image', skin: 'cosmos', appearance: { version: 1, cards: { fill: { color: '#ff0000' } } } };
  assert.deepEqual(reconcileThemeSnapshot(previous, { mode: 'light', id: 'blush' }, defaults), { mode: 'light', id: 'blush' });
  assert.equal(previous.wallpaper, 'old-image');
});
test('historical partial snapshots preserve unspecified cached preferences', () => {
  const previous: AppTheme = { mode: 'dark', id: 'magenta', shapeRadius: 18 };
  assert.deepEqual(reconcileThemeSnapshot(previous, { mode: 'light' } as AppTheme, defaults), { ...previous, mode: 'light' });
});
test('first-paint cache strips wallpaper bytes and IDs without mutating saved data', () => {
  const saved: AppTheme = { mode: 'dark', id: 'magenta', wallpaper: 'old-image', lockScreenWallpaper: 'lock-image', wallpapers: ['slide'],
    appearance: { version: 1, wallpaper: { assetId: 'asset-1', blur: 3 }, cards: { border: { width: 2 } } } };
  const cache = themeFirstPaintCache(saved);
  assert.equal(cache.wallpaper, undefined);
  assert.equal(cache.lockScreenWallpaper, undefined);
  assert.equal(cache.wallpapers, undefined);
  assert.equal(cache.appearance?.wallpaper?.assetId, undefined);
  assert.equal(cache.appearance?.wallpaper?.blur, 3);
  assert.equal(cache.appearance?.cards?.border?.width, 2);
  assert.equal(saved.appearance?.wallpaper?.assetId, 'asset-1');
  assert.equal(saved.wallpaper, 'old-image');
});
