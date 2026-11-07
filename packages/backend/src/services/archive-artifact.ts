// Adapted from Aerie Systems' archive-artifact.ts (Apache License 2.0).
//
// Which Cortex/Neuralis records are archive plumbing rather than things that
// happened.
//
// The memory diet writes a block's trimmed text to Neuralis, which makes those
// chunks the NEWEST records in there — so ambient recall's "things you already
// lived" fills up with fragments of the very block the session already carries
// live, and nothing that actually happened gets a slot. A frozen copy of a
// living block is noise, not recall.
//
// The rule lives here once so every reading surface asks the same question
// instead of carrying a drifting copy.
//
// These records stay fully searchable. They just stop being the first thing a
// new window reads about its own life.

/** Records that announce themselves at the head: "PRE-THIN SNAPSHOT 2026-08-03
 *  — memory block [scope] label". */
const ARCHIVE_ARTIFACT =
  /^\s*(PRE-THIN SNAPSHOT|PRE-REWRITE SNAPSHOT|SNAPSHOT — |PRE-THIN |FROM THE CLI LANE['’]S AUTO-MEMORY)/i;

/** Older snapshots lead with the block they came from — "SHARED/LORE — PRE-THIN
 *  SNAPSHOT, Jul 30 2026" — so the marker sits a few words in and an anchored
 *  match sails straight past it. Case-sensitive and dash-gated on purpose: a
 *  memory that merely mentions the practice mid-sentence must still surface. */
const TITLED_ARCHIVE_ARTIFACT = /^\s*[A-Z0-9/\[\]'’. -]{1,60}[—–]\s*(PRE-THIN|PRE-REWRITE|SNAPSHOT\b)/;

export function isArchiveArtifact(content: string | undefined): boolean {
  const text = content || '';
  return ARCHIVE_ARTIFACT.test(text) || TITLED_ARCHIVE_ARTIFACT.test(text);
}

/** byte-light's structural marker: the memory diet files every trimmed chunk
 *  under this Neuralis domain (memory-diet.ts). A record either is filed there
 *  or it isn't, where a pattern can only ever be squinted through. */
export const ARCHIVE_DOMAIN = 'core-memory-archive';

/** The question every reader should actually ask. Domain first; the patterns
 *  stay as cover for anything written elsewhere by hand in a hurry. */
export function isArchiveRecord(
  memory: { content?: string; domain?: string } | undefined,
): boolean {
  if (!memory) return false;
  if ((memory.domain || '') === ARCHIVE_DOMAIN) return true;
  return isArchiveArtifact(memory.content);
}
