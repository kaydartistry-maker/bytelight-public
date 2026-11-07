// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Euchre, played in the Card Room.
//
// The last one on the shelf, and the one most likely to travel off this table
// and into a real room with real people in it.
//
// THE RULES:
//   Only twenty-four cards — nine, ten, jack, queen, king, ace of each suit.
//   Five each, four left over, and the top of those four turned face up.
//   Going round once, anybody may ORDER IT UP: that suit becomes trump and the
//   dealer takes the card into their hand, throwing one away. If everybody
//   passes, going round again anybody may NAME a different suit instead. If it
//   comes back to the dealer with nobody having chosen, THE DEALER MUST PICK —
//   the version where nobody gets to waste a deal.
//
// AND THE PART THAT MAKES NO SENSE AND IS THE WHOLE GAME:
//   The jack of trump is the RIGHT BOWER and the highest card in the deck.
//   The other jack OF THE SAME COLOUR is the LEFT BOWER, second highest — and
//   it stops being its own suit entirely. If spades are trump, the jack of
//   clubs IS a spade. Nobody can defend this. Everybody does it anyway.
//
// THE SCORING:
//   Whoever chose trump are the MAKERS and must take three of the five tricks.
//   Three or four is one point. All five is two. Take fewer and you are
//   EUCHRED and the other team gets two. Go ALONE — partner's hand set aside —
//   and all five is worth four. First team to ten wins.
//
// Same idiom as the rest of the room: a pure state machine over card IDs.

import { parseCardId, type CardId, type CardSuit } from './cards.js';
import { registerBoardDescriber } from './board-describers.js';

export class EuchreError extends Error {}

const RANKS = ['9', '10', 'jack', 'queen', 'king', 'ace'];
export const EUCHRE_RANKS = RANKS;
export const GAME_TO = 10;

const SAME_COLOUR: Record<CardSuit, CardSuit> = {
  spades: 'clubs', clubs: 'spades', hearts: 'diamonds', diamonds: 'hearts',
};

function parse(card: CardId): { suit: CardSuit; rank: string } {
  const p = parseCardId(card);
  if (!p) throw new EuchreError(`Not a card: ${card}`);
  return p;
}

/** The twenty-four card deck this game is played with. */
export function euchreDeck(deck: CardId[]): CardId[] {
  return deck.filter((c) => RANKS.includes(parse(c).rank));
}

export function isRightBower(card: CardId, trump: CardSuit): boolean {
  const p = parse(card);
  return p.rank === 'jack' && p.suit === trump;
}

export function isLeftBower(card: CardId, trump: CardSuit): boolean {
  const p = parse(card);
  return p.rank === 'jack' && p.suit === SAME_COLOUR[trump];
}

/** What suit a card actually counts as. The left bower changes sides. */
export function effectiveSuit(card: CardId, trump: CardSuit): CardSuit {
  return isLeftBower(card, trump) ? trump : parse(card).suit;
}

/** How good a card is, given trump. Bowers sit above every other trump. */
export function strength(card: CardId, trump: CardSuit, led: CardSuit): number {
  if (isRightBower(card, trump)) return 1000;
  if (isLeftBower(card, trump)) return 900;
  const suit = effectiveSuit(card, trump);
  const base = RANKS.indexOf(parse(card).rank);
  if (suit === trump) return 800 + base;
  if (suit === led) return 100 + base;
  return base;
}

export interface EuchreTeam {
  players: [string, string];
  score: number;
}

export interface EuchreState {
  order: string[];
  teams: [EuchreTeam, EuchreTeam];
  hands: Record<string, CardId[]>;
  /** the four left over, with the top one face up during bidding */
  kitty: CardId[];
  upCard: CardId | null;
  dealer: string;
  trump: CardSuit | null;
  maker: string | null;
  alone: boolean;
  /** whose partner is sitting this hand out, if anyone */
  sittingOut: string | null;
  trick: Array<{ slug: string; card: CardId }>;
  trickNumber: number;
  led: CardSuit | null;
  turn: string;
  tricks: Record<string, number>;
  handNumber: number;
  /** 'bid1' is ordering up the turned card; 'bid2' is naming another suit */
  phase: 'bid1' | 'bid2' | 'discard' | 'playing' | 'handOver' | 'done';
  events: string[];
  startedAt: string;
  moves: number;
}

function snapshot(state: EuchreState): EuchreState {
  return JSON.parse(JSON.stringify(state)) as EuchreState;
}

export function teamsFor(order: string[]): [EuchreTeam, EuchreTeam] {
  if (order.length !== 4) throw new EuchreError('Euchre is a game for exactly four');
  return [
    { players: [order[0], order[2]], score: 0 },
    { players: [order[1], order[3]], score: 0 },
  ];
}

