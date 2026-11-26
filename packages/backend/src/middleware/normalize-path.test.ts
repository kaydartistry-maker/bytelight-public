import { test } from 'node:test';
import assert from 'node:assert/strict';

import { collapseDuplicateSlashes } from './normalize-path.js';

test('a clean path is returned unchanged', () => {
  assert.equal(collapseDuplicateSlashes('/api/cortex/memories'), '/api/cortex/memories');
  assert.equal(collapseDuplicateSlashes('/'), '/');
});

test('the doubled-slash auth-skip is collapsed back onto its prefix', () => {
  // This is the exact bypass: '/api//cortex' misses the '/api/cortex' gate but
  // reaches the '/api' router. After collapsing it hits the gate again.
  assert.equal(collapseDuplicateSlashes('/api//cortex/memories'), '/api/cortex/memories');
  assert.equal(collapseDuplicateSlashes('/api//xray/identity'), '/api/xray/identity');
  assert.equal(collapseDuplicateSlashes('//api/cortex/memories'), '/api/cortex/memories');
});

test('three or more slashes collapse to one', () => {
  assert.equal(collapseDuplicateSlashes('/api///cortex////memories'), '/api/cortex/memories');
});

test('a query string is left untouched, even when it contains slashes', () => {
  // A param that is itself a URL legitimately carries '//'. Only the path is
  // normalized, so the value survives.
  assert.equal(
    collapseDuplicateSlashes('/api//studio?src=https://cdn.example.com/a//b.png'),
    '/api/studio?src=https://cdn.example.com/a//b.png',
  );
  assert.equal(
    collapseDuplicateSlashes('/api/studio?src=https://cdn.example.com/x'),
    '/api/studio?src=https://cdn.example.com/x',
  );
});
