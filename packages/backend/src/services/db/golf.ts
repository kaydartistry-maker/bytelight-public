// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Six-card Golf, played in the Card Room.
//
// The first game in this house that nobody at the table already knows. The
// house rule for the whole run, and the point of it: no companion arrives already
// good at a game — the owner learns it and the companions learn it in the same
// hand.
//
// THE RULES, in the order you meet them:
//   Six cards each, face down, in two rows of three. Two of them get turned
//   face up at the deal so everyone starts with something to think about.
//   On your turn you take the top of the STOCK or the top of the DISCARD.
//   A card off the discard has to go into your six, swapping out whatever was
//   in that slot. A card off the stock can do the same — or you can throw it
//   away and turn one of your own face-down cards up instead.
//   The moment somebody has all six face up, everybody else gets ONE more turn.
//
// THE SCORING, which is where the game actually lives:
//   King 0. Ace 1. Two is MINUS two. Three through ten are worth their number.
//   Jack and Queen are ten. And a matching pair in the same COLUMN cancels —
//   both cards score nothing at all. Lowest total wins, so a good hand is one
//   you keep getting rid of.
//
// Same idiom as solitaire.ts and rat-screw.ts: a pure state machine over card
// IDs living in the table's opaque state blob. No database, no migration.

import { parseCardId, type CardId } from './cards.js';
import { registerBoardDescriber } from './board-describers.js';

export class GolfError extends Error {}

/** Two rows of three. Columns are (0,3), (1,4), (2,5). */
export const GOLF_SLOTS = 6;
const COLUMNS: Array<[number, number]> = [[0, 3], [1, 4], [2, 5]];

export interface GolfSlot {
  card: CardId;
  faceUp: boolean;
}

export interface GolfState {
  order: string[];
  hands: Record<string, GolfSlot[]>;
  stock: CardId[];
  discard: CardId[];
  turn: string;
  /** the card in the actor's hand mid-turn, and where it came from */
  held: { card: CardId; from: 'stock' | 'discard' } | null;
  /** who went out — everyone after them gets exactly one more turn */
  closedBy: string | null;
  turnsLeft: number;
  phase: 'playing' | 'done';
  scores: Record<string, number> | null;
  winner: string | null;
  startedAt: string;
  moves: number;
}

function rankOf(card: CardId): string {
  const parsed = parseCardId(card);
  if (!parsed) throw new GolfError(`Not a card: ${card}`);
  return parsed.rank;
}

/** What one card is worth on its own, before columns cancel. */
export function cardScore(card: CardId): number {
  const rank = rankOf(card);
  if (rank === 'king') return 0;
  if (rank === 'ace') return 1;
  if (rank === '2') return -2;
  if (rank === 'jack' || rank === 'queen') return 10;
  return Number(rank);
}

/** A whole hand, with matching columns cancelled to nothing. */
export function handScore(hand: GolfSlot[]): number {
  let total = 0;
  const cancelled = new Set<number>();
  for (const [a, b] of COLUMNS) {
    if (hand[a] && hand[b] && rankOf(hand[a].card) === rankOf(hand[b].card)) {
      cancelled.add(a);
      cancelled.add(b);
    }
  }
  hand.forEach((slot, i) => {
    if (!cancelled.has(i)) total += cardScore(slot.card);
  });
  return total;
}

function snapshot(state: GolfState): GolfState {
  return JSON.parse(JSON.stringify(state)) as GolfState;
}

