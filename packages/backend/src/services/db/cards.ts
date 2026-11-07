// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// The Card Room — a live deck.
//
// Fifty-two cards plus a back, cut to one size and
// one paper by tools/cut-cards.py and tools/normalize-stock.py. The art lives
// in data/cards; this file only ever deals in card IDs like 'hearts-king'.
//
// Nothing in here knows a game. The table holds a shuffled deck, four seats and
// a pile, and hands the running game an opaque state blob — the games get
// designed with the owner rather than guessed at, and adding one should not
// need a migration or a change here.
import crypto from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../../config.js';
import { getDb } from './state.js';
import { createThread, getThread } from './threads.js';
import { createMessage } from './messages.js';
// byte-light's companion registry (services/db/rooms.ts): the row id IS the
// slug ('companion-a', 'companion-b', 'companion-c'), so Aerie's `.slug` reads `.id` here.
import { listCompanions } from './rooms.js';
import { getOwnerSlug, ownerDisplayName } from './owner-name.js';

export const CARDS_DIR = join(PROJECT_ROOT, 'data/cards');

/**
 * A plain deck that ships WITH the code, drawn by tools/make-placeholder-cards.py.
 *
 * A house's own deck is held: it lives in gitignored data/cards and does not
 * travel with the code, which left the Card Room shipping as code that could not
 * draw a single card in a fresh clone — the table would 503 with "the deck has
 * not been cut yet" and nobody would know why. This is the fallback so the room works out
 * of the box, and it is deliberately checked in for the same reason the BERT
 * tokenizer is: a thing a fresh clone needs cannot live behind .gitignore.
 *
 * A house's own deck wins wherever it exists. This is only ever what is left.
 */
export const PLACEHOLDER_CARDS_DIR = join(PROJECT_ROOT, 'packages/backend/assets/cards');

/** Which deck directory is actually usable — the house's own first, the plain one after. */
export function activeCardsDir(): string {
  return existsSync(join(CARDS_DIR, 'cards.json')) ? CARDS_DIR : PLACEHOLDER_CARDS_DIR;
}

export const CARD_SUITS = ['spades', 'clubs', 'diamonds', 'hearts'] as const;
export const CARD_RANKS = [
  'ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king',
] as const;

export type CardSuit = (typeof CARD_SUITS)[number];
export type CardRank = (typeof CARD_RANKS)[number];
/** e.g. 'hearts-king'. The art file is this plus .png (or .webp under thumbs/). */
export type CardId = string;

export type CardTableStatus = 'open' | 'playing' | 'complete';

export interface CardSeat {
  slug: string;
  hand: CardId[];
}

export interface CardTable {
  id: string;
  threadId: string;
  game: string;
  status: CardTableStatus;
  deck: CardId[];
  seats: Record<string, CardSeat>;
  pile: CardId[];
  state: Record<string, unknown>;
  companionPending: boolean;
  companionError: string | null;
  createdAt: string;
  updatedAt: string;
}

export class CardRoomError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- the deck

/**
 * The deck as it exists on disk. Read from the manifest rather than generated,
 * so a card that was never cut cannot be dealt — an ID with no art behind it
 * would reach the phone as a hole in somebody's hand and nothing would error.
 */
export function loadDeck(): CardId[] {
  const dir = activeCardsDir();
  const manifestPath = join(dir, 'cards.json');
  if (!existsSync(manifestPath)) {
    throw new CardRoomError('The deck has not been cut yet', 503);
  }
  const manifest = parseJson<{ cards?: Array<{ suit: string; rank: string; file: string }> }>(
    readFileSync(manifestPath, 'utf-8'), {});
  const ids = (manifest.cards ?? [])
    .filter((c) => c.rank !== 'back')
    .filter((c) => existsSync(join(dir, c.file)))
    .map((c) => `${c.suit}-${c.rank}`);
  if (ids.length !== 52) {
    throw new CardRoomError(`The deck is ${ids.length} cards, not 52`, 503);
  }
  return ids;
}

