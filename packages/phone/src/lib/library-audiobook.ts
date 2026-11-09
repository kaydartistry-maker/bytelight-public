// Audiobook mode's pure helpers (Library slice 5): where the voice goes next,
// who reads which piece, when the sleep timer stops, how fast they read.
// The player itself (lib/use-audiobook.ts) holds the one <audio>
// element and the lock-screen controls; everything it decides lives here.

import type { Segment } from './library-reader';

export interface PiecePos { chapter: number; seg: number }

/** Where the voice goes after a piece ends. `seg: 0` of a new chapter may
 *  turn out to be an empty chapter; the player steps on again from there. */
export type Step = { kind: 'piece'; chapter: number; seg: number } | { kind: 'end' };

/** The piece after `pos`: the next one in the chapter, else the next
 *  chapter's first, else the end of the book. */
export function nextPiece(pos: PiecePos, segCount: number, chapterCount: number): Step {
  if (pos.seg + 1 < segCount) return { kind: 'piece', chapter: pos.chapter, seg: pos.seg + 1 };
  if (pos.chapter + 1 < chapterCount) return { kind: 'piece', chapter: pos.chapter + 1, seg: 0 };
  return { kind: 'end' };
}

/** The piece before `pos`. At a chapter's first piece it is the previous
 *  chapter's last, given as `seg: -1` (its piece count isn't known until that
 *  chapter is fetched). At the book's very first piece, it stays put. */
export function prevPiece(pos: PiecePos): PiecePos {
  if (pos.seg > 0) return { chapter: pos.chapter, seg: pos.seg - 1 };
  if (pos.chapter > 0) return { chapter: pos.chapter - 1, seg: -1 };
  return { chapter: 0, seg: 0 };
}

/** Resolve `seg: -1` (the last piece) against a chapter's piece count. */
export function resolveSeg(seg: number, segCount: number): number {
  if (segCount <= 0) return 0;
  if (seg < 0) return segCount - 1;
  return Math.min(seg, segCount - 1);
}

// ── who reads ─────────────────────────────────────────────────────────────

/** The voice pick that means both companions, taking turns. Not a valid
 *  companion slug ([a-z0-9_-]), so it can never collide with one. */
export const BOTH_VOICES = '+both';

/**
 * Who reads piece `seg`. With Both, the pair takes turns piece by piece and
 * every chapter opens with the first of the pair: even pieces are the first
 * voice, odd pieces the second. The rule depends only on the piece's place in
 * its chapter, so a piece is always read by the same voice and the cached
 * audio is reused when she listens again.
 */
export function voiceFor(pick: string, seg: number, pair: readonly string[]): string {
  if (pick !== BOTH_VOICES) return pick;
  if (pair.length === 0) return '';
  return pair[Math.abs(seg) % Math.min(2, pair.length)];
}

/** "read by Companion A", "read by Companion A & Companion B" — names come from the house. */
export function readByLine(pick: string, pair: readonly string[], labelOf: (slug: string) => string): string {
  if (pick === BOTH_VOICES) {
    const names = pair.slice(0, 2).map(labelOf);
    return names.length ? `read by ${names.join(' & ')}` : '';
  }
  return pick ? `read by ${labelOf(pick)}` : '';
}

// ── how fast ──────────────────────────────────────────────────────────────

export const SPEEDS: readonly number[] = [0.8, 1, 1.2, 1.5];

/** The next speed on the chip, round and back to the start. */
export function nextSpeed(current: number): number {
  const i = SPEEDS.indexOf(current);
  return SPEEDS[(i + 1) % SPEEDS.length];
}

/** A saved speed if it's one of ours, else normal. */
export function validSpeed(value: unknown): number {
  const n = Number(value);
  return SPEEDS.includes(n) ? n : 1;
}

export function speedLabel(speed: number): string {
  return `${speed}×`;
}

// ── sleep timer ───────────────────────────────────────────────────────────

export type SleepMode = 'off' | 'chapter' | 15 | 30 | 60;
export const SLEEP_MODES: readonly SleepMode[] = ['off', 'chapter', 15, 30, 60];
/** The voice fades over this many seconds before the timer pauses it. */
export const FADE_SECONDS = 6;

export function nextSleep(current: SleepMode): SleepMode {
  const i = SLEEP_MODES.indexOf(current);
  return SLEEP_MODES[(i + 1) % SLEEP_MODES.length];
}

export function sleepMinutes(mode: SleepMode): number | null {
  return typeof mode === 'number' ? mode : null;
}

/** The chip's words: "Sleep", "End of chapter", "23 min left". */
export function sleepLabel(mode: SleepMode, leftMs: number | null): string {
  if (mode === 'off') return 'Sleep timer';
  if (mode === 'chapter') return 'End of chapter';
  const mins = Math.max(1, Math.ceil((leftMs ?? mode * 60_000) / 60_000));
  return `${mins} min left`;
}

/** End-of-chapter sleep: the piece now playing is the chapter's last, so the
 *  voice stops when it ends instead of turning the page. */
export function sleepsAfterThisPiece(mode: SleepMode, seg: number, segCount: number): boolean {
  return mode === 'chapter' && seg >= segCount - 1;
}

/** The timer counts listening time, not the clock: a pause holds it. */
export function tickSleep(leftMs: number, elapsedMs: number): number {
  return Math.max(0, leftMs - Math.max(0, elapsedMs));
}

/** Volume for the last FADE_SECONDS before the timer stops (1 before that). */
export function fadeVolume(secondsLeft: number, fade = FADE_SECONDS): number {
  if (!(secondsLeft < fade)) return 1;
  return Math.min(1, Math.max(0, secondsLeft / fade));
}

// ── where she is ──────────────────────────────────────────────────────────

/** How far through the chapter, 0–1: whole pieces done plus this one's share. */
export function chapterProgress(seg: number, segCount: number, currentTime: number, duration: number): number {
  if (segCount <= 0) return 0;
  const within = duration > 0 && Number.isFinite(duration) ? Math.min(1, Math.max(0, currentTime / duration)) : 0;
  return Math.min(1, (seg + within) / segCount);
}

/** Her bookmark while listening: the paragraph the voice is on, as a share of
 *  the chapter's paragraphs (the same fraction the companions' reach reads). */
export function bookmarkFraction(segments: Segment[], seg: number, paragraphCount: number, within = 0): number {
  const s = segments[seg];
  if (!s || paragraphCount <= 0) return 0;
  const span = s.to - s.from + 1;
  const at = s.from + Math.floor(span * Math.min(1, Math.max(0, within)));
  return Math.min(1, Math.max(0, Math.min(at, s.to) / paragraphCount));
}

/** ⟲15 / ⟳15: a new time inside the piece now playing. */
export function seekTarget(currentTime: number, duration: number, delta: number): number {
  const end = Number.isFinite(duration) && duration > 0 ? duration : Math.max(0, currentTime + delta);
  return Math.min(end, Math.max(0, currentTime + delta));
}
