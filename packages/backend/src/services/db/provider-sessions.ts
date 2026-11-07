import { getDb } from './init.js';

// ---------------------------------------------------------------------------
// Per-(thread, runtime, provider, model_ref) session sidecar
// Adapted for byte-light (attribution in NOTICE), hardened: no legacy
// threads.current_session_id fallback on read. Sidecar miss = fresh session.
// ---------------------------------------------------------------------------

export interface ProviderSession {
  thread_id: string;
  /** '' for the shared lane; a companion id for his own lane (The Room). */
  lane: string;
  runtime_id: string;
  provider: string;
  model_ref: string;
  session_id: string;
  last_used_at: string;
  metadata_json: string | null;
}

export interface ProviderSessionKey {
  threadId: string;
  /** Omitted or '' = the shared lane (every card from before lanes existed). */
  lane?: string;
  runtimeId: string;
  provider: string;
  modelRef: string;
}

export function getProviderSession(key: ProviderSessionKey): ProviderSession | null {
  const stmt = getDb().prepare(`
    SELECT thread_id, lane, runtime_id, provider, model_ref, session_id, last_used_at, metadata_json
    FROM thread_provider_sessions
    WHERE thread_id = ? AND lane = ? AND runtime_id = ? AND provider = ? AND model_ref = ?
  `);
  const row = stmt.get(key.threadId, key.lane ?? '', key.runtimeId, key.provider, key.modelRef);
  return row ? (row as unknown as ProviderSession) : null;
}

export function setProviderSession(params: {
  threadId: string;
  lane?: string;
  runtimeId: string;
  provider: string;
  modelRef: string;
  sessionId: string;
  metadata?: Record<string, unknown>;
}): void {
  const now = new Date().toISOString();
  const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null;
  const stmt = getDb().prepare(`
    INSERT INTO thread_provider_sessions
      (thread_id, lane, runtime_id, provider, model_ref, session_id, last_used_at, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id, lane, runtime_id, provider, model_ref) DO UPDATE SET
      session_id = excluded.session_id,
      last_used_at = excluded.last_used_at,
      metadata_json = excluded.metadata_json
  `);
  stmt.run(
    params.threadId,
    params.lane ?? '',
    params.runtimeId,
    params.provider,
    params.modelRef,
    params.sessionId,
    now,
    metadataJson,
  );
}

export function clearProviderSessionsForThread(threadId: string): number {
  const stmt = getDb().prepare('DELETE FROM thread_provider_sessions WHERE thread_id = ?');
  const result = stmt.run(threadId);
  return result.changes;
}

// Used to distinguish pristine threads from model-switched threads at
// the sidecar-miss boundary in agent.ts. Cross-model continuity bridge
// fires only when this returns true.
export function hasAnyProviderSessionForThread(threadId: string, lane = ''): boolean {
  const stmt = getDb().prepare('SELECT 1 FROM thread_provider_sessions WHERE thread_id = ? AND lane = ? LIMIT 1');
  return stmt.get(threadId, lane) !== undefined;
}

// Recency signal for the return-to-model bridge (Slice 1.5). The newest
// sidecar row tells us which (runtime, provider, model) triple carried the
// thread most recently; agent.ts compares it against the current turn's hit
// row to detect "returning to a previously-used model" and bridge the gap.
export function getMostRecentProviderSession(threadId: string, lane = ''): ProviderSession | null {
  const stmt = getDb().prepare(`
    SELECT thread_id, lane, runtime_id, provider, model_ref, session_id, last_used_at, metadata_json
    FROM thread_provider_sessions
    WHERE thread_id = ? AND lane = ?
    ORDER BY last_used_at DESC
    LIMIT 1
  `);
  const row = stmt.get(threadId, lane);
  return row ? (row as unknown as ProviderSession) : null;
}
