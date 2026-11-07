// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
// Egyptian Rat Screw rules, tested away from any table or art. The deck here
// is synthetic (suit-rank IDs), so these run on a fresh clone — the engine
// never needs the drawn cards, only their names.
import { test } from 'node:test';
import assert from 'node:assert';
import { CARD_SUITS, CARD_RANKS } from './cards.js';
import {
  detectPattern,
  flip,
  maybeTwitch,
  newRatScrew,
  rollReflexes,
  resolveSlap,
  slap,
  RatScrewError,
  type RatScrewState,
} from './rat-screw.js';

function fullDeck(): string[] {
  const deck: string[] = [];
  for (const suit of CARD_SUITS) for (const rank of CARD_RANKS) deck.push(`${suit}-${rank}`);
  return deck;
}

/** The seat of the person playing live; every other seat is a companion. */
const OWNER = 'owner';
const ORDER = [OWNER, 'birch', 'maple', 'cedar'];

function rigged(hands: Record<string, string[]>, over: Partial<RatScrewState> = {}): RatScrewState {
  const state = newRatScrew(fullDeck(), ORDER);
  for (const slug of ORDER) state.hands[slug] = [...(hands[slug] ?? [])];
  state.pile = [];
  state.dent = null;
  state.phase = 'playing';
  state.slap = null;
  state.turn = 'owner';
  return Object.assign(state, over);
}

test('deal splits 52 evenly across four seats', () => {
  const state = newRatScrew(fullDeck(), ORDER);
  for (const slug of ORDER) assert.strictEqual(state.hands[slug].length, 13);
  assert.strictEqual(state.pile.length, 0);
  assert.strictEqual(state.turn, 'owner');
});

test('doubles and sandwiches are the only slaps', () => {
  assert.strictEqual(detectPattern(['hearts-7', 'spades-7']), 'double');
  assert.strictEqual(detectPattern(['hearts-7', 'spades-2', 'clubs-7']), 'sandwich');
  assert.strictEqual(detectPattern(['hearts-7', 'spades-2', 'clubs-9']), null);
  assert.strictEqual(detectPattern(['hearts-7']), null);
});

test('a quiet flip passes the turn in order', () => {
  const state = rigged({ owner: ['hearts-2'], birch: ['spades-9'], maple: ['clubs-4'], cedar: ['diamonds-6'] });
  flip(state, 'owner', OWNER);
  assert.strictEqual(state.turn, 'birch');
  assert.strictEqual(state.phase, 'playing');
});

test('a double opens the slap window with rolls for every companion', () => {
  const state = rigged({ owner: ['hearts-7'], birch: ['spades-7'], maple: ['clubs-4'], cedar: ['diamonds-6'] });
  flip(state, 'owner', OWNER);
  flip(state, 'birch', OWNER);
  assert.strictEqual(state.phase, 'slap');
  assert.ok(state.slap);
  assert.deepStrictEqual(Object.keys(state.slap!.rolls).sort(), ['birch', 'cedar', 'maple']);
});

test('a faster live tap wins the pile; a slower one loses it', () => {
  const win = rigged({ owner: ['hearts-7'], birch: ['spades-7'], maple: ['clubs-4'], cedar: ['diamonds-6'] });
  flip(win, 'owner', OWNER);
  flip(win, 'birch', OWNER);
  slap(win, 'owner', 1); // one millisecond: faster than any roll
  assert.strictEqual(win.phase, 'playing');
  assert.strictEqual(win.hands.owner.length, 2);
  assert.strictEqual(win.pile.length, 0);

  const lose = rigged({ owner: ['hearts-7'], birch: ['spades-7'], maple: ['clubs-4'], cedar: ['diamonds-6'] });
  flip(lose, 'owner', OWNER);
  flip(lose, 'birch', OWNER);
  lose.slap!.rolls = { birch: 1300, maple: 1500, cedar: 1700 }; // a companion inside the window
  slap(lose, 'owner', 999999);
  const kingsHold = lose.hands.birch.length + lose.hands.maple.length + lose.hands.cedar.length;
  assert.strictEqual(kingsHold, 2 + 1 + 1); // the pile of two went to one companion
});

