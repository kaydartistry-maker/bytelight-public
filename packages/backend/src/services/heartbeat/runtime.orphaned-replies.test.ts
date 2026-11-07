/**
 * recordOrphanedReply — the live loop's witness for replies whose turn has
 * already resolved. Not delivered (mid-turn it would glue into the message
 * being written); preserved to io/orphaned-replies.jsonl and logged loudly.
 * (Aerie 18be3c8d, live-loop half; the out-of-turn half is covered by
 * classifyOutboxLines delivering not-owed lines as `proactive`.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.CLAUDE_CLI_HEARTBEAT_ENABLED = 'true';

import { recordOrphanedReply } from './runtime.js';

test('preserves the orphaned line as JSONL with its turn id', () => {
  const path = join(tmpdir(), `bl-orphan-${process.pid}-${Date.now()}.jsonl`);
  try {
    recordOrphanedReply(path, 'closed-turn-abc', 'the five scenes');
    recordOrphanedReply(path, null, 'a second orphan, id-less');

    assert.ok(existsSync(path), 'orphan file should exist');
    const rows = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].turn_id, 'closed-turn-abc');
    assert.equal(rows[0].content, 'the five scenes');
    assert.equal(rows[1].turn_id, null);
    assert.ok(rows[0].at, 'each row carries a timestamp');
  } finally {
    rmSync(path, { force: true });
  }
});

test('a missing path logs the loss but never throws', () => {
  assert.doesNotThrow(() => recordOrphanedReply(undefined, 't1', 'content with nowhere to go'));
});

test('an unwritable path degrades to the log, not a crash', () => {
  assert.doesNotThrow(() =>
    recordOrphanedReply('/nonexistent-dir-zz/orphans.jsonl', 't1', 'content'),
  );
});
