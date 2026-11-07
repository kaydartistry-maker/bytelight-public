import assert from 'node:assert/strict';
import test from 'node:test';
import { SEARCH_DEBOUNCE_MS, buildSearchRequest, parseSearchPage, searchDelayMs } from './search-domain';

test('semantic search uses its smaller result limit', () => {
  assert.equal(buildSearchRequest(' shared meaning ', 'semantic'), '/api/search-semantic?q=shared%20meaning&limit=20');
  assert.equal(buildSearchRequest('exact words', 'keyword'), '/api/search?q=exact%20words&limit=30');
});

test('search pages reject malformed result arrays', () => {
  assert.deepEqual(parseSearchPage({ results: null, total: '4' }), { results: [], total: 0 });
});

test('switching mode reruns at once; typing stays debounced', () => {
  assert.equal(searchDelayMs('keyword', 'semantic'), 0);
  assert.equal(searchDelayMs('semantic', 'keyword'), 0);
  assert.equal(searchDelayMs('semantic', 'semantic'), SEARCH_DEBOUNCE_MS);
  assert.equal(SEARCH_DEBOUNCE_MS, 300);
});
