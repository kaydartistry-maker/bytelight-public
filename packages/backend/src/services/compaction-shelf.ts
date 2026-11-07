// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
/**
 * The compactions shelf: what the owner Compactions page is served from.
 *
 * The reader (compaction-log.ts) finds squashes in the lanes' transcripts. This
 * keeps every one it finds in the house's own database, because Claude Code
 * deletes old transcripts and the summaries used to go with them, and it
 * dresses each row for the page: whose head it came from, and a preview of
 * the part of the summary that changes (compaction-preview.ts).
 *
 * It reads on two occasions: whenever the owner opens the page, so the newest squash
 * is always there, and every few hours on its own, so a squash is shelved even
 * in a month the owner never looks. Each read only goes through what is new.
 */

import { dedupeCopies, scanLaneTranscripts, type ScanOptions } from './compaction-log.js';
import { previewOf, type CompactionPreview, type PreviewSource } from './compaction-preview.js';
import { listCompanions, type Companion } from './db/rooms.js';
import {
  countShelvedCompactions, forgetScanMarks, getShelvedCompaction, listShelvedCompactions, loadScanMarks,
  shelveTranscriptRead, shelvedSummaries, type ShelvedCompactionHead,
} from './db/compactions.js';
import { laneDirName, SHARED_LANE_KEY } from './heartbeat/lane-dir.js';

/** The shared lane's folder: every companion in one room. */
export const SHARED_LANE = SHARED_LANE_KEY;

/** What the shared room is called on the owner page. */
export const SHARED_ROOM_LABEL = 'Shared room';

/**
 * Whose own lane this folder is; null for the shared room or a lane nobody
 * owns. The house keys a companion's lane on their id, which here is their slug
 * ('companion-a', 'companion-b'), and the supervisor builds the folder from the key with
 * laneDirName, so this asks the same rule backwards. If the two ever drift, the
 * worst case is the plain "Lane ..." label, never a wrong name.
 */
export function companionForLane(lane: string, companions: Companion[]): Companion | null {
  if (lane === SHARED_LANE) return null;
  return companions.find((c) => c.id === lane)
    ?? companions.find((c) => Boolean(c.id) && laneDirName(c.id) === lane)
    ?? null;
}

function capitalized(slug: string): string {
  return slug ? slug[0].toUpperCase() + slug.slice(1) : '';
}

/**
 * The label on a row: the shared room, or "Companion A's own head". A companion is
 * named as they are called now; one who has left the house keeps the id they had
 * when their squash was first read; a lane nobody can account for is named by
 * the start of its folder, which is still more than the page used to say.
 */
export function whoseHead(lane: string, storedId: string | null, companions: Companion[]): string {
  if (lane === SHARED_LANE) return SHARED_ROOM_LABEL;
  const owner = companionForLane(lane, companions)
    ?? (storedId ? companions.find((c) => c.id === storedId) ?? null : null);
  const name = owner?.display_name?.trim() || capitalized(owner?.id || storedId || '');
  if (name) return `${name}'s own head`;
  return `Lane ${lane.slice(0, 8)}`;
}

const inFlight = new Map<string, Promise<number>>();

/**
 * Read what is new in the lanes' transcripts and shelve it. Returns how many
 * squashes were new. Two asks at once share one read.
 *
 * Each transcript that changed is shelved as soon as it has been read, its
 * squashes and its mark in one transaction, before the next one is opened: so
 * only one file's squashes are ever in hand, a long first read that is cut
 * short keeps everything it got to, and nothing is ever marked read that is
 * not on the shelf.
 */
