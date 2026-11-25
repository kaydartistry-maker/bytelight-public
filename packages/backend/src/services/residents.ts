/**
 * Residents — the companions who live in THIS house (Phase 1.3).
 *
 * A resident is a companions row whose brain is the configured local brain
 * (local-brain.ts). Everything that used to name a fixed pair in code — memory
 * scopes, voice splitting, image-reference drawers, music-drop permission, tool
 * enums, wake preambles — reads this list instead, so a house of 0, 1, 2 or
 * 3+ residents is described by its own database.
 *
 * Read per call (one small indexed query). A missing table or closed DB reads
 * as an empty house rather than throwing, so callers never crash at boot.
 */
import { getDb } from './db/init.js';
import { isLocalBrain } from './local-brain.js';

export interface Resident {
  id: string;
  name: string;
  /** The row's own glyph (companions.emoji), or null when none is set. */
  emoji: string | null;
}

export function residents(): Resident[] {
  try {
    const rows = getDb()
      .prepare('SELECT id, display_name, brain, emoji FROM companions ORDER BY sort_order ASC, id ASC')
      .all() as Array<{ id: string; display_name: string | null; brain: string; emoji?: string | null }>;
    return rows
      .filter((row) => isLocalBrain(row.brain))
      .map((row) => ({ id: row.id, name: row.display_name || row.id, emoji: row.emoji ?? null }));
  } catch {
    return [];
  }
}

export function residentIds(): string[] {
  return residents().map((r) => r.id);
}

export function isResident(id: unknown): id is string {
  return typeof id === 'string' && residentIds().includes(id);
}

/** "A", "A and B", "A, B and C" — plain English list of names. */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
