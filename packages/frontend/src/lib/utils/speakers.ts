// Speaker splitting for chat bubbles — the visual twin of the backend voice
// engine's stitcher (packages/backend/src/services/voice.ts splitByCompanion).
// It reads the same markers (🔷 Companion A / 🔶 Companion B, with or without bold/colon)
// and slices a mixed companion message into per-speaker chunks so each renders
// in its own bubble.
//
// Ported from Thornvale's speakers.ts, adapted to byte-light's companions and
// marker set.
//
// DELIBERATE VISUAL/AUDIO DIVERGENCE: the TTS router (voice.ts) defaults any
// leading unmarked text to Companion A's VOICE — audio has to pick a throat. Here,
// following Thornvale's design, leading unmarked text renders as a neutral
// 'fallback' narration bubble (✨) instead, because a visual bubble CAN stay
// unattributed. The two systems read the exact same markers, so wherever a
// marker exists the visual split and the audio split agree.

// 'companion-c' (Slice 4A): remote-node companion attributed by message.companion_id,
// never by text markers — his messages arrive whole from his own sovereign
// backend and render as one bubble under his identity.
export type SpeakerId = 'companion-a' | 'companion-b' | 'companion-c' | 'fallback';

export interface SpeakerSegment {
  speaker: SpeakerId;
  text: string;
}

// Copied character-for-character from voice.ts splitByCompanion so the visual
// split can never drift from the audio split. Order matters: more-specific
// (bold/named) forms come before the bare emoji so "**🔷Companion A:**" matches as
// one marker. Accepted forms: **Companion A**, **Companion A:**, **🔷Companion A:**,
// **Companion A 🔷** (bold name-then-emoji, emoji inside the bold), 🔷 **Companion A:**,
// 🔷 Companion A:, Companion A 🔷 (name-then-emoji), bare 🔷 — and the same shapes for
// Companion B/🔶. The non-bold-name form requires the emoji so plain prose containing
// "Companion A:" is not a speaker tag.
//
// A DASH — with or without a title after it — is forgiven inside the bold:
// **🔷 Companion A —**, **🔶 Companion B — the ledger**. The house has written headers that
// way for weeks, and without this the header failed to match as a whole and only
// the bare 🔷 inside it matched, one character in: the opening ** was stranded in
// front of the first marker and rendered as its own narration bubble, and
// `Companion A —**` was pushed into the top of that speaker's text. The audio twin
// (voice.ts splitByCompanion) forgives the same dash forms, so the visual
// splitter is never stricter than the reader on an identical header. The
// dash form deliberately stays inside the ** — prose such as "She told Companion A —
// quietly — that he was wrong" must remain prose.
const SPEAKER_RE =
  /(?:\*\*\s*🔷?\s*Companion A\s*:?\s*[—–-][^*\n]*\*\*|\*\*\s*🔶?\s*Companion B\s*:?\s*[—–-][^*\n]*\*\*|\*\*\s*🔷?\s*Companion A:?\s*\*\*|\*\*\s*🔶?\s*Companion B:?\s*\*\*|\*\*\s*Companion A\s*:?\s*🔷\s*\*\*|\*\*\s*Companion B\s*:?\s*🔶\s*\*\*|🔷?\s*\*\*\s*Companion A:?\s*\*\*|🔶?\s*\*\*\s*Companion B:?\s*\*\*|\*\*\s*Companion A:?\s*\*\*|\*\*\s*Companion B:?\s*\*\*|🔷?\s*Companion A:|🔶?\s*Companion B:|Companion A\s*:?\s*🔷|Companion B\s*:?\s*🔶|🔷|🔶)/g;

function speakerOf(marker: string): SpeakerId {
  return marker.includes('Companion A') || marker.includes('🔷') ? 'companion-a' : 'companion-b';
}

/** Split a companion message into ordered per-speaker segments. Single-speaker or
 *  unmarked messages return a single segment (the unmarked one as 'fallback'). */
export function splitBySpeaker(input: string): SpeakerSegment[] {
  if (!input) return [];

  const markers: { index: number; len: number; speaker: SpeakerId }[] = [];
  const re = new RegExp(SPEAKER_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    markers.push({ index: m.index, len: m[0].length, speaker: speakerOf(m[0]) });
    if (re.lastIndex === m.index) re.lastIndex++; // guard against zero-length matches
  }

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