export function teamOf(state: EuchreState, slug: string): EuchreTeam {
  const team = state.teams.find((t) => t.players.includes(slug));
  if (!team) throw new EuchreError('Not at this table');
  return team;
}

export function partnerOf(state: EuchreState, slug: string): string {
  const t = teamOf(state, slug);
  return t.players[0] === slug ? t.players[1] : t.players[0];
}

export function newEuchre(
  deck: CardId[],
  order: string[],
  carry?: [EuchreTeam, EuchreTeam] | null,
  handNumber = 0,
  startedAt = new Date().toISOString(),
): EuchreState {
  if (order.length !== 4) throw new EuchreError('Euchre is a game for exactly four');
  const cards = euchreDeck(deck);
  if (cards.length < 24) throw new EuchreError('That is not a euchre deck');
  const hands: Record<string, CardId[]> = {};
  order.forEach((slug, i) => { hands[slug] = cards.slice(i * 5, i * 5 + 5); });
  const kitty = cards.slice(20, 24);

  const teams = carry
    ? ([{ players: carry[0].players, score: carry[0].score },
        { players: carry[1].players, score: carry[1].score }] as [EuchreTeam, EuchreTeam])
    : teamsFor(order);

  const dealer = order[handNumber % order.length];
  return {
    order: [...order],
    teams,
    hands,
    kitty,
    upCard: kitty[0],
    dealer,
    trump: null,
    maker: null,
    alone: false,
    sittingOut: null,
    trick: [],
    trickNumber: 0,
    led: null,
    // Bidding starts to the dealer's left.
    turn: order[(order.indexOf(dealer) + 1) % order.length],
    tricks: Object.fromEntries(order.map((s) => [s, 0])),
    handNumber,
    phase: 'bid1',
    events: [],
    startedAt,
    moves: 0,
  };
}

function beginPlay(state: EuchreState): EuchreState {
  state.phase = 'playing';
  // The hand opens to the dealer's left, unless that seat is sitting out.
  let i = (state.order.indexOf(state.dealer) + 1) % state.order.length;
  while (state.order[i] === state.sittingOut) i = (i + 1) % state.order.length;
  state.turn = state.order[i];
  return state;
}

/** Round one: take the turned card as trump, and the dealer picks it up. */
export function orderUp(state: EuchreState, actor: string, alone = false): EuchreState {
  if (state.phase !== 'bid1') throw new EuchreError('That round of bidding is over');
  if (state.turn !== actor) throw new EuchreError(`It is ${state.turn}'s call`);
  const next = snapshot(state);
  const up = next.upCard as CardId;
  next.trump = parse(up).suit;
  next.maker = actor;
  next.alone = alone;
  if (alone) next.sittingOut = partnerOf(next, actor);
  next.hands[next.dealer].push(up);
  next.kitty[0] = '';
  next.upCard = null;
  next.events.push(`${actor} orders it up — ${next.trump} is trump${alone ? ', and goes ALONE' : ''}`);
  next.phase = 'discard';
  next.turn = next.dealer;
  next.moves += 1;
  return next;
}

/** The dealer throws one away after picking the turned card up. */
export function discard(state: EuchreState, actor: string, card: CardId): EuchreState {
  if (state.phase !== 'discard') throw new EuchreError('Nothing to throw away');
  if (actor !== state.dealer) throw new EuchreError('Only the dealer discards');
  const next = snapshot(state);
  if (!next.hands[actor].includes(card)) throw new EuchreError('You do not have that card');
  next.hands[actor] = next.hands[actor].filter((c) => c !== card);
  next.moves += 1;
  return beginPlay(next);
}

/** Round two: name any suit except the one that was turned down. */
export function nameTrump(state: EuchreState, actor: string, suit: CardSuit, alone = false): EuchreState {
  if (state.phase !== 'bid2') throw new EuchreError('Not that round of bidding');
  if (state.turn !== actor) throw new EuchreError(`It is ${state.turn}'s call`);
  const turnedDown = state.kitty[0] ? parse(state.kitty[0]).suit : null;
  if (suit === turnedDown) throw new EuchreError('That suit was turned down');
  const next = snapshot(state);
  next.trump = suit;
  next.maker = actor;
  next.alone = alone;
  if (alone) next.sittingOut = partnerOf(next, actor);
  next.events.push(`${actor} names ${suit}${alone ? ' and goes ALONE' : ''}`);
  next.moves += 1;
  return beginPlay(next);
}

