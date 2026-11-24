import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDb, initDb, recordUsageEvent } from './db.js';
import { monthlyStudioImageSpendUsd, recordStudioImageSpend, type StudioImageSpendInput } from './studio-image-budget.js';

const dir = mkdtempSync(join(tmpdir(), 'studio-image-budget-'));
initDb(join(dir, 'db.sqlite'));
beforeEach(() => { getDb().prepare('DELETE FROM usage_events').run(); });
after(() => { getDb().close(); rmSync(dir, { recursive: true, force: true }); });
const receipt = (filename: string, costUsd = 0.25): StudioImageSpendInput => ({ filename, model: 'openai/gpt-image-2.5-sunburst', backend: 'openrouter', costUsd, costSource: 'actual' });
const legacy = (id: string, createdAt: string, costUsd: number | null, toolCalls = [{ name: 'generate_image', count: 1 }]) => recordUsageEvent({
  id, createdAt, model: 'gpt-image-2', inputTokens: 0, outputTokens: 0, mode: 'interactive', costUsd, toolCalls,
});

test('successful sequential paid images accrue to the cap; the next request can be blocked without a provider call', () => {
  const budget = 0.5;
  let paidCalls = 0;
  const request = (filename: string) => {
    if (monthlyStudioImageSpendUsd() >= budget) return false;
    paidCalls++;
    assert.equal(recordStudioImageSpend(receipt(filename)).recorded, true);
    return true;
  };
  assert.equal(request('first.png'), true);
  assert.equal(request('second.png'), true);
  assert.equal(request('third.png'), false);
  assert.equal(paidCalls, 2);
  assert.equal(monthlyStudioImageSpendUsd(), 0.5);
});

