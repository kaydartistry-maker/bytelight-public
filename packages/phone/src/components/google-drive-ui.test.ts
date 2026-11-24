import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./GoogleDriveApp.tsx', import.meta.url), 'utf8');

test('Google setup distinguishes the callback URI from a destination and supplies a real copy control', () => {
  assert.match(source, /Do not open this address/);
  assert.match(source, /Copy redirect URI/);
  assert.match(source, /copyToClipboard\(callback\)/);
  assert.match(source, /Open Google Cloud setup/);
});

test('callback URI comes from backend truth when available', () => {
  assert.match(source, /status\?\.redirectUri \|\|/);
});
