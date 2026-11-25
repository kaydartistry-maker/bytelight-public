import type { Thread } from '@bytelight/shared';
import { getBytelightConfig } from '../../config.js';
import { getDb } from './init.js';

export type ThreadRoster = readonly [string, ...string[]];

export function requireThreadRoster(companionIds: readonly string[] | undefined): ThreadRoster {
  if (!companionIds || companionIds.length === 0) {
    throw new Error('companionIds must be a non-empty roster');
  }
  const normalized = companionIds.map((id) => id.trim());
  if (normalized.some((id) => id.length === 0)) {
    throw new Error('companionIds must contain non-empty companion ids');
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('companionIds must not contain duplicate companion ids');
  }
  const [first, ...rest] = normalized;
  return [first, ...rest];
}

interface ThreadInput {
  id: string;
  name: string;
  type: 'daily' | 'named' | 'treehouse';
  createdAt: string;
  sessionType?: 'v1' | 'v2';
}

function insertThread(params: ThreadInput): void {
  getDb().prepare(`
    INSERT INTO threads (id, name, type, created_at, session_type, last_activity_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    params.id,
    params.name,
    params.type,
    params.createdAt,
    params.sessionType || 'v2',
    params.createdAt,
  );
}

export function createThread(params: ThreadInput & { companionIds: ThreadRoster }): Thread {
  const database = getDb();
  const roster = requireThreadRoster(params.companionIds);
  const placeholders = roster.map(() => '?').join(', ');
  const insertSeat = database.prepare(
    'INSERT INTO thread_companions (thread_id, companion_id) VALUES (?, ?)',
  );
  const seat = database.transaction(() => {
    const found = database.prepare(
      `SELECT COUNT(*) AS count FROM companions WHERE id IN (${placeholders})`,
    ).get(...roster) as { count: number };
    if (found.count !== roster.length) {
      throw new Error('companionIds must all exist in the companions registry');
    }
    insertThread(params);
    for (const companionId of roster) insertSeat.run(params.id, companionId);
  });
  seat();

  const thread = getThread(params.id);
  if (!thread) throw new Error(`thread ${params.id} was not created`);
  return thread;
}

/** Create the empty Home shell when a house has no conversation to route to. */
export function createRoutingThreadShell(params: ThreadInput): Thread {
  insertThread(params);
  const thread = getThread(params.id);
  if (!thread) throw new Error(`routing thread ${params.id} was not created`);
  return thread;
}

export function getThread(id: string): Thread | null {
  const stmt = getDb().prepare('SELECT * FROM threads WHERE id = ?');
  const row = stmt.get(id);
  return row ? (row as unknown as Thread) : null;
}

export function getTodayThread(): Thread | null {
  // Compute today's date in configured timezone
  const config = getBytelightConfig();
  const timezone = config.identity.timezone;
  const now = new Date();
  const localDate = now.toLocaleDateString('en-CA', { timeZone: timezone }); // YYYY-MM-DD

  // Compute UTC offset in minutes for the configured timezone
  // Using total-minutes approach to correctly handle UTC- zones when UTC crosses midnight
  const localHour = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }));
  const localMinute = parseInt(now.toLocaleString('en-GB', { timeZone: timezone, minute: '2-digit' }));
  const localTotalMinutes = localHour * 60 + localMinute;
  const utcTotalMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  let offsetMinutes = localTotalMinutes - utcTotalMinutes;
  // Clamp to ±720 minutes to handle UTC crossing midnight
  if (offsetMinutes > 12 * 60) offsetMinutes -= 24 * 60;
  if (offsetMinutes < -12 * 60) offsetMinutes += 24 * 60;

  // Query with offset applied to created_at so SQLite compares in local time
  // ORDER BY + LIMIT 1 ensures deterministic result if multiple daily threads exist
  const modifier = `${offsetMinutes >= 0 ? '+' : ''}${offsetMinutes} minutes`;
  const stmt = getDb().prepare(`
    SELECT * FROM threads
    WHERE type = 'daily'
    AND date(created_at, ?) = ?
    AND archived_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1
  `);
  const row = stmt.get(modifier, localDate);
  return row ? (row as unknown as Thread) : null;
}

export function listThreads(params: {
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
  /** The Treehouse (type 'treehouse') is the companions' read-only room and
   *  has its own app, so it stays out of every thread list, switcher and
   *  "most recent thread" fallback unless a caller asks for it by name. */
  includeTreehouse?: boolean;
}): Thread[] {
  const { includeArchived = false, limit = 50, offset = 0, includeTreehouse = false } = params;

  const where: string[] = [];
  if (!includeArchived) where.push('archived_at IS NULL');
  if (!includeTreehouse) where.push("type != 'treehouse'");
  let sql = 'SELECT * FROM threads';
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY last_activity_at DESC LIMIT ? OFFSET ?';

  const stmt = getDb().prepare(sql);
  const rows = stmt.all(limit, offset);
  return rows as unknown as Thread[];
}

export function getMostRecentActiveThread(): Thread | null {
  // Returns the most recently active non-archived thread with a session
  // Used to route user's messages into their active conversation
  const stmt = getDb().prepare(`
    SELECT * FROM threads
    WHERE archived_at IS NULL
    AND type != 'treehouse'
    AND current_session_id IS NOT NULL
    ORDER BY last_activity_at DESC
    LIMIT 1
  `);
  const row = stmt.get();
  return row ? (row as unknown as Thread) : null;
}

export function updateThreadSession(threadId: string, sessionId: string | null): void {
  const stmt = getDb().prepare('UPDATE threads SET current_session_id = ? WHERE id = ?');
  stmt.run(sessionId, threadId);
}

// Nuke every active session (legacy current_session_id + provider sidecar) so
// the next message starts on a fresh SDK session. Used by the MCP toggle flow
// to force the SDK to fully reconnect MCP servers after a re-enable. Cross-model
// continuity is preserved by agent-bridge.ts (history injection on fresh session).
export function clearAllThreadSessions(): void {
  const db = getDb();
  db.prepare('UPDATE threads SET current_session_id = NULL').run();
  db.prepare('DELETE FROM thread_provider_sessions').run();
}

export function updateThreadActivity(threadId: string, timestamp: string, incrementUnread = false): void {
  let sql = 'UPDATE threads SET last_activity_at = ?';
  if (incrementUnread) {
    sql += ', unread_count = unread_count + 1';
  }
  sql += ' WHERE id = ?';

  const stmt = getDb().prepare(sql);
  stmt.run(timestamp, threadId);
}

export function archiveThread(threadId: string, archivedAt: string | null): void {
  const stmt = getDb().prepare('UPDATE threads SET archived_at = ? WHERE id = ?');
  stmt.run(archivedAt, threadId);
}

export function deleteThread(threadId: string): string[] {
  const db = getDb();

  // Collect fileIds from message metadata before deleting
  const fileIds: string[] = [];
  const msgs = db.prepare('SELECT metadata FROM messages WHERE thread_id = ? AND metadata IS NOT NULL').all(threadId) as Array<{ metadata: string }>;
  for (const row of msgs) {
    try {
      const meta = JSON.parse(row.metadata);
      if (meta.fileId) fileIds.push(meta.fileId);
    } catch { /* skip unparseable */ }
  }

  // Cascading delete in a transaction
  const deleteAll = db.transaction(() => {
    db.prepare('DELETE FROM triggers WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM timers WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM canvases WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM outbound_queue WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM audit_log WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM session_history WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)').run(threadId);
    db.prepare('DELETE FROM starred_messages WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)').run(threadId);
    db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
  });
  deleteAll();

  return fileIds;
}

// Pin operations
export function pinThread(threadId: string): void {
  const stmt = getDb().prepare('UPDATE threads SET pinned_at = ? WHERE id = ?');
  stmt.run(new Date().toISOString(), threadId);
}

export function unpinThread(threadId: string): void {
  const stmt = getDb().prepare('UPDATE threads SET pinned_at = NULL WHERE id = ?');
  stmt.run(threadId);
}
