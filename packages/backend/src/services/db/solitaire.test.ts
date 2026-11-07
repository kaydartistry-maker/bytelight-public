// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyMove,
  autoFinish,
  canAutoFinish,
  draw,
  isWon,
  newKlondike,
  undo,
  wasteTop,
  type KlondikeState,
} from './solitaire.js';

const SUITS = ['spades', 'clubs', 'diamonds', 'hearts'] as const;
const RANKS = ['ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king'];
const DECK = SUITS.flatMap((s) => RANKS.map((r) => `${s}-${r}`));
const AT = '2026-08-07T00:00:00.000Z';

function deal(drawCount: 1 | 3 = 1): KlondikeState {
  return newKlondike(DECK, drawCount, AT);
}

test('a deal is 28 cards on the table and 24 in the stock', () => {
  const game = deal();
  const onTable = game.tableau.reduce((n, pile) => n + pile.length, 0);
  assert.equal(onTable, 28);
  assert.equal(game.stock.length, 24);
  assert.equal(game.tableau.map((p) => p.length).join(','), '1,2,3,4,5,6,7');
  // exactly the last card of each column shows
  for (const pile of game.tableau) {
    assert.equal(pile.filter((c) => c.faceUp).length, 1);
    assert.equal(pile.at(-1)!.faceUp, true);
  }
  // and every card is present exactly once
  const all = [...game.stock, ...game.tableau.flat().map((c) => c.card)];
  assert.equal(new Set(all).size, 52);
});

test('draw three turns three but only the top is live', () => {
  const game = draw(deal(3));
  assert.equal(game.waste.length, 3);
  assert.equal(wasteTop(game), game.waste[2]);
  assert.equal(game.stock.length, 21);
});

test('the stock recycles for ever', () => {
  let game = deal(3);
  for (let i = 0; i < 8; i++) game = draw(game); // 24 cards, three at a time
  assert.equal(game.stock.length, 0);
  assert.equal(game.waste.length, 24);
  game = draw(game);
  assert.equal(game.stock.length, 24, 'the waste goes back under');
  assert.equal(game.waste.length, 0);
});

test('a foundation only takes its own suit, in order, from the ace', () => {
  const game = deal();
  const spadeAceOnTop: KlondikeState = {
    ...game,
    tableau: [[{ card: 'spades-ace', faceUp: true }], ...game.tableau.slice(1)],
  };
  const played = applyMove(spadeAceOnTop, { from: 'tableau', fromIndex: 0, to: 'foundation' });
  assert.deepEqual(played.foundations.spades, ['spades-ace']);

  const withThree: KlondikeState = {
    ...played,
    tableau: [[{ card: 'spades-3', faceUp: true }], ...played.tableau.slice(1)],
  };
  assert.throws(() => applyMove(withThree, { from: 'tableau', fromIndex: 0, to: 'foundation' }),
    /will not go there/, 'a three cannot land on an ace');
});

test('a tableau column takes descending alternating colour, and only a king when empty', () => {
  const base = deal();
  const state: KlondikeState = {
    ...base,
    tableau: [
      [{ card: 'spades-7', faceUp: true }],
      [{ card: 'hearts-6', faceUp: true }],
      [{ card: 'clubs-6', faceUp: true }],
      [], [], [], [],
    ],
  };
  const ok = applyMove(state, { from: 'tableau', fromIndex: 1, to: 'tableau', toIndex: 0 });
  assert.equal(ok.tableau[0].at(-1)!.card, 'hearts-6', 'red six onto a black seven');

  assert.throws(() => applyMove(state, { from: 'tableau', fromIndex: 2, to: 'tableau', toIndex: 0 }),
    /will not go there/, 'black six cannot go on a black seven');
  assert.throws(() => applyMove(state, { from: 'tableau', fromIndex: 0, to: 'tableau', toIndex: 3 }),
    /will not go there/, 'only a king starts an empty column');
});

test('moving a card uncovers the one beneath it', () => {
  const base = deal();
  const state: KlondikeState = {
    ...base,
    tableau: [
      [{ card: 'diamonds-9', faceUp: false }, { card: 'hearts-6', faceUp: true }],
      [{ card: 'spades-7', faceUp: true }],
      [], [], [], [], [],
    ],
  };
  const after = applyMove(state, { from: 'tableau', fromIndex: 0, to: 'tableau', toIndex: 1 });
  assert.equal(after.tableau[0].length, 1);
  assert.equal(after.tableau[0][0].faceUp, true, 'the nine turns over');
});

