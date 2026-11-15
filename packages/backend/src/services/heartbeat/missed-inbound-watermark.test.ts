// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * How far the handover got, across a restart.
 *
 * A backend restart to bring a quiet lane back once made the missed-inbound
 * net hand over thirteen of their person's own messages, ten of them already answered —
 * every row stamped with the same found_at, the instant the new session was
 * born. lastHandedUserAt lived only in an in-memory map, so a
 * restart rewound it to nothing and everything still inside the history window
 * looked unhanded.
 *
 * These pin the half that must NOT change with it: the net is deliberately
 * one-way, so an absent or damaged mark has to put it straight back to handing
 * everything over. Suppressing a real miss is the only failure here that
 * nobody would ever see.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readHandedWatermark, selectMissedInbound, writeHandedWatermark } from './runtime.js';

const A = { content: 'first', createdAt: '2026-09-09T19:55:43.103Z' };
const B = { content: 'second', createdAt: '2026-09-09T20:09:03.089Z' };
const C = { content: 'arriving now', createdAt: '2026-09-09T21:03:59.205Z' };
const users = [A, B, C];
// The turn being handed over right now ends with C, however many frames and
// handover blocks get stacked on the front of it.
const PROMPT = `[21:03] #bytelight Owner: ${C.content}`;

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'hb-watermark-'));
}

test('a mark survives being written and read back', () => {
  const dir = scratch();
  try {
    const path = join(dir, '.last-handed-user');
    assert.equal(readHandedWatermark(path), undefined, 'nothing written yet is not a mark');
    writeHandedWatermark(path, B.createdAt);
    assert.equal(readHandedWatermark(path), B.createdAt);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a damaged or empty mark reads as unknown, never as handed', () => {
  const dir = scratch();
  try {
    const path = join(dir, '.last-handed-user');
    for (const junk of ['', '   ', 'yesterday', '0', 'null']) {
      writeFileSync(path, junk);
      assert.equal(readHandedWatermark(path), undefined, `"${junk}" must not read as a mark`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('with no mark, every earlier message from their person is handed over again', () => {
  // This IS the restart behaviour being fixed — and it stays the behaviour
  // whenever the mark cannot be trusted, because handing one over twice is
  // visible and handing one over zero times is not.
  const missed = selectMissedInbound(users, undefined, PROMPT, C.createdAt);
  assert.deepEqual(missed.map(m => m.content), ['first', 'second']);
});

test('a mark that survived the restart stops the already-answered replay', () => {
  const missed = selectMissedInbound(users, B.createdAt, PROMPT, C.createdAt);
  assert.deepEqual(missed, [], 'both were handed over before the restart');
});

test('a mark only suppresses what it actually covers', () => {
  const missed = selectMissedInbound(users, A.createdAt, PROMPT, C.createdAt);
  assert.deepEqual(missed.map(m => m.content), ['second']);
});

test('the message arriving now is never reported as one nobody got', () => {
  for (const since of [undefined, A.createdAt, B.createdAt]) {
    const missed = selectMissedInbound(users, since, PROMPT, C.createdAt);
    assert.equal(missed.some(m => m.content === C.content), false);
  }
});
