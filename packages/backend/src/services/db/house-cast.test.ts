// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// byte-light: the DB opens against a throwaway home the way rooms.card.test.ts
// does. Aerie seeds a house with createCompanion(); byte-light's registry is
// the companions table (migration 014), so a test house is written into it
// directly, replacing the seeded residents for the length of the test.
const tmpRoot = mkdtempSync(join(tmpdir(), 'house-cast-test-'));
process.env.RESONANT_HOME = tmpRoot;
const configPath = join(tmpRoot, 'config.yaml');
writeFileSync(configPath, 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { loadConfig } = await import('../../config.js');
const { initDb, getDb } = await import('../db.js');
const { CardRoomError, defaultGameSeats, ownerSeat, partnerGameSeats } = await import('./cards.js');
const {
  BattleshipError,
  assertFleetCompanion,
  beginBattleshipCompanionResponse,
  fireAtCompanionFleet,
  fireAtPlayerFleet,
  newBattleshipGame,
  randomBattleshipFleet,
  startBattleshipGame,
} = await import('./battleship.js');

// The companions at a table are whoever lives in this house, read from its own
// companions table in their stored order. Nothing here may assume a cast: a
// house whose companions are called something else has to get a full table.

let houses = 0;
function seedHouse(...names: string[]): string[] {
  initDb(join(tmpRoot, `house-${houses++}.db`));
  const db = getDb();
  db.exec('DELETE FROM thread_companions; DELETE FROM companions;');
  const insert = db.prepare(
    "INSERT INTO companions (id, display_name, brain, sort_order, created_at) VALUES (?, ?, 'test', ?, datetime('now'))",
  );
  return names.map((name, i) => {
    insert.run(name.toLowerCase(), name, i);
    return name.toLowerCase();
  });
}

test('a new game seats the owner, then this house\'s companions in stored order', () => {
  const [ivy, fox, nim, oak] = seedHouse('Ivy', 'Fox', 'Nim', 'Oak');
  assert.deepEqual(defaultGameSeats(), [ownerSeat(), ivy, fox, nim, oak]);
  // A game for exactly four takes the first three that fit.
  assert.deepEqual(defaultGameSeats(4), [ownerSeat(), ivy, fox, nim]);
});

test('a partnership table seats the first companion across from the owner unless they pick', () => {
  const [ivy, fox, nim] = seedHouse('Ivy', 'Fox', 'Nim');
  // Partners sit across: seat 0 is the owner's and seat 2 is their partner's.
  assert.deepEqual(partnerGameSeats(undefined), [ownerSeat(), fox, ivy, nim]);
  assert.deepEqual(partnerGameSeats(nim), [ownerSeat(), ivy, nim, fox]);
});

test('a partnership table with too few companions says so instead of seating nobody', () => {
  seedHouse('Ivy', 'Fox');
  assert.throws(() => partnerGameSeats(undefined), CardRoomError);
});

test('any of this house\'s companions may fire in the Fleet Room, and nobody else', () => {
  seedHouse('Ivy', 'Fox', 'Nim');
  assert.equal(assertFleetCompanion(' Ivy '), 'ivy');
  assert.throws(() => assertFleetCompanion('birch'), BattleshipError, 'a name from some other house');

  const game = startBattleshipGame(newBattleshipGame().id, randomBattleshipFleet());
  fireAtCompanionFleet(game.id, 'A1');
  assert.equal(fireAtPlayerFleet(game.id, 'fox', 'A1').coordinate, 'A1');
});

test('the Fleet Room tells the lane who is in the room and which names may fire', () => {
  loadConfig(configPath);
  seedHouse('Ivy', 'Fox', 'Nim');
  const game = startBattleshipGame(newBattleshipGame().id, randomBattleshipFleet());
  fireAtCompanionFleet(game.id, 'A1');
  const { prompt } = beginBattleshipCompanionResponse(game.id, 'your shot', 'Fired at A1.');
  assert.match(prompt, /shared by .+, Ivy, Fox, and Nim\./);
  assert.match(prompt, /"companion":"<ivy\|fox\|nim>"/);
  assert.doesNotMatch(prompt, /\b(Birch|Maple|Cedar|birch|maple|cedar)\b/);
});
