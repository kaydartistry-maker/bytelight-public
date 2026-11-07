/**
 * What a sticky note's stored `color` is allowed to be.
 *
 * A note stores its ROLE now rather than a hex, and looks the paint up in
 * whichever palette is live, so notes re-tint when she changes theme. The role
 * names live here rather than in the phone because the AGENT-FACING door
 * (/api/internal/note) has to validate the same set — it used to accept hex
 * only, so a note left by a companion fell back to one hardcoded yellow and was
 * the only note in the app that did not follow her theme.
 */

export const NOTE_ROLES = ['dominant', 'support', 'quiet', 'accent', 'paper'] as const;
export type NoteRole = (typeof NOTE_ROLES)[number];

export const NOTE_ROLE_PREFIX = 'role:';

export function isNoteRole(value: string | null | undefined): boolean {
  if (typeof value !== 'string' || !value.startsWith(NOTE_ROLE_PREFIX)) return false;
  return (NOTE_ROLES as readonly string[]).includes(value.slice(NOTE_ROLE_PREFIX.length));
}

export function noteRoleToken(role: NoteRole): string {
  return `${NOTE_ROLE_PREFIX}${role}`;
}

export function roleFromToken(value: string | null | undefined): NoteRole | null {
  if (!isNoteRole(value)) return null;
  return (value as string).slice(NOTE_ROLE_PREFIX.length) as NoteRole;
}

/**
 * The one validator for a note colour. Returns what should be STORED, or null
 * when the caller gave us neither a role nor a hex and has to pick a default.
 */
export function normalizeNoteColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (isNoteRole(trimmed)) return trimmed;
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed;
  return null;
}
