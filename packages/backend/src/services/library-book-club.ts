// The Book Club — rounds of "what do we read next", inside the Library.
//
// A round is OPEN while pitches and votes come in: she and each seated
// companion pitch one book (pitching again replaces your pitch, and keeps the
// votes it already had) and cast one vote each (voting again moves it). She
// picks the winner when she is ready: the most votes wins, and when the top
// is tied (or nobody voted) she chooses between the tied pitches. The round is
// then READING, the winner linked to the shelf: a pitch that names a Gutenberg
// book not yet shelved is fetched onto the shelf and put on Reading. Finishing
// a round archives it as FINISHED; an open round can also be set aside that
// way, with no winner. Only one round is open or reading at a time.
//
// Storage: data/library/book-club.json, { rounds: [...] }, newest first —
// a JSON file beside the shelf like the rest of the Library, no schema.
// The companions' turn (waking them to pitch and vote) lives in
// library-book-club-turns.ts; this module is the rules and the file.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import crypto from 'crypto';
import { fetchAndShelve, libraryDir, readShelf, setShelf, type SavedEntry, type ShelfEntry } from './library.js';

/** Her id at the table, beside the companions' slugs. */
export const OWNER_SEAT = 'owner';

export type BookClubStatus = 'open' | 'reading' | 'finished';

export interface BookClubPitch {
  id: string;
  /** 'owner' or a companion slug. */
  by: string;
  title: string;
  author: string;
  /** One line, in the pitcher's own voice. */
  pitch: string;
  gutenbergId: number | null;
  /** A book already on her shelf, when the pitch is one she owns. */
  bookId: number | null;
  createdAt: string;
  updatedAt: string;
}

/** Where the companions' turn stands: waiting on it, done, or back without everything asked for. */
export interface BookClubTurn {
  state: 'idle' | 'waiting' | 'empty';
  /** Why a turn came back empty, in plain words; null otherwise. */
  note: string | null;
  at: string;
}

export interface BookClubRound {
  id: string;
  status: BookClubStatus;
  startedAt: string;
  pitches: BookClubPitch[];
  /** voter ('owner' or a slug) → pitch id. One each. */
  votes: Record<string, string>;
  winnerPitchId: string | null;
  /** The shelf book the winner became, when there is one. */
  bookId: number | null;
  /** When the winner could not be fetched onto the shelf, why. */
  shelveError: string | null;
  pickedAt: string | null;
  finishedAt: string | null;
  turn: BookClubTurn;
}

export interface Seat { id: string; name: string }

export class BookClubError extends Error {
  constructor(public status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'BookClubError';
  }
}

const MAX_TITLE = 200;
const MAX_AUTHOR = 200;
const MAX_PITCH = 600;
const now = () => new Date().toISOString();

// ── the file ───────────────────────────────────────────────────────────────

function clubPath(root: string): string {
  return join(root, 'book-club.json');
}

export function readRounds(root = libraryDir()): BookClubRound[] {
  const path = clubPath(root);
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'));
    return Array.isArray(data?.rounds) ? (data.rounds as BookClubRound[]) : [];
  } catch {
    return [];
  }
}

function writeRounds(rounds: BookClubRound[], root: string): void {
  mkdirSync(root, { recursive: true });
  const path = clubPath(root);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ rounds }));
  renameSync(tmp, path);
}

/** Change one round under read-modify-write. */
function withRound<T>(roundId: string, root: string, change: (round: BookClubRound) => T): T {
  const rounds = readRounds(root);
  const round = rounds.find((r) => r.id === roundId);
  if (!round) throw new BookClubError(404, 'There is no book club round with that id.');
  const result = change(round);
  writeRounds(rounds, root);
  return result;
}

export function getRound(roundId: string, root = libraryDir()): BookClubRound | null {
  return readRounds(root).find((r) => r.id === roundId) ?? null;
}

/** The round open or being read right now, if any. */
export function currentRound(root = libraryDir()): BookClubRound | null {
  return readRounds(root).find((r) => r.status !== 'finished') ?? null;
}

// ── the rules ──────────────────────────────────────────────────────────────

function text(raw: unknown, field: string, max: number, required: boolean): string {
  const value = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (required && !value) throw new BookClubError(400, `A pitch needs its ${field}.`);
  if (value.length > max) throw new BookClubError(400, `Keep the ${field} under ${max} characters.`);
  return value;
}

