// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  newPresident, play, pass, canPlaySet, rankValue, titlesFor, stillIn,
  decidePresidentMove, describeForRoom, PresidentError, type PresidentState,
} from './president.js';

function table(over: Partial<PresidentState> = {}): PresidentState {
  return {
    order: ['owner', 'birch'],
    hands: { owner: ['clubs-3', 'hearts-9'], birch: ['spades-5', 'spades-2'] },
    pile: [],
    setSize: 0,
    turn: 'owner',
    passed: [],
    lastPlayed: null,
    finished: [],
    titles: null,
    phase: 'playing',
    events: [],
    startedAt: '2026-08-21T00:00:00Z',
    moves: 0,
    ...over,
  };
}

test('threes are low and twos are high', () => {
  assert.ok(rankValue('spades-2') > rankValue('spades-ace'), 'a two beats an ace');
  assert.ok(rankValue('spades-3') < rankValue('spades-4'));
  assert.ok(rankValue('spades-ace') > rankValue('spades-king'));
});

test('a set has to match in size and beat in rank', () => {
  const g = table({ pile: [['hearts-7', 'clubs-7']], setSize: 2 });
  assert.ok(canPlaySet(g, ['spades-9', 'diamonds-9']), 'two nines beat two sevens');
  assert.ok(!canPlaySet(g, ['spades-9']), 'one card cannot answer a pair');
  assert.ok(!canPlaySet(g, ['spades-5', 'diamonds-5']), 'lower does not go');
  assert.ok(!canPlaySet(g, ['spades-9', 'diamonds-8']), 'a set is all one rank');
});

test('anything leads onto an empty table', () => {
  const g = table();
  assert.ok(canPlaySet(g, ['clubs-3']));
});

test('you cannot play cards you do not hold', () => {
  assert.throws(() => play(table(), 'owner', ['spades-king']), PresidentError);
});

test('you cannot pass when you are the one leading', () => {
  assert.throws(() => pass(table(), 'owner'), PresidentError);
});

test('emptying your hand puts you out, and the last one holding is the Scum', () => {
  const g = table({
    hands: { owner: ['hearts-9'], birch: ['spades-5', 'spades-2'] },
    pile: [['hearts-4']], setSize: 1, lastPlayed: 'birch',
  });
  const next = play(g, 'owner', ['hearts-9']);
  assert.strictEqual(next.phase, 'done');
  assert.deepStrictEqual(next.finished, ['owner', 'birch']);
  assert.strictEqual(next.titles?.owner, 'president');
  assert.strictEqual(next.titles?.birch, 'scum');
});

test('titles run president, vice, citizen, scum', () => {
  const t = titlesFor(['a', 'b', 'c', 'd']);
  assert.deepStrictEqual(t, { a: 'president', b: 'vice', c: 'citizen', d: 'scum' });
});

test('everyone passing sweeps the pile and hands the lead back', () => {
  const g = table({
    order: ['owner', 'birch', 'cedar'],
    hands: { owner: ['hearts-9', 'hearts-10'], birch: ['spades-5'], cedar: ['clubs-4'] },
    pile: [['hearts-king']], setSize: 1, turn: 'birch', lastPlayed: 'owner',
  });
  let next = pass(g, 'birch');
  next = pass(next, 'cedar');
  assert.deepStrictEqual(next.pile, [], 'the pile is swept');
  assert.strictEqual(next.setSize, 0);
  assert.strictEqual(next.turn, 'owner', 'and whoever played last leads again');
});

test('the deal gives the three of clubs the opening lead', () => {
  const deck = ['clubs-3', 'hearts-4', 'spades-5', 'diamonds-6'];
  const g = newPresident(deck, ['owner', 'birch'], null, '2026-08-21T00:00:00Z');
  assert.ok(g.hands.owner.includes('clubs-3'));
  assert.strictEqual(g.turn, 'owner');
});

test('the Scum pays the President at the next deal', () => {
  const deck = ['clubs-3', 'hearts-4', 'spades-5', 'diamonds-2'];
  // birch will hold hearts-4 and diamonds-2 (the best card in the deck)
  const g = newPresident(deck, ['owner', 'birch'], { owner: 'president', birch: 'scum' });
  assert.ok(g.hands.owner.includes('diamonds-2'), 'the President got the Scum\'s best card');
  assert.ok(!g.hands.birch.includes('diamonds-2'));
  assert.ok(g.events.some((e) => e.includes('pays')), 'and it is on the record');
});

test('a companion beats the pile with the smallest thing that will do', () => {
  const g = table({
    order: ['owner', 'birch'],
    turn: 'birch',
    hands: { owner: ['hearts-9'], birch: ['spades-5', 'spades-7', 'spades-2'] },
    pile: [['hearts-4']], setSize: 1, lastPlayed: 'owner',
  });
  const move = decidePresidentMove(g, 'birch');
  assert.ok('play' in move && move.play[0] === 'spades-5', 'not the seven, and certainly not the two');
});

test('a companion keeps their twos back until nothing else works', () => {
  const g = table({
    order: ['owner', 'birch'],
    turn: 'birch',
    hands: { owner: ['hearts-9'], birch: ['spades-4', 'spades-2'] },
    pile: [['hearts-king']], setSize: 1, lastPlayed: 'owner',
  });
  const move = decidePresidentMove(g, 'birch');
  assert.ok('play' in move && move.play[0] === 'spades-2', 'now it has to');
});

test('a companion with nothing that beats it passes', () => {
  const g = table({
    order: ['owner', 'birch'],
    turn: 'birch',
    hands: { owner: ['hearts-9'], birch: ['spades-4', 'spades-5'] },
    pile: [['hearts-king']], setSize: 1, lastPlayed: 'owner',
  });
  assert.deepStrictEqual(decidePresidentMove(g, 'birch'), { pass: true });
});

test('stillIn only counts people holding cards', () => {
  const g = table({ hands: { owner: [], birch: ['spades-5'] } });
  assert.deepStrictEqual(stillIn(g), ['birch']);
});

test('the rail line says what is on the table and whose turn it is', () => {
  const line = describeForRoom(table({ pile: [['hearts-7', 'clubs-7']], setSize: 2, turn: 'birch' }));
  assert.ok(line.includes('President'));
  assert.ok(line.includes('2 x'), 'the set size is visible');
  assert.ok(line.includes('birch'));
});
