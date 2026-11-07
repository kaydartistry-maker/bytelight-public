import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffortForModel, type ThinkingEffort } from './thinking-effort.js';

describe('resolveEffortForModel', () => {
  describe('explicit override (configured !== auto)', () => {
    for (const [configured, model] of [
      ['low', 'claude-opus-4-7'],
      ['high', 'claude-opus-5'],
      ['medium', 'claude-opus-4-7'],
      ['high', 'claude-opus-4-7'],
      ['xhigh', 'claude-opus-4-7'],
      ['max', 'claude-opus-4-7'],
      ['low', 'claude-haiku-4-5'],
      ['max', 'claude-sonnet-4-6'],
    ] as Array<[ThinkingEffort, string]>) {
      it(`returns ${configured} verbatim regardless of model ${model}`, () => {
        assert.equal(resolveEffortForModel(model, configured), configured);
      });
    }

    it('respects explicit max even on Haiku (no second-guessing)', () => {
      // Even though Haiku doesn't actually support max — that's the SDK's
      // problem, not the resolver's. User intent wins.
      assert.equal(resolveEffortForModel('claude-haiku-4-5', 'max'), 'max');
    });
  });

  describe('auto resolution', () => {
    for (const [model, expected] of [
      ['claude-opus-4-7', 'high'],
      ['claude-opus-4-6', 'high'],
      ['claude-opus-4-5', 'high'],
      ['opus', 'high'],
      ['claude-sonnet-4-6', 'high'],
      ['claude-sonnet-4-5', 'high'],
      ['sonnet', 'high'],
    ] as Array<[string, string]>) {
      it(`Opus/Sonnet model ${model} resolves auto → ${expected}`, () => {
        assert.equal(resolveEffortForModel(model, 'auto'), expected);
      });
    }

    for (const [model, expected] of [
      ['claude-haiku-4-5', 'medium'],
      ['haiku', 'medium'],
      ['claude-haiku-4', 'medium'],     // future variant
      ['CLAUDE-HAIKU-5-0', 'medium'],   // case-insensitive guard
    ] as Array<[string, string]>) {
      it(`Haiku-family ${model} resolves auto → ${expected}`, () => {
        assert.equal(resolveEffortForModel(model, 'auto'), expected);
      });
    }

    it('falls through to high for unknown future model IDs', () => {
      // Defensive: a model class we don't know about yet shouldn't get
      // medium (the lightweight default). 'high' is the safe baseline.
      assert.equal(resolveEffortForModel('claude-mythos-preview', 'auto'), 'high');
      assert.equal(resolveEffortForModel('claude-something-new-1', 'auto'), 'high');
    });
  });

  describe('missing / invalid configured value', () => {
    it('treats undefined as auto', () => {
      assert.equal(resolveEffortForModel('claude-opus-4-7', undefined), 'high');
      assert.equal(resolveEffortForModel('claude-haiku-4-5', undefined), 'medium');
    });

    it('treats unknown string as auto (no surprise passthrough)', () => {
      // Defensive: a stale config with a typo or removed value should
      // fall back to safe defaults, not be sent verbatim to the SDK.
      assert.equal(resolveEffortForModel('claude-opus-4-7', 'frenzied'), 'high');
      assert.equal(resolveEffortForModel('claude-opus-4-7', ''), 'high');
    });
  });

  describe('conservative-by-default invariants', () => {
    it('auto never returns xhigh or max for any current model', () => {
      const models = [
        'claude-opus-5', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5',
        'claude-sonnet-4-6', 'claude-sonnet-4-5',
        'claude-haiku-4-5',
        'opus', 'sonnet', 'haiku',
      ];
      for (const model of models) {
        const resolved = resolveEffortForModel(model, 'auto');
        assert.notEqual(resolved, 'xhigh');
        assert.notEqual(resolved, 'max');
      }
    });
  });
});
