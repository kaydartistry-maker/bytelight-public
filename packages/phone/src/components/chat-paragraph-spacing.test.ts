// Copyright 2026 Byte-light contributors. Licensed under the Apache License 2.0.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

test('every chat markdown surface preserves full paragraph spacing', () => {
  for (const file of ['MessageBubble.tsx', 'MessageSegments.tsx', 'SpeakerBubbles.tsx']) {
    const source = readFileSync(join(here, file), 'utf8');
    assert.doesNotMatch(source, /prose-p:my-0/, `${file} must not collapse paragraph margins`);
    assert.match(source, /<p className="mb-3 last:mb-0">/, `${file} must draw a full gap between paragraphs`);
  }
});
