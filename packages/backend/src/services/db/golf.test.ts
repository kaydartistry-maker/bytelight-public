// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  newGolf, draw, place, discardAndFlip, cardScore, handScore, allUp,
  decideGolfMove, decideGolfPlacement, describeForRoom, GolfError,
  type GolfState, type GolfSlot,
} from './golf.js';

const deck = (...ids: string[]) => ids;
const slots = (...cards: string[]): GolfSlot[] => cards.map((card) => ({ card, faceUp: true }));

// A deck long enough for two hands plus a discard and a stock to draw from.
function twoHandDeck(): string[] {
  return [
    'hearts-3', 'hearts-4', 'hearts-5', 'hearts-6', 'hearts-7', 'hearts-8',   // owner
    'clubs-3', 'clubs-4', 'clubs-5', 'clubs-6', 'clubs-7', 'clubs-8',         // birch
    'spades-9',                                                               // discard
    'diamonds-king', 'diamonds-2', 'diamonds-10', 'diamonds-ace',             // stock
  ];
}

test('a king is nothing, a two is worth less than nothing', () => {
  assert.strictEqual(cardScore('spades-king'), 0);
  assert.strictEqual(cardScore('spades-ace'), 1);
  assert.strictEqual(cardScore('spades-2'), -2);
  assert.strictEqual(cardScore('spades-7'), 7);
  assert.strictEqual(cardScore('spades-jack'), 10);
  assert.strictEqual(cardScore('spades-queen'), 10);
});

test('a matching column cancels both cards, whatever they are', () => {
  // queens are 10 each; in the same column they are worth nothing at all
  const hand = slots('hearts-queen', 'clubs-3', 'clubs-4', 'spades-queen', 'clubs-5', 'clubs-6');
  assert.strictEqual(handScore(hand), 3 + 4 + 5 + 6);
  const apart = slots('hearts-queen', 'spades-queen', 'clubs-4', 'clubs-3', 'clubs-5', 'clubs-6');
  assert.strictEqual(handScore(apart), 10 + 10 + 4 + 3 + 5 + 6);
});

test('the deal gives everyone six cards with two of them face up', () => {
  const g = newGolf(twoHandDeck(), ['owner', 'birch'], '2026-08-21T00:00:00Z');
  for (const slug of ['owner', 'birch']) {
    assert.strictEqual(g.hands[slug].length, 6);
    assert.strictEqual(g.hands[slug].filter((s) => s.faceUp).length, 2);
  }
  assert.strictEqual(g.discard.length, 1);
  assert.strictEqual(g.turn, 'owner');
});

test('a card off the discard has to go into your hand', () => {
  let g = newGolf(twoHandDeck(), ['owner', 'birch']);
  g = draw(g, 'owner', 'discard');
  assert.throws(() => discardAndFlip(g, 'owner', 1), GolfError);
});

test('placing swaps the slot and throws the old card away', () => {
  let g = newGolf(twoHandDeck(), ['owner', 'birch']);
  const before = g.hands.owner[2].card;
  g = draw(g, 'owner', 'discard');
  const taken = g.held!.card;
  g = place(g, 'owner', 2);
  assert.strictEqual(g.hands.owner[2].card, taken);
  assert.ok(g.hands.owner[2].faceUp, 'a placed card is always face up');
  assert.strictEqual(g.discard.at(-1), before, 'what it replaced is now the discard');
  assert.strictEqual(g.turn, 'birch', 'and the turn passes');
});

test('you cannot play out of turn or hold two cards', () => {
  let g = newGolf(twoHandDeck(), ['owner', 'birch']);
  assert.throws(() => draw(g, 'birch', 'stock'), GolfError);
  g = draw(g, 'owner', 'stock');
  assert.throws(() => draw(g, 'owner', 'stock'), GolfError);
});

test('going out gives everybody else exactly one more turn', () => {
  // the owner is one flip away from all six up; birch has four down.
  const g: GolfState = {
    order: ['owner', 'birch'],
    hands: {
      owner: [
        { card: 'hearts-3', faceUp: true }, { card: 'hearts-4', faceUp: true },
        { card: 'hearts-5', faceUp: true }, { card: 'hearts-6', faceUp: true },
        { card: 'hearts-7', faceUp: true }, { card: 'hearts-8', faceUp: false },
      ],
      birch: slots('clubs-3', 'clubs-4', 'clubs-5', 'clubs-6', 'clubs-7', 'clubs-8')
        .map((s, i) => ({ ...s, faceUp: i < 2 })),
    },
    stock: ['diamonds-king', 'diamonds-2'],
    discard: ['spades-9'],
    turn: 'owner', held: null, closedBy: null, turnsLeft: 0,
    phase: 'playing', scores: null, winner: null,
    startedAt: '2026-08-21T00:00:00Z', moves: 0,
  };
  let next = draw(g, 'owner', 'stock');
  next = discardAndFlip(next, 'owner', 5);
  assert.ok(allUp(next.hands.owner));
  assert.strictEqual(next.closedBy, 'owner');
  assert.strictEqual(next.phase, 'playing', 'going out does not end it on the spot');
  assert.strictEqual(next.turn, 'birch');
  // birch's one last turn, and then it is over
  next = draw(next, 'birch', 'stock');
  next = discardAndFlip(next, 'birch', 2);
  assert.strictEqual(next.phase, 'done');
  assert.ok(next.scores, 'scores exist at the end');
  assert.ok(next.hands.birch.every((s) => s.faceUp), 'everything is revealed');
});

