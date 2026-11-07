// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// byte-light: the DB opens against a throwaway home the way rooms.card.test.ts
// does, and the companions come from the registry seed (migration 014) rather
// than Aerie's createCompanion().
const tmpRoot = mkdtempSync(join(tmpdir(), 'battleship-owner-side-test-'));
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { initDb, getDb } = await import('../db.js');
const { listCompanions } = await import('./rooms.js');
const {
  OWNER_SIDE,
  fireAtCompanionFleet,
  fireAtPlayerFleet,
  getBattleshipView,
  newBattleshipGame,
  randomBattleshipFleet,
  startBattleshipGame,
} = await import('./battleship.js');

// The owner's side of the board is OWNER_SIDE to everything above the
// database. On disk, battleship_games pins that side's spelling inside two
// CHECK constraints, and a table created by an earlier build pinned a
// different word there — one SQLite cannot change without rebuilding the
// table. A match has to play on both kinds of table, every side the API
// reports has to be OWNER_SIDE, and each table has to keep the word it allows.

const MIGRATION_036 = join(dirname(fileURLToPath(import.meta.url)), '../../../migrations/036_battleship.sql');

/** A fresh house; its first seeded companion answers fire. */
let houses = 0;
let firer = '';
function seedHouse(): void {
  initDb(join(tmpRoot, `house-${houses++}.db`));
  firer = listCompanions()[0]!.id;
}

const storedTurn = (id: string) =>
  (getDb().prepare('SELECT turn FROM battleship_games WHERE id = ?').get(id) as { turn: string }).turn;

function playOneExchange(): string {
  const opened = newBattleshipGame();
  const started = startBattleshipGame(opened.id, randomBattleshipFleet());
  assert.equal(started.turn, OWNER_SIDE, 'the owner has the first shot');
  assert.equal(fireAtCompanionFleet(started.id, 'A1').turn, 'companions');
  assert.equal(fireAtPlayerFleet(started.id, firer, 'A1').nextTurn, OWNER_SIDE);
  const view = getBattleshipView(started.id)!;
  assert.equal(view.turn, OWNER_SIDE);
  assert.equal(view.playerShots[0].actor, OWNER_SIDE);
  assert.ok(view.log.some((entry) => entry.kind === 'shot' && entry.actor === OWNER_SIDE));
  return started.id;
}

test('a table made by the current migration stores the owner side as owner', () => {
  seedHouse();
  const id = playOneExchange();
  assert.equal(storedTurn(id), 'owner');
});

test('a table made by an older build keeps its own word, and the API still says owner', () => {
  seedHouse();
  // A stand-in for an existing install: the same table, with another word
  // fixed into its CHECK constraints. Any word will do; the code must read it.
  getDb().exec('DROP TABLE battleship_log; DROP TABLE battleship_games;');
  getDb().exec(readFileSync(MIGRATION_036, 'utf8').replaceAll("'owner'", "'captain'"));

  // A match played before the change, stored in that word throughout.
  const now = new Date().toISOString();
  const thread = newBattleshipGame().threadId;
  getDb().prepare(`
    INSERT INTO battleship_games (id, thread_id, status, turn, player_fleet_json, companion_fleet_json,
      player_shots_json, companion_shots_json, companion_pending, companion_error, winner, created_at, updated_at)
    VALUES ('old', ?, 'complete', 'captain', '[]', '[]', ?, '[]', 0, NULL, 'captain', ?, ?)
  `).run(thread, JSON.stringify([{ coordinate: 'B2', result: 'miss', actor: 'captain', createdAt: now }]), now, now);
  getDb().prepare(`INSERT INTO battleship_log (game_id, kind, actor, content, created_at)
                   VALUES ('old', 'shot', 'captain', 'B2: miss', ?)`).run(now);

  const old = getBattleshipView('old')!;
  assert.equal(old.turn, OWNER_SIDE);
  assert.equal(old.winner, OWNER_SIDE);
  assert.equal(old.playerShots[0].actor, OWNER_SIDE);
  assert.equal(old.log[0].actor, OWNER_SIDE);

  // A new match has to satisfy the table's own CHECK, or it never starts.
  const id = playOneExchange();
  assert.equal(storedTurn(id), 'captain');
});
