import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { openRouterCacheSessionId } from './api-router.js';

describe('OpenRouter cache routing key', () => {
  test('is stable, private, model-scoped, and comfortably below the provider limit', () => {
    const first = openRouterCacheSessionId('thread-private-name', 'openrouter/google/gemini-4-argon');
    const again = openRouterCacheSessionId('thread-private-name', 'openrouter/google/gemini-4-argon');
    const otherModel = openRouterCacheSessionId('thread-private-name', 'openrouter/google/gemini-4-neon');

    assert.equal(first, again);
    assert.notEqual(first, otherModel);
    assert.match(first, /^bl-[a-f0-9]{32}$/);
    assert.ok(!first.includes('thread-private-name'));
    assert.ok(first.length <= 256);
  });
});
