/**
 * Rooms — companion registry reads + per-thread roster read/write.
 *
 * Backs routes/rooms-routes.ts. Schema lives in migrations/014_companions.sql
 * (companions + thread_companions) and is seeded/backfilled by
 * migrations/015_rooms_seed.sql. Nothing in dispatch/prompt assembly reads
 * these yet (that is Slice 4) — this is the plumbing that lets the picker
 * (Slice 3) read and write a thread's roster.
 *
 * Schema shape ported from NESTstack's rooms-worker (cindiekinzz-coder, MIT):
 * a room's participant list = the set of companion ids seated in it. byte-light
 * stores that as thread_companions rows joined back to the companions registry.
 *
 * Style matches byte-light's flat-service pattern (services/db.ts,
 * services/db/companion-settings.ts): prepared statements per call
 * (better-sqlite3 caches them), plain row → typed object casts at the boundary.
 * The roster write runs in a transaction (delete-then-insert) so a thread's
 * roster is never observed half-swapped.
 */

import { getDb } from './init.js';

/** A pickable companion, as stored in the `companions` registry. */
export interface Companion {
  id: string;
  display_name: string;
  avatar: string | null;
  brain: string;
  model: string | null;
  sort_order: number;
  created_at: string;
  /** Written about the companion; read by his own head in a lane of his own. */
  bio: string | null;
  status: string | null;
  phone: string | null;
  /** The card's glyph and accent (048). */
  emoji: string | null;
  color: string | null;
}

/** List every companion in the registry, picker order (sort_order, then id). */
export function listCompanions(): Companion[] {
  const rows = getDb()
    .prepare('SELECT id, display_name, avatar, brain, model, sort_order, created_at, bio, status, phone, emoji, color FROM companions ORDER BY sort_order ASC, id ASC')
    .all();
  return rows as unknown as Companion[];
}

/** True iff every id in `ids` exists in the companions registry. Empty input
 *  returns true (the caller enforces non-empty separately). */
export function allCompanionsExist(ids: string[]): boolean {
  if (ids.length === 0) return true;
  const placeholders = ids.map(() => '?').join(', ');
  const row = getDb()
    .prepare(`SELECT COUNT(DISTINCT id) AS n FROM companions WHERE id IN (${placeholders})`)
    .get(...ids) as { n: number };
  return row.n === new Set(ids).size;
}

/**
 * The roster seated in a thread: the companion registry rows for the
 * thread_companions entries, in picker order. Empty array when the thread has
 * no roster (e.g. a thread created after the Slice 2 backfill, before the
 * picker seats it). Does NOT assert the thread exists — callers that need a
 * 404 check the thread separately.
 */
export function getThreadRoster(threadId: string): Companion[] {
  const rows = getDb()
    .prepare(
      `SELECT c.id, c.display_name, c.avatar, c.brain, c.model, c.sort_order, c.created_at, c.bio, c.status, c.phone, c.emoji, c.color
         FROM thread_companions tc
         JOIN companions c ON c.id = tc.companion_id
        WHERE tc.thread_id = ?
        ORDER BY c.sort_order ASC, c.id ASC`,
    )
    .all(threadId);
  return rows as unknown as Companion[];
}

/**
 * Replace a thread's roster with exactly `companionIds` (dedup preserved by the
 * composite PK). Delete-then-insert inside a transaction so the roster is never
 * observed half-swapped. Caller is responsible for validating that the thread
 * exists, the ids are non-empty, and every id resolves (allCompanionsExist).
 * Returns the resulting roster in picker order (load-path parity: the write is
 * immediately readable through the same join getThreadRoster uses).
 */
export function setThreadRoster(threadId: string, companionIds: string[]): Companion[] {
  const db = getDb();
  const del = db.prepare('DELETE FROM thread_companions WHERE thread_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO thread_companions (thread_id, companion_id) VALUES (?, ?)');
  const swap = db.transaction((ids: string[]) => {
    del.run(threadId);
    for (const cid of ids) ins.run(threadId, cid);
  });
  swap(companionIds);
  return getThreadRoster(threadId);
}

/** The card fields a companion's profile can edit. */
export type CompanionCardUpdate = Partial<Pick<Companion, 'display_name' | 'bio' | 'status' | 'phone' | 'avatar' | 'emoji' | 'color'>>;

/**
 * Update a companion's card fields. Only the keys present are written; a null
 * clears that field. Returns the updated row, or null when no such companion.
 */
export function updateCompanionCard(id: string, updates: CompanionCardUpdate): Companion | null {
  const db = getDb();
  const keys = (['display_name', 'bio', 'status', 'phone', 'avatar', 'emoji', 'color'] as const).filter((k) => k in updates);
  if (keys.length > 0) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    const result = db.prepare(`UPDATE companions SET ${sets} WHERE id = ?`).run(...keys.map((k) => updates[k] ?? null), id);
    if (result.changes === 0) return null;
  }
  return (db
    .prepare('SELECT id, display_name, avatar, brain, model, sort_order, created_at, bio, status, phone, emoji, color FROM companions WHERE id = ?')
    .get(id) as Companion | undefined) ?? null;
}
