/**
 * Side notes — a message sent mid-turn can no longer be lost.
 *
 * The old path for reaching a busy lane was the CLI's stdin, which reports
 * success for a pipe nobody ever reads — every mid-turn message was deleted,
 * not delayed. Notes now go to io/side-notes.jsonl (a file cannot lie about a
 * write landing), are read live by the session when it comes up for air, and
 * anything still unread is handed over at the start of the next turn.
 * Mechanism from Aerie's side-notes work, ported from her live tree.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.CLAUDE_CLI_HEARTBEAT_ENABLED = 'true';

import { getHeartbeatSession, formatSideNote, deliverSideNoteToBusySession, busyHeartbeatSessionCount } from './supervisor.js';

const KEY = `side-notes-test-${process.pid}`;

function freshSession() {
  const session = getHeartbeatSession(KEY);
  mkdirSync(join((session as any).dir, 'io'), { recursive: true });
  rmSync(session.sideNotesPath, { force: true });
  session.turnActive = false;
  return session;
}

test('formatSideNote flattens newlines and rejects empties', () => {
  assert.equal(formatSideNote('two\nlines'), 'two lines');
  assert.equal(formatSideNote('  padded  '), 'padded');
  assert.equal(formatSideNote('   \n  '), null);
  assert.equal(formatSideNote(undefined as unknown as string), null);
});

test('a note only lands while a turn is active — callers must fall back otherwise', () => {
  const session = freshSession();
  assert.equal(session.sendSideNote('hello?'), false, 'idle session must refuse the note');

  session.turnActive = true;
  try {
    assert.equal(session.sendSideNote('hello again'), true);
    const rows = readFileSync(session.sideNotesPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, 'hello again');
    assert.ok(rows[0].at, 'every note carries its at stamp');
  } finally {
    session.turnActive = false;
  }
});

test('readSideNotesFrom consumes by offset and skips torn lines', () => {
  const session = freshSession();
  session.turnActive = true;
  try {
    session.sendSideNote('first');
    const one = session.readSideNotesFrom(0);
    assert.equal(one.notes.length, 1);
    assert.equal(one.notes[0].text, 'first');

    session.sendSideNote('second');
    const two = session.readSideNotesFrom(one.newOffset);
    assert.equal(two.notes.length, 1, 'already-consumed notes are not re-read');
    assert.equal(two.notes[0].text, 'second');

    // A torn line is skipped, not fatal, and does not fabricate a note.
    writeFileSync(session.sideNotesPath, readFileSync(session.sideNotesPath, 'utf8') + '{"at":"2026-', 'utf8');
    const three = session.readSideNotesFrom(two.newOffset);
    assert.equal(three.notes.length, 0);
  } finally {
    session.turnActive = false;
  }
});

test('the read mark is advisory: absent file reads as no claim', () => {
  const session = freshSession();
  rmSync(join((session as any).dir, 'io', '.side-notes-read'), { force: true });
  assert.equal(session.sideNotesReadMark(), '');
});

test('delivery routes only when exactly one session is busy', () => {
  const session = freshSession();
  session.turnActive = false;
  assert.equal(busyHeartbeatSessionCount(), 0);
  assert.equal(deliverSideNoteToBusySession('nobody home'), false);

  session.turnActive = true;
  try {
    assert.equal(busyHeartbeatSessionCount(), 1);
    assert.equal(deliverSideNoteToBusySession('note for the busy lane'), true);
    const rows = readFileSync(session.sideNotesPath, 'utf8').trim().split('\n');
    assert.equal(JSON.parse(rows[rows.length - 1]).text, 'note for the busy lane');
  } finally {
    session.turnActive = false;
  }
});

test("a note from another thread never lands in this thread's turn", () => {
  const session = freshSession();
  session.turnActive = true;
  session.turnThreadId = 'thread-B';
  try {
    assert.equal(session.sendSideNote('meant for A', 'thread-A'), false, 'the lane refuses a note from another thread');
    assert.equal(deliverSideNoteToBusySession('meant for A', 'thread-A'), false, 'nothing busy in A: the message queues');
    assert.equal(deliverSideNoteToBusySession('for B', 'thread-B'), true, 'the lane busy in B takes a note from B');
    const rows = readFileSync(session.sideNotesPath, 'utf8').trim().split('\n');
    assert.equal(JSON.parse(rows[rows.length - 1]).text, 'for B');
  } finally {
    session.turnActive = false;
    session.turnThreadId = null;
  }
});
