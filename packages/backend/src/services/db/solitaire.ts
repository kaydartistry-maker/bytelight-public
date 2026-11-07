// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Klondike, played in the Card Room.
//
// The whole game is a pure state machine over card IDs. It never touches the
// database and never reaches for a clock: the Card Room's table already stores
// which game is running and hands it an opaque state blob, so this file is what
// goes in that blob and nothing here needed a migration.
//
// House rules, decided rather than defaulted:
//   - unlimited redeals; the stock cycles as often as the player likes
//   - no score. It is played to wind down, not to be graded.
//     Moves and elapsed time are tracked so the room has something to say, and
//     neither is the point.
//   - unlimited undo
//   - draw one, or draw three with only the top of the three live — the classic
//     rule, not a variant
import {
  CARD_RANKS,
  parseCardId,
  shuffle,
  type CardId,
  type CardSuit,
} from './cards.js';
import { registerBoardDescriber } from './board-describers.js';

export type Pile = 'stock' | 'waste' | 'foundation' | 'tableau';

export interface TableauCard {
  card: CardId;
  faceUp: boolean;
}

export interface KlondikeState {
  drawCount: 1 | 3;
  stock: CardId[];
  waste: CardId[];
  /** keyed by suit; each is an ascending run from the ace */
  foundations: Record<CardSuit, CardId[]>;
  /** seven piles, left to right; only the last card of each starts face up */
  tableau: TableauCard[][];
  moves: number;
  startedAt: string;
  wonAt: string | null;
  /** bounded so a long game cannot grow the row without limit */
  history: string[];
}

export class SolitaireError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

const RED: CardSuit[] = ['hearts', 'diamonds'];
const HISTORY_LIMIT = 200;

function rankValue(card: CardId): number {
  const parsed = parseCardId(card);
  if (!parsed) throw new SolitaireError(`${card} is not a card`, 500);
  return CARD_RANKS.indexOf(parsed.rank) + 1; // ace = 1 … king = 13
}

function suitOf(card: CardId): CardSuit {
  const parsed = parseCardId(card);
  if (!parsed) throw new SolitaireError(`${card} is not a card`, 500);
  return parsed.suit;
}

function isRed(card: CardId): boolean {
  return RED.includes(suitOf(card));
}

export function newKlondike(deck: CardId[], drawCount: 1 | 3, startedAt: string): KlondikeState {
  const cards = shuffle(deck);
  const tableau: TableauCard[][] = [];
  let cut = 0;
  for (let pile = 0; pile < 7; pile++) {
    const take = cards.slice(cut, cut + pile + 1);
    cut += pile + 1;
    tableau.push(take.map((card, i) => ({ card, faceUp: i === pile })));
  }
  return {
    drawCount,
    stock: cards.slice(cut),
    waste: [],
    foundations: { spades: [], clubs: [], diamonds: [], hearts: [] },
    tableau,
    moves: 0,
    startedAt,
    wonAt: null,
    history: [],
  };
}

function snapshot(state: KlondikeState): KlondikeState {
  const { history, ...rest } = state;
  return {
    ...structuredClone(rest),
    history: [...history, JSON.stringify(rest)].slice(-HISTORY_LIMIT),
  };
}

/** Turn the top of the stock over. An empty stock recycles the waste, face down. */
export function draw(state: KlondikeState): KlondikeState {
  const next = snapshot(state);
  if (next.stock.length === 0) {
    if (next.waste.length === 0) throw new SolitaireError('Nothing left to turn');
    // Unlimited redeals, on purpose. The waste goes back in the order it was
    // laid down, so a cycle is deterministic rather than a reshuffle.
    next.stock = [...next.waste].reverse();
    next.waste = [];
    next.moves += 1;
    return next;
  }
  const take = Math.min(next.drawCount, next.stock.length);
  for (let i = 0; i < take; i++) next.waste.push(next.stock.pop()!);
  next.moves += 1;
  return next;
}

/** Only the last card of the waste is live — that is the whole point of draw three. */
export function wasteTop(state: KlondikeState): CardId | null {
  return state.waste.at(-1) ?? null;
}

