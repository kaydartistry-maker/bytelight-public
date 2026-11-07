import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractThinkingSummary } from './thinking-summary.js';
import { extractThinkingSummary as fromAgent } from './agent.js';

test('first sentence wins', () => {
  assert.equal(extractThinkingSummary('Checking the calendar. Then the tasks.'), 'Checking the calendar.');
  assert.equal(extractThinkingSummary('  \n  Leading space is dropped! More.'), 'Leading space is dropped!');
});

test('decimals and abbreviations do not end the sentence', () => {
  assert.equal(extractThinkingSummary('Upgrading to v3.5 now. Then restart.'), 'Upgrading to v3.5 now.');
  assert.equal(extractThinkingSummary('Use a soft tone, e.g. warm. Next step.'), 'Use a soft tone, e.g.');
});

test('a newline ends the headline', () => {
  assert.equal(extractThinkingSummary('Planning the slice\nstep one, step two'), 'Planning the slice');
});

test('long text is capped at 120 chars', () => {
  const long = 'x'.repeat(200);
  const out = extractThinkingSummary(long);
  assert.equal(out.length, 120);
  assert.ok(out.endsWith('...'));
});

test('empty input stays empty', () => {
  assert.equal(extractThinkingSummary(''), '');
});

test('agent.ts re-exports the same function every lane uses', () => {
  assert.equal(fromAgent, extractThinkingSummary);
});