test('a run moves as a unit, and only if it is really a run', () => {
  const base = deal();
  const good: KlondikeState = {
    ...base,
    tableau: [
      [{ card: 'spades-8', faceUp: true }, { card: 'hearts-7', faceUp: true }],
      [{ card: 'hearts-9', faceUp: true }],
      [], [], [], [], [],
    ],
  };
  const moved = applyMove(good, { from: 'tableau', fromIndex: 0, count: 2, to: 'tableau', toIndex: 1 });
  assert.deepEqual(moved.tableau[1].map((c) => c.card), ['hearts-9', 'spades-8', 'hearts-7']);
  assert.equal(moved.tableau[0].length, 0);

  const bad: KlondikeState = {
    ...base,
    tableau: [
      [{ card: 'spades-8', faceUp: true }, { card: 'clubs-7', faceUp: true }],
      [{ card: 'hearts-9', faceUp: true }],
      [], [], [], [], [],
    ],
  };
  assert.throws(() => applyMove(bad, { from: 'tableau', fromIndex: 0, count: 2, to: 'tableau', toIndex: 1 }),
    /not a run/, 'two black cards are not a sequence');
});

test('undo puts the board back exactly', () => {
  const game = deal(3);
  const before = JSON.stringify({ ...game, history: [] });
  const after = draw(game);
  assert.notEqual(JSON.stringify({ ...after, history: [] }), before);
  const back = undo(after);
  assert.equal(JSON.stringify({ ...back, history: [] }), before);
});

test('undo refuses when there is nothing behind it', () => {
  assert.throws(() => undo(deal()), /Nothing to undo/);
});

test('auto-finish only offers itself once nothing is hidden, then wins', () => {
  const base = deal();
  const laid: KlondikeState = {
    ...base,
    stock: [],
    waste: [],
    foundations: { spades: [], clubs: [], diamonds: [], hearts: [] },
    // every card face up, one suit per column, kings at the bottom
    tableau: SUITS.map((suit) =>
      [...RANKS].reverse().map((rank) => ({ card: `${suit}-${rank}`, faceUp: true }))
    ).concat([[], [], []]),
  };
  assert.equal(canAutoFinish(laid), true);
  const { state, order } = autoFinish(laid);
  assert.equal(isWon(state), true);
  assert.equal(order.length, 52, 'every card flies home');
  assert.equal(state.wonAt !== null, true);

  const stillHidden: KlondikeState = {
    ...laid,
    tableau: laid.tableau.map((pile, i) =>
      i === 0 && pile.length ? [{ ...pile[0], faceUp: false }, ...pile.slice(1)] : pile),
  };
  assert.equal(canAutoFinish(stillHidden), false);
  assert.equal(canAutoFinish({ ...laid, stock: ['spades-ace'] }), false, 'stock left means not decided');
});

test('a won board does not offer to finish itself again', () => {
  const base = deal();
  const won: KlondikeState = {
    ...base,
    stock: [], waste: [], tableau: [[], [], [], [], [], [], []],
    foundations: {
      spades: RANKS.map((r) => `spades-${r}`),
      clubs: RANKS.map((r) => `clubs-${r}`),
      diamonds: RANKS.map((r) => `diamonds-${r}`),
      hearts: RANKS.map((r) => `hearts-${r}`),
    },
  };
  assert.equal(isWon(won), true);
  assert.equal(canAutoFinish(won), false);
});

// FINISH IT DID NOTHING AND STILL ANSWERED 200.
//
// Reported Sep 17 2026. Real Klondike lets any ace start any empty
// foundation; ours labels the four piles by suit. Both facts are fine alone and
// together they let the ace of hearts start the pile keyed `spades` — after
// which every lookup asking for foundations[suitOf(card)] points at the wrong
// pile. autoFinish asks exactly that, finds a pile it cannot build on, moves
// nothing, and reports success.

test('an ace cannot start a foundation belonging to another suit', () => {
  const state = deal();
  state.stock = [];
  state.waste = ['hearts-ace'];
  state.tableau = state.tableau.map(() => []);
  assert.throws(
    () => applyMove(state, { from: 'waste', to: 'foundation', toSuit: 'spades' }),
    /will not go there/,
    'the slot is labelled, so the label is the rule',
  );
});

test('and it does go to its own', () => {
  const state = deal();
  state.stock = [];
  state.waste = ['hearts-ace'];
  state.tableau = state.tableau.map(() => []);
  const after = applyMove(state, { from: 'waste', to: 'foundation', toSuit: 'hearts' });
  assert.deepEqual(after.foundations.hearts, ['hearts-ace']);
});

test('a game already saved with a suit in the wrong slot can still be finished', () => {
  // The repair half: this state cannot be created any more, but it exists in
  // databases where it was created before the rule above.
  const state = deal();
  state.stock = [];
  state.waste = [];
  state.foundations = { spades: ['hearts-ace'], clubs: [], diamonds: [], hearts: [] };
  state.tableau = state.tableau.map(() => []);
  state.tableau[0] = [{ card: 'hearts-2', faceUp: true }];
  const { order } = autoFinish(state);
  assert.deepEqual(order, ['hearts-2'], 'it found the pile the suit is actually in');
});
