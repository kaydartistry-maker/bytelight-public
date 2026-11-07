import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

// Ported from Aerie: 100svh can hold the keyboard-up height for a couple of
// seconds after the keyboard closes, leaving a block of page color under the
// composer. Pinned to the screen's edges, the root follows the window at once.
test('the app root is pinned to the screen edges, not sized in viewport units', () => {
  const root = app.match(/"bytelight-root [^"]*"/)?.[0] ?? '';
  assert.match(root, /\bfixed inset-0\b/);
  assert.doesNotMatch(root, /100svh|100dvh|100vh/);
});
