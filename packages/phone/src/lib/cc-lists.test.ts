import assert from 'node:assert/strict';
import test from 'node:test';
import { canDeleteList } from './cc-lists.js';

test('Shopping is protected, matched exactly like classic', () => {
  assert.equal(canDeleteList('Shopping'), false);
});

test('every other list can be deleted', () => {
  assert.equal(canDeleteList('Groceries'), true);
  assert.equal(canDeleteList('shopping'), true);
  assert.equal(canDeleteList('Shopping '), true);
  assert.equal(canDeleteList(''), true);
  assert.equal(canDeleteList(undefined), true);
});
