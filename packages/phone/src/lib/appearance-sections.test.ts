import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APPEARANCE_SECTIONS } from './apps.js';

test('advanced appearance links to every phone screen', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const union = app.match(/export type OsScreen\s*=([\s\S]*?);/)?.[1] ?? '';
  const screens = [...union.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  const linked = new Set(APPEARANCE_SECTIONS.map((section) => section.id));

  assert.ok(screens.length > 0, 'OsScreen must remain discoverable by this coverage test');
  assert.deepEqual(screens.filter((screen) => !linked.has(screen)), []);
  assert.ok(linked.has('settings'));
});
