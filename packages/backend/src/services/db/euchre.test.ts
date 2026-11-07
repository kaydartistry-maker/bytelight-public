// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import { test } from 'node:test';
import assert from 'node:assert';
import {
  newEuchre, euchreDeck, isRightBower, isLeftBower, effectiveSuit, strength,
  orderUp, discard, nameTrump, pass, play, legalPlays, trickWinner, scoreHand,
  handStrength, decideEuchreCall, decideEuchrePlay, describeForRoom, teamsFor,
  EuchreError, type EuchreState, type EuchreTeam,
} from './euchre.js';

const ORDER = ['owner', 'birch', 'maple', 'cedar'];
const FULL = (() => {
  const out: string[] = [];
  for (const s of ['spades', 'clubs', 'diamonds', 'hearts']) {
    for (const r of ['2','3','4','5','6','7','8','9','10','jack','queen','king','ace']) out.push(`${s}-${r}`);
  }
  return out;
})();

function table(over: Partial<EuchreState> = {}): EuchreState {
  return {
    order: [...ORDER],
    teams: teamsFor(ORDER),
    hands: { owner: [], birch: [], maple: [], cedar: [] },
    kitty: ['spades-9', 'clubs-9', 'hearts-9', 'diamonds-9'],
    upCard: null,
    dealer: 'cedar',
    trump: 'spades',
    maker: 'owner',
    alone: false,
    sittingOut: null,
    trick: [],
    trickNumber: 0,
    led: null,
    turn: 'owner',
    tricks: { owner: 0, birch: 0, maple: 0, cedar: 0 },
    handNumber: 0,
    phase: 'playing',
    events: [],
    startedAt: '2026-08-21T00:00:00Z',
    moves: 0,
    ...over,
  };
}

test('the deck is twenty-four cards, nine up', () => {
  const deck = euchreDeck(FULL);
  assert.strictEqual(deck.length, 24);
  assert.ok(!deck.includes('spades-2'));
  assert.ok(deck.includes('spades-9'));
});

test('the right bower is the jack of trump and beats everything', () => {
  assert.ok(isRightBower('spades-jack', 'spades'));
  assert.ok(strength('spades-jack', 'spades', 'spades') > strength('spades-ace', 'spades', 'spades'));
});

test('the left bower is the other jack of the same colour, and it IS trump now', () => {
  assert.ok(isLeftBower('clubs-jack', 'spades'), 'clubs and spades are both black');
  assert.ok(!isLeftBower('hearts-jack', 'spades'));
  assert.strictEqual(effectiveSuit('clubs-jack', 'spades'), 'spades', 'it stops being a club entirely');
  assert.ok(strength('clubs-jack', 'spades', 'spades') > strength('spades-ace', 'spades', 'spades'));
  assert.ok(strength('spades-jack', 'spades', 'spades') > strength('clubs-jack', 'spades', 'spades'));
});

test('any trump beats any non-trump, however big', () => {
  assert.ok(strength('spades-9', 'spades', 'hearts') > strength('hearts-ace', 'spades', 'hearts'));
});

test('following suit counts the left bower as trump, not as its own suit', () => {
  const g = table({
    trump: 'spades',
    trick: [{ slug: 'birch', card: 'clubs-ace' }],
    led: 'clubs',
    turn: 'owner',
    hands: { owner: ['clubs-jack', 'clubs-10', 'hearts-9'], birch: [], maple: [], cedar: [] },
  });
  // the jack of clubs is a spade now, so it does NOT satisfy a club lead
  assert.deepStrictEqual(legalPlays(g, 'owner'), ['clubs-10']);
});

test('ordering it up sets trump and makes the dealer pick the card up', () => {
  const g = newEuchre(FULL, ORDER, null, 0, '2026-08-21T00:00:00Z');
  assert.strictEqual(g.phase, 'bid1');
  const up = g.upCard as string;
  const next = orderUp(g, g.turn, false);
  assert.strictEqual(next.trump, up.split('-')[0]);
  assert.strictEqual(next.phase, 'discard');
  assert.strictEqual(next.hands[next.dealer].length, 6, 'the dealer is holding six for a moment');
  const done = discard(next, next.dealer, next.hands[next.dealer][0]);
  assert.strictEqual(done.hands[done.dealer].length, 5);
  assert.strictEqual(done.phase, 'playing');
});

test('everybody passing turns the card down and opens the second round', () => {
  let g = newEuchre(FULL, ORDER, null, 0, '2026-08-21T00:00:00Z');
  for (let i = 0; i < 4; i += 1) g = pass(g, g.turn);
  assert.strictEqual(g.phase, 'bid2');
  assert.strictEqual(g.upCard, null);
});

test('the suit that was turned down cannot be named', () => {
  let g = newEuchre(FULL, ORDER, null, 0, '2026-08-21T00:00:00Z');
  const turned = (g.upCard as string).split('-')[0] as 'spades';
  for (let i = 0; i < 4; i += 1) g = pass(g, g.turn);
  assert.throws(() => nameTrump(g, g.turn, turned), EuchreError);
});

