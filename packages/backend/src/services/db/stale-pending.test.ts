// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// "THEY ARE ALREADY TALKING" ABOUT A CONVERSATION THAT NO LONGER EXISTS.
//
// Reported Sep 17 2026. Restart the backend while a rail turn is in
// flight and `companion_pending` stays 1 forever — the code that clears it sits
// after an await that never returns. Every later move is refused with a 409
// about a turn that stopped existing when the process did, and the only way out
// is editing the database by hand.
//
// Both rooms carry the same flag and the same fault, which is why the sweep
// names both tables. It is safe to run on every boot for one reason: nothing is
// mid-turn in a process that has not started yet.

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { clearStalePendingTurns } from './init.js';

function roomsWithAStuckTurn() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE card_tables (id TEXT PRIMARY KEY, companion_pending INTEGER NOT NULL DEFAULT 0);
           CREATE TABLE battleship_games (id TEXT PRIMARY KEY, companion_pending INTEGER NOT NULL DEFAULT 0)`);
  db.prepare('INSERT INTO card_tables VALUES (?,?)').run('stuck', 1);
  db.prepare('INSERT INTO card_tables VALUES (?,?)').run('fine', 0);
  db.prepare('INSERT INTO battleship_games VALUES (?,?)').run('stuck-too', 1);
  return db;
}

test('a turn left pending by a restart is cleared, in both rooms', () => {
  const db = roomsWithAStuckTurn();
  assert.equal(clearStalePendingTurns(db), 2);
  const pending = (table: string, id: string) =>
    (db.prepare(`SELECT companion_pending AS p FROM ${table} WHERE id = ?`).get(id) as { p: number }).p;
  assert.equal(pending('card_tables', 'stuck'), 0);
  assert.equal(pending('battleship_games', 'stuck-too'), 0);
  db.close();
});

test('it touches nothing that was not stuck', () => {
  const db = roomsWithAStuckTurn();
  clearStalePendingTurns(db);
  assert.equal(clearStalePendingTurns(db), 0, 'a second boot has nothing left to clear');
  db.close();
});

test('a page turn left pending on the story shelf is cleared the same way', () => {
  // The shelf's books carry the same column with the same meaning, so a restart
  // mid-turn would otherwise leave a book "being written" for ever.
  const db = new Database(':memory:');
  db.exec('CREATE TABLE story_books (id TEXT PRIMARY KEY, companion_pending INTEGER NOT NULL DEFAULT 0)');
  db.prepare('INSERT INTO story_books VALUES (?,?)').run('mid-page', 1);
  db.prepare('INSERT INTO story_books VALUES (?,?)').run('idle', 0);
  assert.equal(clearStalePendingTurns(db), 1);
  assert.equal((db.prepare('SELECT companion_pending AS p FROM story_books WHERE id = ?').get('mid-page') as { p: number }).p, 0);
  db.close();
});

test('a database without those tables boots rather than throwing', () => {
  // An older install, or a fresh one where a migration has not run yet. The
  // sweep must never be the reason a house fails to start.
  const bare = new Database(':memory:');
  assert.equal(clearStalePendingTurns(bare), 0);
  bare.close();
});