test('an unanswered window resolves to the fastest rolled hand', () => {
  const state = rigged({ owner: ['hearts-7'], birch: ['spades-7'], maple: ['clubs-4'], cedar: ['diamonds-6'] });
  flip(state, 'owner', OWNER);
  flip(state, 'birch', OWNER);
  state.slap!.rolls = { birch: 1200, maple: 1500, cedar: 1700 }; // all inside the window
  resolveSlap(state);
  assert.strictEqual(state.phase, 'playing');
  assert.strictEqual(state.pile.length, 0);
  assert.strictEqual(state.hands.owner.length, 0); // the owner never got it
  assert.strictEqual(state.hands.birch.length, 2); // the fast hand took the pair
});

test('a window everybody sleeps through goes stale — the pile rides', () => {
  const state = rigged({ owner: ['hearts-7'], birch: ['spades-7'], maple: ['clubs-4'], cedar: ['diamonds-6'] });
  flip(state, 'owner', OWNER);
  flip(state, 'birch', OWNER);
  state.slap!.rolls = { birch: 4200, maple: 4400, cedar: 4100 }; // every roll missed
  resolveSlap(state);
  assert.strictEqual(state.phase, 'playing');
  assert.strictEqual(state.pile.length, 2); // nobody took it
  assert.strictEqual(state.slap, null);
  assert.strictEqual(state.turn, 'maple'); // play moves on past the flipper
});

test('the live seat is whichever one the caller names, not a fixed slug', () => {
  // A house names its own person; the engine must not assume who sits there.
  const order = ['alex', 'birch', 'maple', 'cedar'];
  const state = newRatScrew(fullDeck(), order);
  Object.assign(state.hands, { alex: ['hearts-7'], birch: ['spades-7'], maple: ['clubs-4'], cedar: ['diamonds-6'] });
  state.turn = 'alex';
  flip(state, 'alex', 'alex');
  flip(state, 'birch', 'alex');
  assert.strictEqual(state.phase, 'slap');
  assert.deepStrictEqual(Object.keys(state.slap!.rolls).sort(), ['birch', 'cedar', 'maple']);
  slap(state, 'alex', 1);
  assert.strictEqual(state.hands.alex.length, 2, 'the live tap took the pair');
});

test('a live tap still takes a window every companion missed', () => {
  const state = rigged({ owner: ['hearts-7'], birch: ['spades-7'], maple: ['clubs-4'], cedar: ['diamonds-6'] });
  flip(state, 'owner', OWNER);
  flip(state, 'birch', OWNER);
  state.slap!.rolls = { birch: 4200, maple: 4400, cedar: 4100 };
  slap(state, 'owner', 2600);
  assert.strictEqual(state.hands.owner.length, 2); // an unclaimed pattern is still the owner's
  assert.strictEqual(state.pile.length, 0);
});

test('the dent rule: a face card demands a face card or the pile comes home', () => {
  const state = rigged({ owner: ['hearts-jack'], birch: ['spades-3'], maple: ['clubs-4'], cedar: ['diamonds-6'] });
  flip(state, 'owner', OWNER); // jack: birch owes one chance
  assert.ok(state.dent);
  assert.strictEqual(state.dent!.owner, 'owner');
  assert.strictEqual(state.turn, 'birch');
  flip(state, 'birch', OWNER); // a 3 — the dent comes due
  assert.strictEqual(state.pile.length, 0);
  assert.strictEqual(state.hands.owner.length, 2); // jack and the 3 came home
  assert.strictEqual(state.turn, 'owner');
});

test('a face card answered with a face card passes the dent on', () => {
  const state = rigged({ owner: ['hearts-jack'], birch: ['spades-queen'], maple: ['clubs-4', 'diamonds-9'], cedar: ['diamonds-6'] });
  flip(state, 'owner', OWNER); // dent: the owner is owed, birch pays
  flip(state, 'birch', OWNER); // queen answers — now maple owes birch two chances
  assert.strictEqual(state.dent!.owner, 'birch');
  assert.strictEqual(state.dent!.remaining, 2);
  assert.strictEqual(state.turn, 'maple');
  flip(state, 'maple', OWNER);
  assert.strictEqual(state.dent!.remaining, 1);
  assert.strictEqual(state.turn, 'maple'); // the payer keeps flipping
});

test('a slap pattern beats a dent in flight', () => {
  const state = rigged({ owner: ['hearts-jack'], birch: ['spades-jack'], maple: ['clubs-4'], cedar: ['diamonds-6'] });
  flip(state, 'owner', OWNER);
  flip(state, 'birch', OWNER); // jack on jack: double outranks the dent
  assert.strictEqual(state.phase, 'slap');
  slap(state, 'owner', 1);
  assert.strictEqual(state.dent, null);
  assert.strictEqual(state.hands.owner.length, 2);
});

