import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, findBytelightConfigPath } from '../config.js';

// `npm start` runs the backend from packages/backend while pm2 runs it from
// the project root. The preferences route must find bytelight.yaml the way the
// loader does — from PROJECT_ROOT — or saving works under one and not the other.

const here = dirname(fileURLToPath(import.meta.url));
const routeSource = readFileSync(join(here, 'preferences-routes.ts'), 'utf-8');

test('the preferences route locates the config with the loader\'s finder', () => {
  assert.match(routeSource, /findBytelightConfigPath\(\)/);
  assert.doesNotMatch(routeSource, /resolve\(name\)/, 'no working-directory lookup');
  assert.doesNotMatch(routeSource, /function findConfigPath/);
});

test('the finder answers the same from any working directory', () => {
  const before = process.cwd();
  const fromHere = findBytelightConfigPath();
  try {
    process.chdir(join(PROJECT_ROOT, 'packages', 'backend'));
    assert.equal(findBytelightConfigPath(), fromHere);
    process.chdir('/');
    assert.equal(findBytelightConfigPath(), fromHere);
  } finally {
    process.chdir(before);
  }
  if (fromHere) assert.ok(fromHere.startsWith(PROJECT_ROOT));
});

test('a missing config is an error on read, not an empty success', () => {
  assert.match(routeSource, /res\.status\(404\)\.json\(\{ error: 'No config file found' \}\);[\s\S]*router\.put\('\/preferences'/);
});