/**
 * ANY ACE ON ANY EMPTY PILE IS THE REAL RULE, AND OUR PILES ARE LABELLED.
 *
 * Reported Sep 17 2026: Finish It did nothing and still
 * answered 200. The cause is the collision between those two facts. An empty
 * foundation accepted any ace, so the ace of hearts could start the pile keyed
 * `spades` — and from then on every lookup that asks for `foundations[suitOf(card)]`
 * is pointed at the wrong pile. autoFinish asks exactly that, finds a pile it
 * cannot build on, moves nothing, and reports success.
 *
 * The slot is labelled, so the label is now the rule: an empty foundation takes
 * the ace OF ITS OWN SUIT. Nothing is lost — there are always four slots and
 * every ace has one — and the invariant every other lookup already assumed is
 * true by construction instead of by luck.
 *
 * `slotSuit` is optional because a mixed pile saved before this existed must
 * still be finishable; foundationHolding below is what reaches those.
 */
function canSitOnFoundation(card: CardId, foundation: CardId[], slotSuit?: CardSuit): boolean {
  const value = rankValue(card);
  if (foundation.length === 0) return value === 1 && (slotSuit === undefined || suitOf(card) === slotSuit);
  return suitOf(card) === suitOf(foundation[0]) && value === rankValue(foundation.at(-1)!) + 1;
}

/**
 * The pile a suit is ACTUALLY in, which is not always the one named after it.
 * A game that was played before the rule above existed can have hearts sitting
 * in the spades slot; this is what lets such a game still be finished.
 */
function foundationHolding(state: KlondikeState, suit: CardSuit): CardSuit {
  const suits = Object.keys(state.foundations) as CardSuit[];
  const occupied = suits.find((s) => state.foundations[s].length > 0 && suitOf(state.foundations[s][0]) === suit);
  if (occupied) return occupied;
  // Otherwise its own slot, if that slot is free for it.
  return suit;
}

function canSitOnTableau(card: CardId, pile: TableauCard[]): boolean {
  if (pile.length === 0) return rankValue(card) === 13; // an empty column takes a king
  const top = pile.at(-1)!;
  if (!top.faceUp) return false;
  return isRed(card) !== isRed(top.card) && rankValue(card) === rankValue(top.card) - 1;
}

export interface MoveRequest {
  from: Pile;
  /** tableau column index, or the foundation suit */
  fromIndex?: number;
  fromSuit?: CardSuit;
  /** how many cards from the top of a tableau column — a run moves together */
  count?: number;
  to: Pile;
  toIndex?: number;
  toSuit?: CardSuit;
}

function liftFrom(state: KlondikeState, req: MoveRequest): CardId[] {
  if (req.from === 'waste') {
    const top = wasteTop(state);
    if (!top) throw new SolitaireError('The waste is empty');
    return [top];
  }
  if (req.from === 'foundation') {
    const suit = req.fromSuit;
    if (!suit) throw new SolitaireError('Which foundation?');
    const top = state.foundations[suit].at(-1);
    if (!top) throw new SolitaireError('That foundation is empty');
    return [top];
  }
  if (req.from === 'tableau') {
    const pile = state.tableau[req.fromIndex ?? -1];
    if (!pile) throw new SolitaireError('No such column');
    const count = req.count ?? 1;
    if (count < 1 || count > pile.length) throw new SolitaireError('Not that many cards there');
    const run = pile.slice(pile.length - count);
    if (run.some((c) => !c.faceUp)) throw new SolitaireError('Those cards are face down');
    // A run only moves as a unit if it is already a legal sequence.
    for (let i = 1; i < run.length; i++) {
      const above = run[i - 1].card;
      const below = run[i].card;
      if (isRed(above) === isRed(below) || rankValue(below) !== rankValue(above) - 1) {
        throw new SolitaireError('That is not a run');
      }
    }
    return run.map((c) => c.card);
  }
  throw new SolitaireError('You cannot take from the stock');
}