function optionalId(raw: unknown, field: string): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new BookClubError(400, `${field} must be a whole number.`);
  return n;
}

function seatIds(seats: Seat[]): string[] {
  return [OWNER_SEAT, ...seats.map((s) => s.id)];
}

function requireSeat(who: unknown, seats: Seat[], role: string): string {
  const id = typeof who === 'string' ? who.trim().toLowerCase() : '';
  if (!seatIds(seats).includes(id)) {
    throw new BookClubError(400, `${role} must be one of: ${seatIds(seats).join(', ')}.`);
  }
  return id;
}

function requireOpen(round: BookClubRound): void {
  if (round.status !== 'open') throw new BookClubError(409, 'This round is past pitching and voting.');
}

export function startRound(root = libraryDir()): BookClubRound {
  const rounds = readRounds(root);
  if (rounds.some((r) => r.status !== 'finished')) {
    throw new BookClubError(409, 'A round is already going. Finish it before starting another.');
  }
  const at = now();
  const round: BookClubRound = {
    id: crypto.randomUUID(),
    status: 'open',
    startedAt: at,
    pitches: [],
    votes: {},
    winnerPitchId: null,
    bookId: null,
    shelveError: null,
    pickedAt: null,
    finishedAt: null,
    turn: { state: 'idle', note: null, at },
  };
  writeRounds([round, ...rounds], root);
  return round;
}

/** Pitch a book. One pitch each: pitching again replaces yours and keeps its votes. */
export function addPitch(
  roundId: string,
  input: { by?: unknown; title?: unknown; author?: unknown; pitch?: unknown; gutenbergId?: unknown; bookId?: unknown },
  seats: Seat[],
  root = libraryDir(),
): BookClubPitch {
  const by = requireSeat(input.by, seats, 'by');
  const title = text(input.title, 'title', MAX_TITLE, true);
  const author = text(input.author, 'author', MAX_AUTHOR, false);
  const pitch = text(input.pitch, 'pitch', MAX_PITCH, by !== OWNER_SEAT);
  const gutenbergId = optionalId(input.gutenbergId, 'gutenbergId');
  const bookId = optionalId(input.bookId, 'bookId');
  if (bookId !== null && !readShelf(root).some((e) => e.id === bookId)) {
    throw new BookClubError(400, 'That book is not on her shelf.');
  }
  return withRound(roundId, root, (round) => {
    requireOpen(round);
    const at = now();
    const mine = round.pitches.find((p) => p.by === by);
    if (mine) {
      Object.assign(mine, { title, author, pitch, gutenbergId, bookId, updatedAt: at });
      return mine;
    }
    const fresh: BookClubPitch = { id: crypto.randomUUID().slice(0, 8), by, title, author, pitch, gutenbergId, bookId, createdAt: at, updatedAt: at };
    round.pitches.push(fresh);
    return fresh;
  });
}

/** One vote each; voting again moves it. */
export function castVote(roundId: string, input: { voter?: unknown; pitchId?: unknown }, seats: Seat[], root = libraryDir()): BookClubRound {
  const voter = requireSeat(input.voter, seats, 'voter');
  const pitchId = typeof input.pitchId === 'string' ? input.pitchId.trim() : '';
  return withRound(roundId, root, (round) => {
    requireOpen(round);
    if (!round.pitches.some((p) => p.id === pitchId)) throw new BookClubError(400, 'There is no pitch with that id in this round.');
    round.votes[voter] = pitchId;
    return round;
  });
}

/** Votes per pitch, every pitch listed (zero included). */
export function tally(round: BookClubRound): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(round.pitches.map((p) => [p.id, 0]));
  for (const pitchId of Object.values(round.votes)) if (pitchId in counts) counts[pitchId] += 1;
  return counts;
}

/** The pitches with the most votes; more than one means she decides. */
export function leaders(round: BookClubRound): string[] {
  const counts = tally(round);
  const top = Math.max(0, ...Object.values(counts));
  return round.pitches.filter((p) => counts[p.id] === top).map((p) => p.id);
}

type FetchLike = Parameters<typeof fetchAndShelve>[1];

/**
 * She picks the winner. The votes decide; when the top is tied she names the
 * pitch (pitchId), which must be one of the tied ones. The winner goes onto
 * the shelf on Reading when it can: a book she already has is moved there
 * from To Be Read, a Gutenberg pitch not yet shelved is fetched first. A
 * fetch that fails still picks the winner; the round says why it isn't shelved.
 */
