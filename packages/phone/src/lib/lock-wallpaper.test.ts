import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveLockBackgroundTheme } from '../components/LockScreen';
import type { AppTheme } from '../types';

const base: AppTheme = { id: 'magenta', mode: 'dark', wallpaper: '/legacy-home.png' };

test('absent theme, empty appearance and unrelated controls retain the exact legacy lock branch', () => {
  assert.equal(resolveLockBackgroundTheme(undefined, '/filtered-lock.png'), undefined);
  assert.equal(resolveLockBackgroundTheme(base, '/filtered-lock.png'), undefined);
  assert.equal(resolveLockBackgroundTheme({ ...base, appearance: { version: 1 } }, '/filtered-lock.png'), undefined);
  assert.equal(resolveLockBackgroundTheme({ ...base, appearance: { version: 1, cards: { blur: 20 } } }, '/filtered-lock.png'), undefined);
});

test('lock effects use supplied wallpaper, default opacity 60 and never a slideshow', () => {
  const theme: AppTheme = { ...base, wallpapers: ['/a.png', '/b.png'], slideshowEnabled: true,
    appearance: { version: 1, wallpaper: { zoom: 130, blur: 5, positionX: 20 } } };
  const result = resolveLockBackgroundTheme(theme, '/filtered-lock.png')!;
  assert.equal(result.wallpaper, '/filtered-lock.png');
  assert.equal(result.slideshowEnabled, false);
  assert.equal(result.wallpapers, undefined);
  assert.deepEqual(result.appearance?.wallpaper, { opacity: 60, zoom: 130, blur: 5, positionX: 20 });
  assert.equal(theme.appearance?.wallpaper?.opacity, undefined);
  assert.equal(theme.slideshowEnabled, true);
});

test('an explicit lock wallpaper wins over the global asset but keeps chosen effects and opacity', () => {
  const theme: AppTheme = { ...base, lockScreenWallpaper: '/dedicated-lock.png', appearance: {
    version: 1, wallpaper: { assetId: 'global-image', opacity: 35, fit: 'contain', dim: 20, colorWash: { color: '#abc', opacity: 10 } },
  } };
  const result = resolveLockBackgroundTheme(theme, '/dedicated-lock.png')!;
  assert.equal(result.wallpaper, '/dedicated-lock.png');
  assert.equal(result.appearance?.wallpaper?.assetId, undefined);
  assert.equal(result.appearance?.wallpaper?.opacity, 35);
  assert.equal(result.appearance?.wallpaper?.fit, 'contain');
  assert.deepEqual(result.appearance?.wallpaper?.colorWash, { color: '#abc', opacity: 10 });
  assert.equal(theme.appearance?.wallpaper?.assetId, 'global-image');
});

test('global appearance assets work as lock fallback even when no legacy image exists', () => {
  const result = resolveLockBackgroundTheme({ ...base, wallpaper: undefined, appearance: {
    version: 1, wallpaper: { assetId: 'new-wallpaper', opacity: 0 },
  } });
  assert.equal(result?.appearance?.wallpaper?.assetId, 'new-wallpaper');
  assert.equal(result?.appearance?.wallpaper?.opacity, 0);
  assert.equal(result?.slideshowEnabled, false);
});

test('filtered wallpaper is not recovered from private legacy fields when unavailable', () => {
  const theme: AppTheme = { ...base, lockScreenWallpaper: '/private-lock.png', appearance: {
    version: 1, wallpaper: { assetId: 'private-global', blur: 5 },
  } };
  assert.equal(resolveLockBackgroundTheme(theme, undefined), undefined);
  assert.equal(resolveLockBackgroundTheme({ ...base, appearance: { version: 1, wallpaper: { zoom: 120 } } }), undefined);
});

test('lock frame contains optional shared background while the original paint remains untouched', () => {
  const source = readFileSync(new URL('../components/LockScreen.tsx', import.meta.url), 'utf8');
  assert.match(source, /backgroundTheme\?: AppTheme/);
  assert.match(source, /themedBackground \? <AppBackground theme=\{themedBackground\}/);
  assert.match(source, /absolute inset-0 z-0 bg-cover bg-center opacity-60/);
  assert.match(source, /!wallpaper && !backgroundAsset/);
  assert.match(source, /backgroundAsset \? themeAssetUrl\(backgroundAsset\) : wallpaper/);
});
