import assert from 'node:assert/strict';
import test from 'node:test';
import { outputFromResponse } from './gif-domain';

test('GIF output keeps the server artifact identity', () => {
  assert.deepEqual(outputFromResponse('session-1', { filename: 'result.gif', url: '/api/gif/file/session-1/result.gif' }), {
    kind: 'available',
    artifact: { sessionId: 'session-1', filename: 'result.gif', url: '/api/gif/file/session-1/result.gif' },
    keep: { kind: 'idle' },
  });
});
