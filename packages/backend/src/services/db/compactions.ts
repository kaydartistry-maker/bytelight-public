// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * The compactions shelf in the database (migrations/046_compactions.sql).
 *
 * Only ever added to. A row is written the first time the reader meets a
 * squash and is never changed after: its id is built from the squash's own
 * lane, stamp and text, so the same squash read again from a resumed copy, or
 * on another day, finds the row already there and is quietly passed over.
 *
 * Beside it, how far each transcript has been read (compaction_scan_marks), so
 * a transcript that has not changed is never opened again, a restart included.
 * A transcript's squashes and its mark are written in one transaction: a
 * squash can never be marked read without being on the shelf.
 */

import { createHash } from 'node:crypto';
import { getDb } from './init.js';
import { compactionKey, type FileMark } from '../compaction-log.js';

export interface ShelvedCompaction {
  id: string;
  project: string;
  lane: string;
  /** The companion whose own head it was, by id, when it was first read; null for the shared room. */
  companion: string | null;
  sessionId: string;
  at: string;
  chars: number;
  summary: string;
  firstSeen: string;
}

/** Everything about a shelved squash except the text itself. */
export type ShelvedCompactionHead = Omit<ShelvedCompaction, 'summary'>;

export type NewCompaction = Omit<ShelvedCompaction, 'id' | 'firstSeen'>;

/**
 * A squash's identity: the same project + stamp + text the reader folds
 * resumed copies on (compactionKey), as a short hash so it can sit in an address.
 */
export function compactionId(project: string, at: string, summary: string): string {
  return createHash('sha256').update(compactionKey({ project, at, summary })).digest('hex').slice(0, 32);
}

function insertRows(rows: NewCompaction[], now: string): number {
  if (rows.length === 0) return 0;
  const insert = getDb().prepare(`
    INSERT OR IGNORE INTO compactions (id, project, lane, companion, session_id, at, chars, summary, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let added = 0;
  for (const row of rows) {
    const result = insert.run(
      compactionId(row.project, row.at, row.summary),
      row.project, row.lane, row.companion, row.sessionId, row.at, row.chars, row.summary, now,
    );
    added += result.changes;
  }
  return added;
}

/**
 * One transcript's read, kept whole or not at all: its squashes and where the
 * read stopped, in one transaction. The first copy of a squash is the one
 * kept. Returns how many squashes were new.
 */
export function shelveTranscriptRead(path: string, rows: NewCompaction[], mark: FileMark, now: string = new Date().toISOString()): number {
  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO compaction_scan_marks (path, size, mtime_ms, byte_offset, head_len, head_hash, tail_len, tail_hash, read_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      size = excluded.size, mtime_ms = excluded.mtime_ms, byte_offset = excluded.byte_offset,
      head_len = excluded.head_len, head_hash = excluded.head_hash,
      tail_len = excluded.tail_len, tail_hash = excluded.tail_hash, read_at = excluded.read_at
  `);
  return db.transaction(() => {
    const added = insertRows(rows, now);
    upsert.run(path, mark.size, mark.mtimeMs, mark.offset, mark.headLen, mark.headHash, mark.tailLen, mark.tailHash, now);
    return added;
  })();
}

interface MarkRow {
  path: string;
  size: number;
  mtime_ms: number;
  byte_offset: number;
  head_len: number;
  head_hash: string;
  tail_len: number;
  tail_hash: string;
}

/** Every transcript's mark, for the reader to skip what has not changed. */
export function loadScanMarks(): Map<string, FileMark> {
  const rows = getDb().prepare(
    'SELECT path, size, mtime_ms, byte_offset, head_len, head_hash, tail_len, tail_hash FROM compaction_scan_marks',
  ).all() as MarkRow[];
  return new Map(rows.map((r) => [r.path, {
    size: r.size,
    mtimeMs: r.mtime_ms,
    offset: r.byte_offset,
    headLen: r.head_len,
    headHash: r.head_hash,
    tailLen: r.tail_len,
    tailHash: r.tail_hash,
  }]));
}

/** Forget the marks of transcripts that are gone. The squashes they gave up stay on the shelf. */
export function forgetScanMarks(paths: string[]): void {
  if (paths.length === 0) return;
  const db = getDb();
  const remove = db.prepare('DELETE FROM compaction_scan_marks WHERE path = ?');
  db.transaction(() => {
    for (const path of paths) remove.run(path);
  })();
}

export function countShelvedCompactions(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM compactions').get() as { n: number }).n;
}

const HEAD_COLUMNS = 'id, project, lane, companion, session_id, at, chars, first_seen';

interface HeadRow {
  id: string;
  project: string;
  lane: string;
  companion: string | null;
  session_id: string;
  at: string;
  chars: number;
  first_seen: string;
}

function headFrom(row: HeadRow): ShelvedCompactionHead {
  return {
    id: row.id,
    project: row.project,
    lane: row.lane,
    companion: row.companion,
    sessionId: row.session_id,
    at: row.at,
    chars: row.chars,
    firstSeen: row.first_seen,
  };
}

/** One page of the shelf, newest first, without the summaries (they are large). */
export function listShelvedCompactions(limit: number, offset: number): ShelvedCompactionHead[] {
  const rows = getDb().prepare(`
    SELECT ${HEAD_COLUMNS} FROM compactions
    ORDER BY at DESC, project ASC, id ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as HeadRow[];
  return rows.map(headFrom);
}

/** The full text of each of these, for the ones the caller has not already read. */
export function shelvedSummaries(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const db = getDb();
  // In batches, well under SQLite's limit on bound parameters.
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const rows = db.prepare(
      `SELECT id, summary FROM compactions WHERE id IN (${batch.map(() => '?').join(', ')})`,
    ).all(...batch) as Array<{ id: string; summary: string }>;
    for (const row of rows) out.set(row.id, row.summary);
  }
  return out;
}

export function getShelvedCompaction(id: string): ShelvedCompaction | null {
  const row = getDb().prepare(`SELECT ${HEAD_COLUMNS}, summary FROM compactions WHERE id = ?`).get(id) as
    (HeadRow & { summary: string }) | undefined;
  return row ? { ...headFrom(row), summary: row.summary } : null;
}
