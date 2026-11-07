import assert from 'node:assert/strict';
import test from 'node:test';
import { providerCheckBody } from './provider-check';

test('key-only providers use transient canonical URLs', () => {
  assert.deepEqual(providerCheckBody({ provider: 'groq', apiKey: 'key' }), { provider: 'groq', base_url: 'https://api.groq.com/openai/v1', api_key: 'key' });
});

test('editable providers keep the draft base URL', () => {
  assert.deepEqual(providerCheckBody({ provider: 'openai', baseUrl: 'https://example.test/v1/', apiKey: '' }), { provider: 'openai', base_url: 'https://example.test/v1/' });
});
