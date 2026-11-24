import { it } from 'node:test';
import assert from 'node:assert/strict';
import { jobResponse } from './studio.js';

it('returns the editable prompt and style from a persisted job input', () => {
  // Job inputs are serialized whole by the job store. Model a reload, then
  // exercise the same response serializer used by both job endpoints.
  const input = JSON.parse(JSON.stringify({ prompt: 'Expanded styled prompt', sourcePrompt: 'A moonlit lake', styleId: 'watercolor', size: 'portrait' }));
  const response = jobResponse({ id: 'restored-job', status: 'running', createdAt: 1, input });
  assert.equal(response?.sourcePrompt, 'A moonlit lake');
  assert.equal(response?.styleId, 'watercolor');
  assert.equal(response?.prompt, 'Expanded styled prompt');
  const legacy = jobResponse({ id: 'legacy', status: 'completed', createdAt: 1, input: { prompt: 'Old prompt' } });
  assert.equal(legacy?.sourcePrompt, null);
  assert.equal(legacy?.styleId, null);
});
