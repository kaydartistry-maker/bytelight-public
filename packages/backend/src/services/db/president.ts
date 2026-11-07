// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// President (Scum), played in the Card Room.
//
// Third on the shelf and the first one with a memory: the round you just played
// changes how the next one is dealt.
//
// THE RULES:
//   The whole deck goes out, thirteen each. Whoever holds the three of clubs
//   leads. You play a SET — one card, or two of a kind, or three — and the next
//   person must play the same NUMBER of cards at a HIGHER rank, or pass. When
//   everybody passes, the pile is swept away and whoever played last leads
//   again with anything they like.
//   Threes are low and TWOS ARE HIGH, which is the only bit that catches people.
//   First hand empty is PRESIDENT. Last one still holding cards is SCUM.
//
// AND THE PART THAT MAKES IT A GAME ABOUT PEOPLE:
//   Next round, the Scum hands the President their BEST card and gets the
//   President's worst back. The game remembers who lost and makes them pay for
//   it, every deal, until they climb out.
//
// Same idiom as the rest of the room: a pure state machine over card IDs in the
// table's opaque state blob.

import { parseCardId, type CardId } from './cards.js';
import { registerBoardDescriber } from './board-describers.js';

export class PresidentError extends Error {}

/** Threes are low, twos are high. The whole game is in that last part. */
const ORDER = ['3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king', 'ace', '2'];

export function rankValue(card: CardId): number {
  const parsed = parseCardId(card);
  if (!parsed) throw new PresidentError(`Not a card: ${card}`);
  const i = ORDER.indexOf(parsed.rank);
  if (i < 0) throw new PresidentError(`Unrankable: ${card}`);
  return i;
}

export type PresidentTitle = 'president' | 'vice' | 'citizen' | 'scum';

export interface PresidentState {
  order: string[];
  hands: Record<string, CardId[]>;
  /** the set currently on the table, and how many cards a set must be */
  pile: CardId[][];
  setSize: number;
  turn: string;
  /** who has passed since the pile was last swept */
  passed: string[];
  /** who put the top set down — they lead again when the pile is swept */
  lastPlayed: string | null;
  /** the order people went out in, first to last */
  finished: string[];
  titles: Record<string, PresidentTitle> | null;
  phase: 'playing' | 'done';
  events: string[];
  startedAt: string;
  moves: number;
}

function snapshot(state: PresidentState): PresidentState {
  return JSON.parse(JSON.stringify(state)) as PresidentState;
}

const byRank = (a: CardId, b: CardId) => rankValue(a) - rankValue(b);

/** Titles from a finishing order: first is President, last is Scum. */
export function titlesFor(finished: string[]): Record<string, PresidentTitle> {
  const titles: Record<string, PresidentTitle> = {};
  finished.forEach((slug, i) => {
    if (i === 0) titles[slug] = 'president';
    else if (i === finished.length - 1) titles[slug] = 'scum';
    else if (i === 1) titles[slug] = 'vice';
    else titles[slug] = 'citizen';
  });
  return titles;
}

export function newPresident(
  deck: CardId[],
  order: string[],
  previous?: Record<string, PresidentTitle> | null,
  startedAt = new Date().toISOString(),
): PresidentState {
  if (order.length < 2) throw new PresidentError('President needs at least two players');
  const hands: Record<string, CardId[]> = {};
  for (const slug of order) hands[slug] = [];
  deck.forEach((card, i) => hands[order[i % order.length]].push(card));
  for (const slug of order) hands[slug].sort(byRank);

  const events: string[] = [];
  // The tax. Scum hands over its best card and takes the President's worst.
  if (previous) {
    const scum = order.find((s) => previous[s] === 'scum');
    const president = order.find((s) => previous[s] === 'president');
    if (scum && president && hands[scum].length && hands[president].length) {
      const tribute = hands[scum].pop() as CardId;
      const back = hands[president].shift() as CardId;
      hands[president].push(tribute);
      hands[scum].push(back);
      hands[president].sort(byRank);
      hands[scum].sort(byRank);
      events.push(`${scum} pays ${president}: ${tribute} for ${back}`);
    }
  }

  // Whoever holds the three of clubs opens, as at every table this game has
  // ever been played at.
  const opener = order.find((s) => hands[s].includes('clubs-3')) ?? order[0];
  return {
    order: [...order],
    hands,
    pile: [],
    setSize: 0,
    turn: opener,
    passed: [],
    lastPlayed: null,
    finished: [],
    titles: null,
    phase: 'playing',
    events,
    startedAt,
    moves: 0,
  };
}

/** Everyone still holding cards, in seat order. */
export function stillIn(state: PresidentState): string[] {
  return state.order.filter((s) => (state.hands[s]?.length ?? 0) > 0);
}

function nextLivePlayer(state: PresidentState, from: string): string {
  const live = stillIn(state).filter((s) => !state.passed.includes(s));
  if (!live.length) return '';
  const seats = state.order;
  let i = seats.indexOf(from);
  for (let step = 0; step < seats.length * 2; step += 1) {
    i = (i + 1) % seats.length;
    if (live.includes(seats[i])) return seats[i];
  }
  return live[0];
}

