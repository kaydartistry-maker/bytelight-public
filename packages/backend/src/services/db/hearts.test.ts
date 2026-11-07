// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  newHearts, choosePass, play, legalPlays, pointsOf, applyMoon, passTarget,
  directionFor, leader, decideHeartsPass, decideHeartsPlay, describeForRoom,
  HeartsError, QUEEN_OF_SPADES, TWO_OF_CLUBS, type HeartsState,
} from './hearts.js';

const ORDER = ['owner', 'birch', 'maple', 'cedar'];

function table(over: Partial<HeartsState> = {}): HeartsState {
  return {
    order: [...ORDER],
    hands: { owner: [], birch: [], maple: [], cedar: [] },
    passing: {},
    direction: 'hold',
    handNumber: 3,
    trick: [],
    trickNumber: 1,
    led: null,
    turn: 'owner',
    heartsBroken: false,
    taken: { owner: 0, birch: 0, maple: 0, cedar: 0 },
    totals: { owner: 0, birch: 0, maple: 0, cedar: 0 },
    phase: 'playing',
    events: [],
    startedAt: '2026-08-21T00:00:00Z',
    moves: 0,
    ...over,
  };
}

test('hearts cost one and the queen of spades costs thirteen', () => {
  assert.strictEqual(pointsOf('hearts-2'), 1);
  assert.strictEqual(pointsOf('hearts-ace'), 1);
  assert.strictEqual(pointsOf(QUEEN_OF_SPADES), 13);
  assert.strictEqual(pointsOf('spades-king'), 0);
  assert.strictEqual(pointsOf('clubs-10'), 0);
});

test('the pass rotates left, right, across, and then nobody', () => {
  assert.deepStrictEqual([0, 1, 2, 3].map(directionFor), ['left', 'right', 'across', 'hold']);
  assert.strictEqual(passTarget(ORDER, 'owner', 'left'), 'birch');
  assert.strictEqual(passTarget(ORDER, 'owner', 'right'), 'cedar');
  assert.strictEqual(passTarget(ORDER, 'owner', 'across'), 'maple');
  assert.strictEqual(passTarget(ORDER, 'owner', 'hold'), null);
});

test('a hold hand skips the pass and goes straight to play', () => {
  const deck = Array.from({ length: 52 }, (_, i) => `${['spades', 'clubs', 'diamonds', 'hearts'][i % 4]}-${['2','3','4','5','6','7','8','9','10','jack','queen','king','ace'][Math.floor(i / 4)]}`);
  const g = newHearts(deck, ORDER, null, 3, '2026-08-21T00:00:00Z');
  assert.strictEqual(g.phase, 'playing');
  assert.ok(g.hands[g.turn].includes(TWO_OF_CLUBS), 'and the two of clubs has the lead');
});

test('passing takes exactly three, and nothing moves until everyone has chosen', () => {
  const deck = Array.from({ length: 52 }, (_, i) => `${['spades', 'clubs', 'diamonds', 'hearts'][i % 4]}-${['2','3','4','5','6','7','8','9','10','jack','queen','king','ace'][Math.floor(i / 4)]}`);
  let g = newHearts(deck, ORDER, null, 0, '2026-08-21T00:00:00Z');
  assert.strictEqual(g.phase, 'passing');
  assert.throws(() => choosePass(g, 'owner', g.hands.owner.slice(0, 2)), HeartsError);
  g = choosePass(g, 'owner', g.hands.owner.slice(0, 3));
  assert.strictEqual(g.phase, 'passing', 'still waiting on the others');
  const before = [...g.hands.birch];
  for (const slug of ['birch', 'maple', 'cedar']) g = choosePass(g, slug, g.hands[slug].slice(0, 3));
  assert.strictEqual(g.phase, 'playing');
  assert.notDeepStrictEqual(g.hands.birch, before, 'hands actually changed');
  assert.ok(ORDER.every((s) => g.hands[s].length === 13), 'and everyone still has thirteen');
});

test('the two of clubs is the only legal opening card', () => {
  const g = table({
    trickNumber: 0,
    hands: { owner: [TWO_OF_CLUBS, 'hearts-5', 'spades-9'], birch: [], maple: [], cedar: [] },
  });
  assert.deepStrictEqual(legalPlays(g, 'owner'), [TWO_OF_CLUBS]);
});

test('you must follow suit when you can', () => {
  const g = table({
    trick: [{ slug: 'birch', card: 'clubs-9' }],
    led: 'clubs',
    turn: 'owner',
    hands: { owner: ['clubs-4', 'hearts-5', 'spades-9'], birch: [], maple: [], cedar: [] },
  });
  assert.deepStrictEqual(legalPlays(g, 'owner'), ['clubs-4']);
});

