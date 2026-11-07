// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * Compactions, and where the record actually lives.
 *
 * When a CLI lane fills its window, the tool squashes everything said so far
 * into a summary and carries on from that. From the user's side it is invisible: the
 * lane keeps talking, nothing is announced, and a compaction and a dead lane
 * look identical. What the user gets is a companion who is subtly off and no way to
 * check why.
 *
 * The CLI already writes the summary into that
 * session's own transcript as a user-role message carrying `isCompactSummary`,
 * with a timestamp and the whole summary text, marked visible-in-transcript-
 * only so it renders to nobody. The record has existed all along and had no
 * reader. So this is the reader.
 *
 * The summary also ends by instructing the lane not to acknowledge it and to
 * carry on as if the break never happened, which is why a lane left to itself
 * never mentions one to the user.
 *
 * What changed on Oct 21 2026, at the owner ask:
 *
 * It reads the house's LANES and nothing else. Claude Code keeps a project
 * folder for every session that runs on this box — the system tmp folder, the owner
 * terminal sessions, test walks — and the old reader walked all of them, so a
 * squash from the tmp folder sat on the owner page as one of ours. The banner check
 * (isHeartbeatLane) already knew what a lane was; the page's reader simply
 * never asked it. Now the walk starts from data/heartbeat and opens only each
 * lane's own project folder.
 *
 * The transcripts are no longer the only copy. They were treated as the log
 * because anything written beside them could only drift from a record the tool
 * already kept — and then the tool turned out to delete old transcripts, and
 * the summaries went with them. So every squash read here is shelved in the
 * house's own database (services/compaction-shelf.ts), and this module only
 * has to find the new ones.
 *
 * And it never holds a transcript in memory. The shared room's is a hundred
 * and fifty megabytes and there are dozens of resumed copies beside it, so a
 * transcript is read a piece at a time, only a line carrying the flag is ever
 * decoded, and each file's squashes are handed over and let go before the next
 * file is opened. Where each read stopped is kept on the shelf too, so a
 * transcript that has not changed is never opened again, even after a restart.
 */

import { existsSync, readdirSync } from 'node:fs';
import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { PROJECT_ROOT } from '../config.js';
import { projectKeyForDir } from './heartbeat/transcript-usage.js';

export interface CompactionEvent {
  /** The transcript file this came out of, without its extension. */
  sessionId: string;
  /** The project directory name — the CLI's folder for the lane's transcripts. */
  project: string;
  /** The lane it happened in: its folder under data/heartbeat ('primary', or a companion's id). */
  lane: string;
  /** ISO stamp written by the CLI at the moment of the squash. */
  at: string;
  /** How much conversation the summary is standing in for, in characters. */
  chars: number;
  /** The summary itself — what the lane carried on from. */
  summary: string;
}

/** Overridable so a test can point at a fixture tree rather than the real one. */
export function transcriptRoot(): string {
  return process.env.BYTELIGHT_TRANSCRIPT_ROOT || join(homedir(), '.claude', 'projects');
}

/** Where the lanes live. Overridable for the same reason. */
export function lanesRoot(): string {
  return process.env.BYTELIGHT_LANES_ROOT || join(PROJECT_ROOT, 'data', 'heartbeat');
}

/** One rule for what a lane is. */
function isLaneFolder(root: string, lane: unknown): lane is string {
  if (typeof lane !== 'string' || !/^[A-Za-z0-9._-]+$/.test(lane) || /^\.+$/.test(lane)) return false;
  return existsSync(join(root, lane, 'io'));
}

/**
 * Whether a name is one of the house's own lanes: a folder under data/heartbeat
 * with an io folder in it. Claude Code keeps project folders for every session
 * on the box (the system tmp folder, terminal sessions); none of those are ours.
 */
export function isHeartbeatLane(lane: unknown, projectRoot: string): lane is string {
  return isLaneFolder(join(projectRoot, 'data', 'heartbeat'), lane);
}

/** Every lane folder in the house, by the same rule, in a fixed order. */
export function heartbeatLanes(root: string = lanesRoot()): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((name) => isLaneFolder(root, name)).sort();
}

/**
 * A squash's identity: WHEN it happened and WHAT it said, inside one lane's
 * project. The shelf's row id is a hash of exactly this, so the reader and the
 * shelf can never disagree about whether two copies are one squash.
 */
export function compactionKey(e: Pick<CompactionEvent, 'project' | 'at' | 'summary'>): string {
  return `${e.project}\u0000${e.at}\u0000${e.summary}`;
}

/**
 * One squash, one row.
 *
 * Reopening a room copies the ENTIRE transcript into a new file under a new
 * session id, and every compaction already in it rides along in the copy. So a
 * room resumed eight times puts the same squash on disk eight times, and a
 * reader that walks files hands the owner eight identical rows for one event. The owner saw
 * that before we did — Sep 20 2026, a bunch in the memory app that look like
 * they're duplicated.
 *
 * The session id is not part of the identity: after a resume the honest answer
 * to "which session" is several, and picking one is not worth losing the row
 * over. Project stays in it so two lanes can never swallow each other.
 */
