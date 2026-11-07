import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_VARIANTS, getVariant } from './model-variants.js';

describe('Opus 5 model variant', () => {
  test('is a single 1M-default option with the official API id', () => {
    // By API id, not id prefix: Opus 5.5 ('opus-5-5') is its own model, and
    // a duplicate 1M row for Opus 5 would share 'claude-opus-5'.
    const opus5 = MODEL_VARIANTS.filter((variant) => variant.modelApiId === 'claude-opus-5');

    assert.equal(opus5.length, 1);
    const { id, label, modelApiId, contextWindow, betas } = opus5[0];
    assert.deepEqual({ id, label, modelApiId, contextWindow, betas }, {
      id: 'opus-5',
      label: 'Opus 5',
      modelApiId: 'claude-opus-5',
      contextWindow: 1_000_000,
      betas: [],
    });
    assert.equal(getVariant('claude-opus-5'), opus5[0]);
  });
});
