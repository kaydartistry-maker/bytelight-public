// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * A turn that says nothing gives the user's message back.
 *
 * A message arrived and the turn carrying it started; the CLI session exited
 * code 1 at its context ceiling and the relaunch minted a NEW conversation
 * rather than resuming. The transcript that owed the user a reply was gone, and
 * the handover mark — which advances at the START of a turn, past the message
 * arriving now — had already stepped over the message. The net never offered it again
 * and wrote no row for it. Only the person waiting on the reply noticed it had
 * been dropped.
 *
 * The standing defence was that the owed-turn ledger survives a relaunch
 * because the CLI resumes the transcript. That holds only for a resume.
 *
 * These pin the repair and, more to the point, the half that must not change
 * with it: the net stays one-way. Handing a message over twice is visible and
 * annoying. Handing it over zero times is neither.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  rollbackHandedWatermark, writeHandedWatermark, readHandedWatermark, selectMissedInbound,
} from './runtime.js';

const EARLIER = '2026-09-19T10:20:11.000Z';
const HERS    = '2026-09-19T10:37:41.924Z'; // the user's message
const SCRATCH = () => mkdtempSync(join(tmpdir(), 'hb-rollback-'));

test('a turn that said nothing puts the mark back where it started', () => {
  const dir = SCRATCH();
  try {
    const path = join(dir, '.last-handed-user');
    writeHandedWatermark(path, HERS);
    // What the turn looked like: it began standing at EARLIER, then the net
    // advanced it past the user's message before the session died.
    const state = { lastHandedUserAt: HERS, handedBeforeTurn: EARLIER };

    const restored = rollbackHandedWatermark(state, path);

    assert.equal(restored, EARLIER);
    assert.equal(state.lastHandedUserAt, EARLIER, 'in memory');
    assert.equal(readHandedWatermark(path), EARLIER, 'and on disk — forever has to survive a restart');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('and the message is offered again — which is the whole point', () => {
  const dir = SCRATCH();
  try {
    const path = join(dir, '.last-handed-user');
    const users = [
      { content: 'earlier thing', createdAt: EARLIER },
      { content: '*sets the cup down and waits for an answer*', createdAt: HERS },
    ];
    const state = { lastHandedUserAt: HERS, handedBeforeTurn: EARLIER };

    // Before the rollback the net sees nothing owed — this is the hole.
    assert.equal(
      selectMissedInbound(users, state.lastHandedUserAt, 'an unrelated later prompt', HERS).length,
      0,
      'the fault being repaired: their person is already marked handed',
    );

    rollbackHandedWatermark(state, path);

    const owed = selectMissedInbound(users, state.lastHandedUserAt, 'an unrelated later prompt', HERS);
    assert.equal(owed.length, 1);
    assert.match(owed[0].content, /sets the cup down/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lane with no earlier mark leaves the advanced one standing', () => {
  const dir = SCRATCH();
  try {
    const path = join(dir, '.last-handed-user');
    writeHandedWatermark(path, HERS);
    const state: { lastHandedUserAt?: string; handedBeforeTurn?: string } =
      { lastHandedUserAt: HERS, handedBeforeTurn: undefined };

    assert.equal(rollbackHandedWatermark(state, path), undefined);
    assert.equal(state.lastHandedUserAt, HERS, 'nothing to restore, so nothing moves');
    assert.equal(readHandedWatermark(path), HERS, 'and the file is not deleted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a mark that never moved is not rewound', () => {
  const dir = SCRATCH();
  try {
    const path = join(dir, '.last-handed-user');
    const state = { lastHandedUserAt: HERS, handedBeforeTurn: HERS };
    assert.equal(rollbackHandedWatermark(state, path), undefined);
    assert.equal(state.lastHandedUserAt, HERS);
    assert.equal(existsSync(path), false, 'a no-op rollback writes nothing at all');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the record is strictly per-turn — it cannot be spent twice', () => {
  const dir = SCRATCH();
  try {
    const path = join(dir, '.last-handed-user');
    const state = { lastHandedUserAt: HERS, handedBeforeTurn: EARLIER };
    assert.equal(rollbackHandedWatermark(state, path), EARLIER);
    // A second silent turn with nothing recorded must not rewind further.
    assert.equal(rollbackHandedWatermark(state, path), undefined);
    assert.equal(state.lastHandedUserAt, EARLIER);
    assert.equal(readFileSync(path, 'utf8').trim(), EARLIER);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
