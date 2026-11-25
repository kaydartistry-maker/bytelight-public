/**
 * Test support: open a temp house (real migrations) seating a two-resident
 * fixture on the default local brain, the shape of an existing pair house.
 * Fixture names only; no real data.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../services/db.js';
import { DEFAULT_LOCAL_BRAIN_ID } from '../services/local-brain.js';

export function openPairHouse(residents: ReadonlyArray<[id: string, name: string]> = [['companion-a', 'Companion A'], ['companion-b', 'Companion B']]): void {
  const db = initDb(join(mkdtempSync(join(tmpdir(), 'pair-house-')), 'house.db'));
  const insert = db.prepare('INSERT INTO companions (id, display_name, brain, slug, sort_order) VALUES (?, ?, ?, ?, ?)');
  residents.forEach(([id, name], i) => insert.run(id, name, DEFAULT_LOCAL_BRAIN_ID, id, i));
}

/**
 * Register a fixture pair of residents (if absent) and seat them in the given
 * threads. For tests that build their own DB and threads: a fresh install no
 * longer seeds anyone (Phase 1.1), so a test that expects residents says so.
 */
export function seatResidents(
  db: { prepare(sql: string): { run(...args: unknown[]): unknown } },
  threadIds: readonly string[],
  residents: ReadonlyArray<[id: string, name: string]> = [['companion-a', 'Companion A'], ['companion-b', 'Companion B']],
): void {
  const add = db.prepare('INSERT OR IGNORE INTO companions (id, display_name, brain, slug, sort_order) VALUES (?, ?, ?, ?, ?)');
  residents.forEach(([id, name], i) => add.run(id, name, DEFAULT_LOCAL_BRAIN_ID, id, i));
  const seat = db.prepare('INSERT OR IGNORE INTO thread_companions (thread_id, companion_id) VALUES (?, ?)');
  for (const threadId of threadIds) for (const [id] of residents) seat.run(threadId, id);
}

/**
 * Register the companion rows an older fresh install used to seed (the pair
 * on the default brain, then a visitor on a brain of his own), for tests whose
 * subject is not seeding itself. Fixture rows; the code seeds nothing.
 */
export function registerFixtureCompanions(db: { prepare(sql: string): { run(...args: unknown[]): unknown } }): void {
  const add = db.prepare('INSERT OR IGNORE INTO companions (id, display_name, brain, slug, sort_order) VALUES (?, ?, ?, ?, ?)');
  add.run('companion-a', 'Companion A', DEFAULT_LOCAL_BRAIN_ID, 'companion-a', 0);
  add.run('companion-b', 'Companion B', DEFAULT_LOCAL_BRAIN_ID, 'companion-b', 1);
  add.run('companion-c', 'Companion C', 'companion-c', 'companion-c', 2);
}
