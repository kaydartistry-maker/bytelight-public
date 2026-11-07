/**
 * Migration 027 rebuilds thread_provider_sessions with a `lane` column. Every
 * existing card must come through unchanged, in the shared lane ('').
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const here = dirname(fileURLToPath(import.meta.url));
const migrations = join(here, '../../../migrations');
const old005 = readFileSync(join(migrations, '005_thread_provider_sessions.sql'), 'utf8');
const lane027 = readFileSync(join(migrations, '027_provider_sessions_lane.sql'), 'utf8');

test('027 keeps every card, all in the shared lane, and adds lane to the key', () => {
  const db = new Database(':memory:');
  db.exec("CREATE TABLE threads (id TEXT PRIMARY KEY)");
  db.exec(old005);
  db.exec("INSERT INTO threads (id) VALUES ('a'), ('b')");
  const insert = db.prepare('INSERT INTO thread_provider_sessions (thread_id, runtime_id, provider, model_ref, session_id, last_used_at, metadata_json) VALUES (?,?,?,?,?,?,?)');
  insert.run('a', 'codex-cli', 'openai', 'gpt-5.6-sol', 'conv-1', '2026-10-20T00:00:00Z', null);
  insert.run('a', 'claude-cli', 'anthropic', 'claude-opus-5-5', 'conv-2', '2026-10-20T01:00:00Z', '{"x":1}');
  insert.run('b', 'codex-cli', 'openai', 'gpt-5.6-sol', 'conv-3', '2026-10-20T02:00:00Z', null);
  const before = db.prepare('SELECT * FROM thread_provider_sessions ORDER BY session_id').all();

  db.transaction(() => db.exec(lane027))();

  const after = db.prepare('SELECT * FROM thread_provider_sessions ORDER BY session_id').all() as Array<Record<string, unknown>>;
  assert.equal(after.length, before.length);
  for (const row of after) assert.equal(row.lane, '');
  assert.deepEqual(after.map(({ lane: _lane, ...rest }) => rest), before);
  // The same thread + model can now hold a card per lane.
  db.prepare("INSERT INTO thread_provider_sessions (thread_id, lane, runtime_id, provider, model_ref, session_id, last_used_at) VALUES ('a','companion-a','codex-cli','openai','gpt-5.6-sol','conv-companion-a','2026-10-21T00:00:00Z')").run();
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM thread_provider_sessions WHERE thread_id='a' AND model_ref='gpt-5.6-sol'").get() as { n: number }).n, 2);
  db.close();
});

const root = mkdtempSync(join(tmpdir(), 'lane-migration-'));
after(() => rmSync(root, { recursive: true, force: true }));

test('booting the house twice is safe: the rebuild runs once', async () => {
  process.env.RESONANT_HOME = root;
  writeFileSync(join(root, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');
  const { initDb } = await import('./init.js');
  const path = join(root, 'house.db');
  initDb(path);
  initDb(path);
  const db = new Database(path);
  const cols = (db.prepare('PRAGMA table_info(thread_provider_sessions)').all() as Array<{ name: string; pk: number }>);
  assert.ok(cols.some((c) => c.name === 'lane' && c.pk > 0), 'lane is part of the key');
  db.close();
});