/** A legal set: all the same rank, the right size, and higher than the pile. */
export function canPlaySet(state: PresidentState, cards: CardId[]): boolean {
  if (!cards.length) return false;
  const first = rankValue(cards[0]);
  if (cards.some((c) => rankValue(c) !== first)) return false;
  if (!state.pile.length) return true;
  if (cards.length !== state.setSize) return false;
  const top = state.pile.at(-1) as CardId[];
  return first > rankValue(top[0]);
}

export function play(state: PresidentState, actor: string, cards: CardId[]): PresidentState {
  if (state.phase !== 'playing') throw new PresidentError('The round is over');
  if (state.turn !== actor) throw new PresidentError(`It is ${state.turn}'s turn`);
  const next = snapshot(state);
  const hand = next.hands[actor];
  for (const card of cards) {
    if (!hand.includes(card)) throw new PresidentError('You do not have that card');
  }
  if (!canPlaySet(next, cards)) throw new PresidentError('That will not beat it');

  next.hands[actor] = hand.filter((c) => !cards.includes(c));
  next.pile.push([...cards]);
  next.setSize = cards.length;
  next.lastPlayed = actor;
  next.moves += 1;

  if (!next.hands[actor].length && !next.finished.includes(actor)) {
    next.finished.push(actor);
    next.events.push(`${actor} is out`);
  }

  // One player left holding cards ends it — they are the Scum by default.
  const remaining = stillIn(next);
  if (remaining.length <= 1) {
    if (remaining.length === 1) next.finished.push(remaining[0]);
    return finish(next);
  }

  next.turn = nextLivePlayer(next, actor);
  return next;
}

export function pass(state: PresidentState, actor: string): PresidentState {
  if (state.phase !== 'playing') throw new PresidentError('The round is over');
  if (state.turn !== actor) throw new PresidentError(`It is ${state.turn}'s turn`);
  if (!state.pile.length) throw new PresidentError('You are leading — you have to play something');
  const next = snapshot(state);
  next.passed.push(actor);
  next.moves += 1;

  const live = stillIn(next).filter((s) => !next.passed.includes(s));
  if (live.length <= 1) {
    // The pile is swept and whoever played last leads again with anything.
    const leader = live[0] ?? next.lastPlayed ?? '';
    next.pile = [];
    next.setSize = 0;
    next.passed = [];
    next.lastPlayed = null;
    next.events.push('the pile is swept');
    next.turn = leader && stillIn(next).includes(leader) ? leader : (stillIn(next)[0] ?? '');
    return next;
  }

  next.turn = nextLivePlayer(next, actor);
  return next;
}

function finish(state: PresidentState): PresidentState {
  for (const slug of state.order) {
    if (!state.finished.includes(slug)) state.finished.push(slug);
  }
  state.titles = titlesFor(state.finished);
  state.phase = 'done';
  state.turn = '';
  return state;
}

// ── How a companion plays it ─────────────────────────────────────────────────
//
// Ordinary again: beat the pile with the smallest thing that will do it, keep
// the twos back, and lead the lowest set you hold. Which is roughly what a
// person works out in their second round.

export type PresidentMove = { play: CardId[] } | { pass: true };

function groups(hand: CardId[]): CardId[][] {
  const by: Record<number, CardId[]> = {};
  for (const card of hand) {
    const v = rankValue(card);
    (by[v] ??= []).push(card);
  }
  return Object.keys(by)
    .map(Number)
    .sort((a, b) => a - b)
    .map((v) => by[v]);
}

export function decidePresidentMove(state: PresidentState, actor: string): PresidentMove {
  const hand = state.hands[actor] ?? [];
  if (!hand.length) return { pass: true };
  const sets = groups(hand);

  if (!state.pile.length) {
    // Leading: put down the lowest group you have, whole.
    const lead = sets[0];
    return { play: lead };
  }

  const top = state.pile.at(-1) as CardId[];
  const need = state.setSize;
  const beat = rankValue(top[0]);
  const candidates = sets.filter((set) => set.length >= need && rankValue(set[0]) > beat);
  if (!candidates.length) return { pass: true };
  // Smallest thing that does the job, and a two is a last resort — it is the
  // highest card in the game and worth more later than now.
  const notTwos = candidates.filter((set) => parseCardId(set[0])?.rank !== '2');
  const chosen = (notTwos.length ? notTwos : candidates)[0];
  return { play: chosen.slice(0, need) };
}

export function describeForRoom(state: PresidentState): string {
  if (state.phase === 'done' && state.titles) {
    const line = state.finished.map((s) => `${s} (${state.titles![s]})`).join(', ');
    return `President, finished — ${line}.`;
  }
  const counts = state.order.map((s) => `${s} ${state.hands[s]?.length ?? 0}`).join(', ');
  const top = state.pile.at(-1);
  const showing = top ? `${top.length} x ${top[0].replace('-', ' of ')}` : 'nothing — a fresh lead';
  const passed = state.passed.length ? ` Passed: ${state.passed.join(', ')}.` : '';
  return `President. On the table: ${showing}. ${state.turn}'s turn. Hands: ${counts}.${passed}`;
}

registerBoardDescriber('president', (state) => describeForRoom(state as unknown as PresidentState));
