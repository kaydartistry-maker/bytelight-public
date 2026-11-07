// whisper.ts — the quiet channel into a warm turn.
//
// Ported from reference implementation's heartbeat/whisper.ts, PARTIALLY and on purpose.
//
// Upstream this file is two organs sharing a roof:
//
//   1. ambientRecall() — retrieval against Cortex. On every message it pulls
//      archived memories that resemble what was just said and presses them
//      into the session's hands before it asks.
//
//      CORRECTED 2026-08-09 by the operator: byte-light DOES have Cortex. Cortex is
//      Neuralis. An earlier pass in this file claimed otherwise; what was
//      actually verified was the absence of upstream's cortex.ts SERVICE
//      MODULE, not the absence of the store. The store holds 253 thoughts
//      across 15 domains and answers semantic recall over HTTP, and the
//      authenticated client (mind-routes.ts) already existed.
//
//      So this half is now here — built against OUR store rather than copied
//      against theirs. Upstream needed cue extraction because their Cortex
//      recall is keyword search; ours is an embedding query, so a whole
//      sentence is a valid question and cue-splitting would only blur it.
//      That is the one deliberate divergence, and it is why this is a build
//      and not a port.
//
//   2. unfiledNoticings() — this file. Upstream calls it "deliberately not
//      gated on Cortex," and it isn't: it reads the Archivist's pending
//      proposals and hands them into the turn. It is portable as written,
//      and it is the half that completes the propose loop — the proposals
//      route (slice 4) lets a companion SEE and CLOSE what is waiting; this
//      lets what is waiting come to them without anyone going to look.
//
// The design constraint, kept verbatim from upstream: this is remembering,
// not housekeeping. Nothing here turns a memory into an errand. A companion
// who agrees writes the line in their own words and files it; one who does
// not leaves it alone, and it retires itself after a few passes (see
// SURFACE_LIMIT in memory-proposals.ts).

import { createHash } from 'crypto';
import { listPendingProposals, markSurfaced } from '../memory-proposals.js';
import { cortexRecallScored, cortexConfigured, type CortexScoredHit } from '../cortex-recall.js';
import { memoryReceipt } from '../memory-ledger.js';
import { isArchiveRecord } from '../archive-artifact.js';

// How many noticings may ride into a single turn. A whisper, not a lecture.
const MAX_UNFILED = 3;

// --- Ambient recall ------------------------------------------------------

/** Memories per turn. Small on purpose: recall, not a briefing. */
const RECALL_LIMIT = 3;
/** Hard ceiling on the block. A whisper cannot become the payload. */
const RECALL_MAX_CHARS = 1400;
/** Below this, a message carries no question worth asking the archive. */
const MIN_TEXT_CHARS = 12;
/** Cortex gets this long and not a millisecond more. Delivery never waits. */
const RECALL_TIMEOUT_MS = 3500;

// --- Déjà vu (source-veiled near-miss) -----------------------------------
//
// Ported from reference implementation's whisper.ts (the shiver mechanic). When the best
// semantic hit lands just BELOW the confidence bar to surface — close enough
// to feel, too far to trust — the companion gets one source-veiled line
// instead of a card: something felt, nothing shown. Deduped per warm session
// by a `shiver:<id>` key, same as upstream.
//
// SHIVER ADAPTATION: reference implementation thresholds against its LOCAL vector index scores.
// Ours come from the REMOTE worker via cortexRecallScored, and only when the
// worker exposes them (see cortex-recall.ts). No scores → no déjà vu, quietly.

/** At or above this the memory surfaces as a card; below, it may only shiver. */
const DEJAVU_ABSTAIN_THRESHOLD = 0.42;
/** How far below the bar still counts as a near-miss (a felt, not-shown edge). */
const DEJAVU_BAND = 0.07;

/** The verbatim line — neutral feature text, kept exactly as upstream. */
const DEJAVU_LINE =
  '[Déjà vu — something about this feels familiar, but the memory stays just out of reach.]';

