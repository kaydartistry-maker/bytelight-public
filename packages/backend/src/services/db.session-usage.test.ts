/**
 * Per-session usage totals on the session lifecycle log (Wave 2 Slice 2):
 *   • totals are summed from usage_events by thread + [started_at, ended_at)
 *     window — exact figures, no estimation,
 *   • a session with no rows reports usage_turns 0 and NULL sums — absence is
 *     never dressed up as zero,
 *   • a row landing exactly on a resume boundary counts once, in the session
 *     that started on it,
 *   • totals never carry across sessions or threads,
 *   • reading the list twice changes nothing (reads are reads),
 *   • last_context_* is the final recorded turn's endpoint, not a sum.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'session-usage-test-'));
process.env.RESONANT_HOME = root;
writeFileSync(join(root, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');
const { initDb, createSessionRecord, endSessionRecord, recordUsageEvent, listSessionHistory } = await import('./db.js');
const db = initDb(join(root, 'test.db'));
after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

const now = new Date().toISOString();
for (const id of ['t1', 't2']) {
  db.prepare("INSERT INTO threads (id,name,type,created_at,last_activity_at) VALUES (?,?,'named',?,?)").run(id, id, now, now);
}

// Thread t1: session s1 (ended) then s2 (open). Thread t2: session s3 with no usage.
createSessionRecord({ id: 'r1', threadId: 't1', sessionId: 's1', sessionType: 'v2', startedAt: '2026-09-01T00:00:00.000Z' });
endSessionRecord({ sessionId: 's1', endedAt: '2026-09-01T12:00:00.000Z', endReason: 'resumed' });
createSessionRecord({ id: 'r2', threadId: 't1', sessionId: 's2', sessionType: 'v2', startedAt: '2026-09-01T12:00:00.000Z' });
createSessionRecord({ id: 'r3', threadId: 't2', sessionId: 's3', sessionType: 'v2', startedAt: '2026-09-01T00:00:00.000Z' });

function usageRow(id: string, threadId: string, createdAt: string, tokens: { in: number; out: number; cr?: number; cw?: number }, ctx?: { tokens: number; window: number }) {
  recordUsageEvent({
    id, createdAt, threadId, mode: 'interactive', model: 'claude-fable-5',
    inputTokens: tokens.in, outputTokens: tokens.out,
    cacheReadTokens: tokens.cr ?? 0, cacheCreationTokens: tokens.cw ?? 0,
    contextTokens: ctx?.tokens ?? null, contextWindow: ctx?.window ?? null,
  });
}

// Inside s1's window.
usageRow('e1', 't1', '2026-09-01T01:00:00.000Z', { in: 10, out: 100, cr: 1000, cw: 50 }, { tokens: 1060, window: 200000 });
usageRow('e2', 't1', '2026-09-01T02:00:00.000Z', { in: 15, out: 200, cr: 1200, cw: 30 }, { tokens: 1245, window: 200000 });
// Exactly on the resume boundary — belongs to s2, once.
usageRow('e3', 't1', '2026-09-01T12:00:00.000Z', { in: 20, out: 300 }, { tokens: 5000, window: 1000000 });
// Later inside s2 (still open).
usageRow('e4', 't1', '2026-09-01T13:00:00.000Z', { in: 25, out: 400 }, { tokens: 9000, window: 1000000 });
// Before any session on t1 — belongs to nobody.
usageRow('e0', 't1', '2026-08-31T23:00:00.000Z', { in: 999, out: 999 });

test('per-session totals are exact, windowed, and never invented', () => {
  const rows = listSessionHistory(50);
  const s1 = rows.find(r => r.session_id === 's1')!;
  const s2 = rows.find(r => r.session_id === 's2')!;
  const s3 = rows.find(r => r.session_id === 's3')!;

  // s1: e1 + e2 only — the boundary row went to s2, the pre-session row to nobody.
  assert.equal(s1.usage_turns, 2);
  assert.equal(s1.usage_input_tokens, 25);
  assert.equal(s1.usage_output_tokens, 300);
  assert.equal(s1.usage_cache_read_tokens, 2200);
  assert.equal(s1.usage_cache_creation_tokens, 80);
  // Endpoint of the LAST recorded turn in the window — e2, not e1+e2.
  assert.equal(s1.last_context_tokens, 1245);
  assert.equal(s1.last_context_window, 200000);

  // s2 (open): boundary row + the later one.
  assert.equal(s2.usage_turns, 2);
  assert.equal(s2.usage_input_tokens, 45);
  assert.equal(s2.usage_output_tokens, 700);
  assert.equal(s2.last_context_tokens, 9000);
  assert.equal(s2.last_context_window, 1000000);

  // s3: nothing recorded — absence, not zeros.
  assert.equal(s3.usage_turns, 0);
  assert.equal(s3.usage_input_tokens, null);
  assert.equal(s3.usage_output_tokens, null);
  assert.equal(s3.usage_cost_usd, null);
  assert.equal(s3.last_context_tokens, null);
});

test('rereading the list changes nothing — totals are stable across calls', () => {
  const first = listSessionHistory(50);
  const second = listSessionHistory(50);
  assert.deepEqual(second, first);
});

test('totals never cross threads', () => {
  const rows = listSessionHistory(50);
  const s3 = rows.find(r => r.session_id === 's3')!;
  // t1 carries 5 usage rows; none of them may leak into t2's session.
  assert.equal(s3.usage_turns, 0);
});