test('lowest total wins, and a two can drag you under', () => {
  const g: GolfState = {
    order: ['owner', 'birch'],
    hands: {
      owner: slots('spades-2', 'spades-king', 'spades-ace', 'hearts-3', 'hearts-4', 'hearts-5'),
      birch: slots('clubs-10', 'clubs-9', 'clubs-8', 'clubs-7', 'clubs-6', 'clubs-5'),
    },
    stock: ['diamonds-king'], discard: ['spades-9'],
    turn: 'owner', held: null, closedBy: 'birch', turnsLeft: 1,
    phase: 'playing', scores: null, winner: null,
    startedAt: '2026-08-21T00:00:00Z', moves: 0,
  };
  let next = draw(g, 'owner', 'stock');
  next = place(next, 'owner', 3);
  assert.strictEqual(next.phase, 'done');
  assert.strictEqual(next.winner, 'owner');
  assert.ok(next.scores!.owner < next.scores!.birch);
});

test('the stock turning over keeps the game alive', () => {
  const g: GolfState = {
    order: ['owner', 'birch'],
    hands: {
      owner: slots('hearts-3', 'hearts-4', 'hearts-5', 'hearts-6', 'hearts-7', 'hearts-8'),
      birch: slots('clubs-3', 'clubs-4', 'clubs-5', 'clubs-6', 'clubs-7', 'clubs-8'),
    },
    stock: [], discard: ['spades-9', 'spades-10', 'spades-jack'],
    turn: 'owner', held: null, closedBy: null, turnsLeft: 0,
    phase: 'playing', scores: null, winner: null,
    startedAt: '2026-08-21T00:00:00Z', moves: 0,
  };
  const next = draw(g, 'owner', 'stock');
  assert.ok(next.held, 'a card came out of the turned-over stock');
  assert.strictEqual(next.discard.length, 1, 'the card everyone was looking at stays on top');
  assert.strictEqual(next.discard[0], 'spades-jack');
});

test('a companion takes a king off the discard rather than gambling', () => {
  const g: GolfState = {
    order: ['owner', 'birch'],
    hands: {
      owner: slots('hearts-3', 'hearts-4', 'hearts-5', 'hearts-6', 'hearts-7', 'hearts-8'),
      birch: [
        { card: 'clubs-10', faceUp: true }, { card: 'clubs-9', faceUp: true },
        { card: 'clubs-8', faceUp: false }, { card: 'clubs-7', faceUp: false },
        { card: 'clubs-6', faceUp: false }, { card: 'clubs-5', faceUp: false },
      ],
    },
    stock: ['diamonds-2'], discard: ['spades-king'],
    turn: 'birch', held: null, closedBy: null, turnsLeft: 0,
    phase: 'playing', scores: null, winner: null,
    startedAt: '2026-08-21T00:00:00Z', moves: 0,
  };
  const move = decideGolfMove(g, 'birch');
  assert.strictEqual(move.take, 'discard');
});

test('a companion throws away a bad stock card and turns something over instead', () => {
  const g: GolfState = {
    order: ['owner', 'birch'],
    hands: {
      owner: slots('hearts-3', 'hearts-4', 'hearts-5', 'hearts-6', 'hearts-7', 'hearts-8'),
      birch: [
        { card: 'clubs-3', faceUp: true }, { card: 'clubs-4', faceUp: true },
        { card: 'clubs-8', faceUp: false }, { card: 'clubs-7', faceUp: false },
        { card: 'clubs-6', faceUp: false }, { card: 'clubs-5', faceUp: false },
      ],
    },
    stock: ['diamonds-queen'], discard: ['spades-9'],
    turn: 'birch', held: null, closedBy: null, turnsLeft: 0,
    phase: 'playing', scores: null, winner: null,
    startedAt: '2026-08-21T00:00:00Z', moves: 0,
  };
  const held = draw(g, 'birch', 'stock');
  const call = decideGolfPlacement(held, 'birch');
  assert.ok('flip' in call, 'a queen is worth ten — it does not belong in anybody\'s hand');
});

test('the rail line says whose turn it is and what is showing', () => {
  const g = newGolf(twoHandDeck(), ['owner', 'birch']);
  const line = describeForRoom(g);
  assert.ok(line.includes('Golf'));
  assert.ok(line.includes('owner'));
  assert.ok(line.includes('??'), 'face-down cards are not spelled out');
});
