import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { initDb } from './db/init.js';

test('native restoration adds original features and preserves private history and settings on restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'bl-native-restoration-'));
  const path = join(root, 'fixture.db');
  let db: Database.Database | undefined;
  try {
    db = initDb(path);
    db.exec(readFileSync(fileURLToPath(new URL('../../../../docs/legacy-letta-schema/051_letta_chat.sql', import.meta.url)), 'utf8'));
    db.prepare(`INSERT INTO threads (id,name,type,created_at) VALUES ('saved-thread','Saved','named','2026-11-20')`).run();
    db.prepare(`INSERT INTO messages (id,thread_id,sequence,role,content,created_at) VALUES ('saved-message','saved-thread',1,'companion','Remembered conversation','2026-11-20')`).run();
    db.prepare(`INSERT INTO memory_blocks (scope,label,content) VALUES ('shared','restoration-fixture','Keep this correction')`).run();
    db.prepare(`INSERT INTO config (key,value) VALUES ('restoration.theme','periwinkle')`).run();
    db.prepare(`INSERT INTO letta_chat_threads (thread_id,agent_id,conversation_id,state,creation_attempt_id,created_at,updated_at) VALUES ('saved-thread','fixture-agent','fixture-conversation','ready','fixture-attempt',1,1)`).run();
    // Saved custom game state is independent of the native foundation.
    db.exec(`CREATE TABLE saved_custom_game_fixture (id TEXT PRIMARY KEY, xp INTEGER); INSERT INTO saved_custom_game_fixture VALUES ('boss-progress',30)`);
    db.close(); db = undefined;

    db = initDb(path);
    assert.equal((db.prepare("SELECT content FROM messages WHERE id='saved-message'").get() as {content:string}).content, 'Remembered conversation');
    assert.equal((db.prepare("SELECT content FROM memory_blocks WHERE label='restoration-fixture'").get() as {content:string}).content, 'Keep this correction');
    assert.equal((db.prepare("SELECT value FROM config WHERE key='restoration.theme'").get() as {value:string}).value, 'periwinkle');
    assert.equal((db.prepare("SELECT conversation_id FROM letta_chat_threads WHERE thread_id='saved-thread'").get() as {conversation_id:string}).conversation_id, 'fixture-conversation');
    assert.equal((db.prepare("SELECT xp FROM saved_custom_game_fixture WHERE id='boss-progress'").get() as {xp:number}).xp, 30);
    for (const table of ['spells', 'looks', 'canvases', 'memory_blocks', 'messages']) {
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), `${table} restored`);
    }
    const columns = db.prepare('PRAGMA table_info(looks)').all() as Array<{name:string}>;
    assert.ok(columns.some(c => c.name === 'favorite'));
  } finally {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