export function dedupeCopies<T extends Pick<CompactionEvent, 'project' | 'at' | 'summary'>>(events: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const e of events) {
    const key = compactionKey(e);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * How far a transcript has been read. The caller keeps these (the shelf keeps
 * them in the database, in the same write as the squashes they found), so the
 * reader itself remembers nothing between reads.
 */
export interface FileMark {
  size: number;
  mtimeMs: number;
  /** Just past the last whole line read. */
  offset: number;
  /** The first bytes of the file as last read, and their hash. */
  headLen: number;
  headHash: string;
  /** The bytes just before `offset` as last read, and their hash. */
  tailLen: number;
  tailHash: string;
}

/** What one transcript gave up since its last read. */
export interface TranscriptRead {
  path: string;
  /** Compactions in the bytes not read before, in line order. */
  events: CompactionEvent[];
  /** Where this read got to. Store it with the events, in the same write. */
  mark: FileMark;
}

export interface ScanOptions {
  transcriptRoot?: string;
  lanesRoot?: string;
}

export interface LaneScan {
  /**
   * Marks for transcripts that are gone: in a lane folder that was listed this
   * time, and no longer in it (Claude Code deletes old transcripts). The caller
   * forgets them, so the marks never outlive the files.
   */
  stale: string[];
}

/** The flag's key with its quotes. A mention inside a string is escaped (\"isCompactSummary\"), so it never matches. */
const KEY = Buffer.from('"isCompactSummary"');
const TRUE = Buffer.from('true');
const NEWLINE = 0x0a;
const COLON = 0x3a;
/** A transcript is read this much at a time. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** Enough of the top of a file, and of the bytes before where a read stopped, to tell growth from a rewrite. */
const HEAD_BYTES = 4096;
const TAIL_BYTES = 4096;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return '';
}

function isSpace(byte: number | undefined): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d;
}

/** Whether the key found at `at` is set to true: `"isCompactSummary":true`, spaces allowed. */
function flagIsTrue(region: Buffer, at: number, end: number): boolean {
  let i = at + KEY.length;
  while (i < end && isSpace(region[i])) i++;
  if (region[i] !== COLON) return false;
  i++;
  while (i < end && isSpace(region[i])) i++;
  return i + TRUE.length <= end && region.subarray(i, i + TRUE.length).equals(TRUE);
}

type Found = Pick<CompactionEvent, 'at' | 'chars' | 'summary'>;

/** A line is a compaction only if the record itself carries the flag; a mention is not. */
function compactionIn(line: string): Found | null {
  try {
    const row = JSON.parse(line);
    if (row?.isCompactSummary !== true) return null;
    const summary = textOf(row?.message?.content);
    return { at: typeof row.timestamp === 'string' ? row.timestamp : '', chars: summary.length, summary };
  } catch {
    // A half-written last line is normal on a live transcript.
    return null;
  }
}

/**
 * Every compaction in a run of whole lines. Only a line whose own key is set
 * to true is ever decoded; the rest stay bytes.
 */
function scanLines(region: Buffer, found: Found[]): void {
  let from = 0;
  while (from < region.length) {
    const hit = region.indexOf(KEY, from);
    if (hit === -1) return;
    const start = region.lastIndexOf(NEWLINE, hit) + 1;
    let end = region.indexOf(NEWLINE, hit);
    if (end === -1) end = region.length;
    // A record writes the key once; anything earlier on the line is text.
    let at = hit;
    while (at !== -1 && at < end && !flagIsTrue(region, at, end)) {
      at = region.indexOf(KEY, at + 1);
    }
    if (at !== -1 && at < end) {
      const event = compactionIn(region.toString('utf8', start, end));
      if (event) found.push(event);
    }
    from = end + 1;
  }
}

async function hashRange(handle: FileHandle, from: number, length: number): Promise<string> {
  const buf = Buffer.alloc(Math.max(0, length));
  let got = 0;
  while (got < length) {
    const { bytesRead } = await handle.read(buf, got, length - got, from + got);
    if (bytesRead <= 0) break;
    got += bytesRead;
  }
  return createHash('sha1').update(buf.subarray(0, got)).digest('hex');
}

/** The one buffer a walk reads every transcript through, so a walk of hundreds of files allocates it once. */
interface Scratch {
  buf: Buffer | null;
}

/**
 * Read a transcript from `start` to `size`, a piece at a time. Returns what it
 * found and where the last whole line ended. An unfinished last line is still
 * looked at (a test fixture, or a record whose newline has not landed yet), but
 * the offset never moves past it, so it is read again next time and the shelf
 * folds the copy. The walk's one buffer is reused; it only grows if a single
 * line is longer than half of it.
 */
