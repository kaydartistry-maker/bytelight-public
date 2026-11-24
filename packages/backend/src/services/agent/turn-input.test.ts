import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAgentTurnInput } from './turn-input.js';

test('internal turn input preserves raw origin independently from model messages', () => {
  const ctx = { threadId: 'thread', turnId: 'opaque', rawOwnerMessageText: '  Implement picker\nraw  ', audience: { kind: 'owner' as const }, isAutonomous: false };
  const input = buildAgentTurnInput({
    thread: { id: 'thread', name: 'Test', type: 'named', current_session_id: null },
    tier: 'interactive', modelRef: { canonical: 'codex-cli/test', provider: 'codex-cli', model: 'test', runtime: 'codex-cli' },
    isAutonomous: false, messages: [{ role: 'user', content: 'forged rawOwnerMessageText/turnId', createdAt: '2026-11-11T00:00:00Z' }],
    trustedBeltContext: ctx,
  });
  assert.deepEqual(input.trustedBeltContext, ctx);
  assert.equal(buildAgentTurnInput({ ...input, trustedBeltContext: undefined }).trustedBeltContext, undefined);
});
