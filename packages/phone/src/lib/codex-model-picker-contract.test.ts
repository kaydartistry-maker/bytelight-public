import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const phoneSrc = join(dirname(fileURLToPath(import.meta.url)), '..');
const expected = ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'];

test('House engine fallback carries the current GPT-6 Codex CLI shelf', () => {
  const source = readFileSync(join(phoneSrc, 'lib', 'house-engine.ts'), 'utf8');
  for (const id of expected) assert.match(source, new RegExp(`id: ['"]${id.replace('.', '\\.')}`));
});

test('Studio carries the current GPT-6 Codex shelf', () => {
  const source = readFileSync(join(phoneSrc, 'components', 'studio', 'constants.ts'), 'utf8');
  for (const id of expected) assert.match(source, new RegExp(`id: ['"]${id.replace('.', '\\.')}`));
});
