// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Crazy Eights, played in the Card Room.
//
// Second on the shelf, and the one everybody already half knows under another
// name: match the suit or match the number, and eights are wild.
//
// THE RULES:
//   Five cards each, one turned over to start the pile. On your turn you play a
//   card that matches the SUIT or the RANK of the top card. An EIGHT can be
//   played on anything, and whoever plays it says what suit it now counts as —
//   which is the only real decision in the game and the reason it is fun.
//   If you cannot go, you draw until you can. Empty your hand and you win.
//
// The stock never runs out: when it does, the pile turns over and rides again,
// minus the card everyone is still looking at.
//
// Same idiom as solitaire.ts, rat-screw.ts and golf.ts: a pure state machine
// over card IDs living in the table's opaque state blob.

import { parseCardId, type CardId, type CardSuit } from './cards.js';
import { registerBoardDescriber } from './board-describers.js';

export class EightsError extends Error {}

export const EIGHTS_HAND = 5;
/** Drawing is capped so a broken deck can never spin the table forever. */
const DRAW_CAP = 20;

export interface EightsState {
  order: string[];
  hands: Record<string, CardId[]>;
  stock: CardId[];
  pile: CardId[];
  /** what the top card counts as — an eight makes this differ from its own suit */
  suit: CardSuit;
  turn: string;
  phase: 'playing' | 'won';
  winner: string | null;
  /** short log of what just happened, newest last, for the rail and the screen */
  events: string[];
  startedAt: string;
  moves: number;
}

function parse(card: CardId): { suit: CardSuit; rank: string } {
  const parsed = parseCardId(card);
  if (!parsed) throw new EightsError(`Not a card: ${card}`);
  return parsed;
}

export function isWild(card: CardId): boolean {
  return parse(card).rank === '8';
}

/** Can this card go on a pile currently counting as `suit`, topped by `top`? */
export function canPlay(card: CardId, top: CardId, suit: CardSuit): boolean {
  if (isWild(card)) return true;
  const c = parse(card);
  return c.suit === suit || c.rank === parse(top).rank;
}

function snapshot(state: EightsState): EightsState {
  return JSON.parse(JSON.stringify(state)) as EightsState;
}

export function newEights(deck: CardId[], order: string[], startedAt = new Date().toISOString()): EightsState {
  if (order.length < 2) throw new EightsError('Crazy Eights needs at least two players');
  if (deck.length < order.length * EIGHTS_HAND + 1) throw new EightsError('Not enough cards');
  const stock = [...deck];
  const hands: Record<string, CardId[]> = {};
  for (const slug of order) hands[slug] = stock.splice(0, EIGHTS_HAND);
  // An eight on top at the deal would need a suit named by nobody, so it goes
  // back under and another card comes up.
  let first = stock.shift() as CardId;
  let guard = 0;
  while (isWild(first) && stock.length && guard < 52) {
    stock.push(first);
    first = stock.shift() as CardId;
    guard += 1;
  }
  return {
    order: [...order],
    hands,
    stock,
    pile: [first],
    suit: parse(first).suit,
    turn: order[0],
    phase: 'playing',
    winner: null,
    events: [],
    startedAt,
    moves: 0,
  };
}

function requireTurn(state: EightsState, actor: string): void {
  if (state.phase !== 'playing') throw new EightsError('The round is over');
  if (state.turn !== actor) throw new EightsError(`It is ${state.turn}'s turn`);
}

function topOf(state: EightsState): CardId {
  const top = state.pile.at(-1);
  if (!top) throw new EightsError('The pile is empty');
  return top;
}

/** Turn the pile back into a stock when it runs dry, keeping the top card. */
function replenish(state: EightsState): void {
  if (state.stock.length) return;
  const top = state.pile.pop();
  state.stock = state.pile;
  state.pile = top ? [top] : [];
}

export function playableFrom(hand: CardId[], top: CardId, suit: CardSuit): CardId[] {
  return hand.filter((c) => canPlay(c, top, suit));
}