export function newGolf(deck: CardId[], order: string[], startedAt = new Date().toISOString()): GolfState {
  if (order.length < 2) throw new GolfError('Golf needs at least two players');
  if (deck.length < order.length * GOLF_SLOTS + 1) throw new GolfError('Not enough cards');
  const stock = [...deck];
  const hands: Record<string, GolfSlot[]> = {};
  for (const slug of order) {
    const hand: GolfSlot[] = [];
    for (let i = 0; i < GOLF_SLOTS; i++) hand.push({ card: stock.shift() as CardId, faceUp: false });
    // Two up at the deal, so nobody starts a turn with nothing to think about.
    hand[0].faceUp = true;
    hand[GOLF_SLOTS - 1].faceUp = true;
    hands[slug] = hand;
  }
  return {
    order: [...order],
    hands,
    stock,
    discard: [stock.shift() as CardId],
    turn: order[0],
    held: null,
    closedBy: null,
    turnsLeft: 0,
    phase: 'playing',
    scores: null,
    winner: null,
    startedAt,
    moves: 0,
  };
}

function requireTurn(state: GolfState, actor: string): void {
  if (state.phase !== 'playing') throw new GolfError('The round is over');
  if (state.turn !== actor) throw new GolfError(`It is ${state.turn}'s turn`);
}

export function draw(state: GolfState, actor: string, from: 'stock' | 'discard'): GolfState {
  requireTurn(state, actor);
  if (state.held) throw new GolfError('You are already holding a card');
  const next = snapshot(state);
  if (from === 'discard') {
    const top = next.discard.pop();
    if (!top) throw new GolfError('The discard is empty');
    next.held = { card: top, from: 'discard' };
  } else {
    // The stock never truly runs out — the discard turns over and rides again,
    // minus the card on top of it, which is what everyone is still looking at.
    if (!next.stock.length) {
      const top = next.discard.pop();
      next.stock = next.discard;
      next.discard = top ? [top] : [];
    }
    const top = next.stock.shift();
    if (!top) throw new GolfError('There are no cards left');
    next.held = { card: top, from: 'stock' };
  }
  return next;
}

/** Put the held card into a slot; whatever was there goes to the discard. */
export function place(state: GolfState, actor: string, index: number): GolfState {
  requireTurn(state, actor);
  if (!state.held) throw new GolfError('You are not holding a card');
  if (index < 0 || index >= GOLF_SLOTS) throw new GolfError('No such slot');
  const next = snapshot(state);
  const hand = next.hands[actor];
  const out = hand[index];
  hand[index] = { card: next.held!.card, faceUp: true };
  next.discard.push(out.card);
  next.held = null;
  return endTurn(next, actor);
}

/** Throw the held card away and turn one of your own face-down cards up.
 *  Only legal on a card taken from the stock — a card off the discard has to
 *  go into your hand, or nothing would ever be taken from it. */
export function discardAndFlip(state: GolfState, actor: string, index: number): GolfState {
  requireTurn(state, actor);
  if (!state.held) throw new GolfError('You are not holding a card');
  if (state.held.from === 'discard') throw new GolfError('A card off the discard has to go into your hand');
  if (index < 0 || index >= GOLF_SLOTS) throw new GolfError('No such slot');
  const next = snapshot(state);
  const hand = next.hands[actor];
  if (hand[index].faceUp) throw new GolfError('That one is already face up');
  hand[index].faceUp = true;
  next.discard.push(next.held!.card);
  next.held = null;
  return endTurn(next, actor);
}

export function allUp(hand: GolfSlot[]): boolean {
  return hand.every((s) => s.faceUp);
}

function endTurn(state: GolfState, actor: string): GolfState {
  state.moves += 1;

  // Going out does not end the round on the spot — everybody else gets one
  // more turn, which is the whole tension of the last lap.
  if (!state.closedBy && allUp(state.hands[actor])) {
    state.closedBy = actor;
    state.turnsLeft = state.order.length - 1;
  } else if (state.closedBy) {
    state.turnsLeft -= 1;
  }

  if (state.closedBy && state.turnsLeft <= 0) return finish(state);

  const i = state.order.indexOf(actor);
  state.turn = state.order[(i + 1) % state.order.length];
  return state;
}