/** Fisher-Yates over crypto randomness. A card game deserves a real shuffle. */
export function shuffle<T>(input: T[]): T[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function parseCardId(id: CardId): { suit: CardSuit; rank: CardRank } | null {
  const cut = id.indexOf('-');
  if (cut < 0) return null;
  const suit = id.slice(0, cut) as CardSuit;
  const rank = id.slice(cut + 1) as CardRank;
  if (!CARD_SUITS.includes(suit) || !CARD_RANKS.includes(rank)) return null;
  return { suit, rank };
}

// ---------------------------------------------------------------- the room

const CARD_THREAD_CONFIG_KEY = 'cardroom.thread_id';

function ensureCardRoomThread(): string {
  const configured = getDb()
    .prepare('SELECT value FROM config WHERE key = ?')
    .get(CARD_THREAD_CONFIG_KEY) as { value: string } | undefined;
  if (configured?.value && getThread(configured.value)) return configured.value;

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // Participants, no primary — the same shape as the owner's home thread and
  // for the same reason the Fleet Room learned the hard way: that column also
  // resolves the CLI session key, so naming a leader here hands the room its
  // own cold lane that walks in knowing the table and nothing about the evening.
  // byte-light seats a thread's roster at creation (createThread companionIds);
  // it has no primary/participant split, so every companion is simply seated.
  createThread({
    id, name: 'The Card Room', type: 'named', createdAt: now, sessionType: 'v2',
    companionIds: listCompanions().map((c) => c.id),
  });

  getDb().prepare('UPDATE threads SET archived_at = ? WHERE id = ?').run(now, id);
  getDb()
    .prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)')
    .run(CARD_THREAD_CONFIG_KEY, id);

  createMessage({
    id: crypto.randomUUID(),
    threadId: id,
    role: 'system',
    content: 'The Card Room opened. Fifty-two cards, one table.',
    platform: 'api',
    createdAt: now,
  });
  return id;
}

// -------------------------------------------------------------- the table

interface CardTableRow {
  id: string;
  thread_id: string;
  game: string;
  status: CardTableStatus;
  deck_json: string;
  seats_json: string;
  pile_json: string;
  state_json: string;
  companion_pending: number;
  companion_error: string | null;
  created_at: string;
  updated_at: string;
}

