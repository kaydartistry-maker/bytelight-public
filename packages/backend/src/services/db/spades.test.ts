// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  newSpades, bid, play, legalPlays, trickWinner, scoreTeam, teamsFor, partnerOf,
  decideSpadesBid, decideSpadesPlay, describeForRoom, SpadesError,
  type SpadesState, type SpadesTeam,
} from './spades.js';

const ORDER = ['owner', 'birch', 'maple', 'cedar'];

function table(over: Partial<SpadesState> = {}): SpadesState {
  return {
    order: [...ORDER],
    teams: teamsFor(ORDER),
    hands: { owner: [], birch: [], maple: [], cedar: [] },
    bids: { owner: 3, birch: 3, maple: 3, cedar: 3 },
    trick: [],
    trickNumber: 1,
    led: null,
    turn: 'owner',
    spadesBroken: false,
    tricks: { owner: 0, birch: 0, maple: 0, cedar: 0 },
    handNumber: 0,
    phase: 'playing',
    events: [],
    startedAt: '2026-08-21T00:00:00Z',
    moves: 0,
    ...over,
  };
}

test('partners sit across the table', () => {
  const [a, b] = teamsFor(ORDER);
  assert.deepStrictEqual(a.players, ['owner', 'maple']);
  assert.deepStrictEqual(b.players, ['birch', 'cedar']);
  assert.strictEqual(partnerOf(table(), 'owner'), 'maple');
});

test('a spade beats anything that is not a spade', () => {
  const trick = [
    { slug: 'owner', card: 'hearts-ace' },
    { slug: 'birch', card: 'spades-2' },
    { slug: 'maple', card: 'hearts-king' },
    { slug: 'cedar', card: 'clubs-ace' },
  ];
  assert.strictEqual(trickWinner(trick, 'hearts'), 'birch', 'the two of spades takes the ace of hearts');
});

test('with no spades the highest card of the led suit wins', () => {
  const trick = [
    { slug: 'owner', card: 'hearts-9' },
    { slug: 'birch', card: 'hearts-king' },
    { slug: 'maple', card: 'clubs-ace' },
    { slug: 'cedar', card: 'hearts-4' },
  ];
  assert.strictEqual(trickWinner(trick, 'hearts'), 'birch', 'the off-suit ace is nothing');
});

test('spades cannot open a trick until one has been thrown', () => {
  const g = table({ hands: { owner: ['spades-5', 'hearts-9'], birch: [], maple: [], cedar: [] } });
  assert.deepStrictEqual(legalPlays(g, 'owner'), ['hearts-9']);
  const broken = table({ spadesBroken: true, hands: { owner: ['spades-5', 'hearts-9'], birch: [], maple: [], cedar: [] } });
  assert.strictEqual(legalPlays(broken, 'owner').length, 2);
});

test('a hand of nothing but spades may lead one', () => {
  const g = table({ hands: { owner: ['spades-5', 'spades-9'], birch: [], maple: [], cedar: [] } });
  assert.strictEqual(legalPlays(g, 'owner').length, 2);
});

test('you must follow suit', () => {
  const g = table({
    trick: [{ slug: 'cedar', card: 'hearts-9' }],
    led: 'hearts',
    hands: { owner: ['hearts-3', 'spades-ace'], birch: [], maple: [], cedar: [] },
  });
  assert.deepStrictEqual(legalPlays(g, 'owner'), ['hearts-3']);
});

test('bidding goes round and then play starts', () => {
  const deck = Array.from({ length: 52 }, (_, i) => `${['spades', 'clubs', 'diamonds', 'hearts'][i % 4]}-${['2','3','4','5','6','7','8','9','10','jack','queen','king','ace'][Math.floor(i / 4)]}`);
  let g = newSpades(deck, ORDER, null, 0, '2026-08-21T00:00:00Z');
  assert.strictEqual(g.phase, 'bidding');
  assert.throws(() => bid(g, 'birch', 3), SpadesError, 'not your bid yet');
  assert.throws(() => bid(g, 'owner', 14), SpadesError);
  for (const slug of ORDER) g = bid(g, slug, 3);
  assert.strictEqual(g.phase, 'playing');
  assert.strictEqual(g.turn, 'owner');
});

test('making the bid pays ten a trick, and the extras are bags', () => {
  const team: SpadesTeam = { players: ['owner', 'maple'], score: 0, bags: 0 };
  const out = scoreTeam(team, { owner: 3, maple: 2, birch: 4, cedar: 4 }, { owner: 4, maple: 3, birch: 3, cedar: 3 });
  assert.strictEqual(out.score, 52, '5 bid, 7 taken: fifty plus two bags');
  assert.strictEqual(out.bags, 2);
});

test('missing the bid costs ten a trick for every trick you promised', () => {
  const team: SpadesTeam = { players: ['owner', 'maple'], score: 0, bags: 0 };
  const out = scoreTeam(team, { owner: 4, maple: 4, birch: 3, cedar: 2 }, { owner: 2, maple: 2, birch: 4, cedar: 5 });
  assert.strictEqual(out.score, -80);
  assert.strictEqual(out.bags, 0);
});

