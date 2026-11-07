import crypto from 'crypto';
import type { Thread } from '@bytelight/shared';
import { deleteConfig, getConfig, setConfig } from './config.js';
import { getDb } from './init.js';
import { createThread, getThread } from './threads.js';

// ── Active routing thread ("Home") ──────────────────────────────────────
// One global routing thread is the catch-all target for ambient activity.
// Per-source overrides (Discord, Telegram, wakes) let each lane aim at a
// different thread — useful for keeping Discord chatter out of a journal
// thread, or sending night wakes somewhere quiet. A source-specific key
// wins when set; the global key is the fallback.

const ROUTING_CONFIG_KEY = 'app.routingThreadId';

/** Valid routing sources — each can have its own routing thread, falling back
 *  to the global setting when unset. The web/WS lane stays on the global,
 *  since it's the "main" active thread shown in the chat UI. */
export type RoutingSource = 'discord' | 'telegram' | 'wake';

function sourceKey(source: RoutingSource): string {
  return `app.routingThreadId.${source}`;
}

export function getRoutingThreadId(): string | null {
  return getConfig(ROUTING_CONFIG_KEY);
}

export function setRoutingThreadId(threadId: string): void {
  setConfig(ROUTING_CONFIG_KEY, threadId);
}

/** Source-specific routing thread id, or null if the source falls back to
 *  the global setting. */
export function getRoutingThreadIdForSource(source: RoutingSource): string | null {
  return getConfig(sourceKey(source));
}

/** Set a source-specific routing thread. Pass `null` to clear the override
 *  and fall back to the global. */
export function setRoutingThreadIdForSource(source: RoutingSource, threadId: string | null): void {
  if (threadId === null) {
    deleteConfig(sourceKey(source));
  } else {
    setConfig(sourceKey(source), threadId);
  }
}

export function getRoutingThread(): Thread | null {
  const id = getRoutingThreadId();
  if (!id) return null;
  const t = getThread(id);
  if (!t || t.archived_at) return null;
  return t;
}

/** Resolve a source-specific routing thread, with fallback to the global one.
 *  Returns null if neither the source override nor the global resolves to a
 *  live thread — callers should fall through to `resolveRoutingThread()`. */
function getRoutingThreadFor(source: RoutingSource): Thread | null {
  const id = getRoutingThreadIdForSource(source);
  if (!id) return null;
  const t = getThread(id);
  // byte-light deletes threads hard (rows removed), so getThread returning a
  // row means the thread exists; we only need to skip archived ones.
  if (!t || t.archived_at) return null;
  return t;
}

/** Resolve the thread that ambient activity should land in.
 *  - If `source` is provided and a per-source override is set + valid, return it.
 *  - Else if the global routing thread is set and valid, return it.
 *  - Otherwise fall back to the most recent live thread and pin it.
 *  - If no threads exist at all, create a starter "Home" thread.
 *  The `source` parameter is optional so existing callers (web/WS) keep
 *  working unchanged on the global routing thread. */
export function resolveRoutingThread(
  registryOrSource?: { broadcast: (msg: any) => void } | RoutingSource,
  maybeRegistry?: { broadcast: (msg: any) => void },
): Thread {
  // Overload: either resolveRoutingThread(registry) — legacy — or
  // resolveRoutingThread(source, registry) — new per-source form.
  let source: RoutingSource | undefined;
  let registry: { broadcast: (msg: any) => void } | undefined;
  if (typeof registryOrSource === 'string') {
    source = registryOrSource;
    registry = maybeRegistry;
  } else {
    registry = registryOrSource;
  }

  if (source) {
    const sourceThread = getRoutingThreadFor(source);
    if (sourceThread) return sourceThread;
  }

  const current = getRoutingThread();
  if (current) return current;

  const stmt = getDb().prepare(
    // Never the Treehouse: it is the companions' read-only room, not a Home.
    "SELECT * FROM threads WHERE archived_at IS NULL AND type != 'treehouse' ORDER BY last_activity_at DESC LIMIT 1"
  );
  const row = stmt.get() as Thread | undefined;
  if (row) {
    setRoutingThreadId(row.id);
    if (registry) registry.broadcast({ type: 'routing_thread_changed', threadId: row.id });
    return row;
  }

  // No threads at all — bootstrap a starter
  const created = createThread({
    id: crypto.randomUUID(),
    name: 'Home',
    type: 'named',
    createdAt: new Date().toISOString(),
    sessionType: 'v2',
  });
  setRoutingThreadId(created.id);
  if (registry) {
    registry.broadcast({ type: 'thread_created', thread: created });
    registry.broadcast({ type: 'routing_thread_changed', threadId: created.id });
  }
  return created;
}
