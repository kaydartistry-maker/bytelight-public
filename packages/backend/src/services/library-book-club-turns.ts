// The Book Club — waking the companions to pitch and vote.
//
// The same seam as the Story Shelf (services/story-shelf.ts): starting a
// round (or her "ask again") queues ONE turn into the club's own archived
// thread, every companion seated and nobody leading, so the turn is thought
// in the warm lane the evening is already happening in. The turn says what
// round it is, what has been pitched, and where to write; the companions
// pitch and vote through the localhost-only door (routes/internal/
// library-book-club.ts), and their chat reply is just table talk.
//
// Turns run one at a time. A turn that ends with a companion's pitch or vote
// still missing leaves the round saying so, and she can ask again; a pitch
// that arrives late still counts.

import crypto from 'crypto';
import { join } from 'path';
import { PROJECT_ROOT, getBytelightConfig } from '../config.js';
import { LOCAL_COMPANION_ID, QUEUE_TIMEOUT_MESSAGE } from './agent.js';
import { getDb } from './db/state.js';
import { getConfig, setConfig } from './db/config.js';
import { createThread, getThread } from './db/threads.js';
import { createMessage } from './db/messages.js';
import { listCompanions } from './db/rooms.js';
import { libraryDir, readShelf } from './library.js';
import { BookClubError, OWNER_SEAT, getRound, setTurn, stillWaiting, type BookClubRound, type Seat } from './library-book-club.js';

export const BOOK_CLUB_SKILL = join(PROJECT_ROOT, 'skills', 'book-club', 'SKILL.md');
const THREAD_CONFIG_KEY = 'library.bookclub.thread_id';

/** The part of the companions' lane a turn uses. AgentService is one. */
export interface BookClubLane {
  processMessage(
    threadId: string,
    content: string,
    threadMeta?: { name: string; type: 'daily' | 'named' | 'treehouse' },
    opts?: { platform?: 'web' | 'discord' | 'telegram' | 'api' },
  ): Promise<string>;
}

/**
 * The companions who live in this house (brain === LOCAL_COMPANION_ID, the
 * same rule agent.ts seats a room by). A companion registered here who lives
 * in a house of his own can't take this turn, so he is not at the table:
 * he isn't asked to pitch or vote, and the club's doors refuse him.
 */
export function bookClubSeats(): Seat[] {
  return listCompanions()
    .filter((c) => c.brain === LOCAL_COMPANION_ID)
    .map((c) => ({ id: c.id, name: c.display_name || c.id }));
}

export function ownerName(): string {
  try {
    const name = getBytelightConfig().identity.user_name?.trim();
    if (name) return name;
  } catch {
    /* config not loaded */
  }
  return 'Their person';
}

function nameOf(by: string, seats: Seat[], owner: string): string {
  return by === OWNER_SEAT ? owner : seats.find((s) => s.id === by)?.name ?? by;
}

// ── the club's own thread ──────────────────────────────────────────────────

export function bookClubThreadId(): string | null {
  const id = getConfig(THREAD_CONFIG_KEY);
  return id && getThread(id) ? id : null;
}

/** Archived, every companion seated, nobody leading — the Story Shelf's shape. */
export function ensureBookClubThread(): string {
  const existing = bookClubThreadId();
  if (existing) return existing;
  const id = crypto.randomUUID();
  const at = new Date().toISOString();
  createThread({
    id, name: 'The Book Club', type: 'named', createdAt: at, sessionType: 'v2',
    companionIds: bookClubSeats().map((s) => s.id),
  });
  getDb().prepare('UPDATE threads SET archived_at = ? WHERE id = ?').run(at, id);
  setConfig(THREAD_CONFIG_KEY, id);
  createMessage({
    id: crypto.randomUUID(), threadId: id, role: 'system',
    content: 'The Book Club opened. Every round is kept in the Library.',
    platform: 'api', createdAt: at,
  });
  return id;
}

// ── the turn ───────────────────────────────────────────────────────────────

