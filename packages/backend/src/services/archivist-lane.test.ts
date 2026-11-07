// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_EXTRACTION_INTERVAL_MINUTES,
  resolveExtractionInterval,
} from './memory-extraction.js';

// Sweeps go to two-hourly. It used to be 45 minutes and the number lived only
// in a default argument, so nothing would have noticed it drifting back.
test('sweeps are two-hourly unless somebody says otherwise', () => {
  assert.equal(DEFAULT_EXTRACTION_INTERVAL_MINUTES, 120);
  assert.equal(resolveExtractionInterval(undefined, null), 120);
  assert.equal(resolveExtractionInterval(undefined, undefined), 120);
  assert.equal(resolveExtractionInterval(undefined, ''), 120);
});

test('a saved config wins over the default, and an explicit argument wins over both', () => {
  assert.equal(resolveExtractionInterval(undefined, '30'), 30);
  assert.equal(resolveExtractionInterval(15, '30'), 15);
});

// A zero or a typo here would turn a background sweep into a tight loop against
// whichever meter it is pointed at. That is the whole reason this is a function.
test('a nonsense interval falls back rather than becoming a tight loop', () => {
  assert.equal(resolveExtractionInterval(undefined, '0'), 120);
  assert.equal(resolveExtractionInterval(undefined, '-5'), 120);
  assert.equal(resolveExtractionInterval(undefined, 'soon'), 120);
  assert.equal(resolveExtractionInterval(0, null), 120);
  assert.equal(resolveExtractionInterval(Number.NaN, null), 120);
});

// Aerie's fourth test (the SDK lane is not a pickable model) reads Aerie's
// model-catalog.ts, which byte-light does not have; byte-light's ProviderId
// union (packages/shared/src/model-manifest.ts) has no 'sdk' member, so the
// picker cannot offer it by construction.