function finish(state: GolfState): GolfState {
  for (const slug of state.order) state.hands[slug].forEach((s) => { s.faceUp = true; });
  const scores: Record<string, number> = {};
  for (const slug of state.order) scores[slug] = handScore(state.hands[slug]);
  state.scores = scores;
  state.phase = 'done';
  state.turn = '';
  let best = Infinity;
  let winner = '';
  for (const slug of state.order) {
    if (scores[slug] < best) { best = scores[slug]; winner = slug; }
  }
  state.winner = winner;
  return state;
}

// ── How a companion plays it ─────────────────────────────────────────────────
//
// Deliberately simple, and deliberately not perfect: the house rule is that
// nobody arrives already good at this. It takes an obviously good card, dumps
// its worst known one, and otherwise turns something over — which is roughly
// how a person plays their first evening of Golf.

/** The face-up slot costing the most, or -1 if nothing is face up. */
function worstFaceUp(hand: GolfSlot[]): number {
  let worst = -1;
  let worstValue = -Infinity;
  hand.forEach((slot, i) => {
    if (!slot.faceUp) return;
    const v = cardScore(slot.card);
    if (v > worstValue) { worstValue = v; worst = i; }
  });
  return worst;
}

function firstFaceDown(hand: GolfSlot[]): number {
  return hand.findIndex((s) => !s.faceUp);
}

export type GolfMove =
  | { take: 'discard'; place: number }
  | { take: 'stock' };

/** What this companion does on its turn, as a plain description. The caller
 *  applies it, so the decision can be tested without touching a table. */
export function decideGolfMove(state: GolfState, actor: string): GolfMove {
  const hand = state.hands[actor];
  const top = state.discard.at(-1);
  const worst = worstFaceUp(hand);
  const worstValue = worst >= 0 ? cardScore(hand[worst].card) : -Infinity;
  const down = firstFaceDown(hand);

  // A very good card off the discard is worth taking even blind.
  if (top !== undefined) {
    const v = cardScore(top);
    if (v <= 0 && down >= 0) return { take: 'discard', place: down };
    if (worst >= 0 && v < worstValue - 1) return { take: 'discard', place: worst };
  }

  // Otherwise take the unknown one and decide once you can see it.
  return { take: 'stock' };
}

/** The second half of a companion's turn, once the stock card is in their hand. */
export function decideGolfPlacement(state: GolfState, actor: string): { place: number } | { flip: number } {
  const hand = state.hands[actor];
  const held = state.held;
  if (!held) throw new GolfError('Nothing held');
  const v = cardScore(held.card);
  const worst = worstFaceUp(hand);
  const down = firstFaceDown(hand);

  if (v <= 0 && down >= 0) return { place: down };
  if (worst >= 0 && v < cardScore(hand[worst].card) - 1) return { place: worst };
  if (down >= 0) return { flip: down };
  // Nothing left to turn over, so it has to go somewhere in the hand.
  return { place: worst >= 0 ? worst : 0 };
}

export function describeForRoom(state: GolfState): string {
  if (state.phase === 'done' && state.scores) {
    const line = state.order.map((s) => `${s} ${state.scores![s]}`).join(', ');
    return `Golf, finished — ${line}. ${state.winner} wins (lowest takes it).`;
  }
  const hands = state.order.map((slug) => {
    const hand = state.hands[slug];
    const up = hand.filter((s) => s.faceUp).length;
    const shown = hand.map((s) => (s.faceUp ? s.card.replace('-', ' of ') : '??')).join(' | ');
    return `${slug} (${up}/6 up): ${shown}`;
  }).join('  //  ');
  const held = state.held ? `; holding ${state.held.card.replace('-', ' of ')} from the ${state.held.from}` : '';
  const closing = state.closedBy ? `; ${state.closedBy} is out — ${state.turnsLeft} turn(s) left` : '';
  return `Golf. Discard shows ${state.discard.at(-1)?.replace('-', ' of ') ?? 'nothing'}, ${state.stock.length} in the stock. ${state.turn}'s turn${held}${closing}. ${hands}`;
}

registerBoardDescriber('golf', (state) => describeForRoom(state as unknown as GolfState));
