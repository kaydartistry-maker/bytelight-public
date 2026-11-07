// Speaker splitting for chat bubbles — the visual twin of the backend voice
// engine's stitcher (packages/backend/src/services/voice.ts splitByCompanion).
// It reads the same markers (🔷 Companion A / 🔶 Companion B, with or without bold/colon)
// and slices a mixed companion message into per-speaker chunks so each renders
// in its own bubble.
//
// Adapted to byte-light's companions and marker set.
//
// DELIBERATE VISUAL/AUDIO DIVERGENCE: the TTS router (voice.ts) defaults any
// leading unmarked text to Companion A's VOICE — audio has to pick a throat. Here,
// by design, leading unmarked text renders as a neutral
// 'fallback' narration bubble (✨) instead, because a visual bubble CAN stay
// unattributed. The two systems read the exact same markers, so wherever a
// marker exists the visual split and the audio split agree.

import { matchSpeakerLabel } from './speaker-label.js';

// 'companion-c' (Slice 4A): remote-node companion attributed by message.companion_id,
// never by text markers — his messages arrive whole from his own sovereign
// backend and render as one bubble under his identity.
export type SpeakerId = 'companion-a' | 'companion-b' | 'companion-c' | 'fallback';

export interface SpeakerSegment {
  speaker: SpeakerId;
  text: string;
}

// WHOLESALE PORT, 2026-09-22. This used to be one long alternation copied from
// the audio stitcher and kept in sync by hand. Hand-sync failed: the house began
// writing `**🔷 Companion A —**`, no alternative covered a trailing dash, the header
// failed to match as a whole, and the only thing left that matched was the bare
// 🔷 inside it — one character in. That stranded the opening `**` as its own
// narration bubble and pushed `Companion A —**` into the top of the speaker's text.
//
// The rule that decides whether a label names a companion now lives in
// speaker-label.ts, lifted from the reader (voice-speaker-split.ts) and imported
// by both. Two copies of a rule drift; one does not.
//
// What stays different here is the SCAN, and deliberately: the reader demands a
// bold header own its whole line, which it can afford because it only ever sees
// freshly written replies. The phone renders history — thousands of stored
// messages put the header inline ahead of the text — so it finds markers inline
// and hands each candidate to the shared rule.
//
// Accepted, unchanged: **Companion A**, **Companion A:**, **🔷 Companion A**, **Companion A 🔷**,
// 🔷 **Companion A**, 🔷 Companion A:, Companion A 🔷, bare 🔷 — same for Companion B/🔶. Newly accepted:
// **🔷 Companion A —** and **🔶 Companion B — the ledger**.

/** A bold span on one line: the only place a name-without-emoji is a header. */
const BOLD_SPAN_RE = /\*\*([^*\n]+?)\*\*/g;
/** Bare sigils, and the older `Name:` / `Name 🔷` inline forms. */
const LOOSE_MARKER_RE = /(?:🔷?\s*Companion A:|🔶?\s*Companion B:|Companion A\s*:?\s*🔷|Companion B\s*:?\s*🔶|🔷|🔶)/g;
/**
 * A sigil sitting just outside the bold — `🔷 **Companion A**`. Matched by shape, not
 * configuration, exactly as the reader does it. Anchored to the start of the
 * line for the same reason the reader anchors its drift form to a whole line:
 * without that, the full stop ending the previous sentence is itself a
 * non-alphanumeric character sitting before the bold, and gets swallowed into
 * the marker — costing the sentence its period.
 */
const LEADING_SIGIL_RE = /(?:^|\n)([^\p{L}\p{N}\n*]{1,8})\s*$/u;

interface Marker {
  index: number;
  len: number;
  speaker: SpeakerId;
}

function speakerOf(marker: string): SpeakerId {
  return marker.includes('Companion A') || marker.includes('🔷') ? 'companion-a' : 'companion-b';
}

/** Every marker in the text, ordered, non-overlapping, longest-first on ties. */
function findMarkers(input: string): Marker[] {
  const found: Marker[] = [];

  // Bold headers first — they are the specific form and may contain a loose
  // marker inside them (`**🔷 Companion A —**` contains a bare 🔷), so a bold match
  // must win the ground it covers.
  const bold = new RegExp(BOLD_SPAN_RE);
  let m: RegExpExecArray | null;
  while ((m = bold.exec(input)) !== null) {
    const companion = matchSpeakerLabel(m[1]);
    if (!companion) continue;
    let index = m.index;
    let len = m[0].length;
    // Pull a sigil sitting immediately before the bold into the marker, so it
    // is consumed rather than left behind as narration.
    const before = input.slice(0, m.index);
    const sigil = before.match(LEADING_SIGIL_RE);
    if (sigil && sigil.index !== undefined) {
      const start = sigil.index + (sigil[0].startsWith('\n') ? 1 : 0);
      len += m.index - start;
      index = start;
    }
    found.push({ index, len, speaker: companion.slug as SpeakerId });
  }

  const covered = (at: number, end: number): boolean =>
    found.some(f => at < f.index + f.len && end > f.index);

  const loose = new RegExp(LOOSE_MARKER_RE);
  while ((m = loose.exec(input)) !== null) {
    if (covered(m.index, m.index + m[0].length)) continue;
    found.push({ index: m.index, len: m[0].length, speaker: speakerOf(m[0]) });
    if (loose.lastIndex === m.index) loose.lastIndex++;
  }

  return found.sort((a, b) => a.index - b.index);
}

