// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Hearts, played in the Card Room.
//
// Fourth on the shelf and the first one worth getting good at. Four players, no
// partners, everyone quietly trying to ruin one specific person.
//
// THE RULES:
//   Thirteen each. Before a hand starts you PASS three cards — left, right,
//   across, and then a hand where nobody passes at all, rotating.
//   The two of clubs leads the first trick. You must FOLLOW SUIT if you can;
//   if you cannot, throw anything. Highest card of the led suit takes the trick
//   and leads the next one.
//   Hearts cannot be LED until a heart has been thrown away on somebody else's
//   trick — that is what "hearts are broken" means. And nothing that costs
//   points may be thrown on the very first trick.
//
// THE SCORING, which is backwards on purpose:
//   Every heart is one point. The QUEEN OF SPADES is thirteen. Points are bad.
//   Twenty-six are on the table each hand, and lowest total wins.
//   UNLESS you take ALL twenty-six — that is SHOOTING THE MOON, and then
//   everybody ELSE takes twenty-six instead of you. Which is why a hand full of
//   high hearts is either a disaster or a plan.
//
// Same idiom as the rest of the room: a pure state machine over card IDs in the
// table's opaque state blob.

import { parseCardId, type CardId, type CardSuit } from './cards.js';
import { registerBoardDescriber } from './board-describers.js';

export class HeartsError extends Error {}

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king', 'ace'];
export const QUEEN_OF_SPADES = 'spades-queen';
export const TWO_OF_CLUBS = 'clubs-2';
const MOON = 26;

export function rankValue(card: CardId): number {
  const parsed = parseCardId(card);
  if (!parsed) throw new HeartsError(`Not a card: ${card}`);
  return RANKS.indexOf(parsed.rank);
}

export function suitOf(card: CardId): CardSuit {
  const parsed = parseCardId(card);
  if (!parsed) throw new HeartsError(`Not a card: ${card}`);
  return parsed.suit;
}

/** What this card costs whoever takes the trick. */
export function pointsOf(card: CardId): number {
  if (card === QUEEN_OF_SPADES) return 13;
  return suitOf(card) === 'hearts' ? 1 : 0;
}

export type PassDirection = 'left' | 'right' | 'across' | 'hold';
const ROTATION: PassDirection[] = ['left', 'right', 'across', 'hold'];

export interface HeartsState {
  order: string[];
  hands: Record<string, CardId[]>;
  /** cards chosen to pass, before they move */
  passing: Record<string, CardId[]>;
  direction: PassDirection;
  /** which hand of the game this is, from 0 — it decides the direction */
  handNumber: number;
  trick: Array<{ slug: string; card: CardId }>;
  /** which trick of this hand we are on, from 0 — the first one has its own rules */
  trickNumber: number;
  led: CardSuit | null;
  turn: string;
  heartsBroken: boolean;
  /** points taken THIS hand, before the moon is worked out */
  taken: Record<string, number>;
  /** running totals across every hand played on this table */
  totals: Record<string, number>;
  phase: 'passing' | 'playing' | 'handOver' | 'done';
  events: string[];
  startedAt: string;
  moves: number;
}

function snapshot(state: HeartsState): HeartsState {
  return JSON.parse(JSON.stringify(state)) as HeartsState;
}

const bySuitThenRank = (a: CardId, b: CardId) =>
  suitOf(a).localeCompare(suitOf(b)) || rankValue(a) - rankValue(b);

export function directionFor(handNumber: number): PassDirection {
  return ROTATION[handNumber % ROTATION.length];
}

/** Who this player passes to, in this direction. */
export function passTarget(order: string[], slug: string, direction: PassDirection): string | null {
  if (direction === 'hold') return null;
  const i = order.indexOf(slug);
  const n = order.length;
  if (direction === 'left') return order[(i + 1) % n];
  if (direction === 'right') return order[(i - 1 + n) % n];
  return order[(i + Math.floor(n / 2)) % n];
}

export function newHearts(
  deck: CardId[],
  order: string[],
  totals?: Record<string, number> | null,
  handNumber = 0,
  startedAt = new Date().toISOString(),
): HeartsState {
  if (order.length !== 4) throw new HeartsError('Hearts is a game for exactly four');
  const hands: Record<string, CardId[]> = {};
  for (const slug of order) hands[slug] = [];
  deck.forEach((card, i) => hands[order[i % order.length]].push(card));
  for (const slug of order) hands[slug].sort(bySuitThenRank);

  const direction = directionFor(handNumber);
  const running: Record<string, number> = {};
  for (const slug of order) running[slug] = totals?.[slug] ?? 0;

  const state: HeartsState = {
    order: [...order],
    hands,
    passing: {},
    direction,
    handNumber,
    trick: [],
    trickNumber: 0,
    led: null,
    turn: '',
    heartsBroken: false,
    taken: Object.fromEntries(order.map((s) => [s, 0])),
    totals: running,
    phase: direction === 'hold' ? 'playing' : 'passing',
    events: direction === 'hold' ? ['nobody passes this hand'] : [`passing ${direction}`],
    startedAt,
    moves: 0,
  };
  if (state.phase === 'playing') state.turn = openerOf(state);
  return state;
}

