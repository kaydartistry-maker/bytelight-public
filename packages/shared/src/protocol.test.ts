import assert from 'node:assert/strict';
import test from 'node:test';

import { isClientMessage } from './protocol.js';

test('create_thread frames require an explicit non-empty roster', () => {
  assert.equal(isClientMessage({ type: 'create_thread', name: 'Missing', threadType: 'named' }), false);
  assert.equal(isClientMessage({ type: 'create_thread', name: 'Empty', threadType: 'named', companionIds: [] }), false);
  assert.equal(
    isClientMessage({ type: 'create_thread', name: 'Solo', threadType: 'named', companionIds: ['solo'] }),
    true,
  );
});
