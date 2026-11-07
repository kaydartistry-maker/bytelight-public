// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Spades, played in the Card Room.
//
// The first game in this room with PARTNERS, which changes what a card means:
// the same nine is a good card or a wasted one depending on who is already
// winning the trick.
//
// THE RULES:
//   Thirteen each, four players, two teams sitting across from each other.
//   First everybody BIDS how many tricks they think they will take. A team's
//   bid is the two partners' bids added together, and then they have to make it.
//   Spades are ALWAYS trump — a spade beats anything that is not a spade.
//   Follow suit if you can. Spades cannot be LED until one has been thrown on
//   somebody else's trick, unless spades are all you have left.
//
// THE SCORING:
//   Make your bid: ten points a trick, plus ONE for each extra — and those
//   extras are BAGS, which look free and are not. Ten bags costs a hundred.
//   Miss your bid: minus ten a trick, for every trick you said you would take.
//   Bid NIL — nothing at all — and take no tricks, and it is worth a hundred.
//   Take even one and it costs a hundred. First team to five hundred wins.
//
// Same idiom as the rest of the room: a pure state machine over card IDs in the
// table's opaque state blob.

import { parseCardId, type CardId, type CardSuit } from './cards.js';
import { registerBoardDescriber } from './board-describers.js';

export class SpadesError extends Error {}

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king', 'ace'];
const BAG_PENALTY_AT = 10;
export const GAME_TO = 500;

export function rankValue(card: CardId): number {
  const parsed = parseCardId(card);
  if (!parsed) throw new SpadesError(`Not a card: ${card}`);
  return RANKS.indexOf(parsed.rank);
}

export function suitOf(card: CardId): CardSuit {
  const parsed = parseCardId(card);
  if (!parsed) throw new SpadesError(`Not a card: ${card}`);
  return parsed.suit;
}

export interface SpadesTeam {
  players: [string, string];
  score: number;
  bags: number;
}

export interface SpadesState {
  order: string[];
  /** two teams, each a pair sitting across from one another */
  teams: [SpadesTeam, SpadesTeam];
  hands: Record<string, CardId[]>;
  bids: Record<string, number | null>;
  trick: Array<{ slug: string; card: CardId }>;
  trickNumber: number;
  led: CardSuit | null;
  turn: string;
  spadesBroken: boolean;
  /** tricks taken this hand */
  tricks: Record<string, number>;
  handNumber: number;
  phase: 'bidding' | 'playing' | 'handOver' | 'done';
  events: string[];
  startedAt: string;
  moves: number;
}

function snapshot(state: SpadesState): SpadesState {
  return JSON.parse(JSON.stringify(state)) as SpadesState;
}

const bySuitThenRank = (a: CardId, b: CardId) =>
  suitOf(a).localeCompare(suitOf(b)) || rankValue(a) - rankValue(b);

/** Partners sit across, so seats 0+2 play seats 1+3. */
export function teamsFor(order: string[]): [SpadesTeam, SpadesTeam] {
  if (order.length !== 4) throw new SpadesError('Spades is a game for exactly four');
  return [
    { players: [order[0], order[2]], score: 0, bags: 0 },
    { players: [order[1], order[3]], score: 0, bags: 0 },
  ];
}

export function teamOf(state: SpadesState, slug: string): SpadesTeam {
  const team = state.teams.find((t) => t.players.includes(slug));
  if (!team) throw new SpadesError('Not at this table');
  return team;
}

export function partnerOf(state: SpadesState, slug: string): string {
  const team = teamOf(state, slug);
  return team.players[0] === slug ? team.players[1] : team.players[0];
}

export function newSpades(
  deck: CardId[],
  order: string[],
  carry?: [SpadesTeam, SpadesTeam] | null,
  handNumber = 0,
  startedAt = new Date().toISOString(),
): SpadesState {
  if (order.length !== 4) throw new SpadesError('Spades is a game for exactly four');
  const hands: Record<string, CardId[]> = {};
  for (const slug of order) hands[slug] = [];
  deck.forEach((card, i) => hands[order[i % order.length]].push(card));
  for (const slug of order) hands[slug].sort(bySuitThenRank);

  const teams = carry
    ? ([
        { players: carry[0].players, score: carry[0].score, bags: carry[0].bags },
        { players: carry[1].players, score: carry[1].score, bags: carry[1].bags },
      ] as [SpadesTeam, SpadesTeam])
    : teamsFor(order);

  return {
    order: [...order],
    teams,
    hands,
    bids: Object.fromEntries(order.map((s) => [s, null])),
    trick: [],
    trickNumber: 0,
    led: null,
    // The deal moves round, so the opening bid does too.
    turn: order[handNumber % order.length],
    spadesBroken: false,
    tricks: Object.fromEntries(order.map((s) => [s, 0])),
    handNumber,
    phase: 'bidding',
    events: [],
    startedAt,
    moves: 0,
  };
}