export async function pickWinner(
  roundId: string,
  input: { pitchId?: unknown },
  root = libraryDir(),
  fetchImpl?: FetchLike,
): Promise<BookClubRound> {
  const round = getRound(roundId, root);
  if (!round) throw new BookClubError(404, 'There is no book club round with that id.');
  requireOpen(round);
  if (round.pitches.length === 0) throw new BookClubError(409, 'Nobody has pitched a book yet.');
  const tied = leaders(round);
  const asked = typeof input.pitchId === 'string' && input.pitchId.trim() ? input.pitchId.trim() : null;
  let winnerId: string;
  if (tied.length === 1) {
    if (asked && asked !== tied[0]) throw new BookClubError(409, 'The votes already chose a winner.');
    winnerId = tied[0];
  } else {
    if (!asked) throw new BookClubError(409, 'It is a tie. You pick the winner.');
    if (!tied.includes(asked)) throw new BookClubError(409, 'Pick one of the tied books.');
    winnerId = asked;
  }
  const winner = round.pitches.find((p) => p.id === winnerId)!;

  // Shelve first, outside the round's read-modify-write: a fetch takes a while.
  let bookId: number | null = null;
  let shelveError: string | null = null;
  const shelf = readShelf(root);
  const owned: ShelfEntry | undefined = winner.bookId !== null
    ? shelf.find((e) => e.id === winner.bookId)
    : winner.gutenbergId !== null ? shelf.find((e) => e.id === winner.gutenbergId) : undefined;
  if (owned) {
    bookId = owned.id;
    if (owned.shelf === 'tbr') setShelf(owned.id, { shelf: 'reading' }, root);
  } else if (winner.gutenbergId !== null) {
    try {
      const saved: SavedEntry = await fetchAndShelve(winner.gutenbergId, fetchImpl, root);
      setShelf(saved.id, { shelf: 'reading' }, root);
      bookId = saved.id;
    } catch (err) {
      shelveError = `It couldn't be fetched from Project Gutenberg (${err instanceof Error ? err.message : 'no answer'}). Find it in Find a book, or read it wherever you have it.`;
    }
  }

  return withRound(roundId, root, (r) => {
    requireOpen(r);
    const at = now();
    r.status = 'reading';
    r.winnerPitchId = winnerId;
    r.bookId = bookId;
    r.shelveError = shelveError;
    r.pickedAt = at;
    if (r.turn.state === 'waiting') r.turn = { state: 'idle', note: null, at };
    return r;
  });
}

/** Archive the round. An open round can be set aside this way too, with no winner. */
export function finishRound(roundId: string, root = libraryDir()): BookClubRound {
  return withRound(roundId, root, (round) => {
    if (round.status === 'finished') throw new BookClubError(409, 'That round is already finished.');
    const at = now();
    round.status = 'finished';
    round.finishedAt = at;
    round.turn = { state: 'idle', note: null, at };
    return round;
  });
}

export function setTurn(roundId: string, turn: Omit<BookClubTurn, 'at'>, root = libraryDir()): BookClubRound {
  return withRound(roundId, root, (round) => {
    round.turn = { ...turn, at: now() };
    return round;
  });
}

/** Who hasn't pitched / voted yet, among the companions. */
export function stillWaiting(round: BookClubRound, seats: Seat[]): { pitch: Seat[]; vote: Seat[] } {
  return {
    pitch: seats.filter((s) => !round.pitches.some((p) => p.by === s.id)),
    vote: seats.filter((s) => !(s.id in round.votes)),
  };
}

// ── the view both doors read ───────────────────────────────────────────────

export interface BookClubView {
  current: (BookClubRound & { tally: Record<string, number>; leaders: string[] }) | null;
  past: BookClubRound[];
  seats: Seat[];
  owner: Seat;
}

export function bookClubView(seats: Seat[], ownerName: string, root = libraryDir()): BookClubView {
  const rounds = readRounds(root);
  const current = rounds.find((r) => r.status !== 'finished') ?? null;
  return {
    current: current ? { ...current, tally: tally(current), leaders: leaders(current) } : null,
    past: rounds.filter((r) => r.status === 'finished'),
    seats,
    owner: { id: OWNER_SEAT, name: ownerName },
  };
}
