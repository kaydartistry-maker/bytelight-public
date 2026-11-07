import test from 'node:test';
import assert from 'node:assert/strict';
import { authRetryDelay, classifyAuthCheck } from './auth-check.js';

test('network error is unreachable, not logged out', () => {
  assert.deepEqual(classifyAuthCheck({ error: new TypeError('Failed to fetch') }), { kind: 'unreachable' });
});

test('5xx from a proxy during restart is unreachable', () => {
  for (const status of [500, 502, 503, 504]) {
    assert.deepEqual(classifyAuthCheck({ status, body: null }), { kind: 'unreachable' }, String(status));
  }
});

test('408 and 429 are transient', () => {
  assert.equal(classifyAuthCheck({ status: 408, body: null }).kind, 'unreachable');
  assert.equal(classifyAuthCheck({ status: 429, body: null }).kind, 'unreachable');
});

test('2xx without the auth JSON shape (HTML fallback) is unreachable', () => {
  assert.equal(classifyAuthCheck({ status: 200, body: null }).kind, 'unreachable');
  assert.equal(classifyAuthCheck({ status: 200, body: {} }).kind, 'unreachable');
});

test('valid session answers authenticated', () => {
  assert.deepEqual(classifyAuthCheck({ status: 200, body: { authenticated: true } }), {
    kind: 'answered', authenticated: true, required: true,
  });
});

test('auth disabled answers not required', () => {
  assert.deepEqual(classifyAuthCheck({ status: 200, body: { authenticated: true, auth_required: false } }), {
    kind: 'answered', authenticated: true, required: false,
  });
});

test('200 authenticated:false is a real logged-out', () => {
  assert.deepEqual(classifyAuthCheck({ status: 200, body: { authenticated: false } }), {
    kind: 'answered', authenticated: false, required: true,
  });
});

test('401 and 403 are a real logged-out', () => {
  assert.deepEqual(classifyAuthCheck({ status: 401, body: null }), { kind: 'answered', authenticated: false, required: true });
  assert.deepEqual(classifyAuthCheck({ status: 403, body: null }), { kind: 'answered', authenticated: false, required: true });
});

test('retry backoff matches the classic schedule and caps at 30s', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 50].map(authRetryDelay), [2000, 4000, 8000, 15000, 30000, 30000, 30000, 30000]);
  assert.equal(authRetryDelay(0), 1000);
});