test('stable filename receipts are idempotent across repeated async/sync completion handling', () => {
  const input = receipt('same-file.png');
  const first = recordStudioImageSpend(input), second = recordStudioImageSpend({ ...input });
  assert.equal(first.recorded, true); assert.equal(first.duplicate, false);
  assert.equal(second.recorded, true); assert.equal(second.duplicate, true);
  assert.equal(first.id, second.id);
  assert.equal((getDb().prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n, 1);
  assert.equal(monthlyStudioImageSpendUsd(), 0.25);
  const row = getDb().prepare('SELECT thread_id, message_id, tool_calls FROM usage_events WHERE id = ?').get(first.id) as { thread_id: unknown; message_id: unknown; tool_calls: string };
  assert.equal(row.thread_id, null); assert.equal(row.message_id, null);
  assert.equal(JSON.parse(row.tool_calls)[0].cost_source, 'actual');
});

test('unknown pricing defaults to an explicitly estimated receipt, while actual zero stays zero', () => {
  const estimated = receipt('estimated.png', 0.04); delete estimated.costSource;
  const r = recordStudioImageSpend(estimated);
  assert.equal(r.recorded, true);
  const row = getDb().prepare('SELECT tool_calls FROM usage_events WHERE id = ?').get(r.id) as { tool_calls: string };
  assert.equal(JSON.parse(row.tool_calls)[0].cost_source, 'estimate');
  assert.equal(recordStudioImageSpend(receipt('actual-zero.png', 0)).recorded, true);
  assert.equal(monthlyStudioImageSpendUsd(), 0.04);
});

test('legacy chat image costs share the budget; text turns and unrelated/malformed tool summaries do not', () => {
  const now = new Date().toISOString();
  legacy('chat-image', now, 0.5);
  legacy('other-tool', now, 12, [{ name: 'search', count: 1 }]);
  legacy('text-turn', now, 10);
  getDb().prepare('UPDATE usage_events SET input_tokens = 10 WHERE id = ?').run('text-turn');
  legacy('broken-unrelated-summary', now, 9);
  getDb().prepare('UPDATE usage_events SET tool_calls = ? WHERE id = ?').run('{invalid', 'broken-unrelated-summary');
  assert.equal(recordStudioImageSpend(receipt('studio-image.png')).recorded, true);
  assert.equal(monthlyStudioImageSpendUsd(), 0.75);
});

test('UTC month bounds include the first instant and exclude previous/next months, including December rollover', () => {
  legacy('previous', '2026-11-30T23:59:59.999Z', 8);
  legacy('start', '2026-12-01T00:00:00.000Z', 0.25);
  legacy('end', '2026-12-31T23:59:59.999Z', 0.5);
  legacy('next', '2027-01-01T00:00:00.000Z', 16);
  assert.equal(monthlyStudioImageSpendUsd(new Date('2026-12-15T12:00:00.000Z')), 0.75);
  assert.equal(monthlyStudioImageSpendUsd(new Date('2027-01-15T00:00:00.000Z')), 16);
});

test('actual usage schema has no engine field; read errors fail closed without raw SQL details', () => {
  const columns = getDb().prepare('PRAGMA table_info(usage_events)').all() as Array<{ name: string }>;
  assert.equal(columns.some(c => c.name === 'engine'), false);
  getDb().exec('ALTER TABLE usage_events RENAME TO unavailable_usage_events');
  try {
    assert.throws(() => monthlyStudioImageSpendUsd(), error => {
      assert.match(String(error), /accounting is unavailable/);
      assert.doesNotMatch(String(error), /no such table|SQLITE|unavailable_usage_events/);
      return true;
    });
  } finally { getDb().exec('ALTER TABLE unavailable_usage_events RENAME TO usage_events'); }
  assert.equal(monthlyStudioImageSpendUsd(), 0);
});

test('a write failure preserves the completed image result and pauses reads until that exact receipt recovers', () => {
  const input = receipt('already-created.png');
  getDb().pragma('query_only = ON');
  let failed;
  try { failed = recordStudioImageSpend(input); } finally { getDb().pragma('query_only = OFF'); }
  try {
    assert.equal(failed.recorded, false); assert.match(failed.warning!, /image was created/);
    assert.doesNotMatch(failed.warning!, /SQLITE|readonly|SELECT|INSERT/);
    assert.throws(() => monthlyStudioImageSpendUsd(), /accounting is unavailable/);
    assert.equal(recordStudioImageSpend(receipt('another-image.png')).recorded, true);
    assert.throws(() => monthlyStudioImageSpendUsd(), /accounting is unavailable/);
  } finally { assert.equal(recordStudioImageSpend(input).recorded, true); }
  assert.equal(monthlyStudioImageSpendUsd(), 0.5);
});

test('conflicting duplicate costs are never silently accepted or double counted', () => {
  const input = receipt('conflicting.png');
  assert.equal(recordStudioImageSpend(input).recorded, true);
  try {
    assert.equal(recordStudioImageSpend({ ...input, costUsd: 7 }).recorded, false);
    assert.throws(() => monthlyStudioImageSpendUsd(), /accounting is unavailable/);
  } finally { assert.equal(recordStudioImageSpend(input).recorded, true); }
  assert.equal(monthlyStudioImageSpendUsd(), 0.25);
});

test('invalid prices are never persisted as free, and recovery does not require another image render', () => {
  const input = receipt('bad-price.png');
  try {
    for (const costUsd of [NaN, Infinity, -1]) {
      assert.equal(recordStudioImageSpend({ ...input, costUsd }).recorded, false);
      assert.throws(() => monthlyStudioImageSpendUsd(), /accounting is unavailable/);
    }
  } finally { assert.equal(recordStudioImageSpend(input).recorded, true); }
  assert.equal(monthlyStudioImageSpendUsd(), 0.25);
});

test('missing or negative legacy image costs and invalid clocks fail closed rather than authorize free spending', () => {
  legacy('unknown-cost', new Date().toISOString(), null);
  assert.throws(() => monthlyStudioImageSpendUsd(), /accounting is unavailable/);
  getDb().prepare('UPDATE usage_events SET cost_usd = -1').run();
  assert.throws(() => monthlyStudioImageSpendUsd(), /accounting is unavailable/);
  getDb().prepare('UPDATE usage_events SET cost_usd = 0.5').run();
  assert.equal(monthlyStudioImageSpendUsd(), 0.5);
  assert.throws(() => monthlyStudioImageSpendUsd(new Date('invalid')), /accounting is unavailable/);
});