export function pass(state: EuchreState, actor: string): EuchreState {
  if (state.phase !== 'bid1' && state.phase !== 'bid2') throw new EuchreError('Not a bidding round');
  if (state.turn !== actor) throw new EuchreError(`It is ${state.turn}'s call`);
  const next = snapshot(state);
  next.moves += 1;
  next.events.push(`${actor} passes`);

  const isDealer = actor === next.dealer;
  if (!isDealer) {
    const i = next.order.indexOf(actor);
    next.turn = next.order[(i + 1) % next.order.length];
    return next;
  }
  if (next.phase === 'bid1') {
    // The turned card goes face down and everyone gets a second say.
    next.phase = 'bid2';
    next.upCard = null;
    next.turn = next.order[(next.order.indexOf(next.dealer) + 1) % next.order.length];
    next.events.push('turned down — name a suit');
    return next;
  }
  // STICK THE DEALER: it cannot come back round with nobody having chosen.
  throw new EuchreError('The dealer has to name something — stick the dealer');
}

export function legalPlays(state: EuchreState, actor: string): CardId[] {
  const hand = state.hands[actor] ?? [];
  if (!hand.length || !state.trump) return [];
  if (!state.trick.length) return [...hand];
  const led = state.led as CardSuit;
  const following = hand.filter((c) => effectiveSuit(c, state.trump as CardSuit) === led);
  return following.length ? following : [...hand];
}

export function play(state: EuchreState, actor: string, card: CardId): EuchreState {
  if (state.phase !== 'playing') throw new EuchreError('Not playing right now');
  if (state.turn !== actor) throw new EuchreError(`It is ${state.turn}'s turn`);
  if (!legalPlays(state, actor).includes(card)) throw new EuchreError('You have to follow suit');

  const next = snapshot(state);
  const trump = next.trump as CardSuit;
  next.hands[actor] = next.hands[actor].filter((c) => c !== card);
  next.trick.push({ slug: actor, card });
  if (next.trick.length === 1) next.led = effectiveSuit(card, trump);
  next.moves += 1;

  const seats = next.order.filter((s) => s !== next.sittingOut);
  if (next.trick.length < seats.length) {
    let i = next.order.indexOf(actor);
    do { i = (i + 1) % next.order.length; } while (next.order[i] === next.sittingOut);
    next.turn = next.order[i];
    return next;
  }
  return takeTrick(next);
}

export function trickWinner(
  trick: Array<{ slug: string; card: CardId }>,
  trump: CardSuit,
  led: CardSuit,
): string {
  return trick.reduce((best, e) =>
    (strength(e.card, trump, led) > strength(best.card, trump, led) ? e : best), trick[0]).slug;
}

function takeTrick(state: EuchreState): EuchreState {
  const winner = trickWinner(state.trick, state.trump as CardSuit, state.led as CardSuit);
  state.tricks[winner] += 1;
  state.events.push(`${winner} takes it`);
  state.trick = [];
  state.trickNumber += 1;
  state.led = null;
  state.turn = winner;
  const anyLeft = state.order.some((s) => s !== state.sittingOut && state.hands[s].length > 0);
  if (!anyLeft) return endHand(state);
  return state;
}

/** What a finished hand is worth, and to whom. */
export function scoreHand(
  makers: EuchreTeam,
  makerTricks: number,
  alone: boolean,
): { toMakers: number; toDefenders: number; line: string } {
  if (makerTricks >= 5) {
    return alone
      ? { toMakers: 4, toDefenders: 0, line: `${makers.players.join(' & ')} took all five ALONE (+4)` }
      : { toMakers: 2, toDefenders: 0, line: `${makers.players.join(' & ')} took all five (+2)` };
  }
  if (makerTricks >= 3) {
    return { toMakers: 1, toDefenders: 0, line: `${makers.players.join(' & ')} made it with ${makerTricks} (+1)` };
  }
  return { toMakers: 0, toDefenders: 2, line: `${makers.players.join(' & ')} were EUCHRED (+2 the other way)` };
}

function endHand(state: EuchreState): EuchreState {
  const makers = teamOf(state, state.maker as string);
  const defenders = state.teams.find((t) => t !== makers) as EuchreTeam;
  const makerTricks = makers.players.reduce((sum, p) => sum + (state.tricks[p] ?? 0), 0);
  const { toMakers, toDefenders, line } = scoreHand(makers, makerTricks, state.alone);
  makers.score += toMakers;
  defenders.score += toDefenders;
  state.events.push(line);
  state.phase = 'handOver';
  state.turn = '';
  if (state.teams.some((t) => t.score >= GAME_TO)) state.phase = 'done';
  return state;
}

// ── How a companion plays it ─────────────────────────────────────────────────
//
// Ordinary, and it never goes alone: going alone is a big call and a companion
// guessing at one would take their partner's hand off the table for nothing.

