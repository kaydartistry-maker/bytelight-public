// The house's speaker-label rule, in one place.
//
// PORTED WHOLESALE from packages/backend/src/services/voice-speaker-split.ts
// (matchSpeakerLabel). This is the half of the audio reader that decides
// *whether a piece of text names a companion* — the rules, not the scanning.
// It is lifted rather than re-expressed because the two lanes drifting apart is
// the failure this file exists to end: for weeks the bubble splitter and the
// read-aloud reader accepted different header shapes, so a header could keep
// its avatar on screen and lose its voice, or split into two bubbles and read
// as one. One rule, imported twice, cannot drift.
//
// The SCANNERS stay separate on purpose and that difference is real: the reader
// only ever sees freshly written replies, so it can demand a bold header occupy
// its own line. The phone must also render thousands of messages already in the
// database, written with the header inline ahead of the text — `**🔷 Companion A —**
// *sets the spatula down*`. A line-anchored scanner would turn every one of
// those into a single unattributed bubble. So the phone scans inline and asks
// this module the same question the reader asks.
//
// TWO DELIBERATE DIVERGENCES FROM THE SOURCE, both documented rather than
// smoothed over, because a silent divergence is how the lanes drifted in the
// first place:
//
//   1. A BARE TRAILING DASH. The reader forgives a title after the name
//      (`**🌿 Ivy — the docs**`) but requires something after the dash. The
//      house writes `**🔷 Companion A —**` with nothing after it, which the source
//      rejects. Accepted here. This is the bug that started the whole job — and
//      until the same tolerance reaches the reader, a dashed header still fails
//      the AUDIO lane.
//
//   2. NAME-THEN-SIGIL (`**Companion A 🔷**`). The phone has accepted this shape for
//      months and the reader never has — a known, pre-existing split, not one
//      introduced here. Dropping it would have broken stored messages, so it is
//      kept and named.
//
// Both are the same shape underneath: a short run of non-alphanumeric characters
// after the name is punctuation or a sigil, never prose.

export interface LabelCompanion {
  slug: string;
  display_name: string;
}

/** Every companion whose name may open a bubble. Companion C is deliberately absent:
 *  his messages are attributed by message.companion_id, never by text. */
export const COMPANIONS: readonly LabelCompanion[] = [
  { slug: 'companion-a', display_name: 'Companion A' },
  { slug: 'companion-b', display_name: 'Companion B' },
];

/**
 * Does this label name a companion? Returns the companion, or null.
 *
 * Accepts `Companion A`, `Companion A:`, `🔷 Companion A`, `🔷Companion A:` — and a trailing part after
 * the name when it opens with a dash, colon or comma, which keeps a sentence
 * that merely contains a name from being read as that companion speaking. The
 * sigil is matched by shape rather than configuration (a short run of
 * non-alphanumeric characters before the name), so a header keeps working if an
 * emoji changes or is dropped, while "My Ivy" still does not match.
 */
export function matchSpeakerLabel(
  label: string,
  companions: readonly LabelCompanion[] = COMPANIONS,
): LabelCompanion | null {
  const normalized = label.trim().replace(/:\s*$/, '').trim();
  const lower = normalized.toLocaleLowerCase();

  for (const companion of companions) {
    const name = companion.display_name.trim();
    if (!name) continue;

    const nameLower = name.toLocaleLowerCase();
    if (lower === nameLower) return companion;

    const at = lower.indexOf(nameLower);
    if (at < 0) continue;
    const prefix = normalized.slice(0, at).trim();
    if (prefix.length > 8 || /[\p{L}\p{N}]/u.test(prefix)) continue;

    const rest = normalized.slice(at + name.length);
    if (rest.trim() === '') return companion;
    // Source rule: a title after a dash/colon/comma is forgiven.
    if (/^\s*[—–:,-]\s*\S/.test(rest)) return companion;
    // Divergences 1 and 2 (see header), both the same shape: a short run of
    // non-alphanumeric characters after the name is punctuation or a sigil, not
    // prose — `Companion A —` and `Companion A 🔷`.
    if (rest.trim().length <= 8 && !/[\p{L}\p{N}]/u.test(rest)) return companion;
  }

  return null;
}
