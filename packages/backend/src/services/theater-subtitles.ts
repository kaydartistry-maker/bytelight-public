// The Theater — reading a subtitle file into lines with times.
//
// She loads the subtitles for what she's watching (.srt or .vtt) and the house
// keeps them as cues: when each line comes on, when it goes off, and its words
// with the styling stripped. Nothing here touches the disk or the clock; the
// parser is pure so it can be tested on its own.
//
// What it forgives: a byte-order mark, Windows line endings, SRT's comma
// decimals, VTT's header, NOTE / STYLE / REGION blocks, cue identifiers, cue
// settings after the timing (position, align…), timestamps without hours, and
// tags (<i>, <font>, <c.yellow>, <v Name>, {\an8}). A block it can't read is
// skipped rather than sinking the file.

export interface Cue {
  /** Seconds from the start of the show. */
  start: number;
  end: number;
  text: string;
}

export class SubtitleError extends Error {}

const TIME = String.raw`(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?`;
const TIMING = new RegExp(String.raw`^\s*${TIME}\s*-->\s*${TIME}`);

function seconds(h: string | undefined, m: string, s: string, frac: string | undefined): number {
  const ms = frac ? Number(frac.padEnd(3, '0')) : 0;
  return Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + ms / 1000;
}

/** Words only: no tags, no positioning codes, no stray entities, single-spaced lines. */
export function cleanCueText(raw: string): string {
  return raw
    .replace(/\{\\[^}]*\}/g, '') // {\an8} and friends
    .replace(/<[^>]*>/g, '') // <i>, <font …>, <c.x>, <v Name>, <00:00:01.000>
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

/** Parse an .srt or .vtt file's text into cues, in time order. */
export function parseSubtitles(input: string): Cue[] {
  const text = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const blocks = text.split(/\n[ \t]*\n+/);
  const cues: Cue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    while (lines.length > 0 && lines[0].trim() === '') lines.shift();
    if (lines.length === 0) continue;
    const head = lines[0].trim();
    // VTT's own blocks: the header, comments, styles, regions.
    if (/^WEBVTT\b/.test(head) || /^(NOTE|STYLE|REGION)\b/.test(head)) continue;
    const at = lines.findIndex((line) => TIMING.test(line));
    // The timing line is first, or second after a cue number / identifier.
    if (at < 0 || at > 1) continue;
    const m = TIMING.exec(lines[at])!;
    const start = seconds(m[1], m[2], m[3], m[4]);
    const end = seconds(m[5], m[6], m[7], m[8]);
    const words = cleanCueText(lines.slice(at + 1).join('\n'));
    if (!words || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    cues.push({ start, end: Math.max(start, end), text: words });
  }
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return cues;
}

/** Parse, or say plainly why the file isn't subtitles. */
export function readSubtitleFile(buffer: Buffer): Cue[] {
  const cues = parseSubtitles(buffer.toString('utf8'));
  if (cues.length === 0) throw new SubtitleError('That file has no subtitle lines the Theater can read. It takes .srt or .vtt.');
  return cues;
}