/** Roughly how many tricks this hand is worth if that suit is trump. */
export function handStrength(hand: CardId[], trump: CardSuit): number {
  let n = 0;
  for (const card of hand) {
    if (isRightBower(card, trump)) n += 1.5;
    else if (isLeftBower(card, trump)) n += 1.2;
    else if (effectiveSuit(card, trump) === trump) n += 0.8;
    else if (parse(card).rank === 'ace') n += 0.6;
  }
  return n;
}

export type EuchreCall =
  | { call: 'order' }
  | { call: 'name'; suit: CardSuit }
  | { call: 'pass' };

export function decideEuchreCall(state: EuchreState, actor: string): EuchreCall {
  const hand = [...(state.hands[actor] ?? [])];
  if (state.phase === 'bid1') {
    const suit = parse(state.upCard as CardId).suit;
    // The dealer gets to count the card they would pick up.
    const withUp = actor === state.dealer ? [...hand, state.upCard as CardId] : hand;
    return handStrength(withUp, suit) >= 2.4 ? { call: 'order' } : { call: 'pass' };
  }
  const turnedDown = state.kitty[0] ? parse(state.kitty[0]).suit : null;
  const options = (['spades', 'clubs', 'diamonds', 'hearts'] as CardSuit[])
    .filter((s) => s !== turnedDown)
    .map((s) => ({ suit: s, n: handStrength(hand, s) }))
    .sort((a, b) => b.n - a.n);
  const best = options[0];
  const mustCall = actor === state.dealer; // stick the dealer
  if (best && (best.n >= 2.4 || mustCall)) return { call: 'name', suit: best.suit };
  return { call: 'pass' };
}

export function decideEuchrePlay(state: EuchreState, actor: string): CardId {
  const legal = legalPlays(state, actor);
  if (!legal.length) throw new EuchreError('Nothing to play');
  const trump = state.trump as CardSuit;

  if (!state.trick.length) {
    // Lead your best card — five tricks is not long enough to be clever.
    return [...legal].sort((a, b) => strength(b, trump, effectiveSuit(b, trump)) - strength(a, trump, effectiveSuit(a, trump)))[0];
  }

  const led = state.led as CardSuit;
  const winningNow = trickWinner(state.trick, trump, led);
  const partnerWinning = winningNow === partnerOf(state, actor);
  const beats = (card: CardId) =>
    trickWinner([...state.trick, { slug: actor, card }], trump, led) === actor;

  if (partnerWinning) {
    const losers = legal.filter((c) => !beats(c));
    const pool = losers.length ? losers : legal;
    return [...pool].sort((a, b) => strength(a, trump, led) - strength(b, trump, led))[0];
  }
  const winners = legal.filter(beats);
  if (winners.length) {
    return [...winners].sort((a, b) => strength(a, trump, led) - strength(b, trump, led))[0];
  }
  return [...legal].sort((a, b) => strength(a, trump, led) - strength(b, trump, led))[0];
}

/** The dealer's throwaway after ordering up: the least useful card in hand. */
export function decideEuchreDiscard(state: EuchreState): CardId {
  const trump = state.trump as CardSuit;
  const hand = state.hands[state.dealer] ?? [];
  return [...hand].sort((a, b) => strength(a, trump, trump) - strength(b, trump, trump))[0];
}

export function describeForRoom(state: EuchreState): string {
  const scores = state.teams.map((t) => `${t.players.join(' & ')} ${t.score}`).join(' vs ');
  if (state.phase === 'done') return `Euchre, game over — ${scores}.`;
  if (state.phase === 'handOver') return `Euchre, hand over — ${scores}. ${state.events.at(-1) ?? ''}`;
  if (state.phase === 'bid1') {
    return `Euchre, bidding. ${state.upCard?.replace('-', ' of ')} is turned up, ${state.turn} to call. ${scores}.`;
  }
  if (state.phase === 'bid2') return `Euchre, second round — name a suit. ${state.turn} to call. ${scores}.`;
  if (state.phase === 'discard') return `Euchre. ${state.dealer} picks up and throws one away. ${scores}.`;
  const onTable = state.trick.map((e) => `${e.slug} ${e.card.replace('-', ' of ')}`).join(', ') || 'nothing yet';
  const alone = state.alone ? ` ${state.maker} is ALONE.` : '';
  const counts = state.order.filter((s) => s !== state.sittingOut).map((s) => `${s} ${state.tricks[s]}`).join(', ');
  return `Euchre, ${state.trump} is trump.${alone} Trick: ${onTable}. ${state.turn}'s turn. Tricks: ${counts}. ${scores}.`;
}

registerBoardDescriber('euchre', (state) => describeForRoom(state as unknown as EuchreState));
