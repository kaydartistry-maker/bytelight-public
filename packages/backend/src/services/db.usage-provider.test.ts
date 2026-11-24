import test from 'node:test';
import assert from 'node:assert/strict';
import { getDb, getProviderUsageSummary, initDb, recordUsageEvent } from './db.js';

test('summarizes tracked GLM usage by provider without treating tokens as plan quota', () => {
  initDb(':memory:');
  const db = getDb();
  db.prepare("DELETE FROM usage_events WHERE id LIKE 'zai-usage-test-%'").run();
  recordUsageEvent({
    id: 'zai-usage-test-1', createdAt: new Date().toISOString(), mode: 'interactive',
    model: 'glm-5.4[1m]', provider: 'zai', runtime: 'claude-sdk',
    inputTokens: 120, outputTokens: 30, cacheReadTokens: 40, cacheCreationTokens: 5,
  });
  recordUsageEvent({
    id: 'zai-usage-test-other', createdAt: new Date().toISOString(), mode: 'interactive',
    model: 'gemini-4-argon', provider: 'google', runtime: 'antigravity',
    inputTokens: 999, outputTokens: 999,
  });

  const summary = getProviderUsageSummary('zai');
  assert.equal(summary.requestCount, 1);
  assert.equal(summary.inputTokens, 120);
  assert.equal(summary.outputTokens, 30);
  assert.equal(summary.cacheReadTokens, 40);
  assert.equal(summary.provider, 'zai');
  db.prepare("DELETE FROM usage_events WHERE id LIKE 'zai-usage-test-%'").run();
});
