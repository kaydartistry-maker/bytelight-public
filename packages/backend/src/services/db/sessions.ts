import type { SessionRecord } from '@bytelight/shared';
import { getDb } from './init.js';

// Session operations
export function createSessionRecord(params: {
  id: string;
  threadId: string;
  sessionId: string;
  sessionType: 'v1' | 'v2';
  startedAt: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT INTO session_history (id, thread_id, session_id, session_type, started_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(params.id, params.threadId, params.sessionId, params.sessionType, params.startedAt);
}

export function endSessionRecord(params: {
  sessionId: string;
  endedAt: string;
  endReason: 'compaction' | 'reaper' | 'daily_rotation' | 'error' | 'manual' | 'resumed';
}): void {
  const stmt = getDb().prepare(`
    UPDATE session_history
    SET ended_at = ?, end_reason = ?
    WHERE session_id = ?
  `);
  stmt.run(params.endedAt, params.endReason, params.sessionId);
}

// What a session's recorded turns cost, summed from usage_events. Sums are
// null (not zero) when no rows fell inside the session's window — "no usage
// recorded" and "recorded zero" must stay distinguishable, so the UI never
// dresses an absence up as a number. `last_context_*` is the window occupancy
// of the session's final recorded turn — an endpoint, never a sum: every turn
// re-sends the whole conversation, so accumulating context would count the
// same conversation once per turn (the endpoint is the honest unit).
export interface SessionUsageTotals {
  usage_turns: number;
  usage_input_tokens: number | null;
  usage_output_tokens: number | null;
  usage_cache_read_tokens: number | null;
  usage_cache_creation_tokens: number | null;
  usage_cost_usd: number | null;
  last_context_tokens: number | null;
  last_context_window: number | null;
}

// Session lifecycle log: real session_history rows joined to their thread name
// and the thread's channel (latest message platform). Newest-first.
// Per-turn cost/token rows live in usage_events (Usage tab); each session row
// here carries their per-session totals, attributed by thread + time window
// (usage_events has no session id). Half-open window [started_at, ended_at)
// so a row landing exactly on a resume boundary is counted once, in the
// session that started on it.
export function listSessionHistory(
  limit = 50,
): (SessionRecord & { thread_name: string | null; platform: string | null } & SessionUsageTotals)[] {
  const stmt = getDb().prepare(`
    SELECT
      sh.*,
      t.name AS thread_name,
      (SELECT m.platform FROM messages m
       WHERE m.thread_id = sh.thread_id
       ORDER BY m.created_at DESC LIMIT 1) AS platform
    FROM session_history sh
    LEFT JOIN threads t ON t.id = sh.thread_id
    ORDER BY sh.started_at DESC
    LIMIT ?
  `);
  const rows = stmt.all(limit) as (SessionRecord & {
    thread_name: string | null;
    platform: string | null;
  })[];

  const totalsStmt = getDb().prepare(`
    SELECT
      COUNT(*) AS usage_turns,
      SUM(input_tokens) AS usage_input_tokens,
      SUM(output_tokens) AS usage_output_tokens,
      SUM(cache_read_tokens) AS usage_cache_read_tokens,
      SUM(cache_creation_tokens) AS usage_cache_creation_tokens,
      SUM(cost_usd) AS usage_cost_usd
    FROM usage_events
    WHERE thread_id = ?
      AND created_at >= ?
      AND (? IS NULL OR created_at < ?)
  `);
  const endpointStmt = getDb().prepare(`
    SELECT context_tokens AS last_context_tokens,
           context_window AS last_context_window
    FROM usage_events
    WHERE thread_id = ?
      AND created_at >= ?
      AND (? IS NULL OR created_at < ?)
    ORDER BY created_at DESC
    LIMIT 1
  `);

  return rows.map((row) => {
    const totals = totalsStmt.get(
      row.thread_id, row.started_at, row.ended_at, row.ended_at,
    ) as Omit<SessionUsageTotals, 'last_context_tokens' | 'last_context_window'>;
    const endpoint = (endpointStmt.get(
      row.thread_id, row.started_at, row.ended_at, row.ended_at,
    ) ?? { last_context_tokens: null, last_context_window: null }) as
      Pick<SessionUsageTotals, 'last_context_tokens' | 'last_context_window'>;
    return { ...row, ...totals, ...endpoint };
  });
}
