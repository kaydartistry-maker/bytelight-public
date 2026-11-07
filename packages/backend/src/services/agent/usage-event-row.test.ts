import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUsageEventRow, type BuildUsageEventRowInput } from './usage-event-row.js';

function input(cost: number | null | undefined, estimateCost: BuildUsageEventRowInput['estimateCost']): BuildUsageEventRowInput {
  return {
    event: { type: 'usage', input: 100, output: 10, ...(cost === undefined ? {} : { cost }) },
    toolInsertions: [],
    model: 'z-ai/glm-5.2',
    modelRef: { canonical: 'openrouter/z-ai/glm-5.2', provider: 'openrouter', model: 'z-ai/glm-5.2', runtime: 'openai-compat' },
    streamMsgId: 'message-1',
    threadId: 'thread-1',
    platform: 'web',
    isAutonomous: false,
    requestStartMs: 900,
    contextTokensUsed: 0,
    contextWindowSize: 0,
    randomId: () => 'usage-1',
    nowIso: () => '2026-08-10T00:00:00.000Z',
    nowMs: () => 1000,
    estimateCost,
  };
}

describe('buildUsageEventRow provider cost precedence', () => {
  test('provider-reported cost overrides the estimator', () => {
    let called = false;
    const row = buildUsageEventRow(input(0.0042, (() => { called = true; return 99; }) as BuildUsageEventRowInput['estimateCost']));
    assert.equal(row.costUsd, 0.0042);
    assert.equal(called, false);
  });

  test('zero is a valid provider-reported cost', () => {
    const row = buildUsageEventRow(input(0, (() => 99) as BuildUsageEventRowInput['estimateCost']));
    assert.equal(row.costUsd, 0);
  });

  test('falls back to the estimator when provider cost is absent', () => {
    const row = buildUsageEventRow(input(undefined, (() => 1.23) as BuildUsageEventRowInput['estimateCost']));
    assert.equal(row.costUsd, 1.23);
  });

  test('explicit null declines the estimator — a subscription lane files NULL, never a guess', () => {
    let called = false;
    const row = buildUsageEventRow(input(null, (() => { called = true; return 99; }) as BuildUsageEventRowInput['estimateCost']));
    assert.equal(row.costUsd, null);
    assert.equal(called, false);
  });
});