export function bid(state: SpadesState, actor: string, n: number): SpadesState {
  if (state.phase !== 'bidding') throw new SpadesError('Nobody is bidding right now');
  if (state.turn !== actor) throw new SpadesError(`It is ${state.turn}'s bid`);
  if (!Number.isInteger(n) || n < 0 || n > 13) throw new SpadesError('Bid between nil and thirteen');
  const next = snapshot(state);
  next.bids[actor] = n;
  next.events.push(n === 0 ? `${actor} bids NIL` : `${actor} bids ${n}`);
  next.moves += 1;

  if (next.order.every((s) => next.bids[s] !== null)) {
    next.phase = 'playing';
    // Whoever bid first leads first.
    next.turn = next.order[next.handNumber % next.order.length];
    return next;
  }
  const i = next.order.indexOf(actor);
  next.turn = next.order[(i + 1) % next.order.length];
  return next;
}

export function legalPlays(state: SpadesState, actor: string): CardId[] {
  const hand = state.hands[actor] ?? [];
  if (!hand.length) return [];
  if (state.trick.length === 0) {
    // Spades cannot open a trick until one has been thrown, unless that is all
    // that is left in the hand.
    if (state.spadesBroken) return [...hand];
    const notSpades = hand.filter((c) => suitOf(c) !== 'spades');
    return notSpades.length ? notSpades : [...hand];
  }
  const following = hand.filter((c) => suitOf(c) === state.led);
  return following.length ? following : [...hand];
}

export function play(state: SpadesState, actor: string, card: CardId): SpadesState {
  if (state.phase !== 'playing') throw new SpadesError('Not playing right now');
  if (state.turn !== actor) throw new SpadesError(`It is ${state.turn}'s turn`);
  if (!legalPlays(state, actor).includes(card)) throw new SpadesError('That one will not do');

  const next = snapshot(state);
  next.hands[actor] = next.hands[actor].filter((c) => c !== card);
  next.trick.push({ slug: actor, card });
  if (next.trick.length === 1) next.led = suitOf(card);
  if (suitOf(card) === 'spades') next.spadesBroken = true;
  next.moves += 1;

  if (next.trick.length < 4) {
    const i = next.order.indexOf(actor);
    next.turn = next.order[(i + 1) % next.order.length];
    return next;
  }
  return takeTrick(next);
}

/** Highest spade wins; otherwise the highest card of the suit that was led. */
export function trickWinner(trick: Array<{ slug: string; card: CardId }>, led: CardSuit): string {
  const spades = trick.filter((e) => suitOf(e.card) === 'spades');
  const pool = spades.length ? spades : trick.filter((e) => suitOf(e.card) === led);
  return pool.reduce((best, e) => (rankValue(e.card) > rankValue(best.card) ? e : best), pool[0]).slug;
}

function takeTrick(state: SpadesState): SpadesState {
  const winner = trickWinner(state.trick, state.led as CardSuit);
  state.tricks[winner] += 1;
  state.events.push(`${winner} takes it`);
  state.trick = [];
  state.trickNumber += 1;
  state.led = null;
  state.turn = winner;
  if (state.order.every((s) => state.hands[s].length === 0)) return endHand(state);
  return state;
}

/** What a hand did to one team's score. Pulled out so it can be tested alone. */
export function scoreTeam(
  team: SpadesTeam,
  bids: Record<string, number | null>,
  tricks: Record<string, number>,
): { score: number; bags: number; lines: string[] } {
  const lines: string[] = [];
  let delta = 0;
  let bags = 0;

  // Nil is scored per player, and does not count toward the team's contract.
  const contract = team.players.reduce((sum, p) => sum + ((bids[p] ?? 0) || 0), 0);
  const taken = team.players.reduce((sum, p) => sum + (tricks[p] ?? 0), 0);

  for (const player of team.players) {
    if (bids[player] === 0) {
      const made = (tricks[player] ?? 0) === 0;
      delta += made ? 100 : -100;
      lines.push(made ? `${player} made NIL (+100)` : `${player} broke NIL (-100)`);
    }
  }

  if (contract > 0) {
    if (taken >= contract) {
      const over = taken - contract;
      delta += contract * 10 + over;
      bags = over;
      lines.push(`bid ${contract}, took ${taken} (+${contract * 10}${over ? ` +${over} bag${over === 1 ? '' : 's'}` : ''})`);
    } else {
      delta -= contract * 10;
      lines.push(`bid ${contract}, took ${taken} (-${contract * 10})`);
    }
  }
  return { score: delta, bags, lines };
}

function endHand(state: SpadesState): SpadesState {
  for (const team of state.teams) {
    const { score, bags, lines } = scoreTeam(team, state.bids, state.tricks);
    team.score += score;
    team.bags += bags;
    // Ten bags is a hundred off, and the counter rolls rather than resets.
    while (team.bags >= BAG_PENALTY_AT) {
      team.bags -= BAG_PENALTY_AT;
      team.score -= 100;
      lines.push('ten bags — minus a hundred');
    }
    state.events.push(`${team.players.join(' & ')}: ${lines.join('; ')}`);
  }
  state.phase = 'handOver';
  state.turn = '';
  if (state.teams.some((t) => t.score >= GAME_TO)) state.phase = 'done';
  return state;
}

