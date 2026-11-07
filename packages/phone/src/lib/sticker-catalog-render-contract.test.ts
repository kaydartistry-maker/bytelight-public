import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const phoneSrc = join(dirname(fileURLToPath(import.meta.url)), '..');

test('chat rerenders when the async sticker catalog becomes available', () => {
  const app = readFileSync(join(phoneSrc, 'App.tsx'), 'utf8');

  assert.match(
    app,
    /import\s*\{\s*subscribeStickers\s*\}\s*from\s*['"]\.\/bytelight\/stickers['"]/,
    'App must listen to the sticker catalog rather than leaving already-rendered refs literal',
  );
  assert.match(
    app,
    /subscribeStickers\(\(\)\s*=>\s*bumpStickerCatalogRevision\(\(revision\)\s*=>\s*revision\s*\+\s*1\)\)/,
    'catalog refresh must force the chat tree to render against the new ref index',
  );
});
