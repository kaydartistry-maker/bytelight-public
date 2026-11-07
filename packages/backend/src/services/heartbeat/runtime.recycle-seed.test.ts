/**
 * Re-prime seed budget (warm-session economics slice).
 *
 * The seed is re-sent as FRESH input on every recycle, so its size is a
 * recurring cache-write cost. Invariants under test (upstream warm-lane
 * numbers, ported whole):
 *   • at most RECYCLE_SEED_MESSAGES newest messages ride the seed,
 *   • each message is clamped to RECYCLE_SEED_MSG_CHARS with a visible marker,
 *   • the whole seed stays under RECYCLE_SEED_TOTAL_CHARS, dropping OLDEST
 *     first with an omitted-count marker line,
 *   • the trailing in-flight user message is still excluded (echo guard).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  InteractiveCliRuntime,
  RECYCLE_SEED_MESSAGES,
  RECYCLE_SEED_MSG_CHARS,
  RECYCLE_SEED_TOTAL_CHARS,
} from './runtime.js';
import type { NormalizedMessage } from '../runtimes/types.js';

function makeRuntime(): InteractiveCliRuntime {
  return new InteractiveCliRuntime({ userName: 'Owner', companionName: 'Companion' });
}

function seed(runtime: InteractiveCliRuntime, messages: NormalizedMessage[]): string {
  // Private in TS only — the budget behavior is the public contract here.
  return (runtime as any).buildRecycleContext(messages);
}

function msg(role: 'user' | 'assistant', content: string): NormalizedMessage {
  return { role, content } as NormalizedMessage;
}

describe('recycle seed budget', () => {
  test('windows to the newest RECYCLE_SEED_MESSAGES with an omitted marker', () => {
    const messages: NormalizedMessage[] = [];
    for (let i = 0; i < 60; i++) {
      messages.push(msg(i % 2 === 0 ? 'user' : 'assistant', `message number ${i}`));
    }
    // Trailing assistant message so nothing is popped by the echo guard.
    const out = seed(makeRuntime(), messages);

    assert.ok(out.includes('[30 older messages omitted from this seed for size]'),
      'omitted-count marker names the dropped messages');
    assert.ok(!out.includes('message number 29'), 'oldest messages are dropped');
    assert.ok(out.includes('message number 30'), 'window starts at newest-30');
    assert.ok(out.includes('message number 59'), 'newest message rides');
    // Header + marker + 30 lines + closer + trailing '' = 34 lines
    const contentLines = out.split('\n').filter(l => l.startsWith('Owner:') || l.startsWith('Companion:'));
    assert.equal(contentLines.length, RECYCLE_SEED_MESSAGES);
  });

  test('clamps one oversized message with a visible truncation marker', () => {
    const big = 'x'.repeat(RECYCLE_SEED_MSG_CHARS * 3);
    const out = seed(makeRuntime(), [msg('assistant', big)]);
    assert.ok(out.includes('truncated to keep this message deliverable'),
      'clamp marker is visible');
    // Clamped line ≈ 95% of cap + marker — must be well under the raw size.
    assert.ok(out.length < RECYCLE_SEED_MSG_CHARS * 2, 'seed is bounded by the per-message clamp');
  });

  test('drops oldest lines until the seed fits the total budget', () => {
    // 30 messages × ~4K each ≈ 120K raw — must shrink under the 50K total.
    const messages: NormalizedMessage[] = [];
    for (let i = 0; i < RECYCLE_SEED_MESSAGES; i++) {
      messages.push(msg('assistant', `m${i} ` + 'y'.repeat(RECYCLE_SEED_MSG_CHARS - 10)));
    }
    const out = seed(makeRuntime(), messages);
    assert.ok(out.length <= RECYCLE_SEED_TOTAL_CHARS + 500,
      `seed length ${out.length} stays at the total budget (+ header slack)`);
    assert.ok(out.includes('omitted from this seed for size'), 'omitted marker present');
    assert.ok(out.includes(`m${RECYCLE_SEED_MESSAGES - 1} `), 'newest survives the total-budget shift');
  });

  test('still excludes the trailing in-flight user message (echo guard)', () => {
    const out = seed(makeRuntime(), [
      msg('assistant', 'earlier reply'),
      msg('user', 'the live message'),
    ]);
    assert.ok(out.includes('earlier reply'));
    assert.ok(!out.includes('the live message'), 'in-flight user message never rides the seed');
  });

  test('empty history still returns an empty seed', () => {
    assert.equal(seed(makeRuntime(), [msg('user', 'only the live message')]), '');
  });
});