test('a bad slap burns a card to the bottom of the pile', () => {
  const state = rigged({ owner: ['hearts-2', 'spades-9'], birch: ['spades-3'], maple: ['clubs-4'], cedar: ['diamonds-6'] });
  flip(state, 'owner', OWNER); // quiet pile
  slap(state, 'owner'); // nothing there
  assert.strictEqual(state.pile.length, 2);
  assert.strictEqual(state.pile[0], 'spades-9'); // burned to the bottom
  assert.strictEqual(state.hands.owner.length, 0);
});

test('holding everything with an empty pile wins the game', () => {
  const state = rigged({ owner: ['hearts-7', 'clubs-7'], birch: [], maple: [], cedar: ['diamonds-6'] });
  state.turn = 'owner';
  flip(state, 'owner', OWNER);
  state.turn = 'cedar';
  flip(state, 'cedar', OWNER);
  state.turn = 'owner';
  flip(state, 'owner', OWNER); // 7 on the pile... 7-6-7 sandwich!
  assert.strictEqual(state.phase, 'slap');
  slap(state, 'owner', 1);
  assert.strictEqual(state.phase, 'won');
  assert.strictEqual(state.winner, 'owner');
});

test('flipping out of turn or while a slap is live refuses', () => {
  const state = rigged({ owner: ['hearts-7'], birch: ['spades-7'], maple: ['clubs-4'], cedar: ['diamonds-6'] });
  assert.throws(() => flip(state, 'maple', OWNER), RatScrewError);
  flip(state, 'owner', OWNER);
  flip(state, 'birch', OWNER);
  assert.throws(() => flip(state, 'maple', OWNER), RatScrewError);
});

test('reflex rolls land in a thumb-on-glass range, and misses happen', () => {
  // The window is 3500ms; a roll beyond it is a companion who never saw the pattern.
  let misses = 0;
  for (let i = 0; i < 200; i++) {
    const rolls = rollReflexes(i % 2 ? 'double' : 'sandwich', ['birch', 'maple', 'cedar']);
    for (const [, ms] of Object.entries(rolls)) {
      assert.ok(ms >= 700 && ms <= 4500, `roll out of range: ${ms}`);
      if (ms > 3500) misses++;
    }
  }
  // ~8.5% miss rate over 600 rolls; generous bounds so the suite never flakes
  assert.ok(misses > 5 && misses < 200, `miss rate off: ${misses}/600`);
});

test('temperaments follow seat order, so a house with other names gets the whole table', (t) => {
  // Every draw pinned at 0.1. The first companion's wide curve misses outright,
  // the second is the tight one, the third reads a sandwich early, and anybody
  // after that rolls the general curve.
  t.mock.method(Math, 'random', () => 0.1);
  assert.deepStrictEqual(
    rollReflexes('sandwich', ['ivy', 'fox', 'nim', 'oak']),
    { ivy: 3960, fox: 1128, nim: 924, oak: 1096 },
  );
});

test('twitches are rare and only ever name a companion', () => {
  let twitches = 0;
  for (let i = 0; i < 2000; i++) {
    const who = maybeTwitch(['birch', 'maple', 'cedar']);
    if (who) {
      twitches++;
      assert.ok(['birch', 'maple', 'cedar'].includes(who));
    }
  }
  assert.ok(twitches > 0 && twitches < 250, `twitch rate off: ${twitches}/2000`);
});

test('a dent names both ends: the next hand owes the player of the face card', () => {
  const state = rigged({ owner: ['hearts-king', 'hearts-2'], birch: ['spades-9'], maple: ['clubs-4'], cedar: ['diamonds-6'] });
  flip(state, 'owner', OWNER);
  assert.ok(state.dent);
  assert.strictEqual(state.dent!.owner, 'owner');
  assert.strictEqual(state.turn, 'birch');
  const line = state.events[state.events.length - 1];
  assert.match(line, /birch owes owner a face card/);
  assert.doesNotMatch(line, /owner owes/);
});

test('a dent with every other hand empty says so instead of "X owes X"', () => {
  const state = rigged({ owner: ['hearts-king', 'hearts-2'], birch: [], maple: [], cedar: [] });
  flip(state, 'owner', OWNER);
  assert.ok(state.dent);
  assert.strictEqual(state.turn, 'owner');
  const line = state.events[state.events.length - 1];
  assert.match(line, /nobody else holds cards to pay owner/);
  assert.doesNotMatch(line, /owes/);
});
