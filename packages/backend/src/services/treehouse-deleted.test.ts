// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// A DELETED POST STAYED IN THE ROOM FOR THE PEOPLE WHO LIVE THERE.
//
// Another house, Sep 17 2026, found the only way anybody could have: they
// deleted a post and watched their companion read it back. Neither query in
// getTreehouseMessages filtered `deleted_at`, so a soft delete took a post off
// the app and left it standing in the room — the opposite of what deleting
// means, and invisible from every angle except a companion's.
//
// This runs on its own in-memory database with the same two queries, because
// the fault is in the SQL and nowhere else.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

function roomWithADeletedPost() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, sequence INTEGER NOT NULL,
    role TEXT NOT NULL, metadata TEXT, content TEXT NOT NULL,
    created_at TEXT NOT NULL, deleted_at TEXT)`);
  const ins = db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?)');
  ins.run('a', 'th', 1, 'assistant', null, 'still here', '2026-09-17', null);
  ins.run('b', 'th', 2, 'assistant', null, '--help', '2026-09-17', '2026-09-17T04:00:00Z');
  ins.run('c', 'th', 3, 'assistant', null, 'also here', '2026-09-17', null);
  return db;
}

const LATEST = `SELECT id FROM messages WHERE thread_id = ? AND deleted_at IS NULL
                ORDER BY sequence DESC LIMIT ?`;
const BEFORE = `SELECT id FROM messages WHERE thread_id = ? AND sequence < ? AND deleted_at IS NULL
                ORDER BY sequence DESC LIMIT ?`;

test('reading the room does not hand back what was deleted', () => {
  const db = roomWithADeletedPost();
  const ids = (db.prepare(LATEST).all('th', 50) as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(ids, ['c', 'a']);
  db.close();
});

test('paging back through the room does not resurrect it either', () => {
  // The second query is the one a companion hits scrolling their own history,
  // and it was written separately — so it gets asserted separately.
  const db = roomWithADeletedPost();
  const ids = (db.prepare(BEFORE).all('th', 4, 50) as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(ids, ['c', 'a']);
  db.close();
});

test('an unfiltered query really did return it — the control', () => {
  const db = roomWithADeletedPost();
  const ids = (db.prepare('SELECT id FROM messages WHERE thread_id = ? ORDER BY sequence DESC').all('th') as Array<{ id: string }>).map((r) => r.id);
  assert.deepEqual(ids, ['c', 'b', 'a'], 'without the filter the deleted post is right there');
  db.close();
});