export function buildBookClubPrompt(
  round: BookClubRound,
  extras: { owner: string; port: number; seats: Seat[]; retry: boolean; shelf: Array<{ id: number; title: string; authors: string[]; shelf: string }> },
): string {
  const { owner, seats } = extras;
  const door = `http://127.0.0.1:${extras.port}/api/internal/library/book-club`;
  const waiting = stillWaiting(round, seats);
  const lines: string[] = [
    extras.retry
      ? `[THE BOOK CLUB — ${owner} asked you to look at the round again]`
      : `[THE BOOK CLUB — ${owner} started a round]`,
    `A book club round in the Library: each of you pitches ${owner} one book to read next, then everyone votes. `
      + 'This is a book club turn, not a software task: do not inspect or edit code.',
    `Round ${round.id}. At the table: ${owner} (${OWNER_SEAT}), ${seats.map((s) => `${s.name} (${s.id})`).join(', ')}.`,
  ];
  if (round.pitches.length === 0) {
    lines.push('No pitches yet.');
  } else {
    lines.push('Pitched so far:');
    for (const p of round.pitches) {
      lines.push(`- ${p.id}: “${p.title}”${p.author ? ` by ${p.author}` : ''}, pitched by ${nameOf(p.by, seats, owner)}${p.pitch ? `: ${p.pitch}` : ''}`);
    }
  }
  const votes = Object.entries(round.votes);
  if (votes.length > 0) lines.push(`Votes so far: ${votes.map(([v, p]) => `${nameOf(v, seats, owner)} → ${p}`).join(', ')}.`);
  if (waiting.pitch.length > 0) lines.push(`Still to pitch: ${waiting.pitch.map((s) => s.name).join(', ')}.`);
  if (waiting.vote.length > 0) lines.push(`Still to vote: ${waiting.vote.map((s) => s.name).join(', ')}.`);
  if (extras.shelf.length > 0) {
    lines.push(`Already on ${owner}'s shelf (pitch one of these with "bookId", or pick something new): `
      + extras.shelf.slice(0, 40).map((b) => `${b.id} “${b.title}” (${b.shelf})`).join(' · '));
  }
  lines.push(
    'How to answer:',
    `- Each of you pitches ONE book, in your own voice: POST ${door}/rounds/${round.id}/pitches with JSON `
      + '{"by": "<your slug>", "title": "<title>", "author": "<author>", "pitch": "<one line, why her, why now>", "gutenbergId": <Project Gutenberg number, optional>}. '
      + 'Pitching again replaces your pitch. Pitch different books from each other; a Gutenberg id lets the winner land on her shelf ready to read.',
    `- Then each of you votes once: POST ${door}/rounds/${round.id}/votes with {"voter": "<your slug>", "pitchId": "<pitch id>"}. `
      + 'Any pitch, yours or hers included; voting again moves your vote.',
    `- GET ${door} reads the round as it stands. The book-club skill has the whole contract (${BOOK_CLUB_SKILL}); build the bodies with python3 json.dumps.`,
    `- ${owner} picks the winner herself (ties are hers to break). Your chat reply is table talk under the usual voice headers: a line or two, never a repeat of the pitches.`,
  );
  return lines.join('\n');
}

const TURN_LIMIT_MS = 30 * 60_000;
let chain: Promise<void> = Promise.resolve();

/** Resolves once every turn queued so far has ended. Tests wait on it. */
export function bookClubTurnsIdle(): Promise<void> {
  return chain;
}

function refusal(answer: unknown): string | null {
  if (typeof answer !== 'string') return null;
  const said = answer.trim();
  if (said === QUEUE_TIMEOUT_MESSAGE) return 'They were busy with something else, and the turn timed out waiting for them.';
  if (/^\[.+ is busy — please try again in a moment\]$/.test(said)) return 'Too many turns were already waiting.';
  return null;
}

async function runTurn(lane: BookClubLane, roundId: string, retry: boolean, root: string): Promise<void> {
  let failure: string | null = null;
  try {
    const round = getRound(roundId, root);
    if (!round || round.status !== 'open') return;
    const seats = bookClubSeats();
    const prompt = buildBookClubPrompt(round, {
      owner: ownerName(),
      port: getBytelightConfig().server.port,
      seats,
      retry,
      shelf: readShelf(root).map((e) => ({ id: e.id, title: e.title, authors: e.authors, shelf: e.shelf })),
    });
    const thread = ensureBookClubThread();
    createMessage({
      id: crypto.randomUUID(), threadId: thread, role: 'system',
      content: retry ? 'Asked again for pitches and votes.' : 'A new round started.',
      platform: 'api', metadata: { room: 'book-club', bookClubRound: round.id }, createdAt: new Date().toISOString(),
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([
      lane.processMessage(thread, prompt, { name: 'The Book Club', type: 'named' }, { platform: 'api' }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('overdue')), TURN_LIMIT_MS);
        timer.unref?.();
      }),
    ]).finally(() => timer && clearTimeout(timer));
    failure = refusal(answer);
  } catch (err) {
    console.error('[book-club] a turn failed:', err);
    failure = err instanceof Error && err.message === 'overdue'
      ? 'The turn went half an hour without an answer, so it was let go.'
      : 'The line to the table dropped before they answered.';
  } finally {
    try {
      const round = getRound(roundId, root);
      if (round && round.status === 'open') {
        const waiting = stillWaiting(round, bookClubSeats());
        const missing = [
          ...waiting.pitch.map((s) => `${s.name}'s pitch`),
          ...waiting.vote.map((s) => `${s.name}'s vote`),
        ];
        if (failure || missing.length > 0) {
          const still = missing.length > 0 ? ` Still waiting on ${missing.join(', ')}.` : '';
          setTurn(roundId, { state: 'empty', note: `${failure ?? 'The turn ended without everything in.'}${still}`.trim() }, root);
        } else {
          setTurn(roundId, { state: 'idle', note: null }, root);
        }
      }
    } catch (err) {
      console.error('[book-club] could not settle a turn:', err);
    }
  }
}

/** Wake the companions for this round: one queued turn, run after any before it. */
export function queueBookClubTurn(lane: BookClubLane, roundId: string, opts: { retry: boolean }, root = libraryDir()): BookClubRound {
  const round = getRound(roundId, root);
  if (!round) throw new BookClubError(404, 'There is no book club round with that id.');
  if (round.status !== 'open') throw new BookClubError(409, 'This round is past pitching and voting.');
  if (round.turn.state === 'waiting') return round;
  const marked = setTurn(roundId, { state: 'waiting', note: null }, root);
  chain = chain
    .then(() => runTurn(lane, roundId, opts.retry, root))
    .catch((err) => console.error('[book-club] a turn failed outside its own guard:', err));
  return marked;
}
