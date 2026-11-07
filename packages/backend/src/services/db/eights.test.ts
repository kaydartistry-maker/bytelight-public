// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  newEights, play, drawUntilPlayable, canPlay, isWild, playableFrom,
  decideEightsMove, describeForRoom, EightsError, type EightsState,
} from './eights.js';

function table(over: Partial<EightsState> = {}): EightsState {
  return {
    order: ['owner', 'birch'],
    hands: { owner: ['hearts-3', 'spades-9'], birch: ['clubs-4', 'clubs-5'] },
    stock: ['diamonds-7', 'diamonds-8', 'clubs-3'],
    pile: ['hearts-10'],
    suit: 'hearts',
    turn: 'owner',
    phase: 'playing',
    winner: null,
    events: [],
    startedAt: '2026-08-21T00:00:00Z',
    moves: 0,
    ...over,
  };
}

test('suit or rank goes, and an eight goes on anything', () => {
  assert.ok(canPlay('hearts-2', 'hearts-10', 'hearts'), 'same suit');
  assert.ok(canPlay('clubs-10', 'hearts-10', 'hearts'), 'same rank');
  assert.ok(!canPlay('clubs-4', 'hearts-10', 'hearts'), 'neither');
  assert.ok(canPlay('clubs-8', 'hearts-10', 'hearts'), 'an eight always goes');
  assert.ok(isWild('spades-8'));
});

test('the called suit overrides what the card actually is', () => {
  // an eight is on the pile but clubs was named, so clubs go and hearts do not
  assert.ok(canPlay('clubs-4', 'hearts-8', 'clubs'));
  assert.ok(!canPlay('hearts-4', 'hearts-8', 'clubs'));
});

test('playing an eight without naming a suit is refused', () => {
  const g = table({ hands: { owner: ['clubs-8'], birch: ['clubs-4'] } });
  assert.throws(() => play(g, 'owner', 'clubs-8'), EightsError);
  const next = play(g, 'owner', 'clubs-8', 'diamonds');
  assert.strictEqual(next.suit, 'diamonds');
});

test('you cannot play a card you do not hold, or one that will not go', () => {
  const g = table();
  assert.throws(() => play(g, 'owner', 'clubs-2'), EightsError);
  assert.throws(() => play(g, 'owner', 'spades-9'), EightsError, 'spades on hearts is nothing');
});

test('emptying your hand ends it', () => {
  const g = table({ hands: { owner: ['hearts-3'], birch: ['clubs-4'] } });
  const next = play(g, 'owner', 'hearts-3');
  assert.strictEqual(next.phase, 'won');
  assert.strictEqual(next.winner, 'owner');
});

test('stuck means draw until you can go, and no further', () => {
  const g = table({
    hands: { owner: ['clubs-4'], birch: ['clubs-5'] },
    stock: ['spades-2', 'spades-5', 'hearts-6', 'diamonds-9'],
  });
  const next = drawUntilPlayable(g, 'owner');
  assert.ok(next.hands.owner.includes('hearts-6'), 'it drew as far as something playable');
  assert.ok(!next.hands.owner.includes('diamonds-9'), 'and stopped there');
  assert.strictEqual(next.turn, 'owner', 'the turn is still theirs to finish');
});

test('drawing when you can already go is refused', () => {
  assert.throws(() => drawUntilPlayable(table(), 'owner'), EightsError);
});

test('an empty stock turns the pile over and keeps the top card', () => {
  const g = table({
    hands: { owner: ['clubs-4'], birch: ['clubs-5'] },
    stock: [],
    pile: ['hearts-2', 'hearts-9', 'hearts-10'],
  });
  const next = drawUntilPlayable(g, 'owner');
  assert.strictEqual(next.pile.at(-1), 'hearts-10', 'what everyone is looking at stays');
  assert.ok(next.hands.owner.length > 1, 'and there were cards to draw');
});

test('the deal never leaves an eight on top with nobody to call a suit', () => {
  const deck = [
    'hearts-3', 'hearts-4', 'hearts-5', 'hearts-6', 'hearts-7',
    'clubs-3', 'clubs-4', 'clubs-5', 'clubs-6', 'clubs-7',
    'spades-8', 'diamonds-9',
  ];
  const g = newEights(deck, ['owner', 'birch'], '2026-08-21T00:00:00Z');
  assert.ok(!isWild(g.pile[0]), 'the eight went back under');
  assert.strictEqual(g.suit, g.pile[0].split('-')[0]);
});

test('a companion keeps their eights for when they need them', () => {
  const g = table({
    turn: 'birch',
    hands: { owner: ['hearts-3'], birch: ['hearts-2', 'spades-8'] },
  });
  const move = decideEightsMove(g, 'birch');
  assert.ok('play' in move && move.play === 'hearts-2', 'the plain card goes first');
});

test('a companion forced onto an eight calls the suit they hold most of', () => {
  const g = table({
    turn: 'birch',
    pile: ['hearts-10'],
    suit: 'hearts',
    hands: { owner: ['hearts-3'], birch: ['spades-8', 'clubs-2', 'clubs-9', 'diamonds-4'] },
  });
  const move = decideEightsMove(g, 'birch');
  assert.ok('play' in move && move.play === 'spades-8');
  assert.strictEqual('suit' in move ? move.suit : null, 'clubs', 'it calls its longest suit');
});

test('a companion with nothing draws', () => {
  const g = table({ turn: 'birch', hands: { owner: ['hearts-3'], birch: ['clubs-4', 'spades-9'] } });
  assert.deepStrictEqual(decideEightsMove(g, 'birch'), { draw: true });
});

test('the rail line names the top card and whose turn it is', () => {
  const line = describeForRoom(table());
  assert.ok(line.includes('Crazy Eights'));
  assert.ok(line.includes('owner'));
  assert.ok(line.includes('10 of hearts') || line.includes('hearts 10') || line.includes('hearts'));
});

test('playableFrom finds every legal card and no others', () => {
  const hand = ['hearts-2', 'clubs-10', 'spades-8', 'diamonds-4'];
  const legal = playableFrom(hand, 'hearts-10', 'hearts');
  assert.deepStrictEqual(legal.sort(), ['clubs-10', 'hearts-2', 'spades-8'].sort());
});
