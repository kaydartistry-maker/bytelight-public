// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * A restart hands a reopened room what changed in the walls, not a second copy
 * of the whole instruction file (theirs, Nov 10 2026: 'I don't want restarts
 * adding so much to your context window').
 *
 * Claude Code reads a lane's CLAUDE.md at startup, and on a resumed room it
 * compares the file with the copy the room already holds: if they differ it
 * attaches the WHOLE new file beside the old one (attachment type
 * 'instructions', changed: true, reason: session_start). Our file carries the
 * walls, which move every few hours, so nearly every restart differed, and
 * each one added about 190 thousand tokens. Measured Nov 10 2026 on the live
 * room: 578k before their first restart that morning, about 770k after it, and
 * the second restart half an hour later took it past the 900k line, so it
 * squashed the minute it could.
 *
 * The older answer, stripStaleInstructions in supervisor.ts, cut the old
 * copies out of a transcript before reopening it. It only runs on a transcript
 * under 32 MB here, and a long room passes that within days.
 *
 * So on a resume this puts back on disk the exact copy the room already holds,
 * which Claude Code then has no reason to attach again, and writes the walls
 * that moved into the resume prompt instead. The current file goes back on
 * disk on the lane's next turn (provisionSessionDir), and a squash reads it
 * fresh from disk, so the room is whole again after its next compaction.
 *
 * Only the walls are handled this way. When anything outside <core-memory>
 * changed (the house file, a persona, the heartbeat contract), the room is
 * left to take the whole new copy, because those changes are rare and are
 * exactly the ones that should not arrive as a summary.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { blockDrift, hashBlock, parseInjectedBlocks, type DriftBlock } from './block-drift.js';

/** A prompt is one argv string, and Linux refuses one past 128 KB. The note
 *  has to fit with room to spare, or the lane would not launch at all. */
export const HELD_NOTE_MAX_BYTES = 90_000;

/** How far back from the end of a transcript to look for the room's copy. A
 *  room gets a fresh one at every compaction and restart, so the last one is
 *  normally within the last few megabytes; this only bounds a strange file. */
const SCAN_LIMIT_BYTES = 1024 * 1024 * 1024;
const WINDOW_BYTES = 8 * 1024 * 1024;

/**
 * The CLAUDE.md text the room was last handed: the newest 'instructions'
 * attachment in its transcript that carries this file. Reads the transcript
 * from the end in windows, so a room of several hundred megabytes costs one
 * short read, not the whole file in memory. Null when none is found or the
 * file cannot be read; a null means do nothing different.
 */
export function lastInjectedClaudeMd(transcriptPath: string, claudeMdPath: string): string | null {
  let fd: number;
  try {
    fd = openSync(transcriptPath, 'r');
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const floor = Math.max(0, size - SCAN_LIMIT_BYTES);
    let pos = size;
    let carry = Buffer.alloc(0);
    const marker = Buffer.from('"instructions"');
    while (pos > floor) {
      const start = Math.max(floor, pos - WINDOW_BYTES);
      const chunk = Buffer.alloc(pos - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      // Everything before the first newline may be the tail of a line that
      // started further back; it waits for the next window unless this is the top.
      let from = 0;
      if (start > floor) {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) { carry = buf; pos = start; continue; }
        carry = buf.subarray(0, nl);
        from = nl + 1;
      } else {
        carry = Buffer.alloc(0);
      }
      // Newest first: walk the complete lines of this window from the end.
      let end = buf.length;
      while (end > from) {
        const nl = buf.lastIndexOf(0x0a, end - 1);
        const lineStart = nl < from ? from : nl + 1;
        const line = buf.subarray(lineStart, end);
        end = nl < from ? from : nl;
        if (line.length < 200 || line.indexOf(marker) === -1) continue;
        let row: { type?: string; attachment?: { type?: string; files?: Array<{ path?: string; content?: string }> } };
        try {
          row = JSON.parse(line.toString('utf8'));
        } catch {
          continue;
        }
        if (row.type !== 'attachment' || row.attachment?.type !== 'instructions') continue;
        const file = row.attachment.files?.find((f) => f.path === claudeMdPath);
        if (file && typeof file.content === 'string') return file.content;
      }
      pos = start;
    }
    return null;
  } catch {
    return null;
  } finally {
    try { closeSync(fd); } catch { /* ignore */ }
  }
}

/** The file the way the CLI stores it in a transcript (read Nov 10 2026): HTML
 *  comments on their own lines are dropped and so is the last newline. The
 *  disk copy has both, so the two are compared in this form. */
export function asTheCliKeepsIt(text: string): string {
  return text.replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*\r?\n/gm, '').trimEnd();
}

/** The file with the walls taken out, for asking whether anything else moved. */
function outsideTheWalls(claudeMd: string): string {
  const open = claudeMd.indexOf('<core-memory>');
  const close = claudeMd.indexOf('</core-memory>');
  if (open === -1 || close === -1 || close < open) return claudeMd;
  return claudeMd.slice(0, open) + claudeMd.slice(close);
}

function asBlocks(parsed: Map<string, string>): DriftBlock[] {
  return [...parsed.entries()].map(([key, content]) => {
    const slash = key.indexOf('/');
    return { scope: key.slice(0, slash), label: key.slice(slash + 1), content };
  });
}