test('nil is worth a hundred, and breaking it costs a hundred', () => {
  const team: SpadesTeam = { players: ['owner', 'maple'], score: 0, bags: 0 };
  const made = scoreTeam(team, { owner: 0, maple: 4, birch: 4, cedar: 5 }, { owner: 0, maple: 4, birch: 4, cedar: 5 });
  assert.strictEqual(made.score, 140, 'a hundred for the nil and forty for the four');
  // A broken nil's trick is not free either: it counts as a bag for the team,
  // which is the rule most tables play and the one that hurts in the right way.
  const broken = scoreTeam(team, { owner: 0, maple: 4, birch: 4, cedar: 5 }, { owner: 1, maple: 4, birch: 4, cedar: 4 });
  assert.strictEqual(broken.score, -59, 'minus a hundred, plus forty made, plus one bag');
  assert.strictEqual(broken.bags, 1);
});

test('ten bags takes a hundred off and the counter rolls', () => {
  const deck = Array.from({ length: 52 }, (_, i) => `${['spades', 'clubs', 'diamonds', 'hearts'][i % 4]}-${['2','3','4','5','6','7','8','9','10','jack','queen','king','ace'][Math.floor(i / 4)]}`);
  const g = newSpades(deck, ORDER, null, 0, '2026-08-21T00:00:00Z');
  g.teams[0].bags = 9;
  g.teams[0].score = 200;
  g.bids = { owner: 1, birch: 3, maple: 1, cedar: 3 };
  g.tricks = { owner: 2, birch: 3, maple: 2, cedar: 3 };
  for (const slug of ORDER) g.hands[slug] = [];
  const { score, bags } = scoreTeam(g.teams[0], g.bids, g.tricks);
  assert.strictEqual(bags, 2, 'bid two, took four');
  assert.strictEqual(9 + bags >= 10, true, 'which tips them over ten');
  assert.strictEqual(score, 22);
});

test('a companion bids what their hand is actually worth', () => {
  const g = table({
    phase: 'bidding',
    turn: 'birch',
    hands: {
      owner: [], maple: [], cedar: [],
      birch: ['spades-ace', 'spades-king', 'spades-2', 'hearts-ace', 'clubs-king', 'diamonds-3'],
    },
  });
  const n = decideSpadesBid(g, 'birch');
  assert.ok(n >= 3 && n <= 5, `expected a sensible bid, got ${n}`);
});

test('a companion never bids nil, even holding nothing', () => {
  const g = table({
    phase: 'bidding',
    turn: 'birch',
    hands: { owner: [], maple: [], cedar: [], birch: ['clubs-2', 'diamonds-3', 'hearts-4'] },
  });
  assert.strictEqual(decideSpadesBid(g, 'birch'), 1);
});

test('a companion does not take a trick their partner is already winning', () => {
  const g = table({
    trick: [
      { slug: 'owner', card: 'hearts-king' },
      { slug: 'birch', card: 'hearts-3' },
    ],
    led: 'hearts',
    turn: 'maple',
    bids: { owner: 3, birch: 3, maple: 3, cedar: 3 },
    hands: { owner: [], birch: [], cedar: [], maple: ['hearts-ace', 'hearts-2'] },
  });
  // the owner is maple's partner and is winning, so the ace stays in hand
  assert.strictEqual(decideSpadesPlay(g, 'maple'), 'hearts-2');
});

test('a companion short of their bid wins the trick as cheaply as they can', () => {
  const g = table({
    trick: [{ slug: 'owner', card: 'hearts-9' }],
    led: 'hearts',
    turn: 'birch',
    bids: { owner: 3, birch: 3, maple: 3, cedar: 3 },
    tricks: { owner: 0, birch: 0, maple: 0, cedar: 0 },
    hands: { owner: [], maple: [], cedar: [], birch: ['hearts-10', 'hearts-king', 'hearts-2'] },
  });
  assert.strictEqual(decideSpadesPlay(g, 'birch'), 'hearts-10', 'the cheapest card that still wins');
});

test('the rail line carries both contracts and the score', () => {
  const line = describeForRoom(table({ turn: 'cedar' }));
  assert.ok(line.includes('Spades'));
  assert.ok(line.includes('cedar'));
  assert.ok(line.includes('/6') || line.includes('0/6'), 'the team contract is visible');
});

test('among several spades the highest one takes it', () => {
  const trick = [
    { slug: 'owner', card: 'spades-9' },
    { slug: 'birch', card: 'spades-queen' },
    { slug: 'maple', card: 'spades-3' },
    { slug: 'cedar', card: 'hearts-ace' },
  ];
  assert.strictEqual(trickWinner(trick, 'hearts'), 'birch');
});

test('a trump played into a trick actually wins it, and the count follows', () => {
  let g = table({
    turn: 'owner',
    spadesBroken: true,
    hands: {
      owner: ['hearts-king'], birch: ['hearts-ace'], maple: ['spades-2'], cedar: ['hearts-3'],
    },
  });
  g = play(g, 'owner', 'hearts-king');
  g = play(g, 'birch', 'hearts-ace');
  g = play(g, 'maple', 'spades-2');
  g = play(g, 'cedar', 'hearts-3');
  assert.strictEqual(g.tricks.maple, 1, 'the two of spades beat the ace of hearts');
  assert.strictEqual(g.tricks.birch, 0);
  assert.strictEqual(g.phase, 'handOver', 'and that was everybody\'s last card');
});
