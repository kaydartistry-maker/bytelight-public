import assert from 'node:assert/strict';
import test from 'node:test';
import { budgetPatch, parseStudioSettings, spendLine } from './studio-settings.js';

test('settings parse the GET shape and never carry a key value', () => {
  const parsed = parseStudioSettings({
    settings: {
      enabled: true, backend: 'openai', size: 'portrait', quality: 'high',
      openaiModel: 'gpt-image-2', monthlyBudgetUsd: 5, hasOpenaiKey: true,
    },
    monthlySpendUsd: 1.25,
  });
  assert.equal(parsed.monthlySpendUsd, 1.25);
  assert.equal(parsed.settings?.backend, 'openai');
  assert.equal(parsed.settings?.hasOpenaiKey, true);
  assert.equal('openai_api_key' in (parsed.settings ?? {}), false);
});

test('unknown engines and malformed bodies fall back safely', () => {
  assert.equal(parseStudioSettings({ settings: { backend: 'mystery' } }).settings?.backend, 'codex');
  assert.deepEqual(parseStudioSettings(null), { settings: null, monthlySpendUsd: 0 });
});

test('budget input coerces like the desktop, and the spend line reads the same', () => {
  assert.deepEqual(budgetPatch('12.5'), { monthly_budget_usd: 12.5 });
  assert.deepEqual(budgetPatch('abc'), { monthly_budget_usd: 0 });
  assert.equal(spendLine(1.5, 0), 'Spent this month: $1.50');
  assert.equal(spendLine(1.5, 10), 'Spent this month: $1.50 / $10.00');
});
