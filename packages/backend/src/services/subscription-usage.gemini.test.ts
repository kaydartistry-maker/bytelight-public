import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeminiUsage } from './subscription-usage.js';

test('parses Antigravity quota groups into honest used and remaining meters', () => {
  const parsed = parseGeminiUsage({ command: { data: { groups: [{
    name: 'Gemini Models', description: 'shared', buckets: [
      { id: 'gemini-weekly', name: 'Weekly Limit Remaining', window: 'weekly', remaining_fraction: 0.984, reset_time: '2026-11-29T20:13:09Z' },
      { id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: 0.97, reset_time: '2026-11-23T01:13:09Z' },
    ],
  }] } } }, '2026-11-22T23:00:00Z');
  assert.equal(parsed.groups[0].buckets[0].remainingPercent, 98.4);
  assert.ok(Math.abs(parsed.groups[0].buckets[0].usedPercent - 1.6) < 0.000001);
  assert.equal(parsed.groups[0].buckets[1].usedPercent, 3);
  assert.equal(parsed.groups[0].buckets[1].resetsAt, '2026-11-23T01:13:09.000Z');
});

test('rejects decorative or malformed quota payloads', () => {
  assert.throws(() => parseGeminiUsage({ response: '98% remaining' }), /no quota groups/);
  assert.throws(() => parseGeminiUsage({ command: { data: { groups: [] } } }), /no readable quota buckets/);
});
