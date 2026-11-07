// Copyright 2026 Byte-light contributors. Licensed under the Apache License 2.0.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CODEX_OPERATING_CONTRACT } from './codex-operating-contract.js';

test('scheduled wakes always answer', () => {
  assert.match(CODEX_OPERATING_CONTRACT, /Every scheduled wake must land at least one in-character line/);
  assert.match(CODEX_OPERATING_CONTRACT, /do the duty and still speak/);
  assert.match(CODEX_OPERATING_CONTRACT, /not answer with `\[SILENT\]`/);
  assert.match(CODEX_OPERATING_CONTRACT, /no quiet hours/i);
});

test('spontaneous wakes use the same picture door as the wake outcome contract', () => {
  // One source of truth: the selfie goes through sc.mjs image, which posts the
  // picture into the thread. The bare Studio route only fills the gallery.
  assert.doesNotMatch(CODEX_OPERATING_CONTRACT, /\/api\/studio\/generate/);
  assert.doesNotMatch(CODEX_OPERATING_CONTRACT, /gallery URL/i);
  assert.doesNotMatch(CODEX_OPERATING_CONTRACT, /codexModel/);
  assert.match(CODEX_OPERATING_CONTRACT, /node tools\/sc\.mjs image/);
  assert.match(CODEX_OPERATING_CONTRACT, /--subjects/);
  assert.match(CODEX_OPERATING_CONTRACT, /portrait\|landscape/);
});

test('local Journal instructions match byte-light and preserve small-screen drafting', () => {
  assert.match(CODEX_OPERATING_CONTRACT, /127\.0\.0\.1:3002\/api\/internal\/journal/);
  assert.doesNotMatch(CODEX_OPERATING_CONTRACT, /3013|3003|phone's Journal app/);
  assert.match(CODEX_OPERATING_CONTRACT, /code block/i);
  assert.match(CODEX_OPERATING_CONTRACT, /wrap/i);
});

test('transport-specific plumbing and out-of-scope side notes do not leak in', () => {
  for (const excluded of ['io/outbox.jsonl', 'turn_id', 'side-notes.jsonl', 'io/.busy', '"more": true']) {
    assert.equal(CODEX_OPERATING_CONTRACT.includes(excluded), false, `must not include ${excluded}`);
  }
});

test('service restarts stay operator-owned', () => {
  assert.match(CODEX_OPERATING_CONTRACT, /Never restart a service/);
});