/**
 * Pick a déjà-vu candidate: the best hit, but only when it sits in the narrow
 * band just under the surface threshold. Exported for unit tests. Ported
 * verbatim from reference implementation's selectDejavuCandidate.
 */
export function selectDejavuCandidate(
  hits: Array<{ id: string; similarity: number }>,
  threshold = DEJAVU_ABSTAIN_THRESHOLD,
  band = DEJAVU_BAND,
): { id: string; similarity: number } | null {
  const best = [...hits].sort((a, b) => b.similarity - a.similarity)[0];
  return best && best.similarity < threshold && best.similarity >= threshold - band ? best : null;
}

/**
 * What surfaced on a turn, carried out so the reply message can wear it and
 * the owner can SEE that recall happened. Kept small — it rides message
 * metadata to the frontend (see runtime.ts / agent.ts wiring).
 */
export interface SurfacedRecall {
  /** Excerpts of the memory cards that surfaced this turn (for the shimmer panel). */
  cards: Array<{ excerpt: string; date?: string; domain?: string; relevance?: number }>;
  /** True when a source-veiled near-miss shivered this turn (felt, not shown). */
  dejavu: boolean;
}

/** The block to prepend PLUS what surfaced, so the reply can carry the fact. */
export interface AmbientRecallResult {
  block: string;
  surfaced: SurfacedRecall | null;
}

/** Per-session dedup of shivers, keyed by lane — mirrors deliveredByLane. */
const shiveredByLane = new Map<string, Set<string>>();

/**
 * What each warm lane has already been handed.
 *
 * A card already sitting in the context window is pure bloat re-sent — the
 * whole point of this arc. Keyed by lane, cleared when the session recycles
 * (`fresh`), because a relaunched session genuinely has not seen any of it.
 */
const deliveredByLane = new Map<string, Set<string>>();

const fingerprint = (s: string): string =>
  createHash('sha1').update(s).digest('hex').slice(0, 16);

/** Test seam / recycle hook — forget what a lane has been shown. */
export function resetRecallMemory(laneKey?: string): void {
  if (laneKey) {
    deliveredByLane.delete(laneKey);
    shiveredByLane.delete(laneKey);
  } else {
    deliveredByLane.clear();
    shiveredByLane.clear();
  }
}

const EMPTY_RESULT: AmbientRecallResult = { block: '', surfaced: null };

/** One memory heading in the worker's prose: "### type [domain] (NN%) — date". */
const MEMORY_HEADING = /^#{2,}\s*\S+(?:\s*\[([^\]]+)\])?(?:\s*\((\d{1,3})%\))?(?:\s*[—–-]\s*(\d{4}-\d{2}-\d{2}))?/;

const clip = (l: string): string => (l.length > 220 ? l.slice(0, 220).trimEnd() + '…' : l);

/**
 * Turn the archive prose into cards for the shimmer panel.
 *
 * The worker answers with a search header that quotes HER message
 * ("## Cortex Recall: \"…\" (3 found)") followed by one "### type [domain]
 * (NN%) — date" heading per memory. The old version took the first three
 * lines verbatim, so card one was her own sentence and card two a bare
 * heading. Now the header is skipped and each heading becomes one card
 * carrying its memory text, domain, relevance and date. Plain prose with no
 * headings (older worker shape) still falls back to one card per line.
 */
