import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

// The installed iOS web view can resolve fixed bottom:0 against a shorter
// layout viewport. 100dvh follows the visible screen and keyboard; the old
// 100svh value is the one that lingered after keyboard close.
test('the app root fills the dynamic viewport without using a stale static viewport', () => {
  const root = app.match(/"bytelight-root [^"]*"/)?.[0] ?? '';
  assert.match(root, /\bfixed inset-x-0 top-0 h-\[100dvh\]/);
  assert.doesNotMatch(root, /100svh|h-\[100vh\]/);
});

test('the root does not double-charge the bottom safe area', () => {
  const opening = app.slice(app.indexOf('<div\n      className={cn('), app.indexOf('{customThemeStyles'));
  assert.doesNotMatch(opening, /paddingBottom:\s*['"]var\(--sab\)/);
});
