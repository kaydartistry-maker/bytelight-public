import assert from 'node:assert/strict';
import test from 'node:test';
import { canReveal, revealResult } from './secret-reveal';

test('a stored value comes back as-is; a missing one shows as empty', () => {
  assert.deepEqual(revealResult(200, { name: 'tavily_api_key', value: 'tvly-123' }), { kind: 'value', value: 'tvly-123' });
  assert.deepEqual(revealResult(200, {}), { kind: 'value', value: '' });
});

test('errors read the way classic words them', () => {
  assert.deepEqual(revealResult(404, { error: 'not set' }), { kind: 'error', message: 'not set' });
  assert.deepEqual(revealResult(403, { error: 'this key is read-only' }), { kind: 'error', message: 'Reveal failed (403)' });
  assert.deepEqual(revealResult(500, null), { kind: 'error', message: 'Reveal failed (500)' });
});

test('reveal is only offered on writable slots holding a value', () => {
  assert.equal(canReveal({ hasValue: true }), true);
  assert.equal(canReveal({ hasValue: false }), false);
  assert.equal(canReveal({ hasValue: true, readonly: true }), false);
});