test('hearts cannot be led until one has been thrown away', () => {
  const g = table({
    hands: { owner: ['hearts-5', 'spades-9'], birch: [], maple: [], cedar: [] },
  });
  assert.deepStrictEqual(legalPlays(g, 'owner'), ['spades-9']);
  const broken = table({
    heartsBroken: true,
    hands: { owner: ['hearts-5', 'spades-9'], birch: [], maple: [], cedar: [] },
  });
  assert.strictEqual(legalPlays(broken, 'owner').length, 2);
});

test('a hand of nothing but hearts may lead one anyway', () => {
  const g = table({ hands: { owner: ['hearts-5', 'hearts-9'], birch: [], maple: [], cedar: [] } });
  assert.strictEqual(legalPlays(g, 'owner').length, 2);
});

test('nothing that costs points lands on the first trick', () => {
  const g = table({
    trickNumber: 0,
    trick: [{ slug: 'birch', card: TWO_OF_CLUBS }],
    led: 'clubs',
    turn: 'owner',
    hands: { owner: ['hearts-5', QUEEN_OF_SPADES, 'diamonds-4'], birch: [], maple: [], cedar: [] },
  });
  assert.deepStrictEqual(legalPlays(g, 'owner'), ['diamonds-4']);
});

test('highest card of the led suit takes the trick and the points with it', () => {
  let g = table({
    turn: 'owner',
    hands: {
      owner: ['clubs-9'], birch: ['clubs-king'], maple: ['hearts-4'], cedar: [QUEEN_OF_SPADES],
    },
    heartsBroken: true,
  });
  g = play(g, 'owner', 'clubs-9');
  g = play(g, 'birch', 'clubs-king');
  g = play(g, 'maple', 'hearts-4');
  g = play(g, 'cedar', QUEEN_OF_SPADES);
  assert.strictEqual(g.taken.birch, 14, 'the king took a heart and the queen');
  assert.strictEqual(g.phase, 'handOver', 'and that was the last card anybody had');
});

test('shooting the moon turns twenty-six around', () => {
  const { scores, shooter } = applyMoon({ owner: 26, birch: 0, maple: 0, cedar: 0 }, ORDER);
  assert.strictEqual(shooter, 'owner');
  assert.deepStrictEqual(scores, { owner: 0, birch: 26, maple: 26, cedar: 26 });
});

test('twenty-five is not the moon', () => {
  const { scores, shooter } = applyMoon({ owner: 25, birch: 1, maple: 0, cedar: 0 }, ORDER);
  assert.strictEqual(shooter, null);
  assert.strictEqual(scores.owner, 25);
});

test('lowest total is the leader', () => {
  const g = table({ totals: { owner: 12, birch: 3, maple: 40, cedar: 8 } });
  assert.strictEqual(leader(g), 'birch');
});

test('a companion passes the queen of spades and their highest cards away', () => {
  const g = table({
    phase: 'passing',
    direction: 'left',
    hands: { owner: [], birch: [QUEEN_OF_SPADES, 'spades-ace', 'clubs-3', 'hearts-king'], maple: [], cedar: [] },
  });
  const chosen = decideHeartsPass(g, 'birch');
  assert.ok(chosen.includes(QUEEN_OF_SPADES));
  assert.ok(chosen.includes('spades-ace'), 'and the card guarding her');
  assert.ok(!chosen.includes('clubs-3'), 'the low one stays');
});

test('a companion void in the led suit throws the queen at somebody', () => {
  const g = table({
    trick: [{ slug: 'owner', card: 'clubs-9' }],
    led: 'clubs',
    turn: 'birch',
    hands: { owner: [], birch: [QUEEN_OF_SPADES, 'hearts-3'], maple: [], cedar: [] },
  });
  assert.strictEqual(decideHeartsPlay(g, 'birch'), QUEEN_OF_SPADES);
});

test('a companion following suit ducks under the trick when they can', () => {
  const g = table({
    trick: [{ slug: 'owner', card: 'clubs-9' }],
    led: 'clubs',
    turn: 'birch',
    hands: { owner: [], birch: ['clubs-3', 'clubs-7', 'clubs-king'], maple: [], cedar: [] },
  });
  assert.strictEqual(decideHeartsPlay(g, 'birch'), 'clubs-7', 'the highest card that still loses');
});

test('the rail line says whether hearts are broken', () => {
  const line = describeForRoom(table({ turn: 'maple' }));
  assert.ok(line.includes('Hearts'));
  assert.ok(line.includes('not yet broken'));
  assert.ok(line.includes('maple'));
});