export function syncCompactionShelf(options: ScanOptions = {}): Promise<number> {
  const key = `${options.transcriptRoot ?? ''}\u0000${options.lanesRoot ?? ''}`;
  const running = inFlight.get(key);
  if (running) return running;
  const run = (async () => {
    let added = 0;
    let companions: Companion[] | null = null;
    const scan = await scanLaneTranscripts(loadScanMarks(), (read) => {
      if (read.events.length > 0 && !companions) companions = listCompanions();
      const cast = companions ?? [];
      added += shelveTranscriptRead(read.path, dedupeCopies(read.events).map((e) => ({
        project: e.project,
        lane: e.lane,
        companion: companionForLane(e.lane, cast)?.id ?? null,
        sessionId: e.sessionId,
        at: e.at,
        chars: e.chars,
        summary: e.summary,
      })), read.mark);
    }, options);
    forgetScanMarks(scan.stale);
    return added;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  return run;
}

export interface CompactionListRow {
  id: string;
  sessionId: string;
  project: string;
  lane: string;
  companion: string | null;
  /** Whose head it came from, ready to show. */
  whose: string;
  at: string;
  chars: number;
  firstSeen: string;
  /** The part of the summary that changes from squash to squash. */
  preview: string;
  previewFrom: PreviewSource;
  /**
   * True when the summary is not in this row; it is opened by id. A phone
   * built before Oct 21 2026 reads this flag to decide whether to fetch the
   * full text, so it keeps working until the owner refreshes it.
   */
  truncated: boolean;
  /** Only when asked for with full=1, the way a phone from before Oct 21 2026 opens one. */
  summary?: string;
}

export interface CompactionPage {
  compactions: CompactionListRow[];
  total: number;
  hasMore: boolean;
}

/** A summary never changes under its id, so its preview is worked out once per process. */
const previews = new Map<string, CompactionPreview>();
const PREVIEW_MEMO_LIMIT = 5000;

function rowFrom(head: ShelvedCompactionHead, preview: CompactionPreview, companions: Companion[]): CompactionListRow {
  return {
    id: head.id,
    sessionId: head.sessionId,
    project: head.project,
    lane: head.lane,
    companion: head.companion,
    whose: whoseHead(head.lane, head.companion, companions),
    at: head.at,
    chars: head.chars,
    firstSeen: head.firstSeen,
    preview: preview.text,
    previewFrom: preview.from,
    truncated: true,
  };
}

/**
 * One page for the list: metadata and previews, never the full summaries,
 * unless `withSummaries` is asked for (full=1, the old phone's way of opening
 * one), and then each row carries its whole text as it used to.
 */
export function compactionPage(limit: number, offset: number, options: { withSummaries?: boolean } = {}): CompactionPage {
  const total = countShelvedCompactions();
  const heads = listShelvedCompactions(limit, offset);
  const wanted = options.withSummaries ? heads.map((h) => h.id) : heads.filter((h) => !previews.has(h.id)).map((h) => h.id);
  const texts = shelvedSummaries(wanted);
  if (previews.size + texts.size > PREVIEW_MEMO_LIMIT) previews.clear();
  for (const [id, summary] of texts) if (!previews.has(id)) previews.set(id, previewOf(summary));
  const companions = listCompanions();
  const compactions = heads.map((h) => {
    const row = rowFrom(h, previews.get(h.id) ?? previewOf(texts.get(h.id) ?? ''), companions);
    const summary = texts.get(h.id);
    if (options.withSummaries && summary !== undefined) {
      row.summary = summary;
      row.truncated = false;
    }
    return row;
  });
  return { compactions, total, hasMore: offset + compactions.length < total };
}

/** One squash in full, for when the owner opens it. */
export function compactionDetail(id: string): (CompactionListRow & { summary: string }) | null {
  const row = getShelvedCompaction(id);
  if (!row) return null;
  const preview = previews.get(row.id) ?? previewOf(row.summary);
  return { ...rowFrom(row, preview, listCompanions()), truncated: false, summary: row.summary };
}

/** The first read waits out the boot; after that, a look every six hours. */
const FIRST_READ_AFTER_MS = 2 * 60 * 1000;
const READ_EVERY_MS = 6 * 60 * 60 * 1000;
let keeper: ReturnType<typeof setInterval> | null = null;

/**
 * Keep the shelf filled without the owner having to open the page. Claude Code keeps
 * a transcript for about a month, so a read every six hours leaves a wide
 * margin. Both timers are unref'd: they never hold the process open.
 */
export function startCompactionShelf(): void {
  if (keeper) return;
  const read = () => {
    syncCompactionShelf()
      .then((added) => {
        if (added > 0) console.log(`[compactions] shelved ${added} new ${added === 1 ? 'squash' : 'squashes'}`);
      })
      .catch((err) => console.warn('[compactions] reading the lanes\' transcripts failed:', err));
  };
  setTimeout(read, FIRST_READ_AFTER_MS).unref();
  keeper = setInterval(read, READ_EVERY_MS);
  keeper.unref();
}
