// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addTally, FIRST_PAGE, isOurUnread, planLooks, roomKey, tallyOurUnread, type LockMessage, type LookMemory } from './lock-unread.js';

type Row = LockMessage & { who: string };

let seq = 0;
function row(role: string, who: string, read = false): Row {
  seq++;
  return { id: `m${seq}`, sequence: seq, role, read_at: read ? '2026-10-20T10:00:00Z' : null, who };
}

/** A fake GET /api/threads/:id/messages over a room, newest last. */
function roomOf(rows: Row[]) {
  const calls: Array<{ before: string | null; limit: number }> = [];
  const fetchPage = async (before: string | null, limit: number) => {
    calls.push({ before, limit });
    const end = before ? rows.findIndex((r) => r.id === before) : rows.length;
    return rows.slice(Math.max(0, end - limit), end);
  };
  return { fetchPage, calls };
}

test('only our words to the owner count, never the people in a listening cafe', async () => {
  seq = 0;
  const rows: Row[] = [row('companion', 'companion-a', true), row('user', 'owner', true)];
  for (let i = 0; i < 148; i++) rows.push(row('system', 'guest'));
  // Our own answers in the cafe were said to the room on Discord, not to the owner
  // phone: 60 of them sat in the owner count on Oct 20 2026, beside 148 of theirs.
  for (let i = 0; i < 60; i++) rows.push({ ...row('companion', 'companion-b'), platform: 'discord' });
  rows.push(row('companion', 'echo'));
  rows.push(row('system', 'guest2'));
  const { fetchPage, calls } = roomOf(rows);
  const t = await tallyOurUnread(fetchPage);
  assert.ok(t);
  assert.equal(t.count, 1);
  assert.equal((t.newest as Row).who, 'echo');
  assert.equal(t.upTo, rows[rows.length - 1].sequence);
  assert.equal(calls[0].limit, FIRST_PAGE);
});

test('the count stops where the owner last read, their own messages aside', async () => {
  seq = 0;
  const rows: Row[] = [
    row('companion', 'companion-b'), // older than where the owner read, so never unread
    row('companion', 'companion-a', true),
    row('user', 'owner'), // theirs, which we stamp, not their reading
    row('companion', 'companion-a'),
    row('companion', 'companion-b'),
  ];
  rows[0].read_at = null;
  const { fetchPage } = roomOf(rows);
  const t = await tallyOurUnread(fetchPage);
  assert.equal(t?.count, 2);
  assert.equal((t?.newest as Row).who, 'companion-b');
});

test('a later look reads only what is new and adds to the first', async () => {
  seq = 0;
  const rows: Row[] = [row('companion', 'companion-a', true), row('companion', 'echo'), row('system', 'guest')];
  const first = await tallyOurUnread(roomOf(rows).fetchPage);
  rows.push(row('companion', 'companion-b'), row('system', 'guest'));
  const { fetchPage, calls } = roomOf(rows);
  const later = await tallyOurUnread(fetchPage, first!.upTo);
  assert.equal(later?.count, 1);
  assert.equal(calls.length, 1);
  const sum = addTally(first!, later!);
  assert.equal(sum.count, 2);
  assert.equal((sum.newest as Row).who, 'companion-b');
  assert.equal(sum.upTo, rows[rows.length - 1].sequence);
});

test('a room that cannot be read is unknown, not empty', async () => {
  assert.equal(await tallyOurUnread(async () => null), null);
});

test('a deleted message of ours, or one we said to a Discord room, is not waiting for the owner', () => {
  assert.equal(isOurUnread({ id: 'a', sequence: 1, role: 'companion', read_at: null, deleted_at: '2026-10-20T10:00:00Z' }), false);
  assert.equal(isOurUnread({ id: 'a', sequence: 1, role: 'system', read_at: null }), false);
  assert.equal(isOurUnread({ id: 'a', sequence: 1, role: 'companion', read_at: null }), true);
  assert.equal(isOurUnread({ id: 'a', sequence: 1, role: 'companion', read_at: null, platform: 'web' }), true);
  assert.equal(isOurUnread({ id: 'a', sequence: 1, role: 'companion', read_at: null, platform: 'discord' }), false);
});

function memoryOf(): LookMemory {
  return { settled: new Map(), looked: new Map(), inflight: new Map() };
}

test('a room with nothing waiting is left alone until it moves', () => {
  const memory = memoryOf();
  const quiet = { id: 'home', unread_count: 0, last_activity_at: '2026-10-20T10:00:00Z' };
  const cafe = { id: 'cafe', unread_count: 216, last_activity_at: '2026-10-20T10:00:00Z' };
  assert.deepEqual(planLooks([quiet, cafe], memory, true), [{ id: 'cafe', key: roomKey(cafe), since: 0 }]);
  // A reply lands in the quiet room while the lock screen is up.
  const moved = { ...quiet, last_activity_at: '2026-10-20T10:05:00Z' };
  memory.inflight.set('cafe', roomKey(cafe));
  assert.deepEqual(planLooks([moved, cafe], memory, false), [{ id: 'home', key: roomKey(moved), since: 0 }]);
});

test('a room already looked at is read again only from where the look stopped', () => {
  const memory = memoryOf();
  const room = { id: 'home', unread_count: 3, last_activity_at: '2026-10-20T10:00:00Z' };
  planLooks([room], memory, true);
  memory.looked.set('home', { key: roomKey(room), upTo: 4100 });
  assert.deepEqual(planLooks([room], memory, false), []);
  const moved = { ...room, last_activity_at: '2026-10-20T10:01:00Z' };
  assert.deepEqual(planLooks([moved], memory, false), [{ id: 'home', key: roomKey(moved), since: 4100 }]);
  // The lock screen coming up again counts it from the top.
  assert.deepEqual(planLooks([room], memory, true), [{ id: 'home', key: roomKey(room), since: 0 }]);
  // So does a counter that dropped: the owner read the room somewhere else.
  const read = { ...room, unread_count: 0 };
  assert.deepEqual(planLooks([read], memory, false), [{ id: 'home', key: roomKey(read), since: 0 }]);
});

test('a room found with nothing of ours waiting stays settled until it moves', () => {
  const memory = memoryOf();
  const cafe = { id: 'cafe', unread_count: 216, last_activity_at: '2026-10-20T10:00:00Z' };
  planLooks([cafe], memory, true);
  memory.settled.set('cafe', roomKey(cafe));
  assert.deepEqual(planLooks([cafe], memory, true), []);
  const louder = { ...cafe, unread_count: 217, last_activity_at: '2026-10-20T10:02:00Z' };
  assert.equal(planLooks([louder], memory, false).length, 1);
});