test('stick the dealer — it cannot come back round with nobody choosing', () => {
  let g = newEuchre(FULL, ORDER, null, 0, '2026-08-21T00:00:00Z');
  for (let i = 0; i < 4; i += 1) g = pass(g, g.turn);
  for (let i = 0; i < 3; i += 1) g = pass(g, g.turn);
  assert.strictEqual(g.turn, g.dealer);
  assert.throws(() => pass(g, g.dealer), EuchreError, 'the dealer has to name something');
});

test('going alone sits the partner down', () => {
  const g = newEuchre(FULL, ORDER, null, 0, '2026-08-21T00:00:00Z');
  const caller = g.turn;
  const next = orderUp(g, caller, true);
  assert.ok(next.alone);
  assert.ok(next.sittingOut && next.sittingOut !== caller);
});

test('three or four tricks is a point, all five is two, alone is four', () => {
  const makers: EuchreTeam = { players: ['owner', 'maple'], score: 0 };
  assert.strictEqual(scoreHand(makers, 3, false).toMakers, 1);
  assert.strictEqual(scoreHand(makers, 4, false).toMakers, 1);
  assert.strictEqual(scoreHand(makers, 5, false).toMakers, 2);
  assert.strictEqual(scoreHand(makers, 5, true).toMakers, 4);
});

test('being euchred hands the other team two', () => {
  const makers: EuchreTeam = { players: ['owner', 'maple'], score: 0 };
  const out = scoreHand(makers, 2, false);
  assert.strictEqual(out.toMakers, 0);
  assert.strictEqual(out.toDefenders, 2);
  assert.ok(out.line.includes('EUCHRED'));
});

test('a trick is won by the strongest card once bowers are counted', () => {
  const trick = [
    { slug: 'owner', card: 'hearts-ace' },
    { slug: 'birch', card: 'clubs-jack' },
    { slug: 'maple', card: 'spades-ace' },
    { slug: 'cedar', card: 'hearts-king' },
  ];
  assert.strictEqual(trickWinner(trick, 'spades', 'hearts'), 'birch', 'the left bower beats the ace of trump');
});

test('a companion calls with a strong hand and passes with a weak one', () => {
  const strong = table({
    phase: 'bid1', upCard: 'spades-king', turn: 'birch', dealer: 'cedar',
    hands: { owner: [], maple: [], cedar: [], birch: ['spades-jack', 'clubs-jack', 'spades-ace', 'hearts-9', 'diamonds-10'] },
  });
  assert.deepStrictEqual(decideEuchreCall(strong, 'birch'), { call: 'order' });
  const weak = table({
    phase: 'bid1', upCard: 'spades-king', turn: 'birch', dealer: 'cedar',
    hands: { owner: [], maple: [], cedar: [], birch: ['hearts-9', 'hearts-10', 'diamonds-9', 'diamonds-10', 'clubs-9'] },
  });
  assert.deepStrictEqual(decideEuchreCall(weak, 'birch'), { call: 'pass' });
});

test('the dealer stuck in the second round names something anyway', () => {
  const g = table({
    phase: 'bid2', upCard: null, turn: 'cedar', dealer: 'cedar',
    kitty: ['spades-king', 'clubs-9', 'hearts-9', 'diamonds-9'],
    hands: { owner: [], birch: [], maple: [], cedar: ['hearts-9', 'hearts-10', 'diamonds-9', 'diamonds-10', 'clubs-9'] },
  });
  const call = decideEuchreCall(g, 'cedar');
  assert.ok('suit' in call && call.suit !== 'spades', 'anything but the suit turned down');
});

test('a companion does not take a trick their partner is already winning', () => {
  const g = table({
    trump: 'spades',
    trick: [
      { slug: 'owner', card: 'hearts-ace' },
      { slug: 'birch', card: 'hearts-9' },
    ],
    led: 'hearts',
    turn: 'maple',
    hands: { owner: [], birch: [], cedar: [], maple: ['hearts-king', 'hearts-10'] },
  });
  // the owner is maple's partner and is winning with the ace
  assert.strictEqual(decideEuchrePlay(g, 'maple'), 'hearts-10');
});

test('handStrength rates the right bower highest', () => {
  const withRight = handStrength(['spades-jack'], 'spades');
  const withLeft = handStrength(['clubs-jack'], 'spades');
  const withAce = handStrength(['spades-ace'], 'spades');
  assert.ok(withRight > withLeft && withLeft > withAce);
});

test('the rail line names trump and whose turn it is', () => {
  const line = describeForRoom(table({ turn: 'maple' }));
  assert.ok(line.includes('Euchre'));
  assert.ok(line.includes('spades is trump'));
  assert.ok(line.includes('maple'));
});