/** Split a companion message into ordered per-speaker segments. Single-speaker or
 *  unmarked messages return a single segment (the unmarked one as 'fallback'). */
export function splitBySpeaker(input: string): SpeakerSegment[] {
  if (!input) return [];

  const markers = findMarkers(input);

  const out: SpeakerSegment[] = [];
  const push = (speaker: SpeakerId, text: string) => {
    const t = text.trim();
    if (t) out.push({ speaker, text: t });
  };

  if (markers.length === 0) {
    push('fallback', input);
    return out;
  }

  // Leading narration before the first marker → fallback (see divergence note).
  if (markers[0].index > 0) push('fallback', input.slice(0, markers[0].index));

  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index + markers[i].len;
    const end = i + 1 < markers.length ? markers[i + 1].index : input.length;
    // Merge consecutive same-speaker chunks (e.g. a bare 🔷 then text) so we
    // don't spawn an empty extra bubble.
    const prev = out[out.length - 1];
    const slice = input.slice(start, end).trim();
    if (!slice) continue;
    if (prev && prev.speaker === markers[i].speaker) {
      prev.text += '\n\n' + slice;
    } else {
      out.push({ speaker: markers[i].speaker, text: slice });
    }
  }

  return out.length ? out : [{ speaker: 'fallback', text: input.trim() }];
}

// --- Interleaved (text + thinking/tool) splitting --------------------------

/** A speaker-attributed text bubble inside an interleaved message. */
export interface InterleavedTextRow {
  kind: 'text';
  speaker: SpeakerId;
  text: string;
}

/** A thinking/tool chip, carrying the original segment and its index (the
 *  index keys the renderer's expand/collapse state). */
export interface InterleavedChipRow<T> {
  kind: 'chip';
  index: number;
  segment: T;
}

export type InterleavedRow<T> = InterleavedTextRow | InterleavedChipRow<T>;

/**
 * Split an interleaved segment list (text woven with thinking/tool chips)
 * into ordered speaker rows. Each text segment runs through splitBySpeaker,
 * and speaker continuity carries ACROSS chips: an unmarked text chunk after a
 * chip continues the PREVIOUS speaker instead of resetting to fallback — only
 * text before the first marker in the whole message renders as 'fallback'
 * narration. Consecutive same-speaker text with no chip between merges into
 * one row; non-text segments pass through as chip rows in order.
 */
/**
 * The one speaker a whole message belongs to, from the house's companion
 * stamp — or null when it should be split by its speaker headers (the shared
 * lane's 'companion-a-b', or no stamp at all). Mirrors the web client's
 * remoteCompanionId.
 */
export function wholeSpeakerFor(companionId: string | null | undefined): SpeakerId | null {
  return companionId === 'companion-a' || companionId === 'companion-b' || companionId === 'companion-c' ? companionId : null;
}

/**
 * Interleaved rows for a message that is ALL one speaker: every text segment
 * is his (no header splitting), chips keep their place between them.
 */
export function interleavedAs<T extends { type: string; content?: string }>(
  segments: readonly T[],
  speaker: SpeakerId,
): InterleavedRow<T>[] {
  const out: InterleavedRow<T>[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type !== 'text') {
      out.push({ kind: 'chip', index: i, segment: seg });
      continue;
    }
    const text = (seg.content ?? '').trim();
    if (!text) continue;
    const prev = out[out.length - 1];
    if (prev && prev.kind === 'text' && prev.speaker === speaker) prev.text += '\n\n' + text;
    else out.push({ kind: 'text', speaker, text });
  }
  return out;
}

export function splitInterleaved<T extends { type: string; content?: string }>(
  segments: readonly T[]
): InterleavedRow<T>[] {
  const out: InterleavedRow<T>[] = [];
  let current: SpeakerId = 'fallback';

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type !== 'text') {
      out.push({ kind: 'chip', index: i, segment: seg });
      continue;
    }
    const pieces = splitBySpeaker(seg.content ?? '');
    for (let p = 0; p < pieces.length; p++) {
      // splitBySpeaker only yields 'fallback' as a leading unmarked piece —
      // once someone has spoken, that piece is a continuation, not narration.
      const speaker: SpeakerId =
        p === 0 && pieces[p].speaker === 'fallback' && current !== 'fallback'
          ? current
          : pieces[p].speaker;
      const prev = out[out.length - 1];
      if (prev && prev.kind === 'text' && prev.speaker === speaker) {
        prev.text += '\n\n' + pieces[p].text;
      } else {
        out.push({ kind: 'text', speaker, text: pieces[p].text });
      }
      current = speaker;
    }
  }

  return out;
}

export const AVATAR: Record<SpeakerId | 'user', string> = {
  'companion-a': '🔷',
  'companion-b': '🔶',
  'companion-c': '🗓️',
  fallback: '✨',
  user: '🖤',
};