function hydrate(row: CardTableRow): CardTable {
  return {
    id: row.id,
    threadId: row.thread_id,
    game: row.game,
    status: row.status,
    deck: parseJson<CardId[]>(row.deck_json, []),
    seats: parseJson<Record<string, CardSeat>>(row.seats_json, {}),
    pile: parseJson<CardId[]>(row.pile_json, []),
    state: parseJson<Record<string, unknown>>(row.state_json, {}),
    companionPending: row.companion_pending === 1,
    companionError: row.companion_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * THE OWNER'S SEAT AT THE TABLE.
 *
 * Reported Sep 17 2026: the seat used to be one house's own
 * slug, compiled into a kit other people install. It resolves from
 * identity.user_name the same way every other slug in the app does, so a house
 * that calls its person the operator seats the operator. The phone learns the same slug from
 * GET /api/companions (owner.slug) — or, on byte-light, from preferences'
 * identity.user_name through lib/owner.ts — so the two can never disagree.
 */
export function ownerSeat(): string {
  return getOwnerSlug();
}

/**
 * Seats in a fixed order so the table does not reshuffle who sits where.
 *
 * Seats are keyed by SLUG, not by database id. The phone looks a seat up by
 * slug to find the face and the name that belong in that chair; handed an id it
 * finds neither, and paints the raw uuid with a broken image beside it.
 */
export function seatOrder(): string[] {
  return [...listCompanions().map((c) => c.id), ownerSeat()];
}

/**
 * The seats a new game sits in when the request names none: the owner first,
 * then this house's companions in their stored order. A game for a fixed
 * number of players takes the first companions that fit. A request that sends
 * its own order never comes through here.
 */
export function defaultGameSeats(players?: number): string[] {
  const companions = listCompanions().map((c) => c.id);
  return [ownerSeat(), ...(players ? companions.slice(0, players - 1) : companions)];
}

/**
 * Seats for a partnership game (Spades, Euchre). Partners sit across from each
 * other, so the owner takes seat 0 and their partner seat 2. The partner defaults
 * to the house's first companion, and the other two seats go to the next
 * companions in stored order. Fewer than three companions cannot make the
 * table, and saying so beats seating a chair nobody is in.
 */
export function partnerGameSeats(partner?: unknown): string[] {
  const companions = listCompanions().map((c) => c.id);
  const chosen = typeof partner === 'string' ? partner : companions[0];
  const rest = companions.filter((slug) => slug !== chosen);
  const seats = [ownerSeat(), rest[0], chosen, rest[1]];
  if (seats.some((slug) => !slug)) {
    throw new CardRoomError('A partnership game needs four players: the owner and three companions');
  }
  return seats;
}

function persist(table: CardTable): CardTable {
  const now = new Date().toISOString();
  getDb()
    .prepare(`UPDATE card_tables SET game = ?, status = ?, deck_json = ?, seats_json = ?,
              pile_json = ?, state_json = ?, updated_at = ? WHERE id = ?`)
    .run(table.game, table.status, JSON.stringify(table.deck), JSON.stringify(table.seats),
         JSON.stringify(table.pile), JSON.stringify(table.state), now, table.id);
  return { ...table, updatedAt: now };
}

export function getCardTable(id?: string): CardTable | null {
  const row = id
    ? getDb().prepare('SELECT * FROM card_tables WHERE id = ?').get(id)
    : getDb().prepare('SELECT * FROM card_tables ORDER BY created_at DESC LIMIT 1').get();
  return row ? hydrate(row as CardTableRow) : null;
}

export function newCardTable(game = 'freeplay'): CardTable {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const threadId = ensureCardRoomThread();
  const seats: Record<string, CardSeat> = {};
  for (const slug of seatOrder()) seats[slug] = { slug, hand: [] };

  getDb()
    .prepare(`INSERT INTO card_tables (id, thread_id, game, status, deck_json, seats_json,
              pile_json, state_json, created_at, updated_at)
              VALUES (?, ?, ?, 'open', ?, ?, '[]', '{}', ?, ?)`)
    .run(id, threadId, game, JSON.stringify(shuffle(loadDeck())), JSON.stringify(seats), now, now);

  addCardLog(id, 'system', 'house', 'A fresh deck. Fifty-two cards, cut and shuffled.');
  return getCardTable(id)!;
}

/** Deal `each` cards to every seat, round-robin off the front of the deck. */
export function dealCards(tableId: string, each: number): CardTable {
  const table = getCardTable(tableId);
  if (!table) throw new CardRoomError('No such table', 404);
  const order = seatOrder();
  if (each * order.length > table.deck.length) {
    throw new CardRoomError(
      `Only ${table.deck.length} cards left — not enough to deal ${each} to ${order.length} seats`);
  }
  const deck = [...table.deck];
  const seats = { ...table.seats };
  for (let round = 0; round < each; round++) {
    for (const slug of order) {
      const seat = seats[slug] ?? { slug, hand: [] };
      seats[slug] = { slug, hand: [...seat.hand, deck.shift()!] };
    }
  }
  addCardLog(tableId, 'system', 'house', `Dealt ${each} to each seat.`);
  return persist({ ...table, deck, seats, status: 'playing' });
}

/** Turn the top of a seat's hand face up onto the pile. */
export function playCard(tableId: string, slug: string): CardTable {
  const table = getCardTable(tableId);
  if (!table) throw new CardRoomError('No such table', 404);
  const seat = table.seats[slug];
  if (!seat) throw new CardRoomError(`${slug} is not at this table`, 404);
  if (seat.hand.length === 0) throw new CardRoomError(`${slug} has no cards left`);
  const [card, ...rest] = seat.hand;
  addCardLog(tableId, 'play', slug, `played ${card}`, card);
  return persist({
    ...table,
    seats: { ...table.seats, [slug]: { slug, hand: rest } },
    pile: [...table.pile, card],
  });
}

/** Gather the pile back under the deck, so a table can keep going. */
export function gatherPile(tableId: string): CardTable {
  const table = getCardTable(tableId);
  if (!table) throw new CardRoomError('No such table', 404);
  if (table.pile.length === 0) return table;
  addCardLog(tableId, 'system', 'house', `Gathered ${table.pile.length} from the pile.`);
  return persist({ ...table, deck: [...table.deck, ...shuffle(table.pile)], pile: [] });
}

// ------------------------------------------------------------- the games

/**
 * Swap the running game and its state in one write. The table stays ignorant of
 * what the blob means — that is the whole reason a second game cost no schema.
 */
export function setCardGame(
  tableId: string, game: string, state: Record<string, unknown>,
): CardTable {
  const table = getCardTable(tableId);
  if (!table) throw new CardRoomError('No such table', 404);
  return persist({ ...table, game, state, status: 'playing' });
}

export function setCardState(tableId: string, state: Record<string, unknown>): CardTable {
  const table = getCardTable(tableId);
  if (!table) throw new CardRoomError('No such table', 404);
  return persist({ ...table, state });
}

// ----------------------------------------------------------------- the log

export interface CardLogEntry {
  id: number;
  kind: 'system' | 'play' | 'chat';
  actor: string;
  content: string;
  card: string | null;
  createdAt: string;
}

export function addCardLog(
  tableId: string, kind: CardLogEntry['kind'], actor: string,
  content: string, card?: string,
): void {
  getDb()
    .prepare(`INSERT INTO card_log (table_id, kind, actor, content, card, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(tableId, kind, actor, content, card ?? null, new Date().toISOString());
}

export function getCardLog(tableId: string, limit = 60): CardLogEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM card_log WHERE table_id = ? ORDER BY id DESC LIMIT ?')
    .all(tableId, limit) as Array<Record<string, unknown>>;
  return rows.reverse().map((r) => ({
    id: r.id as number,
    kind: r.kind as CardLogEntry['kind'],
    actor: r.actor as string,
    content: r.content as string,
    card: (r.card as string) ?? null,
    createdAt: r.created_at as string,
  }));
}

// ------------------------------------------------------------- the rail
//
// The companions sit at the table while the owner plays, which is the whole
// reason solitaire stopped being the game you play alone. What makes that worth more
// than a chat box parked beside a board is that the prompt carries the BOARD:
// the companions are watching this game rather than making conversation next
// to it.

export interface CardRoomTurn {
  threadId: string;
  prompt: string;
}

/**
 * Build the turn the room wakes holding. Pure, and exported ONLY so the one
 * thing that has already gone wrong here can be asserted: the owner's line reached the
 * messages table and the screen and never reached the prompt, so the window
 * woke holding a board and nothing the owner had said, and answered the board.
 * Stored is not delivered and displayed is not delivered — this is the hop
 * nobody was instrumenting.
 */
export function buildCardRoomPrompt(
  game: string, board: string | null, ownerContent: string, ownerName = 'the owner',
): string {
  return [
    '[CARD ROOM — live game conversation]',
    `A real side room shared by ${ownerName} and their companions. Stay in character and answer them naturally.`,
    'This is a game turn, not a software task. Do not inspect or edit code.',
    `Game on the table: ${game}.`,
    board ? `The board as it stands right now:\n${board}` : 'Nothing dealt yet.',
    'You can see the whole board on purpose. Talk about THIS game — the card they have been sitting on, the ace still buried, the column they keep not touching. Being specific is the entire point of you being at the table.',
    'They are playing; you are not. Do not tell them what move to make unless they ask.',
    'Your final spoken reply is written into the Card Room rail automatically.',
    'Use the normal bold sigil headers. Real table talk, not a report, and a quick beat need not become a monologue.',
    '',
    // The owner's line goes LAST and it is the point of the turn.
    'This is what they just said to you, and it is what you are answering:',
    ownerContent,
  ].filter(Boolean).join('\n');
}

/**
 * Reserve the companion lane and write the owner's line into the room. The reservation
 * is a compare-and-swap so two quick messages cannot both open a turn — the
 * second gets told the table is busy rather than silently racing the first.
 */
export function beginCardRoomResponse(tableId: string, ownerContent: string): CardRoomTurn {
  const table = getCardTable(tableId);
  if (!table) throw new CardRoomError('No such table', 404);
  const content = String(ownerContent || '').trim();
  if (!content) throw new CardRoomError('Say something into the room first');

  const now = new Date().toISOString();
  const reserved = getDb().prepare(`
    UPDATE card_tables SET companion_pending = 1, companion_error = NULL, updated_at = ?
    WHERE id = ? AND companion_pending = 0
  `).run(now, tableId);
  if (reserved.changes !== 1) throw new CardRoomError('They are already talking', 409);

  try {
    createMessage({
      id: crypto.randomUUID(),
      threadId: table.threadId,
      role: 'user',
      content,
      platform: 'api',
      metadata: { cardTableId: tableId, room: 'cards' },
      createdAt: now,
    });
  } catch (error) {
    getDb().prepare('UPDATE card_tables SET companion_pending = 0 WHERE id = ?').run(tableId);
    throw error;
  }

  const board = describeCardGame(table.game, table.state);
  return {
    threadId: table.threadId,
    prompt: buildCardRoomPrompt(table.game, board, content, ownerDisplayName()),
  };
}

export function finishCardRoomResponse(tableId: string, error?: string | null): void {
  getDb()
    .prepare('UPDATE card_tables SET companion_pending = 0, companion_error = ?, updated_at = ? WHERE id = ?')
    .run(error?.trim() || null, new Date().toISOString(), tableId);
}

// The board describers live in board-describers.ts (see the note there).
import { describeCardGame } from './board-describers.js';
export { registerBoardDescriber, describeCardGame } from './board-describers.js';

// ------------------------------------------------------------- what leaves

export interface CardSeatView {
  slug: string;
  /** Present only for the seat doing the looking. */
  hand?: CardId[];
  count: number;
}

export interface CardTableView {
  id: string;
  game: string;
  status: CardTableStatus;
  seats: CardSeatView[];
  pile: CardId[];
  deckRemaining: number;
  state: Record<string, unknown>;
  companionPending: boolean;
  companionError: string | null;
  log: CardLogEntry[];
  updatedAt: string;
}

/** What a card nobody at this seat may see looks like on the wire. */
export const HIDDEN_CARD = 'hidden';

/**
 * The running game's blob, as one seat may see it. Every other seat's hand
 * keeps its length (the boards draw counts and card backs from it) but loses
 * its faces; a Golf slot keeps a card only once it is turned up. The draw
 * stock and all but the turned card of a Euchre kitty go face down too.
 * Games with no hands (Solitaire) pass through untouched.
 */
export function redactGameState<T>(state: T, forSeat: string): T {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return state;
  const s = state as Record<string, unknown>;
  const hands = s.hands;
  if (!hands || typeof hands !== 'object' || Array.isArray(hands)) return state;
  const shown: Record<string, unknown> = {};
  for (const [seat, hand] of Object.entries(hands as Record<string, unknown>)) {
    shown[seat] = seat === forSeat || !Array.isArray(hand)
      ? hand
      : hand.map((card) => (card && typeof card === 'object' && 'faceUp' in card
        ? ((card as { faceUp: boolean }).faceUp ? card : { ...card, card: HIDDEN_CARD })
        : HIDDEN_CARD));
  }
  const next: Record<string, unknown> = { ...s, hands: shown };
  if (Array.isArray(s.stock)) next.stock = s.stock.map(() => HIDDEN_CARD);
  if (Array.isArray(s.kitty)) next.kitty = s.kitty.map((card, i) => (i === 0 ? card : HIDDEN_CARD));
  return next as T;
}

/**
 * A hand is private. Every seat sees its own cards, everyone else's as a count.
 * The redaction happens here rather than in the router so both the phone and
 * the companions' localhost lane pass through the same gate — the Fleet Room
 * keeps two of these and they have to agree.
 */
export function viewCardTable(table: CardTable, forSeat: string): CardTableView {
  return {
    id: table.id,
    game: table.game,
    status: table.status,
    seats: seatOrder().map((slug) => {
      const seat = table.seats[slug] ?? { slug, hand: [] };
      return slug === forSeat
        ? { slug, hand: seat.hand, count: seat.hand.length }
        : { slug, count: seat.hand.length };
    }),
    pile: table.pile,
    deckRemaining: table.deck.length,
    state: redactGameState(table.state, forSeat),
    companionPending: table.companionPending,
    companionError: table.companionError,
    log: getCardLog(table.id),
    updatedAt: table.updatedAt,
  };
}
