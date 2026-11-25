import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { normalizeResidents, residentIdFor, seedResidentsFromConfig } from './resident-seed.js';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE companions (
    id TEXT PRIMARY KEY, display_name TEXT NOT NULL, avatar TEXT, brain TEXT NOT NULL,
    model TEXT, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  return db;
}

const rows = (db: Database.Database) =>
  db.prepare('SELECT id, display_name, brain, sort_order FROM companions ORDER BY sort_order').all();

test('names become stable ids', () => {
  assert.equal(residentIdFor('River'), 'river');
  assert.equal(residentIdFor("D'Artagnan Rivera"), 'dartagnan-rivera');
  assert.equal(residentIdFor('Zoë'), 'zoe');
});

test('the yaml list is cleaned: blanks and repeats dropped, given ids kept', () => {
  assert.deepEqual(normalizeResidents(['River', ' ', { name: 'river' }, { id: 'stone', name: 'Stone' }, 7]), [
    { id: 'river', name: 'River' },
    { id: 'stone', name: 'Stone' },
  ]);
  assert.deepEqual(normalizeResidents(undefined), []);
});

test('a solo house gets exactly its one companion, on the house brain', () => {
  const db = freshDb();
  assert.equal(seedResidentsFromConfig(db, [{ name: 'River' }], 'river'), 1);
  assert.deepEqual(rows(db), [{ id: 'river', display_name: 'River', brain: 'river', sort_order: 0 }]);
});

test('a pair keeps the order they were named in', () => {
  const db = freshDb();
  seedResidentsFromConfig(db, ['River', 'Stone'], 'house');
  assert.deepEqual(rows(db).map((r: any) => r.id), ['river', 'stone']);
});

test('booting again changes nothing, and never renames an existing row', () => {
  const db = freshDb();
  seedResidentsFromConfig(db, ['River'], 'river');
  db.prepare("UPDATE companions SET display_name = 'J' WHERE id = 'river'").run();
  assert.equal(seedResidentsFromConfig(db, ['River'], 'river'), 0);
  assert.equal((rows(db)[0] as any).display_name, 'J');
});

test('no residents or no brain seeds nothing', () => {
  const db = freshDb();
  assert.equal(seedResidentsFromConfig(db, [], 'river'), 0);
  assert.equal(seedResidentsFromConfig(db, ['River'], ''), 0);
  assert.deepEqual(rows(db), []);
});
