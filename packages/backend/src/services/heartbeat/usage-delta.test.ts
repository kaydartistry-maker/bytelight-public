/**
 * Warm-lane delta accounting (Aerie 18ec6725, hand-port) — the rule that
 * turns a transcript's RUNNING totals into per-turn usage rows:
 *   • known fixtures produce exact totals through readSessionUsage,
 *   • rereading an unchanged transcript does not double-count,
 *   • the second turn files what it ADDED, never the running total,
 *   • a new transcript path (recycle) resets the baseline — no cross-session
 *     carry,
 *   • a same-path shrink (CLI reused the file after a recycle) also resets —
 *     a negative turn is never filed,
 *   • deliberately-broken case: filing running totals per turn WOULD
 *     double-count — proven, so the delta check is shown able to fail.
 */
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readSessionUsage, computeUsageDelta, __resetUsageCacheForTests,
  type UsageBaseline, type SessionUsage,
} from './transcript-usage.js';

const dir = mkdtempSync(join(tmpdir(), 'bl-usage-delta-'));
afterEach(() => __resetUsageCacheForTests());
test.after(() => rmSync(dir, { recursive: true, force: true }));

function assistantLine(usage: Record<string, number>, model = 'claude-fable-5'): string {
  return JSON.stringify({ type: 'assistant', message: { model, usage } });
}

function write(name: string, lines: string[]): { path: string; size: number; mtime: number } {
  const path = join(dir, name);
  writeFileSync(path, lines.join('\n') + '\n', 'utf8');
  const st = statSync(path);
  return { path, size: st.size, mtime: st.mtimeMs };
}

const TURN_1 = assistantLine({
  input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50,
});
const TURN_2 = assistantLine({
  input_tokens: 15, output_tokens: 200, cache_read_input_tokens: 1200, cache_creation_input_tokens: 30,
});

test('known fixture produces exact totals, and an unchanged reread does not double-count', async () => {
  const f = write('one.jsonl', [TURN_1, TURN_2]);
  const usage = (await readSessionUsage(f.path, f.size, f.mtime))!;
  assert.equal(usage.replies, 2);
  assert.equal(usage.inputTokens, 25);
  assert.equal(usage.outputTokens, 300);
  assert.equal(usage.cacheReadTokens, 2200);
  assert.equal(usage.cacheWriteTokens, 80);
  // Endpoint, not a sum: the LAST turn's window occupancy.
  assert.equal(usage.contextTokens, 15 + 1200 + 30);

  const again = (await readSessionUsage(f.path, f.size, f.mtime))!;
  assert.deepEqual(again, usage);
});

test('first turn files totals-to-date; the second files only what it added', async () => {
  const first = write('grow.jsonl', [TURN_1]);
  const u1 = (await readSessionUsage(first.path, first.size, first.mtime))!;
  const d1 = computeUsageDelta(undefined, u1, first.path);
  assert.deepEqual(d1, { inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 50 });

  const baseline: UsageBaseline = { path: first.path, ...d1 };
  const grown = write('grow.jsonl', [TURN_1, TURN_2]);
  const u2 = (await readSessionUsage(grown.path, grown.size, grown.mtime))!;
  const d2 = computeUsageDelta(baseline, u2, grown.path);
  assert.deepEqual(d2, { inputTokens: 15, outputTokens: 200, cacheReadTokens: 1200, cacheWriteTokens: 30 });

  // Deliberately broken on purpose: file the running totals instead of the
  // delta and the same conversation is counted twice — the failure mode the
  // rule exists to catch, shown catchable.
  const doubleCounted = d1.outputTokens + u2.outputTokens;
  assert.notEqual(doubleCounted, u2.outputTokens);
  assert.equal(d1.outputTokens + d2.outputTokens, u2.outputTokens);
});

test('a new transcript path resets the baseline — totals never carry across sessions', () => {
  const prev: UsageBaseline = {
    path: join(dir, 'old.jsonl'), inputTokens: 500, outputTokens: 5000, cacheReadTokens: 9000, cacheWriteTokens: 700,
  };
  const usage: SessionUsage = {
    replies: 1, inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000,
    cacheWriteTokens: 50, contextTokens: 1060, compactions: 0,
  };
  const d = computeUsageDelta(prev, usage, join(dir, 'new.jsonl'));
  assert.deepEqual(d, { inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 50 });
});

test('a same-path shrink is a fresh baseline, never a negative turn', () => {
  const path = join(dir, 'same.jsonl');
  const prev: UsageBaseline = {
    path, inputTokens: 500, outputTokens: 5000, cacheReadTokens: 9000, cacheWriteTokens: 700,
  };
  const usage: SessionUsage = {
    replies: 1, inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000,
    cacheWriteTokens: 50, contextTokens: 1060, compactions: 0,
  };
  const d = computeUsageDelta(prev, usage, path);
  assert.deepEqual(d, { inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000, cacheWriteTokens: 50 });
  assert.ok(Object.values(d).every(v => v >= 0));
});