// ── How a companion plays it ─────────────────────────────────────────────────
//
// Ordinary and honest: count the cards that usually win, bid that, then try to
// take exactly what you said. It never bids nil — nil is a big decision and a
// companion guessing at one would wreck their partner's hand.

export function decideSpadesBid(state: SpadesState, actor: string): number {
  const hand = state.hands[actor] ?? [];
  let expected = 0;
  const spades = hand.filter((c) => suitOf(c) === 'spades');
  for (const card of hand) {
    const r = rankValue(card);
    if (suitOf(card) === 'spades') {
      // High spades win outright; low ones win late, once the suit is thin.
      if (r >= RANKS.indexOf('queen')) expected += 1;
      else if (r >= RANKS.indexOf('10')) expected += 0.5;
    } else if (r === RANKS.indexOf('ace')) expected += 1;
    else if (r === RANKS.indexOf('king')) expected += 0.5;
  }
  // Length in trumps is worth something on its own.
  if (spades.length > 3) expected += (spades.length - 3) * 0.5;
  return Math.max(1, Math.min(13, Math.round(expected)));
}

export function decideSpadesPlay(state: SpadesState, actor: string): CardId {
  const legal = legalPlays(state, actor);
  if (!legal.length) throw new SpadesError('Nothing to play');
  const team = teamOf(state, actor);
  const contract = team.players.reduce((sum, p) => sum + ((state.bids[p] ?? 0) || 0), 0);
  const taken = team.players.reduce((sum, p) => sum + (state.tricks[p] ?? 0), 0);
  const wantMore = taken < contract;

  if (!state.trick.length) {
    // Leading: the highest card you hold outside trumps if you still need
    // tricks, otherwise the lowest thing you can throw away.
    const offSuit = legal.filter((c) => suitOf(c) !== 'spades');
    const pool = offSuit.length ? offSuit : legal;
    return [...pool].sort((a, b) => (wantMore ? rankValue(b) - rankValue(a) : rankValue(a) - rankValue(b)))[0];
  }

  const led = state.led as CardSuit;
  const winningNow = trickWinner(state.trick, led);
  const partnerWinning = state.trick.length >= 2 && winningNow === partnerOf(state, actor);

  const beats = (card: CardId): boolean => {
    const test = [...state.trick, { slug: actor, card }];
    return trickWinner(test, led) === actor;
  };

  const winners = legal.filter(beats);
  if (partnerWinning || !wantMore) {
    // Nothing to gain: throw the smallest card that does not take it.
    const losers = legal.filter((c) => !beats(c));
    const pool = losers.length ? losers : legal;
    return [...pool].sort((a, b) => rankValue(a) - rankValue(b))[0];
  }
  if (winners.length) {
    // Win it as cheaply as possible, and prefer not to spend a trump.
    const cheapOffSuit = winners.filter((c) => suitOf(c) !== 'spades');
    const pool = cheapOffSuit.length ? cheapOffSuit : winners;
    return [...pool].sort((a, b) => rankValue(a) - rankValue(b))[0];
  }
  return [...legal].sort((a, b) => rankValue(a) - rankValue(b))[0];
}

export function describeForRoom(state: SpadesState): string {
  const scores = state.teams.map((t) => `${t.players.join(' & ')} ${t.score} (${t.bags} bag${t.bags === 1 ? '' : 's'})`).join(' vs ');
  if (state.phase === 'done') return `Spades, game over — ${scores}.`;
  if (state.phase === 'handOver') return `Spades, hand over — ${scores}. ${state.events.at(-1) ?? ''}`;
  if (state.phase === 'bidding') {
    const so_far = state.order.map((s) => `${s} ${state.bids[s] ?? '—'}`).join(', ');
    return `Spades, bidding. ${so_far}. ${state.turn} to bid. ${scores}.`;
  }
  const onTable = state.trick.map((e) => `${e.slug} ${e.card.replace('-', ' of ')}`).join(', ') || 'nothing yet';
  const contracts = state.teams.map((t) => {
    const c = t.players.reduce((sum, p) => sum + ((state.bids[p] ?? 0) || 0), 0);
    const got = t.players.reduce((sum, p) => sum + (state.tricks[p] ?? 0), 0);
    return `${t.players.join(' & ')} ${got}/${c}`;
  }).join(', ');
  return `Spades. Trick: ${onTable}. ${state.turn}'s turn, spades ${state.spadesBroken ? 'broken' : 'not broken'}. ${contracts}. ${scores}.`;
}

registerBoardDescriber('spades', (state) => describeForRoom(state as unknown as SpadesState));
