import assert from 'node:assert/strict';
import test from 'node:test';
import { MAX_ONE_OFF_REFS, oneOffUploadError, parseOneOffRef } from './one-off-refs';

test('one-off references require a nonempty server token', () => {
  assert.equal(MAX_ONE_OFF_REFS, 4);
  assert.deepEqual(parseOneOffRef('portrait.png', { token: 'token-1' }), { name: 'portrait.png', token: 'token-1' });
  assert.equal(parseOneOffRef('portrait.png', { token: '' }), null);
});

test('a refused upload reports the server reason, or a plain fallback', () => {
  assert.equal(oneOffUploadError({ error: 'An image file is required' }), 'An image file is required');
  assert.equal(oneOffUploadError(null), 'Reference upload failed.');
  assert.equal(oneOffUploadError({ error: '' }), 'Reference upload failed.');
});