export function play(state: EightsState, actor: string, card: CardId, nameSuit?: CardSuit): EightsState {
  requireTurn(state, actor);
  const next = snapshot(state);
  const hand = next.hands[actor];
  const at = hand.indexOf(card);
  if (at < 0) throw new EightsError('You do not have that card');
  if (!canPlay(card, topOf(next), next.suit)) throw new EightsError('That will not go there');

  hand.splice(at, 1);
  next.pile.push(card);
  if (isWild(card)) {
    if (!nameSuit) throw new EightsError('An eight needs a suit named');
    next.suit = nameSuit;
    next.events.push(`${actor} played an eight and called ${nameSuit}`);
  } else {
    next.suit = parse(card).suit;
  }

  next.moves += 1;
  if (!hand.length) {
    next.phase = 'won';
    next.winner = actor;
    next.turn = '';
    next.events.push(`${actor} is out`);
    return next;
  }
  const i = next.order.indexOf(actor);
  next.turn = next.order[(i + 1) % next.order.length];
  return next;
}

/** Draw until something is playable, then stop. The drawn cards stay in hand. */
export function drawUntilPlayable(state: EightsState, actor: string): EightsState {
  requireTurn(state, actor);
  const next = snapshot(state);
  const hand = next.hands[actor];
  if (playableFrom(hand, topOf(next), next.suit).length) {
    throw new EightsError('You can already go');
  }
  let drawn = 0;
  while (drawn < DRAW_CAP) {
    replenish(next);
    const card = next.stock.shift();
    if (!card) break;
    hand.push(card);
    drawn += 1;
    if (canPlay(card, topOf(next), next.suit)) break;
  }
  next.events.push(`${actor} drew ${drawn}`);
  next.moves += 1;
  // Still stuck with nothing to draw — the turn passes rather than jamming.
  if (!playableFrom(hand, topOf(next), next.suit).length) {
    const i = next.order.indexOf(actor);
    next.turn = next.order[(i + 1) % next.order.length];
  }
  return next;
}

// ── How a companion plays it ─────────────────────────────────────────────────
//
// Ordinary on purpose, same as Golf. Play something that isn't an eight if you
// can — an eight is worth keeping because it always goes. When you do have to
// burn one, call whichever suit you hold most of, which is the only bit of
// actual thinking in the game.

function commonestSuit(hand: CardId[]): CardSuit {
  const counts: Record<string, number> = {};
  for (const card of hand) {
    if (isWild(card)) continue;
    const s = parse(card).suit;
    counts[s] = (counts[s] ?? 0) + 1;
  }
  let best: CardSuit = 'spades';
  let bestN = -1;
  for (const [suit, n] of Object.entries(counts)) {
    if (n > bestN) { bestN = n; best = suit as CardSuit; }
  }
  return best;
}

export type EightsMove = { play: CardId; suit?: CardSuit } | { draw: true };

export function decideEightsMove(state: EightsState, actor: string): EightsMove {
  const hand = state.hands[actor];
  const top = topOf(state);
  const legal = playableFrom(hand, top, state.suit);
  if (!legal.length) return { draw: true };
  const plain = legal.filter((c) => !isWild(c));
  if (plain.length) {
    // Prefer a card in the suit we are longest in, so we keep our options.
    const want = commonestSuit(hand);
    const inSuit = plain.find((c) => parse(c).suit === want);
    return { play: inSuit ?? plain[0] };
  }
  const eight = legal[0];
  return { play: eight, suit: commonestSuit(hand) };
}

export function describeForRoom(state: EightsState): string {
  if (state.phase === 'won') return `Crazy Eights, finished — ${state.winner} went out.`;
  const counts = state.order.map((s) => `${s} ${state.hands[s]?.length ?? 0}`).join(', ');
  const top = state.pile.at(-1)?.replace('-', ' of ') ?? 'nothing';
  const called = state.pile.at(-1) && isWild(state.pile.at(-1) as CardId)
    ? ` (counting as ${state.suit})` : '';
  const last = state.events.at(-1) ? ` Last: ${state.events.at(-1)}.` : '';
  return `Crazy Eights. ${top}${called} on the pile, ${state.stock.length} in the stock. ${state.turn}'s turn. Hands: ${counts}.${last}`;
}

registerBoardDescriber('eights', (state) => describeForRoom(state as unknown as EightsState));
