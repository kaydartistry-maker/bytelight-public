import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProviderSpend } from './provider-spend';

test('provider spend parses the monthly ledger response', () => {
  assert.deepEqual(parseProviderSpend({ providers: [{ provider: 'groq', requestCount: 2, inputTokens: 10, outputTokens: 5, costUsd: 0.25, spend: { usedFormatted: '$0.25' } }] }), [{ provider: 'groq', requestCount: 2, inputTokens: 10, outputTokens: 5, costUsd: 0.25, spend: { usedFormatted: '$0.25' } }]);
});

test('provider spend rejects a malformed response', () => {
  assert.deepEqual(parseProviderSpend({ providers: null }), []);
});
