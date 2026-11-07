#!/usr/bin/env node

/**
 * Fold attachment copies — one-time history cleanup for "one message, one row".
 *
 * Until the fix in services/ws.ts, sending text with files saved the user's
 * message (carrying metadata.attachments) AND one standalone image/audio/file
 * row per attachment, in the same thread at the same millisecond. Clients that
 * render metadata.attachments then showed every file twice.
 *
 * This removes those standalone copies. A row is a copy only when ALL hold:
 *   - role 'user', content_type image/audio/file
 *   - same thread and exact same created_at as a user message whose
 *     metadata.attachments lists the same fileId
 *
 * Safety:
 *   - Dry run by default. Nothing is written without --apply.
 *   - A copy that is soft-deleted, replied to, starred, queued outbound, or
 *     cited by usage_events / audit_log is SKIPPED and listed, never removed.
 *   - Reactions on a copy are merged onto its parent message first, so a
 *     companion's 👀 on the picture is kept.
 *   - Its message_embeddings / message_tts rows go with it.
 *   - Everything happens in one transaction.
 *
 * Usage:
 *   node scripts/fold-attachment-copies.mjs            # dry run
 *   node scripts/fold-attachment-copies.mjs --apply    # write
 *   node scripts/fold-attachment-copies.mjs --db path/to.db
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/backend/package.json'));
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx >= 0 ? resolve(args[dbIdx + 1]) : join(root, 'data/bytelight.db');

const db = new Database(dbPath, { readonly: !apply });

const tableExists = (name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

const pairs = db.prepare(`
  SELECT c.id AS cid, p.id AS pid, c.deleted_at AS c_deleted, c.metadata AS c_meta, p.metadata AS p_meta,
         c.created_at AS created_at, c.content_type AS ct
  FROM messages p
  JOIN messages c
    ON c.thread_id = p.thread_id AND c.created_at = p.created_at AND c.id <> p.id
  WHERE p.role = 'user'
    AND json_extract(p.metadata, '$.attachments') IS NOT NULL
    AND c.role = 'user'
    AND c.content_type IN ('image', 'audio', 'file')
    AND EXISTS (
      SELECT 1 FROM json_each(json_extract(p.metadata, '$.attachments')) a
      WHERE json_extract(a.value, '$.fileId') = json_extract(c.metadata, '$.fileId')
    )
  ORDER BY c.created_at
`).all();

// Anything that points at a copy and would be orphaned or misread if it went.
const refChecks = [
  ['replied to', 'SELECT COUNT(*) n FROM messages WHERE reply_to_id = ?'],
  ['starred', 'SELECT COUNT(*) n FROM starred_messages WHERE message_id = ?', 'starred_messages'],
  ['outbound queue', 'SELECT COUNT(*) n FROM outbound_queue WHERE message_id = ?', 'outbound_queue'],
  ['usage events', 'SELECT COUNT(*) n FROM usage_events WHERE message_id = ?', 'usage_events'],
  ['audit log', 'SELECT COUNT(*) n FROM audit_log WHERE triggering_message_id = ?', 'audit_log'],
].filter(([, , table]) => !table || tableExists(table))
  .map(([label, sql]) => [label, db.prepare(sql)]);

const fold = [];
const skipped = [];
for (const row of pairs) {
  if (row.c_deleted) { skipped.push({ ...row, why: 'soft-deleted' }); continue; }
  const refs = refChecks.filter(([, stmt]) => stmt.get(row.cid).n > 0).map(([label]) => label);
  if (refs.length > 0) { skipped.push({ ...row, why: refs.join(', ') }); continue; }
  fold.push(row);
}

const reactionsOf = (meta) => {
  try { const r = JSON.parse(meta || '{}').reactions; return Array.isArray(r) ? r : []; } catch { return []; }
};
const withReactions = fold.filter((r) => reactionsOf(r.c_meta).length > 0);
const parents = new Set(fold.map((r) => r.pid));

console.log(`Database: ${dbPath}`);
console.log(`Mode:     ${apply ? 'APPLY' : 'dry run (nothing written)'}`);
console.log('');
console.log(`Standalone copies found:      ${pairs.length}`);
console.log(`  to remove:                  ${fold.length} (under ${parents.size} messages)`);
console.log(`  reactions moved to parent:  ${withReactions.length}`);
console.log(`  skipped, kept as-is:        ${skipped.length}`);
for (const s of skipped) console.log(`    - ${s.cid} (${s.ct}, ${s.created_at}): ${s.why}`);
for (const r of withReactions) {
  console.log(`    reaction ${reactionsOf(r.c_meta).map((x) => x.emoji).join(' ')} on ${r.cid} → message ${r.pid}`);
}

if (!apply) {
  console.log('\nDry run only. Re-run with --apply to write.');
  db.close();
  process.exit(0);
}

const getMeta = db.prepare('SELECT metadata FROM messages WHERE id = ?');
const setMeta = db.prepare('UPDATE messages SET metadata = ? WHERE id = ?');
const delEmbeddings = tableExists('message_embeddings') ? db.prepare('DELETE FROM message_embeddings WHERE message_id = ?') : null;
const delTts = tableExists('message_tts') ? db.prepare('DELETE FROM message_tts WHERE message_id = ?') : null;
const delMessage = db.prepare('DELETE FROM messages WHERE id = ?');

const run = db.transaction(() => {
  let removed = 0;
  for (const r of fold) {
    const moved = reactionsOf(r.c_meta);
    if (moved.length > 0) {
      const meta = JSON.parse(getMeta.get(r.pid).metadata || '{}');
      const existing = Array.isArray(meta.reactions) ? meta.reactions : [];
      const key = (x) => `${x.emoji}|${x.user}`;
      const seen = new Set(existing.map(key));
      meta.reactions = [...existing, ...moved.filter((x) => !seen.has(key(x)))];
      setMeta.run(JSON.stringify(meta), r.pid);
    }
    delEmbeddings?.run(r.cid);
    delTts?.run(r.cid);
    removed += delMessage.run(r.cid).changes;
  }
  return removed;
});

const removed = run();
console.log(`\nRemoved ${removed} standalone copies.`);
db.close();
