// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPartner, partnerChoices } from './partners.js';

// The partner picker offers whoever lives in this house, from GET
// /api/companions in their stored order, and preselects the first.

const house = [{ slug: 'ivy' }, { slug: 'fox' }, { slug: 'nim' }];

test('the picker offers this house\'s companions, in order', () => {
  assert.deepEqual(partnerChoices(house), ['ivy', 'fox', 'nim']);
});

test('the first companion is preselected', () => {
  assert.equal(defaultPartner(house), 'ivy');
  assert.equal(defaultPartner([]), undefined, 'nobody to preselect before the house has answered');
});
