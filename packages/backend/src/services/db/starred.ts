import { join } from 'path';
import { getDb } from './init.js';

// ---------------------------------------------------------------------------
// Starred messages (favorites)
// Apache 2.0 — adapted for byte-light (attribution in NOTICE)
// (generic multi-actor). `starred_by` is an arbitrary actor slug: 'user' (human
// default), 'companion-a', 'companion-b', 'companion-c', or any future companion — no cage.
// ---------------------------------------------------------------------------

/** Arbitrary actor slug — human ('user') or any companion. Intentionally generic. */
export type StarredBy = string;

export interface StarredRow {
  id: string;
  message_id: string;
  starred_by: StarredBy;
  starred_at: string;
  note: string | null;
}

export interface StarredWithContext extends StarredRow {
  thread_id: string;
  thread_title: string | null;
  message_role: 'companion' | 'user' | 'system';
  message_content: string;
  message_content_type: string;
  message_created_at: string;
  message_deleted_at: string | null;
}

export function addStar(params: {
  id: string;
  messageId: string;
  starredBy: StarredBy;
  starredAt: string;
  note?: string | null;
}): StarredRow | null {
  const stmt = getDb().prepare(
    `INSERT INTO starred_messages (id, message_id, starred_by, starred_at, note)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(message_id, starred_by) DO NOTHING`
  );
  stmt.run(params.id, params.messageId, params.starredBy, params.starredAt, params.note ?? null);
  return getStar(params.messageId, params.starredBy);
}

export function removeStar(messageId: string, starredBy: StarredBy): boolean {
  const res = getDb()
    .prepare('DELETE FROM starred_messages WHERE message_id = ? AND starred_by = ?')
    .run(messageId, starredBy);
  return res.changes > 0;
}

export function getStar(messageId: string, starredBy: StarredBy): StarredRow | null {
  const row = getDb()
    .prepare('SELECT * FROM starred_messages WHERE message_id = ? AND starred_by = ?')
    .get(messageId, starredBy) as StarredRow | undefined;
  return row ?? null;
}

export function getStarsForMessage(messageId: string): StarredRow[] {
  return getDb()
    .prepare('SELECT * FROM starred_messages WHERE message_id = ? ORDER BY starred_at DESC')
    .all(messageId) as StarredRow[];
}

export function listStarred(filter: {
  starredBy?: StarredBy | 'all';
  limit?: number;
  offset?: number;
}): StarredWithContext[] {
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
  const offset = Math.max(filter.offset ?? 0, 0);
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.starredBy && filter.starredBy !== 'all') {
    where.push('s.starred_by = ?');
    params.push(filter.starredBy);
  }
  const sql = `
    SELECT
      s.id           AS id,
      s.message_id   AS message_id,
      s.starred_by   AS starred_by,
      s.starred_at   AS starred_at,
      s.note         AS note,
      m.thread_id    AS thread_id,
      m.role         AS message_role,
      m.content      AS message_content,
      m.content_type AS message_content_type,
      m.created_at   AS message_created_at,
      m.deleted_at   AS message_deleted_at,
      t.name         AS thread_title
    FROM starred_messages s
    JOIN messages m ON m.id = s.message_id
    LEFT JOIN threads t ON t.id = m.thread_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY s.starred_at DESC
    LIMIT ? OFFSET ?
  `;
  params.push(limit, offset);
  return getDb().prepare(sql).all(...params) as StarredWithContext[];
}

/** Count of stars grouped by actor slug — generic, whatever actors exist in the table. */
export function countStarredByActor(): Record<string, number> {
  const rows = getDb()
    .prepare('SELECT starred_by, COUNT(*) AS c FROM starred_messages GROUP BY starred_by')
    .all() as { starred_by: string; c: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.starred_by] = r.c;
  return out;
}