function openerOf(state: HeartsState): string {
  return state.order.find((s) => state.hands[s].includes(TWO_OF_CLUBS)) ?? state.order[0];
}

/** Choose the three you are giving away. Nothing moves until everyone has. */
export function choosePass(state: HeartsState, actor: string, cards: CardId[]): HeartsState {
  if (state.phase !== 'passing') throw new HeartsError('Nobody is passing right now');
  if (cards.length !== 3) throw new HeartsError('Three cards, no more and no fewer');
  const hand = state.hands[actor];
  if (!hand) throw new HeartsError('Not at this table');
  for (const card of cards) {
    if (!hand.includes(card)) throw new HeartsError('You do not have that card');
  }
  if (new Set(cards).size !== 3) throw new HeartsError('Three different cards');
  const next = snapshot(state);
  next.passing[actor] = [...cards];
  if (next.order.every((s) => next.passing[s]?.length === 3)) return deliverPasses(next);
  return next;
}

function deliverPasses(state: HeartsState): HeartsState {
  const incoming: Record<string, CardId[]> = {};
  for (const slug of state.order) {
    const to = passTarget(state.order, slug, state.direction);
    if (!to) continue;
    incoming[to] = [...(incoming[to] ?? []), ...state.passing[slug]];
  }
  for (const slug of state.order) {
    const given = state.passing[slug] ?? [];
    state.hands[slug] = state.hands[slug].filter((c) => !given.includes(c));
  }
  for (const [slug, cards] of Object.entries(incoming)) {
    state.hands[slug].push(...cards);
    state.hands[slug].sort(bySuitThenRank);
  }
  state.passing = {};
  state.phase = 'playing';
  state.turn = openerOf(state);
  state.events.push('cards passed');
  return state;
}

/** Everything this player is allowed to throw right now. */
export function legalPlays(state: HeartsState, actor: string): CardId[] {
  const hand = state.hands[actor] ?? [];
  if (!hand.length) return [];
  const firstTrick = state.trickNumber === 0;

  // The two of clubs opens the hand, and nothing else does.
  if (firstTrick && state.trick.length === 0 && hand.includes(TWO_OF_CLUBS)) return [TWO_OF_CLUBS];

  const leading = state.trick.length === 0;
  if (leading) {
    // Hearts cannot be led until one has been thrown away, unless that is all
    // that is left in your hand.
    if (state.heartsBroken) return [...hand];
    const notHearts = hand.filter((c) => suitOf(c) !== 'hearts');
    return notHearts.length ? notHearts : [...hand];
  }

  const led = state.led as CardSuit;
  const following = hand.filter((c) => suitOf(c) === led);
  if (following.length) return following;

  // Void in the led suit: throw anything — except that nothing costing points
  // may land on the very first trick of the hand.
  if (firstTrick) {
    const safe = hand.filter((c) => pointsOf(c) === 0);
    if (safe.length) return safe;
  }
  return [...hand];
}

export function play(state: HeartsState, actor: string, card: CardId): HeartsState {
  if (state.phase !== 'playing') throw new HeartsError('Not playing right now');
  if (state.turn !== actor) throw new HeartsError(`It is ${state.turn}'s turn`);
  if (!legalPlays(state, actor).includes(card)) throw new HeartsError('That one will not do');

  const next = snapshot(state);
  next.hands[actor] = next.hands[actor].filter((c) => c !== card);
  next.trick.push({ slug: actor, card });
  if (next.trick.length === 1) next.led = suitOf(card);
  if (suitOf(card) === 'hearts') next.heartsBroken = true;
  next.moves += 1;

  if (next.trick.length < next.order.length) {
    const i = next.order.indexOf(actor);
    next.turn = next.order[(i + 1) % next.order.length];
    return next;
  }
  return takeTrick(next);
}

function takeTrick(state: HeartsState): HeartsState {
  const led = state.led as CardSuit;
  let winner = state.trick[0];
  for (const entry of state.trick) {
    if (suitOf(entry.card) === led && rankValue(entry.card) > rankValue(winner.card)) winner = entry;
  }
  const points = state.trick.reduce((sum, e) => sum + pointsOf(e.card), 0);
  state.taken[winner.slug] += points;
  state.events.push(points
    ? `${winner.slug} takes the trick and ${points} point${points === 1 ? '' : 's'}`
    : `${winner.slug} takes the trick`);
  state.trick = [];
  state.trickNumber += 1;
  state.led = null;
  state.turn = winner.slug;

  if (state.order.every((s) => state.hands[s].length === 0)) return endHand(state);
  return state;
}

