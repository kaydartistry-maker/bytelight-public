import { getConfig, setConfig } from './db.js';

/**
 * Per-thread "last processed message.sequence" stored in the config table
 * under `${prefix}:${threadId}`. Per-thread because sequence numbers restart
 * with each thread, so one global cursor would stall on a new thread.
 */
export function makeSequenceCursor(prefix: string) {
  const key = (threadId: string) => `${prefix}:${threadId}`;
  return {
    get: (threadId: string): number => parseInt(getConfig(key(threadId)) || '0'),
    set: (threadId: string, value: number): void => setConfig(key(threadId), String(value)),
  };
}
