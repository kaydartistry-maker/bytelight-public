// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Codex brake: one hold, read before every Codex request leaves.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  holdCodex, codexHold, releaseCodexHold, holdFromText, resetStampToMs, passCodexBrake,
  CODEX_WAIT_IN_PLACE_MS,
} from './codex-breaker.js';

const NOW = Date.UTC(2026, 9, 22, 20, 0, 0); // 3:00 PM in Chicago

test('a refusal says when to come back in every way Codex says it', () => {
  assert.equal(holdFromText('429 Too Many Requests. Retry-After: 30', NOW), NOW + 30_000);
  assert.equal(holdFromText('Rate limited, try again in 20s', NOW), NOW + 20_000);
  assert.equal(holdFromText('please retry after 3 minutes', NOW), NOW + 180_000);
  assert.equal(holdFromText("You've hit your usage limit. Upgrade to Pro or try again at 9:14 PM.", NOW, 'America/Chicago'), NOW + (6 * 60 + 14) * 60_000);
  assert.equal(holdFromText('try again at 2:00 PM', NOW, 'America/Chicago'), NOW + 23 * 60 * 60_000, 'a time already past today is tomorrow');
  assert.equal(holdFromText('something else went wrong', NOW), null);
});

test('a reset stamp is read in seconds, milliseconds or ISO', () => {
  assert.equal(resetStampToMs(1792700000), 1792700000000);
  assert.equal(resetStampToMs(1792700000000), 1792700000000);
  assert.equal(resetStampToMs('2026-10-22T21:00:00Z'), Date.UTC(2026, 9, 22, 21));
  assert.equal(resetStampToMs(undefined), null);
});

test('the hold only moves later, is capped, and lifts on time', () => {
  releaseCodexHold();
  holdCodex(NOW + 60_000, 'first', NOW);
  holdCodex(NOW + 10_000, 'sooner', NOW);
  assert.equal(codexHold(NOW)?.why, 'first', 'a sooner time never shortens a hold');
  holdCodex(NOW + 999 * 60 * 60_000, 'nonsense', NOW);
  assert.ok((codexHold(NOW)?.until ?? 0) <= NOW + 8 * 60 * 60_000, 'a bad parse cannot lock Codex for days');
  assert.equal(codexHold(NOW + 9 * 60 * 60_000), null, 'and it lifts');
  releaseCodexHold();
});

test('a short hold is waited out in place, a long one is said plainly', async () => {
  releaseCodexHold();
  assert.equal(await passCodexBrake(), null, 'no hold, the request goes');
  holdCodex(Date.now() + 50, 'brief');
  const t = Date.now();
  assert.equal(await passCodexBrake(), null);
  assert.ok(Date.now() - t >= 40, 'it waited');
  holdCodex(Date.now() + CODEX_WAIT_IN_PLACE_MS + 60_000, 'usage limit');
  assert.match((await passCodexBrake()) ?? '', /Codex asked us to wait/);
  releaseCodexHold();
});

test('while held, a Codex turn is answered with the hold and nothing is sent', async () => {
  const { CodexAgentRuntime: CodexRuntime } = await import('./runtimes/codex.js');
  releaseCodexHold();
  holdCodex(Date.now() + 10 * 60_000, 'Codex reported its primary limit reached.');
  const runtime: any = new (CodexRuntime as any)();
  const events: any[] = [];
  // byte-light's runtime contract takes a modelRef and emits `start` first.
  for await (const e of runtime.runTurn({ prompt: 'hi', modelRef: { runtime: 'codex', provider: 'openai-codex', model: 'gpt-6-sol' } })) events.push(e);
  const error = events.find((e) => e.type === 'error');
  assert.ok(error, 'the turn is answered with the hold');
  assert.match(error.message, /Codex asked us to wait/);
  assert.equal(events.at(-1).type, 'done');
  releaseCodexHold();
});