/** Shooting the moon: take all twenty-six and everybody else takes them instead. */
export function applyMoon(taken: Record<string, number>, order: string[]): { scores: Record<string, number>; shooter: string | null } {
  const shooter = order.find((s) => taken[s] === MOON) ?? null;
  if (!shooter) return { scores: { ...taken }, shooter: null };
  const scores: Record<string, number> = {};
  for (const slug of order) scores[slug] = slug === shooter ? 0 : MOON;
  return { scores, shooter };
}

function endHand(state: HeartsState): HeartsState {
  const { scores, shooter } = applyMoon(state.taken, state.order);
  for (const slug of state.order) state.totals[slug] += scores[slug];
  state.taken = scores;
  state.phase = 'handOver';
  state.turn = '';
  state.events.push(shooter ? `${shooter} SHOT THE MOON` : 'hand over');
  // A hundred points ends the game, as at every table this has ever been played.
  if (state.order.some((s) => state.totals[s] >= 100)) state.phase = 'done';
  return state;
}

export function leader(state: HeartsState): string {
  let best = '';
  let bestScore = Infinity;
  for (const slug of state.order) {
    if (state.totals[slug] < bestScore) { bestScore = state.totals[slug]; best = slug; }
  }
  return best;
}

// ── How a companion plays it ─────────────────────────────────────────────────
//
// Ordinary, and it does NOT count cards. Follow suit low if the trick is
// already dangerous, throw the queen of spades away the moment it is safe to,
// and lead the lowest thing you have. Nobody at this table has read a book
// about Hearts, which is the point.

export function decideHeartsPass(state: HeartsState, actor: string): CardId[] {
  const hand = [...(state.hands[actor] ?? [])];
  // Get rid of the queen and the high spades guarding her, then the highest
  // cards you hold.
  const dangerous = hand.filter((c) => c === QUEEN_OF_SPADES
    || (suitOf(c) === 'spades' && rankValue(c) > rankValue(QUEEN_OF_SPADES)));
  const rest = hand
    .filter((c) => !dangerous.includes(c))
    .sort((a, b) => rankValue(b) - rankValue(a));
  return [...dangerous, ...rest].slice(0, 3);
}

export function decideHeartsPlay(state: HeartsState, actor: string): CardId {
  const legal = legalPlays(state, actor);
  if (!legal.length) throw new HeartsError('Nothing to play');
  const leading = state.trick.length === 0;

  if (leading) {
    // Lead the lowest card you hold, and never the queen.
    const safe = legal.filter((c) => c !== QUEEN_OF_SPADES);
    return (safe.length ? safe : legal).sort((a, b) => rankValue(a) - rankValue(b))[0];
  }

  const led = state.led as CardSuit;
  const following = legal.filter((c) => suitOf(c) === led);
  if (following.length) {
    // Duck under the highest card played if you can; otherwise take it low.
    const highest = state.trick
      .filter((e) => suitOf(e.card) === led)
      .reduce((best, e) => (rankValue(e.card) > rankValue(best.card) ? e : best), state.trick[0]);
    const under = following.filter((c) => rankValue(c) < rankValue(highest.card));
    const pool = under.length ? under : following;
    return pool.sort((a, b) => rankValue(b) - rankValue(a))[0];
  }

  // Void: this is where the queen goes.
  if (legal.includes(QUEEN_OF_SPADES)) return QUEEN_OF_SPADES;
  const hearts = legal.filter((c) => suitOf(c) === 'hearts');
  if (hearts.length) return hearts.sort((a, b) => rankValue(b) - rankValue(a))[0];
  return legal.sort((a, b) => rankValue(b) - rankValue(a))[0];
}

export function describeForRoom(state: HeartsState): string {
  const totals = state.order.map((s) => `${s} ${state.totals[s]}`).join(', ');
  if (state.phase === 'done') return `Hearts, game over — ${totals}. ${leader(state)} wins (lowest takes it).`;
  if (state.phase === 'handOver') {
    const hand = state.order.map((s) => `${s} +${state.taken[s]}`).join(', ');
    return `Hearts, hand over — ${hand}. Running: ${totals}.`;
  }
  if (state.phase === 'passing') {
    const waiting = state.order.filter((s) => !state.passing[s]);
    return `Hearts. Passing ${state.direction} — still choosing: ${waiting.join(', ') || 'nobody'}. Running: ${totals}.`;
  }
  const onTable = state.trick.map((e) => `${e.slug} ${e.card.replace('-', ' of ')}`).join(', ') || 'nothing yet';
  const broken = state.heartsBroken ? 'hearts are broken' : 'hearts not yet broken';
  return `Hearts. Trick: ${onTable}. ${state.turn}'s turn, ${broken}. Taken this hand: ${state.order.map((s) => `${s} ${state.taken[s]}`).join(', ')}. Running: ${totals}.`;
}

registerBoardDescriber('hearts', (state) => describeForRoom(state as unknown as HeartsState));