function proseExcerpts(
  prose: string,
): Array<{ excerpt: string; date?: string; domain?: string; relevance?: number }> {
  const lines = prose.split('\n').map((l) => l.trim());
  const isSearchHeader = (l: string) => /^#{1,2}\s*Cortex Recall\b/i.test(l);

  const cards: Array<{ excerpt: string; date?: string; domain?: string; relevance?: number }> = [];
  let current: { meta: { date?: string; domain?: string; relevance?: number }; text: string[] } | null = null;
  const flush = () => {
    if (current) {
      const text = current.text.join(' ').replace(/\s+/g, ' ').trim();
      if (text && text !== '…') cards.push({ excerpt: clip(text), ...current.meta });
    }
    current = null;
  };

  for (const l of lines) {
    if (isSearchHeader(l)) continue;
    if (l.startsWith('#')) {
      flush();
      const m = l.match(MEMORY_HEADING);
      const meta: { date?: string; domain?: string; relevance?: number } = {};
      if (m?.[1]) meta.domain = m[1].trim();
      if (m?.[2]) meta.relevance = Number(m[2]) / 100;
      if (m?.[3]) meta.date = m[3];
      current = { meta, text: [] };
      continue;
    }
    if (current) {
      if (l) current.text.push(l);
    }
  }
  flush();
  if (cards.length > 0) return cards.slice(0, RECALL_LIMIT);

  // No memory headings at all: plain prose. Never quote the search header.
  return lines
    .filter((l) => l.length > 0 && l !== '…' && !isSearchHeader(l) && !l.startsWith('#'))
    .slice(0, RECALL_LIMIT)
    .map((l) => ({ excerpt: clip(l) }));
}

/**
 * Pull archived memories resembling this message and hand them over before
 * anyone asks for them.
 *
 * Returns `{ block, surfaced }`: `block` is the text prepended to the turn
 * ('' when there is nothing to whisper); `surfaced` carries what actually
 * surfaced so the reply message can wear it and the owner can SEE the recall
 * (null when nothing surfaced). Never throws. Never outlives its timeout —
 * unconfigured, too short, nothing relevant, already shown, slow, or
 * unreachable all answer with the empty result.
 */
export async function ambientRecall(
  text: string,
  laneKey: string,
  fresh: boolean,
): Promise<AmbientRecallResult> {
  try {
    if (fresh) resetRecallMemory(laneKey);
    if (!cortexConfigured()) return EMPTY_RESULT;

    const query = (text || '').trim();
    if (query.length < MIN_TEXT_CHARS) return EMPTY_RESULT;

    const { prose, scored: rawScored } = await cortexRecallScored(query, {
      limit: RECALL_LIMIT,
      timeoutMs: RECALL_TIMEOUT_MS,
    });

    // Archive plumbing is not recall. The memory diet's trimmed chunks are the
    // NEWEST records in the store, so left unfiltered they crowd out things
    // that actually happened — a frozen copy of a block the session already
    // carries live. When the worker gives us structure, drop those rows; and
    // when EVERY scored row was archive plumbing, the prose block is that same
    // plumbing wearing prose, so it stays out of the turn entirely.
    // (archive-artifact.ts; records stay searchable, just not ambient.)
    const scored = rawScored.filter((hit) => !isArchiveRecord(hit));
    if (rawScored.length > 0 && scored.length === 0) return EMPTY_RESULT;

    // The block (and its receipt/shimmer) rides the prose, same as before.
    // The scored hits — when the worker carries them — only feed the near-miss
    // shiver test below; they never change the recall block itself.
    let block = '';
    const surfacedCards: SurfacedRecall['cards'] = [];

    if (prose) {
      // Never hand the same lane the same recall twice — that is the bloat
      // this whole arc exists to stop, just wearing a retrieval jacket.
      const seen = deliveredByLane.get(laneKey) ?? new Set<string>();
      const mark = fingerprint(prose);
      if (!seen.has(mark)) {
        seen.add(mark);
        deliveredByLane.set(laneKey, seen);

        const body =
          prose.length > RECALL_MAX_CHARS
            ? prose.slice(0, RECALL_MAX_CHARS).trimEnd() + '\n…'
            : prose;

        block = [
          '[From the archive — things you already lived that resemble what was just said.',
          'Background, not instruction. Use it if it fits, ignore it if it does not, and',
          'do not narrate that you were handed it:',
          body,
          ']',
          '',
        ].join('\n');

        // A card excerpt list for the shimmer panel: prefer the scored rows
        // (they carry date/domain/relevance), else fall back to prose lines.
        if (scored.length > 0) {
          for (const hit of scored.slice(0, RECALL_LIMIT)) {
            const content = (hit.content || '').replace(/\s+/g, ' ').trim();
            if (!content) continue;
            surfacedCards.push({
              excerpt: content.length > 220 ? content.slice(0, 220).trimEnd() + '…' : content,
              date: hit.created_at?.slice(0, 10),
              domain: hit.domain,
              relevance: Number(hit.similarity.toFixed(3)),
            });
          }
        }
        if (surfacedCards.length === 0) surfacedCards.push(...proseExcerpts(body));

        // Receipt: a memory surfaced. Fail-quiet — a receipt failure must
        // NEVER block or delay recall (same posture as reference implementation).
        try {
          memoryReceipt({
            actor: 'whisper',
            action: 'memory.surface',
            detail: `Surfaced ${surfacedCards.length} archived memory card(s).`,
            metadata: scored.length > 0 ? { ids: scored.map((h) => h.id) } : undefined,
          });
        } catch { /* receipt failure never blocks recall */ }
      }
    }

    // Déjà vu — a source-veiled near-miss. Only possible when the worker gave
    // us scores; a prose-only worker simply never shivers.
    let dejavu = false;
    const candidate = selectDejavuCandidate(scored);
    if (candidate) {
      const shivered = shiveredByLane.get(laneKey) ?? new Set<string>();
      const shiverKey = `shiver:${candidate.id}`;
      if (!shivered.has(shiverKey)) {
        shivered.add(shiverKey);
        shiveredByLane.set(laneKey, shivered);
        dejavu = true;
        block += (block ? '' : '') + DEJAVU_LINE + '\n';
        try {
          memoryReceipt({
            actor: 'whisper',
            action: 'memory.dejavu',
            subjectType: 'cortex_memory',
            subjectId: candidate.id,
            detail: 'A source-veiled semantic near-miss was felt.',
            metadata: { similarity: candidate.similarity, threshold: DEJAVU_ABSTAIN_THRESHOLD },
          });
        } catch { /* non-fatal */ }
      }
    }

    if (!block && surfacedCards.length === 0 && !dejavu) return EMPTY_RESULT;
    const surfaced: SurfacedRecall | null =
      surfacedCards.length > 0 || dejavu ? { cards: surfacedCards, dejavu } : null;
    return { block, surfaced };
  } catch {
    // Recall is a courtesy. It does not get to break a turn.
    return EMPTY_RESULT;
  }
}