export type HoldPlan =
  | { hold: false; reason: 'same' | 'outside-walls' | 'too-big' | 'no-copy' }
  | { hold: true; note: string; changed: string[]; removed: string[] };

/**
 * What to do on a resume, given the copy the room holds and the file the house
 * just wrote. Hold means: put the room's copy back on disk and send the note.
 */
export function planHold(roomCopy: string | null, current: string): HoldPlan {
  if (roomCopy == null) return { hold: false, reason: 'no-copy' };
  const room = asTheCliKeepsIt(roomCopy);
  const now = asTheCliKeepsIt(current);
  if (room === now) return { hold: false, reason: 'same' };
  if (outsideTheWalls(room) !== outsideTheWalls(now)) return { hold: false, reason: 'outside-walls' };
  const before = parseInjectedBlocks(room);
  const { changed, removed } = blockDrift(before, asBlocks(parseInjectedBlocks(now)));
  if (changed.length === 0 && removed.length === 0) return { hold: false, reason: 'same' };
  const note = renderHeldNote(changed, removed, before);
  if (Buffer.byteLength(note, 'utf8') > HELD_NOTE_MAX_BYTES) return { hold: false, reason: 'too-big' };
  return {
    hold: true,
    note,
    changed: changed.map((b) => `${b.scope}/${b.label}`),
    removed,
  };
}

/**
 * The lines of a wall that went and the lines that came. Walls are written one
 * thing to a line, so a line is the unit: an edited line shows as the old one
 * going and the new one coming. Counted, so a repeated line is handled.
 */
export function lineChanges(before: string, after: string): { gone: string[]; came: string[] } {
  const count = (text: string) => {
    const m = new Map<string, number>();
    for (const l of text.split('\n')) {
      if (!l.trim()) continue;
      m.set(l, (m.get(l) || 0) + 1);
    }
    return m;
  };
  const a = count(before);
  const b = count(after);
  const gone: string[] = [];
  const came: string[] = [];
  for (const l of before.split('\n')) {
    const left = (a.get(l) || 0) - (b.get(l) || 0);
    if (l.trim() && left > 0 && !gone.includes(l)) for (let i = 0; i < left; i++) gone.push(l);
  }
  for (const l of after.split('\n')) {
    const extra = (b.get(l) || 0) - (a.get(l) || 0);
    if (l.trim() && extra > 0 && !came.includes(l)) for (let i = 0; i < extra; i++) came.push(l);
  }
  return { gone, came };
}

function renderWall(b: DriftBlock, before: string | undefined): string {
  const whole = `## [${b.scope}] ${b.label} (whole wall, new)\n${b.content}`;
  if (before === undefined) return whole;
  const { gone, came } = lineChanges(before, b.content);
  const parts = [`## [${b.scope}] ${b.label} (only the lines that changed)`];
  if (gone.length) parts.push(`Lines gone from it:\n${gone.map((l) => `- ${l}`).join('\n')}`);
  if (came.length) parts.push(`Lines new in it:\n${came.map((l) => `+ ${l}`).join('\n')}`);
  const diff = parts.join('\n');
  // A wall rewritten top to bottom reads better whole than as two long lists.
  return diff.length < b.content.length ? diff : `## [${b.scope}] ${b.label} (whole wall, rewritten)\n${b.content}`;
}

/** The part of the resume prompt that carries the walls that moved. */
export function renderHeldNote(
  changed: DriftBlock[],
  removed: string[],
  before: Map<string, string> = new Map(),
): string {
  if (changed.length === 0 && removed.length === 0) return '';
  const gone = removed.length ? ` Deleted since: ${removed.join(', ')}.` : '';
  const body = changed.map((b) => renderWall(b, before.get(`${b.scope}/${b.label}`))).join('\n\n');
  return (
    `[WALLS MOVED WHILE THE HOUSE WAS DOWN] The house kept the instruction copy this room ` +
    `already holds rather than handing you a second whole one, so the core-memory blocks ` +
    `above are the older versions of the walls named here.${gone} What changed in each ` +
    `is below, and it replaces what is above:\n\n${body}`
  );
}

/**
 * The launch baseline for a room that kept its own instruction copy.
 *
 * The baseline (io/.block-baseline.json) says what walls the room was opened
 * with, and the after-compaction repair hands back every wall whose live hash
 * differs from it. A held room was opened with the OLD text of the walls that
 * moved, and a compaction replays that old attachment as it is. So those walls
 * have to read as moved after a compaction: a changed wall gets the hash of
 * the text the room holds, a wall new since then is left out (absent reads as
 * new), and a wall deleted since then keeps a hash so it reads as removed.
 * Every other wall keeps its live hash, exactly as an ordinary launch.
 */
export function heldBaseline(
  live: Record<string, string>,
  roomCopy: string,
  changed: readonly string[],
  removed: readonly string[],
): Record<string, string> {
  const room = parseInjectedBlocks(asTheCliKeepsIt(roomCopy));
  const out = { ...live };
  for (const key of [...changed, ...removed]) {
    const held = room.get(key);
    if (held === undefined) { delete out[key]; continue; }
    const h = hashBlock(held);
    // Never let the held wall read as current by accident.
    out[key] = h === live[key] ? `held:${h}` : h;
  }
  return out;
}
