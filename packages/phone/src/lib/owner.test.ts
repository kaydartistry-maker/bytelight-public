// The owner's seat slug must match the house's, or a card table seats her twice.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ownerSlugFromName } from './owner';

test('the owner’s seat slug folds accents the way the house does', () => {
  assert.equal(ownerSlugFromName('User'), 'user');
  assert.equal(ownerSlugFromName(' Joëlle Brandão '), 'joelle-brandao');
});