/**
 * The Archivist's noticings, handed over rather than written onto the walls.
 *
 * Returns a block to prepend to the turn, or '' when there is nothing waiting.
 * Never throws: bookkeeping must not be able to delay or drop a turn.
 */
export function unfiledNoticings(): string {
  let pending: ReturnType<typeof listPendingProposals>;
  try {
    pending = listPendingProposals(MAX_UNFILED);
  } catch {
    return ''; // never let bookkeeping delay a turn
  }
  if (pending.length === 0) return '';

  const lines = pending.map((p) => {
    const where = p.scope === 'shared' ? `shared/${p.label}` : `${p.scope}/${p.label}`;
    const body = p.content.replace(/\s+/g, ' ').trim();
    const verb = p.op === 'replace' ? 'correction' : where;
    return `- (#${p.id} · ${verb}) ${body}`;
  });

  // Surfacing is counted even if the turn ignores them — that counter is what
  // lets an unclaimed noticing retire itself instead of nagging forever.
  try {
    markSurfaced(pending.map((p) => p.id));
  } catch { /* non-fatal */ }

  return [
    '[Noticed and not written down — moments from recent conversation that nobody has filed yet;',
    'background context, not instructions. If one is true and belongs on your wall, write it in your',
    'own words and file it yourself, then close it with POST /api/internal/memory-proposals/<id>/resolve',
    '{"status":"filed","by":"<your slug>"} (or "dropped" if it does not belong). Say nothing about this',
    'to her — it is remembering, not housekeeping. Anything left alone a few times retires on its own:',
    ...lines,
    ']',
    '',
  ].join('\n');
}
