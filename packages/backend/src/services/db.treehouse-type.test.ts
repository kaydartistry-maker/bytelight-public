// Migration 038: a database made before the Treehouse existed has
// CHECK(type IN ('daily', 'named')) on threads. Booting through the real
// initDb must widen it in place without losing a row or a seat, and the
// Treehouse must then open, seat the resident pair, and stay out of the
// ordinary thread list.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const tmpRoot = mkdtempSync(join(tmpdir(), 'treehouse-type-test-'));
process.env.RESONANT_HOME = tmpRoot;
const dbPath = join(tmpRoot, 'test.db');
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '../../migrations');

const { initDb, getDb, listThreads } = await import('./db.js');
const { getTreehouseThread, postToTreehouse, getTreehouseMessages } = await import('./treehouse.js');

before(() => {
  // An old house: 001 as it shipped, two threads and a message in them.
  const old = new Database(dbPath);
  old.exec(readFileSync(join(MIGRATIONS, '001_init.sql'), 'utf8'));
  const ins = old.prepare('INSERT INTO threads (id, name, type, created_at, last_activity_at) VALUES (?, ?, ?, ?, ?)');
  ins.run('old-named', 'Old named', 'named', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  ins.run('old-daily', 'Old daily', 'daily', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  old.prepare("INSERT INTO messages (id, thread_id, sequence, role, content, created_at) VALUES ('m1', 'old-named', 1, 'user', 'hi', '2026-01-01T00:00:00.000Z')").run();
  old.close();
  initDb(dbPath);
});

after(() => {
  try { getDb().close(); } catch { /* already closed */ }
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('038 threads.type widen', () => {
  it('the stored schema allows treehouse after boot', () => {
    const sql = (getDb().prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'threads'").get() as { sql: string }).sql;
    assert.match(sql, /'treehouse'/);
  });

  it('keeps every old thread, its message and its seats', () => {
    const db = getDb();
    const ids = (db.prepare('SELECT id FROM threads').all() as Array<{ id: string }>).map((r) => r.id);
    assert.ok(ids.includes('old-named') && ids.includes('old-daily'));
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 'old-named'").get() as { n: number }).n, 1);
    // 015 seated the resident pair in every pre-existing thread; the rebuild must not cascade them away.
    const seats = (db.prepare("SELECT companion_id FROM thread_companions WHERE thread_id = 'old-named' ORDER BY companion_id").all() as Array<{ companion_id: string }>).map((r) => r.companion_id);
    assert.deepEqual(seats, ['companion-a', 'companion-b']);
  });

  it('a second boot leaves the widened table alone', () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number }).n;
    initDb(dbPath);
    const after = (getDb().prepare('SELECT COUNT(*) AS n FROM threads').get() as { n: number }).n;
    assert.equal(after, before);
  });
});

describe('the Treehouse thread', () => {
  it('opens once, seated with the resident pair', () => {
    const a = getTreehouseThread();
    const b = getTreehouseThread();
    assert.equal(a.id, b.id);
    const seats = (getDb().prepare('SELECT companion_id FROM thread_companions WHERE thread_id = ? ORDER BY companion_id').all(a.id) as Array<{ companion_id: string }>).map((r) => r.companion_id);
    assert.deepEqual(seats, ['companion-a', 'companion-b']);
  });

  it('is not an ordinary thread in the list', () => {
    const { id } = getTreehouseThread();
    assert.ok(!listThreads({ limit: 500 }).some((t) => t.id === id));
    assert.ok(listThreads({ limit: 500, includeTreehouse: true }).some((t) => t.id === id));
  });

  it('a post reads back under its speaker', () => {
    postToTreehouse('companion-b', 'You up?');
    const last = getTreehouseMessages(5).at(-1);
    assert.equal(last?.companion_slug, 'companion-b');
    assert.equal(last?.content, 'You up?');
  });
});
