import { getDb } from './init.js';

// Trigger types
export type TriggerCondition =
  | { type: 'presence_state'; state: 'active' | 'idle' | 'offline' }
  | { type: 'presence_transition'; from: string; to: string }
  | { type: 'agent_free' }
  | { type: 'time_window'; after: string; before?: string }
  | { type: 'routine_missing'; routine: string; after_hour: number }
  // A real date and time, ISO: true from then on (intentions ride this).
  | { type: 'after'; at: string }
  // Her status going from Busy or Away back to clear or Here. Armed once the
  // orchestrator has seen her Busy or Away since the trigger was made, and the
  // arming is kept in the row so a restart in between doesn't lose it.
  | { type: 'status_clears'; armed?: boolean };

export interface Trigger {
  id: string;
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: string; // JSON array of TriggerCondition
  prompt: string | null;
  thread_id: string | null;
  cooldown_minutes: number;
  status: 'pending' | 'waiting' | 'fired' | 'cancelled';
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  fired_at: string | null;
}

// Trigger operations
export function createTrigger(params: {
  id: string;
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: TriggerCondition[];
  prompt?: string;
  threadId?: string;
  cooldownMinutes?: number;
  createdAt: string;
}): Trigger {
  const stmt = getDb().prepare(`
    INSERT INTO triggers (id, kind, label, conditions, prompt, thread_id, cooldown_minutes, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  stmt.run(
    params.id,
    params.kind,
    params.label,
    JSON.stringify(params.conditions),
    params.prompt || null,
    params.threadId || null,
    params.cooldownMinutes ?? 120,
    params.createdAt,
  );
  return getDb().prepare('SELECT * FROM triggers WHERE id = ?').get(params.id) as unknown as Trigger;
}

export function getActiveTriggers(): Trigger[] {
  const stmt = getDb().prepare("SELECT * FROM triggers WHERE status IN ('pending', 'waiting') ORDER BY created_at ASC");
  return stmt.all() as unknown as Trigger[];
}

export function markTriggerWaiting(id: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'waiting' WHERE id = ?");
  stmt.run(id);
}

export function markTriggerFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'fired', fired_at = ?, fire_count = fire_count + 1 WHERE id = ?");
  stmt.run(firedAt, id);
}

export function markWatcherFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'pending', last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?");
  stmt.run(firedAt, id);
}

export function cancelTrigger(id: string): boolean {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'waiting')");
  const result = stmt.run(id);
  return result.changes > 0;
}

export function listTriggers(kind?: 'impulse' | 'watcher'): Trigger[] {
  if (kind) {
    const stmt = getDb().prepare("SELECT * FROM triggers WHERE kind = ? AND status != 'cancelled' ORDER BY created_at DESC");
    return stmt.all(kind) as unknown as Trigger[];
  }
  const stmt = getDb().prepare("SELECT * FROM triggers WHERE status != 'cancelled' ORDER BY created_at DESC");
  return stmt.all() as unknown as Trigger[];
}

/** Rewrite a trigger's conditions (status_clears arming itself). */
export function updateTriggerConditions(id: string, conditions: TriggerCondition[]): void {
  getDb().prepare('UPDATE triggers SET conditions = ? WHERE id = ?').run(JSON.stringify(conditions), id);
}

/** Put a fired impulse back in line (its intention didn't get said). */
export function rearmTrigger(id: string): void {
  getDb().prepare("UPDATE triggers SET status = 'pending', fired_at = NULL WHERE id = ?").run(id);
}
