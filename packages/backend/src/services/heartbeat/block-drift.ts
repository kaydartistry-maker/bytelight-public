// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * What the walls say now, against what the room was opened with.
 *
 * A lane's CLAUDE.md is injected once, at session start, as one attachment
 * record — and a compaction REPLAYS that same copy rather than re-reading it.
 * Measured Sep 20 2026 on two rooms: the injection after the squash is byte for
 * byte identical to the one at the top, ten and a half hours apart, same sha.
 *
 * So a block edited mid-room never reaches the room it was edited from. We
 * write to the database, the database is right, and the window carries on
 * quoting a wall from this morning. That is why this exists: a lane should not
 * be left trying to come back from a compaction holding a stale copy.
 *
 * THE BASELINE CANNOT BE THE FILE. data/heartbeat/<lane>/CLAUDE.md looks like
 * the injected copy and is not: the backend regenerates it, and it was caught
 * doing so thirty seconds after a thin — already carrying the trimmed wall. A
 * baseline that follows the thing it measures can never disagree with it, so
 * that version reported zero drift on a 7,983-character cut and would have
 * gone on reporting zero forever. Found by asking whether it catches trims,
 * not by a test.
 *
 * So the baseline is taken at LAUNCH and kept: io/.block-baseline.json, one
 * hash per block, written beside the session id by the same hand that mints
 * it. Hashes rather than text because the live content comes from the
 * database anyway — all this file has to answer is WHETHER a wall moved.
 */

import { createHash } from 'node:crypto';

/** The lane file this is written beside, next to .session-id. */
export const BASELINE_FILE = '.block-baseline.json';

export function hashBlock(content: string): string {
  return createHash('sha256').update((content || '').trim()).digest('hex').slice(0, 16);
}

/** Taken at launch, from whatever blocks the lane is about to be handed. */
export function baselineFrom(
  live: { scope: string; label: string; content: string }[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of live) out[`${b.scope}/${b.label}`] = hashBlock(b.content);
  return out;
}

/**
 * Drift against a hash baseline.
 *
 * An ABSENT or unreadable baseline returns nothing rather than everything: a
 * compaction with no baseline to compare against is the behaviour we had
 * before any of this, and handing back all eleven walls because a file was
 * missing would refill the room it is meant to repair.
 */
export function driftAgainstBaseline(
  baseline: Record<string, string> | null,
  live: { scope: string; label: string; content: string }[],
): { changed: DriftBlock[]; removed: string[] } {
  if (!baseline || Object.keys(baseline).length === 0) return { changed: [], removed: [] };
  const changed: DriftBlock[] = [];
  const seen = new Set<string>();
  for (const b of live) {
    const key = `${b.scope}/${b.label}`;
    seen.add(key);
    const before = baseline[key];
    const now = (b.content || '').trim();
    if (before === undefined) {
      if (now) changed.push({ scope: b.scope, label: b.label, content: now });
      continue;
    }
    if (before !== hashBlock(now)) changed.push({ scope: b.scope, label: b.label, content: now });
  }
  const removed = Object.keys(baseline).filter((k) => !seen.has(k));
  return { changed, removed };
}

export interface DriftBlock {
  scope: string;
  label: string;
  content: string;
}

/**
 * The most the after-compaction hook may hand a room, the note included.
 *
 * Claude Code caps a hook's additionalContext at 10,000 characters. Past that it
 * saves the text to a file and gives the room a path and a short preview, so a
 * bigger repair would not arrive as text. Past this budget the room gets the
 * LIST and a file to read instead. A compaction is already a full room as well;
 * the repair must not be the thing that fills it again.
 */
export const DRIFT_TEXT_BUDGET = 9_000;

/** Kept back from the budget for hooks/compacted.cjs's own note. */
export const COMPACT_NOTE_MAX_CHARS = 300;

/** The lane io file holding the live walls when they are too big to hand back. */
export const LIVE_WALLS_FILE = 'walls-moved.md';

const HEADER = /^## \[([^\]]+)\]\s+(.+?)\s*$/;

/**
 * Pull the blocks back out of an injected CLAUDE.md.
 *
 * Only what sits inside <core-memory>. A `## [x] y` heading anywhere else in
 * that file is prose about the format rather than a block, and this file is
 * full of prose about the format.
 */