async function readFrom(handle: FileHandle, start: number, size: number, scratch: Scratch): Promise<{ found: Found[]; end: number }> {
  const found: Found[] = [];
  if (!scratch.buf) scratch.buf = Buffer.allocUnsafe(CHUNK_BYTES);
  let work = scratch.buf;
  let held = 0;
  let pos = start;
  let end = start;
  while (pos < size) {
    if (held >= work.length / 2) {
      const bigger = Buffer.allocUnsafe(work.length * 2);
      work.copy(bigger, 0, 0, held);
      work = scratch.buf = bigger;
    }
    const { bytesRead } = await handle.read(work, held, Math.min(work.length - held, size - pos), pos);
    if (bytesRead <= 0) break;
    pos += bytesRead;
    const filled = held + bytesRead;
    const lastNewline = work.lastIndexOf(NEWLINE, filled - 1);
    if (lastNewline === -1) {
      held = filled;
      continue;
    }
    scanLines(work.subarray(0, lastNewline), found);
    end = pos - (filled - (lastNewline + 1));
    held = filled - (lastNewline + 1);
    // The unfinished line moves to the front, for the next piece to complete.
    if (held > 0) work.copy(work, 0, lastNewline + 1, filled);
  }
  if (held > 0) scanLines(work.subarray(0, held), found);
  return { found, end };
}

/**
 * Read one transcript from where its mark says the last read stopped, after
 * checking it is the same file grown rather than a different one: the top of
 * the file and the bytes just before the old place must both be as they were.
 * A transcript rewritten in place (reopening a room trims old copies of the
 * house file out of it) fails that and is read again from the top.
 */
async function readTranscript(path: string, size: number, mtimeMs: number, mark: FileMark | undefined, scratch: Scratch): Promise<{ found: Found[]; mark: FileMark }> {
  const handle = await open(path, 'r');
  try {
    let start = 0;
    if (mark && size >= mark.offset) {
      const sameHead = (await hashRange(handle, 0, mark.headLen)) === mark.headHash;
      const sameTail = sameHead && (await hashRange(handle, mark.offset - mark.tailLen, mark.tailLen)) === mark.tailHash;
      if (sameHead && sameTail) start = mark.offset;
    }
    const { found, end } = await readFrom(handle, start, size, scratch);
    const headLen = Math.min(HEAD_BYTES, size);
    const tailLen = Math.min(TAIL_BYTES, end);
    return {
      found,
      mark: {
        size,
        mtimeMs,
        offset: end,
        headLen,
        headHash: await hashRange(handle, 0, headLen),
        tailLen,
        tailHash: await hashRange(handle, end - tailLen, tailLen),
      },
    };
  } finally {
    await handle.close();
  }
}

/**
 * Walk every lane's transcripts and hand over what each has added since the
 * mark the caller holds for it. Lanes are walked in name order and files in
 * name order, so when a resumed room carries copies of a squash, the copy met
 * first is always the same one.
 *
 * A transcript whose size and stamp match its mark is skipped without being
 * opened. One that changed is read from where it stopped and handed to
 * `onRead` with its new mark before the next file is opened, so only one
 * file's squashes are ever in hand at once. If `onRead` throws (the shelf could
 * not write), the walk stops there: the mark for that file was never stored,
 * so the next walk reads it again.
 */
export async function scanLaneTranscripts(
  marks: ReadonlyMap<string, FileMark>,
  onRead: (read: TranscriptRead) => void | Promise<void>,
  options: ScanOptions = {},
): Promise<LaneScan> {
  const projects = options.transcriptRoot ?? transcriptRoot();
  const lanes = options.lanesRoot ?? lanesRoot();
  const listedDirs = new Set<string>();
  const seen = new Set<string>();
  const scratch: Scratch = { buf: null };
  for (const lane of heartbeatLanes(lanes)) {
    const project = projectKeyForDir(join(lanes, lane));
    const dir = join(projects, project);
    let files: string[];
    try {
      files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
    } catch {
      continue;
    }
    listedDirs.add(dir);
    for (const file of files) {
      const path = join(dir, file);
      let read: { found: Found[]; mark: FileMark };
      try {
        const info = await stat(path);
        if (!info.isFile()) continue;
        seen.add(path);
        const mark = marks.get(path);
        if (mark && mark.size === info.size && mark.mtimeMs === info.mtimeMs) continue;
        read = await readTranscript(path, info.size, info.mtimeMs, mark, scratch);
      } catch {
        // Gone or unreadable mid-walk (the CLI deletes old transcripts); next time.
        continue;
      }
      const sessionId = file.replace(/\.jsonl$/, '');
      await onRead({
        path,
        events: read.found.map((f) => ({ sessionId, project, lane, ...f })),
        mark: read.mark,
      });
    }
  }
  const stale: string[] = [];
  for (const path of marks.keys()) {
    if (listedDirs.has(dirname(path)) && !seen.has(path)) stale.push(path);
  }
  return { stale };
}

/** Keep marks in memory, for a caller with no shelf: what a read handed over, and what the walk found gone. */
export function applyRead(marks: Map<string, FileMark>, read: TranscriptRead): void {
  marks.set(read.path, read.mark);
}

export function forgetStale(marks: Map<string, FileMark>, scan: LaneScan): void {
  for (const path of scan.stale) marks.delete(path);
}
