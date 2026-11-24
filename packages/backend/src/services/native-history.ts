import { getDb } from './db/init.js';

/** Read existing local evidence only. Never creates bridge tables or contacts Cloud. */
export function isPreservedCloudThread(threadId: string): boolean {
  const db = getDb();
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='letta_chat_threads'").get();
  return !!table && !!db.prepare('SELECT 1 FROM letta_chat_threads WHERE thread_id = ?').get(threadId);
}

export function assertNativeThreadWritable(threadId: string): void {
  if (isPreservedCloudThread(threadId)) throw new Error('legacy_history_read_only');
}