export function applyMove(state: KlondikeState, req: MoveRequest): KlondikeState {
  const moving = liftFrom(state, req);
  const head = moving[0];

  if (req.to === 'foundation') {
    if (moving.length !== 1) throw new SolitaireError('Foundations take one card at a time');
    const suit = req.toSuit ?? foundationHolding(state, suitOf(head));
    if (!canSitOnFoundation(head, state.foundations[suit], suit)) {
      throw new SolitaireError('That will not go there');
    }
  } else if (req.to === 'tableau') {
    const pile = state.tableau[req.toIndex ?? -1];
    if (!pile) throw new SolitaireError('No such column');
    if (!canSitOnTableau(head, pile)) throw new SolitaireError('That will not go there');
  } else {
    throw new SolitaireError('Cards do not go back to the stock');
  }

  const next = snapshot(state);

  if (req.from === 'waste') next.waste.pop();
  else if (req.from === 'foundation') next.foundations[req.fromSuit!].pop();
  else if (req.from === 'tableau') {
    const pile = next.tableau[req.fromIndex!];
    pile.splice(pile.length - moving.length, moving.length);
    // Uncovering turns the new top face up. This is the only place the game
    // reveals anything, and it is what makes a move worth making.
    const uncovered = pile.at(-1);
    if (uncovered && !uncovered.faceUp) uncovered.faceUp = true;
  }

  if (req.to === 'foundation') next.foundations[req.toSuit ?? foundationHolding(state, suitOf(head))].push(head);
  else next.tableau[req.toIndex!].push(...moving.map((card) => ({ card, faceUp: true })));

  next.moves += 1;
  if (isWon(next)) next.wonAt = new Date().toISOString();
  return next;
}

export function isWon(state: KlondikeState): boolean {
  return (Object.keys(state.foundations) as CardSuit[])
    .every((suit) => state.foundations[suit].length === 13);
}

/**
 * Whether the game is decided: every card face up, nothing hidden. From here
 * finishing is arithmetic rather than skill, which is exactly when a person
 * wants a button instead of forty more clicks.
 */
export function canAutoFinish(state: KlondikeState): boolean {
  if (isWon(state)) return false;
  if (state.stock.length > 0 || state.waste.length > 0) return false;
  return state.tableau.every((pile) => pile.every((c) => c.faceUp));
}

/** Fly every card home, lowest first. Returns the order so the phone can animate it. */
export function autoFinish(state: KlondikeState): { state: KlondikeState; order: CardId[] } {
  if (!canAutoFinish(state)) throw new SolitaireError('Not everything is showing yet');
  const next = snapshot(state);
  const order: CardId[] = [];
  let moved = true;
  while (moved && !isWon(next)) {
    moved = false;
    for (let i = 0; i < next.tableau.length; i++) {
      const top = next.tableau[i].at(-1);
      if (!top) continue;
      const suit = foundationHolding(next, suitOf(top.card));
      if (!canSitOnFoundation(top.card, next.foundations[suit], suit)) continue;
      next.tableau[i].pop();
      next.foundations[suit].push(top.card);
      order.push(top.card);
      next.moves += 1;
      moved = true;
    }
  }
  if (isWon(next)) next.wonAt = new Date().toISOString();
  return { state: next, order };
}

export function undo(state: KlondikeState): KlondikeState {
  const previous = state.history.at(-1);
  if (!previous) throw new SolitaireError('Nothing to undo');
  const restored = JSON.parse(previous) as Omit<KlondikeState, 'history'>;
  return { ...restored, history: state.history.slice(0, -1) };
}

/**
 * What the companions get. They can see the whole board on purpose — the point
 * of them being at the table is that they are watching THIS game rather than
 * making conversation next to it.
 */
export function describeForRoom(state: KlondikeState): string {
  const foundations = (Object.keys(state.foundations) as CardSuit[])
    .map((suit) => `${suit}: ${state.foundations[suit].at(-1) ?? 'empty'}`).join(', ');
  const columns = state.tableau.map((pile, i) => {
    const hidden = pile.filter((c) => !c.faceUp).length;
    const shown = pile.filter((c) => c.faceUp).map((c) => c.card).join(' ');
    return `  ${i + 1}: ${hidden} down${shown ? ` | ${shown}` : ''}`;
  }).join('\n');
  return [
    `Draw ${state.drawCount}. ${state.moves} moves.`,
    `Stock ${state.stock.length}, waste ${state.waste.length} (top ${wasteTop(state) ?? 'none'}).`,
    `Foundations — ${foundations}`,
    'Columns:',
    columns,
  ].join('\n');
}

// The table asks the game to describe itself for the room, so the companions
// see what the player sees. Registered here rather than switched on in cards.ts,
// which would put a second game's name inside the thing that must not know it.
registerBoardDescriber('klondike', (state) => describeForRoom(state as unknown as KlondikeState));
