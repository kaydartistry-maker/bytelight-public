import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSessionCard, type SessionHistoryRow } from './session-rows.ts';

// Shape the house's /api/sessions actually returns (session_history rows).
const row: SessionHistoryRow = {
  id: 'row-1',
  thread_id: 't-1',
  session_id: 'abcdef1234567890',
  session_type: 'v2',
  started_at: '2026-11-07 15:00:00',
  ended_at: null,
  end_reason: null,
  thread_name: 'The boys',
  platform: 'web',
  usage_turns: 3,
  usage_input_tokens: 1000,
  usage_output_tokens: 2500,
  usage_cache_read_tokens: 0,
  usage_cache_creation_tokens: 0,
  usage_cost_usd: 0.12,
  last_context_tokens: 50000,
  last_context_window: 1000000,
};

test('maps a real session_history row without throwing', () => {
  const c = toSessionCard(row);
  assert.equal(c.key, 'row-1');
  assert.equal(c.shortId, 'abcdef12');
  assert.equal(c.title, 'The boys');
  assert.equal(c.open, true);
  assert.equal(c.outputTokens, 2500);
  assert.equal(c.contextPercent, 5);
});

test('a row missing every optional field still maps (the old screen crashed here)', () => {
  const bare = { id: 'x' } as unknown as SessionHistoryRow;
  const c = toSessionCard(bare);
  assert.equal(c.shortId, '');
  assert.equal(c.title, 'Untitled session');
  assert.equal(c.contextPercent, null);
  assert.equal(c.startedMs, null);
});

test('ended sessions report how they ended', () => {
  const c = toSessionCard({ ...row, ended_at: '2026-11-07 16:00:00', end_reason: 'compaction' });
  assert.equal(c.open, false);
  assert.equal(c.endReason, 'compaction');
});
