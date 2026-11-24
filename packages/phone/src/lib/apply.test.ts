import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUnapplied, stableKey } from './apply.js';

test('nothing changed: no prompt', () => {
  const theme = { mode: 'dark', glass: { opacity: 72, blur: 14 } };
  const settings = { osName: 'X', dockAppIds: ['a', 'b'] };
  assert.equal(hasUnapplied({ theme, settings }, { ...theme, glass: { blur: 14, opacity: 72 } }, { ...settings }), false);
  assert.equal(hasUnapplied(null, theme, settings), false);
});

test('any look or setting change counts; empty values do not', () => {
  const snap: { theme: Record<string, unknown>; settings: Record<string, unknown> } = { theme: { mode: 'dark', accentPalette: 'Mint' }, settings: { osName: 'X' } };
  assert.equal(hasUnapplied(snap, { mode: 'dark', accentPalette: 'Rose' }, { osName: 'X' }), true);
  assert.equal(hasUnapplied(snap, { mode: 'dark', accentPalette: 'Mint' }, { osName: 'Y' }), true);
  assert.equal(hasUnapplied(snap, { mode: 'dark', accentPalette: 'Mint', textOverride: null }, { osName: 'X', appLogo: undefined }), false);
  // Order of a list matters (the dock order is hers).
  assert.notEqual(stableKey(['a', 'b']), stableKey(['b', 'a']));
});
