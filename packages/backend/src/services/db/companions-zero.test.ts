import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

import type Database from 'better-sqlite3';

import {
  createRoutingThreadShell,
  createThread,
  getDb,
  getThreadRoster,
  initDb,
  setRoutingThreadId,
} from '../db.js';
import { handleCommand } from '../commands.js';

const root = mkdtempSync(join(tmpdir(), 'companions-zero-'));
let sequence = 0;

function openFresh(): { database: Database.Database; path: string } {
  const path = join(root, `house-${sequence++}.db`);
  return { database: initDb(path), path };
}

function closeCurrent(): void {
  try {
    getDb().close();
  } catch {
  }
}

function createdThreadId(result: Awaited<ReturnType<typeof handleCommand>>): string {
  if (result.type !== 'command_result' || !result.success) {
    assert.fail(`expected a successful command result, got ${JSON.stringify(result)}`);
  }
  const threadId = result.data?.threadId;
  if (typeof threadId !== 'string') assert.fail('expected a created thread id');
  return threadId;
}

function count(database: Database.Database, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

beforeEach(closeCurrent);

after(() => {
  closeCurrent();
  rmSync(root, { recursive: true, force: true });
});

test('a fresh install and its second boot contain no residents or seeded rooms', () => {
  const { database, path } = openFresh();

  assert.equal(count(database, 'companions'), 0);
  assert.equal(count(database, 'threads'), 0);

  database.close();
  const rebooted = initDb(path);
  assert.equal(count(rebooted, 'companions'), 0);
  assert.equal(count(rebooted, 'threads'), 0);
});

test('creating a conversational thread requires an explicit non-empty roster', () => {
  const { database } = openFresh();
  const base = {
    id: 'missing-roster',
    name: 'Missing roster',
    type: 'named',
    createdAt: '2026-11-13T00:00:00.000Z',
  };

  assert.throws(() => Reflect.apply(createThread, undefined, [base]), /companionIds.*non-empty/i);
  assert.throws(
    () => Reflect.apply(createThread, undefined, [{ ...base, id: 'empty-roster', companionIds: [] }]),
    /companionIds.*non-empty/i,
  );
  assert.throws(
    () => Reflect.apply(createThread, undefined, [{ ...base, id: 'unknown-roster', companionIds: ['not-a-resident'] }]),
    /companionIds.*registry/i,
  );
  assert.equal(count(database, 'threads'), 0, 'validation happens before the thread insert');
});

test('a solo roster remains solo after reboot', () => {
  const { database, path } = openFresh();
  database.prepare(
    `INSERT INTO companions (id, display_name, brain, sort_order)
     VALUES ('solo', 'Solo', 'solo-brain', 0)`,
  ).run();
  createThread({
    id: 'solo-thread',
    name: 'Solo thread',
    type: 'named',
    createdAt: '2026-11-13T00:00:00.000Z',
    companionIds: ['solo'],
  });
  assert.deepEqual(getThreadRoster('solo-thread').map((resident) => resident.id), ['solo']);

  database.close();
  initDb(path);
  assert.deepEqual(getThreadRoster('solo-thread').map((resident) => resident.id), ['solo']);
});

test('a live-shaped house keeps residents, avatars, settings, and the Home roster', () => {
  const { database, path } = openFresh();
  database.exec('DELETE FROM thread_companions; DELETE FROM threads; DELETE FROM companion_settings; DELETE FROM companions;');

  const insertResident = database.prepare(
    `INSERT INTO companions (
       id, display_name, avatar, brain, model, sort_order, effort, slug,
       archetype, claude_md_path, mcp_json_path, model_autonomous,
       avatar_url, is_primary, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertResident.run(
    'companion-a', 'Companion A', '/avatars/companion-a.png', 'companion-a-b', 'model-one', 0,
    'high', 'companion-a', 'anchor', '/identity/companion-a.md', '/identity/companion-a.mcp.json',
    'model-one-auto', 'https://example.invalid/companion-a.png', 1, '2026-11-12T10:00:00Z',
  );
  insertResident.run(
    'companion-b', 'Companion B', '/avatars/companion-b.png', 'companion-a-b', 'model-two', 1,
    'medium', 'companion-b', 'spark', '/identity/companion-b.md', '/identity/companion-b.mcp.json',
    'model-two-auto', 'https://example.invalid/companion-b.png', 0, '2026-11-12T11:00:00Z',
  );
  database.prepare(
    `INSERT INTO threads (id, name, type, created_at, session_type, last_activity_at)
     VALUES ('home', 'Home', 'named', '2026-01-01T00:00:00Z', 'v2', '2026-01-01T00:00:00Z')`,
  ).run();
  database.prepare('INSERT INTO thread_companions (thread_id, companion_id) VALUES (?, ?)').run('home', 'companion-a');
  database.prepare('INSERT INTO thread_companions (thread_id, companion_id) VALUES (?, ?)').run('home', 'companion-b');
  database.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('app.routingThreadId', 'home')").run();
  database.prepare(
    `INSERT INTO companion_settings (
       companion_id, tier, provider_id, model_id, thinking_effort,
       scope, thread_id, created_at, updated_at
     ) VALUES ('companion-a-b', 'interactive', 'claude', 'configured-model', 'high',
       'companion', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  ).run();

  const before = database.prepare(
    `SELECT id, avatar, effort, slug, archetype, claude_md_path, mcp_json_path,
            model_autonomous, avatar_url, is_primary, updated_at
       FROM companions ORDER BY sort_order`,
  ).all();
  database.close();

  const rebooted = initDb(path);
  const afterRows = rebooted.prepare(
    `SELECT id, avatar, effort, slug, archetype, claude_md_path, mcp_json_path,
            model_autonomous, avatar_url, is_primary, updated_at
       FROM companions ORDER BY sort_order`,
  ).all();
  assert.deepEqual(afterRows, before);
  assert.deepEqual(getThreadRoster('home').map((resident) => resident.id), ['companion-a', 'companion-b']);
  assert.equal(
    (rebooted.prepare("SELECT model_id FROM companion_settings WHERE companion_id = 'companion-a-b'").get() as { model_id: string }).model_id,
    'configured-model',
  );
});

test('a deliberately empty Home stays empty after reboot', () => {
  const { database, path } = openFresh();
  database.prepare(
    `INSERT INTO companions (id, display_name, brain, sort_order)
     VALUES ('resident', 'Resident', 'house-brain', 0)`,
  ).run();
  createRoutingThreadShell({
    id: 'empty-home',
    name: 'Home',
    type: 'named',
    createdAt: '2026-11-13T00:00:00.000Z',
  });
  setRoutingThreadId('empty-home');

  database.close();
  const rebooted = initDb(path);

  assert.deepEqual(getThreadRoster('empty-home'), []);
  rebooted.close();
  initDb(path);
  assert.deepEqual(getThreadRoster('empty-home'), []);
});

test('a partially upgraded companion table gets every missing live column', () => {
  const { database, path } = openFresh();
  database.prepare(
    `INSERT INTO companions (id, display_name, avatar, brain, sort_order, slug)
     VALUES ('kept', 'Kept', '/avatars/kept.png', 'kept-brain', 0, 'kept-slug')`,
  ).run();
  database.exec(`
    ALTER TABLE companions DROP COLUMN archetype;
    ALTER TABLE companions DROP COLUMN mcp_json_path;
    ALTER TABLE companions DROP COLUMN updated_at;
  `);
  database.close();

  const upgraded = initDb(path);
  const columns = new Set(
    (upgraded.prepare('PRAGMA table_info(companions)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  assert.ok(columns.has('archetype'));
  assert.ok(columns.has('mcp_json_path'));
  assert.ok(columns.has('updated_at'));
  assert.deepEqual(
    upgraded.prepare('SELECT id, avatar, slug FROM companions').get(),
    { id: 'kept', avatar: '/avatars/kept.png', slug: 'kept-slug' },
  );
  upgraded.close();
  const rebooted = initDb(path);
  assert.deepEqual(
    rebooted.prepare('SELECT id, avatar, slug FROM companions').get(),
    { id: 'kept', avatar: '/avatars/kept.png', slug: 'kept-slug' },
  );
});

test('/new copies the current roster and falls back to Home when the current roster is empty', async () => {
  const { database } = openFresh();
  database.exec(`
    INSERT INTO companions (id, display_name, brain, sort_order) VALUES
      ('current-resident', 'Current resident', 'current-brain', 0),
      ('home-resident', 'Home resident', 'home-brain', 1);
  `);
  createThread({
    id: 'home',
    name: 'Home',
    type: 'named',
    createdAt: '2026-11-13T00:00:00.000Z',
    companionIds: ['home-resident'],
  });
  setRoutingThreadId('home');
  createThread({
    id: 'current',
    name: 'Current',
    type: 'named',
    createdAt: '2026-11-13T00:00:00.000Z',
    companionIds: ['current-resident'],
  });
  createRoutingThreadShell({
    id: 'empty-current',
    name: 'Empty current',
    type: 'named',
    createdAt: '2026-11-13T00:00:00.000Z',
  });

  const fromCurrent = await Reflect.apply(handleCommand, undefined, ['new', 'From current', 'current', {}]);
  const currentCopyId = createdThreadId(fromCurrent);
  assert.deepEqual(getThreadRoster(currentCopyId).map((resident) => resident.id), ['current-resident']);

  const fromHome = await Reflect.apply(handleCommand, undefined, ['new', 'From Home', 'empty-current', {}]);
  const homeCopyId = createdThreadId(fromHome);
  assert.deepEqual(getThreadRoster(homeCopyId).map((resident) => resident.id), ['home-resident']);
});

test('the companion registry reaches live-schema parity on a fresh install', () => {
  const { database } = openFresh();
  const columns = new Set(
    (database.prepare('PRAGMA table_info(companions)').all() as Array<{ name: string }>).map((column) => column.name),
  );
  for (const name of [
    'slug', 'effort', 'archetype', 'claude_md_path', 'mcp_json_path',
    'model_autonomous', 'avatar_url', 'is_primary', 'updated_at',
  ]) {
    assert.ok(columns.has(name), `companions.${name} exists`);
  }
  const index = database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_companions_slug'",
  ).get();
  assert.ok(index, 'the live unique slug index exists');
});
