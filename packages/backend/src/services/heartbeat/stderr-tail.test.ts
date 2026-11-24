// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * The child's last words, kept so an exit can be explained.
 *
 * A room once compacted, worked on for another forty-eight seconds,
 * ran the check that immediately precedes writing a reply, and exited code 1
 * between that check and the write. The answer existed and never reached the
 * page. Asked why, this house could produce the exit code and nothing else —
 * stderr was scanned live for the three deaths it already knew how to read
 * (auth, cap, a refused model) and then dropped on the floor.
 *
 * A ring rather than a log: the interesting part of a death is always its end,
 * and an unbounded buffer on a process that can print for ten hours is a leak
 * wearing a diagnostic's coat.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pushStderrLines } from './supervisor.js';

test('keeps the lines and drops the blanks', () => {
  const buf: string[] = [];
  pushStderrLines(buf, 'first\n\n  \nsecond\n');
  assert.deepEqual(buf, ['first', 'second']);
});

test('arrives in chunks, because a pipe does not respect lines', () => {
  const buf: string[] = [];
  pushStderrLines(buf, 'one\ntwo');
  pushStderrLines(buf, '\nthree\n');
  assert.deepEqual(buf, ['one', 'two', 'three']);
});

test('a long line is capped rather than kept whole', () => {
  const buf: string[] = [];
  pushStderrLines(buf, `${'x'.repeat(5000)}\n`);
  assert.equal(buf.length, 1);
  assert.equal(buf[0].length, 301, '300 characters and the ellipsis');
  assert.ok(buf[0].endsWith('…'));
});

test('it is a ring — a process that talks for ten hours cannot grow it', () => {
  const buf: string[] = [];
  for (let i = 0; i < 500; i++) pushStderrLines(buf, `line ${i}\n`, 12);
  assert.equal(buf.length, 12, 'bounded');
  assert.equal(buf.at(-1), 'line 499', 'and it is the END that survives');
  assert.equal(buf[0], 'line 488');
  assert.equal(buf.includes('line 0'), false, 'the beginning is gone, which is the point');
});

test('carriage returns do not smuggle a blank line through', () => {
  const buf: string[] = [];
  pushStderrLines(buf, 'windows line\r\n\r\nsecond\r\n');
  assert.deepEqual(buf, ['windows line', 'second']);
});
