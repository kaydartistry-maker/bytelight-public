// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversationBatch } from './memory-extraction.js';

function message(sequence: number, content: string) {
  return {
    sequence,
    role: sequence % 2 ? 'user' : 'companion',
    content,
    created_at: '2026-07-16T00:00:00.000Z',
  };
}

test('Archivist batches an oversized backlog from the oldest edge', () => {
  const pending = Array.from({ length: 20 }, (_, i) => message(i + 101, `message-${i + 101}-` + 'x'.repeat(400)));
  const batch = buildConversationBatch(pending, 'the operator', 'America/New_York', 2_400);

  assert.ok(batch);
  assert.equal(batch.messages[0].sequence, 101);
  assert.ok(batch.maxSequence < 120);
  assert.match(batch.text, /message-101/);
  assert.doesNotMatch(batch.text, /message-120/);
});

test('Archivist cursor target is the last message actually included', () => {
  const pending = [message(10, 'a'.repeat(1_600)), message(11, 'b'.repeat(1_600)), message(12, 'c')];
  const batch = buildConversationBatch(pending, 'the operator', 'America/New_York', 2_100);

  assert.ok(batch);
  assert.deepEqual(batch.messages.map((m) => m.sequence), [10]);
  assert.equal(batch.maxSequence, 10);
});

// Found Oct 22 2026: Discord rows from anybody but the owner are stored with
// role 'system', and the Archivist was shown every one of them as 'System:'
// with no name, so a guest's words reached the memory writer wearing the most
// trusted label in its prompt. A guest now reads as who they are, marked as
// not the owner; a real system row still reads as System.
test('Archivist names a Discord guest instead of calling them System', () => {
  const guest = {
    sequence: 1,
    role: 'system',
    content: 'meter the exit, not the rooms',
    created_at: '2026-10-22T00:00:00.000Z',
    metadata: JSON.stringify({ discordUserId: '42', discordUsername: 'pat', discordDisplayName: 'Pat' }),
  };
  const house = {
    sequence: 2,
    role: 'system',
    content: 'a bell rang',
    created_at: '2026-10-22T00:00:00.000Z',
    metadata: null,
  };
  const batch = buildConversationBatch([guest, house], 'the operator', 'America/New_York');

  assert.ok(batch);
  assert.match(batch.text, /Pat \(a guest, not the operator\): meter the exit/);
  assert.doesNotMatch(batch.text, /System: meter the exit/);
  assert.match(batch.text, /System: a bell rang/);
});
