import { getDb } from './init.js';

// Timer operations
export interface Timer {
  id: string;
  label: string;
  context: string | null;
  fire_at: string;
  thread_id: string;
  prompt: string | null;
  status: 'pending' | 'fired' | 'cancelled';
  created_at: string;
  fired_at: string | null;
}

export function createTimer(params: {
  id: string;
  label: string;
  context?: string;
  fireAt: string;
  threadId: string;
  prompt?: string;
  createdAt: string;
}): Timer {
  const stmt = getDb().prepare(`
    INSERT INTO timers (id, label, context, fire_at, thread_id, prompt, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  stmt.run(
    params.id,
    params.label,
    params.context || null,
    params.fireAt,
    params.threadId,
    params.prompt || null,
    params.createdAt,
  );
  return getDb().prepare('SELECT * FROM timers WHERE id = ?').get(params.id) as unknown as Timer;
}

export function listPendingTimers(): Timer[] {
  const stmt = getDb().prepare("SELECT * FROM timers WHERE status = 'pending' ORDER BY fire_at ASC");
  return stmt.all() as unknown as Timer[];
}

export function getDueTimers(now: string): Timer[] {
  const stmt = getDb().prepare("SELECT * FROM timers WHERE status = 'pending' AND fire_at <= ? ORDER BY fire_at ASC");
  return stmt.all(now) as unknown as Timer[];
}

export function markTimerFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE timers SET status = 'fired', fired_at = ? WHERE id = ?");
  stmt.run(firedAt, id);
}

export function cancelTimer(id: string): boolean {
  const stmt = getDb().prepare("UPDATE timers SET status = 'cancelled' WHERE id = ? AND status = 'pending'");
  const result = stmt.run(id);
  return result.changes > 0;
}