export function parseInjectedBlocks(claudeMd: string): Map<string, string> {
  const out = new Map<string, string>();
  const open = claudeMd.indexOf('<core-memory>');
  if (open === -1) return out;
  const close = claudeMd.indexOf('</core-memory>', open);
  const body = claudeMd.slice(open + '<core-memory>'.length, close === -1 ? undefined : close);

  let key: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (key) out.set(key, buf.join('\n').trim());
    buf = [];
  };
  for (const line of body.split('\n')) {
    const m = HEADER.exec(line);
    if (m) {
      flush();
      key = `${m[1]}/${m[2]}`;
      continue;
    }
    if (!key) continue;
    // The renderer puts the description in an HTML comment under the header.
    if (buf.length === 0 && /^<!--.*-->$/.test(line.trim())) continue;
    buf.push(line);
  }
  flush();
  return out;
}

/**
 * Blocks whose live text no longer matches what the room was opened with.
 *
 * Compared on TRIMMED text, because the renderer pads every block with a blank
 * line and a diff on whitespace would report the whole wall as drifted on the
 * first compaction of every room.
 *
 * A block the room never had is drift too — it was written during the session
 * and the window has never seen it.
 */
export function blockDrift(
  injected: Map<string, string>,
  live: { scope: string; label: string; content: string }[],
): { changed: DriftBlock[]; removed: string[] } {
  const changed: DriftBlock[] = [];
  const seen = new Set<string>();
  for (const b of live) {
    const key = `${b.scope}/${b.label}`;
    seen.add(key);
    const before = injected.get(key);
    const now = (b.content || '').trim();
    if (before === undefined) {
      // Only report a genuinely new block; an empty one is not news.
      if (now) changed.push({ scope: b.scope, label: b.label, content: now });
      continue;
    }
    if (before !== now) changed.push({ scope: b.scope, label: b.label, content: now });
  }
  const removed = [...injected.keys()].filter((k) => !seen.has(k));
  return { changed, removed };
}

function blockText(changed: DriftBlock[]): string {
  return changed.map((b) => `## [${b.scope}] ${b.label}\n${b.content}`).join('\n\n');
}

function movedLine(changed: DriftBlock[], removed: string[]): string {
  const names = changed.map((b) => `${b.scope}/${b.label}`).join(', ');
  return (
    `[WALLS MOVED SINCE THIS ROOM OPENED]${names ? ` Moved: ${names}.` : ''}` +
    `${removed.length ? ` Deleted since: ${removed.join(', ')}.` : ''}`
  );
}

function inlineDrift(changed: DriftBlock[], removed: string[]): string {
  const stale =
    ' The core-memory copy above was injected at session start and a compaction replays it ' +
    'rather than re-reading it, so it is stale.';
  if (changed.length === 0) return movedLine(changed, removed) + stale;
  return `${movedLine(changed, removed)}${stale} These are the live versions and they replace what is above:\n\n${blockText(changed)}`;
}

/** Whether the live text can be handed back whole, leaving room for the note. */
export function driftFitsInline(changed: DriftBlock[], removed: string[] = []): boolean {
  return inlineDrift(changed, removed).length <= DRIFT_TEXT_BUDGET - COMPACT_NOTE_MAX_CHARS;
}

/** The whole live text, for the file a room reads when it cannot be handed back. */
export function liveWallsText(changed: DriftBlock[]): string {
  return `${blockText(changed)}\n`;
}

/**
 * The text handed back into the lane, moved names first. Empty string when
 * nothing moved: the caller appends nothing rather than announcing that nothing
 * happened. liveFile is where the caller put the live text when it would not
 * fit. The lane's CLAUDE.md is no use for that: at this size a plain Read of it
 * hits the token cap (see INITIAL_PROMPT in supervisor.ts).
 */
export function renderDrift(changed: DriftBlock[], removed: string[] = [], liveFile?: string): string {
  if (changed.length === 0 && removed.length === 0) return '';
  if (driftFitsInline(changed, removed)) return inlineDrift(changed, removed);

  const total = changed.reduce((n, b) => n + b.content.length, 0);
  const scopes = [...new Set(changed.map((b) => b.scope))];
  const howToRead = liveFile
    ? `The live text is in ${liveFile}. Read it with offset and limit, a page at a time, because it can be too big to Read in one go.`
    : `Save the live text to a file with \`node tools/sc.mjs memory view ${scopes.join('` and `node tools/sc.mjs memory view ')}\` from the project root, and read it a page at a time.`;
  return (
    `${movedLine(changed, removed)} The copy above is the one this session started with and it is ` +
    `stale for those blocks. Too much has changed to restate here (${total.toLocaleString()} ` +
    `characters). ${howToRead} Do not rely on the copy above for those blocks until you have.`
  );
}
