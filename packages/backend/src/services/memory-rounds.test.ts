// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Ported from the rounds half of Aerie's memory-ledger.test.ts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { initDb } from './db.js';
import { listMemoryLedger } from './memory-ledger.js';
import { runMemoryRounds } from './memory-rounds.js';

test('memory rounds are daily/idempotent and leave a receipt', async () => {
  initDb(':memory:');
  const summary = await runMemoryRounds();
  assert.equal(summary.skipped, undefined);
  assert.deepEqual(summary.selfKnowledgeIndex, { missing: 0, orphaned: 0, hashDrift: 0 });
  const second = await runMemoryRounds();
  assert.equal(second.skipped, true);
  assert.ok(listMemoryLedger().some(row => row.action === 'rounds.complete'));
});
