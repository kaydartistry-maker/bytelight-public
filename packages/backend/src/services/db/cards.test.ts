// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Card Room deals IDs, and the art lives on disk under a different name.
// If those two ever drift, a dealt card arrives on the phone as a hole in
// somebody's hand and nothing anywhere throws — so the manifest and the files
// are checked against each other here rather than trusted.
//
// These tests read the real deck. They skip rather than fail if it has not been
// cut, because the art is gitignored and a fresh clone has no data/cards.
//
// The skip has to be a real skip. Returning early reports as a PASS, so on a
// clone this file went green while asserting nothing at all — five tests'
// worth of coverage that looked present and was not.

const HERE = dirname(fileURLToPath(import.meta.url));
const CARDS_DIR = join(HERE, '../../../../../data/cards');
const MANIFEST = join(CARDS_DIR, 'cards.json');

const SUITS = ['spades', 'clubs', 'diamonds', 'hearts'];
const RANKS = ['ace', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'jack', 'queen', 'king'];

interface ManifestCard { suit: string; rank: string; file: string }

const CUT = existsSync(MANIFEST);
const UNCUT = 'the deck has not been cut — data/cards is gitignored';

function deck(): ManifestCard[] | null {
  if (!existsSync(MANIFEST)) return null;
  const parsed = JSON.parse(readFileSync(MANIFEST, 'utf-8')) as { cards?: ManifestCard[] };
  return parsed.cards ?? [];
}

test('the manifest describes a whole deck and a back', { skip: CUT ? false : UNCUT }, () => {
  const cards = deck()!;
  const faces = cards.filter((c) => c.rank !== 'back');
  assert.equal(faces.length, 52, 'a deck is 52 cards');
  assert.ok(cards.some((c) => c.rank === 'back'), 'the deck needs a back');
  for (const suit of SUITS) {
    const inSuit = faces.filter((c) => c.suit === suit).map((c) => c.rank).sort();
    assert.deepEqual(inSuit, [...RANKS].sort(), `${suit} is missing ranks`);
  }
});

test('every card in the manifest has art on disk', { skip: CUT ? false : UNCUT }, () => {
  const cards = deck()!;
  const missing = cards.filter((c) => !existsSync(join(CARDS_DIR, c.file)));
  assert.deepEqual(missing.map((c) => c.file), [], 'manifest names files that are not there');
});

test('the ID the room deals matches the file the art route serves', { skip: CUT ? false : UNCUT }, () => {
  const cards = deck()!;
  // routes/cards.ts turns '<suit>-<rank>' into '<suit>-<rank>.png'. That is only
  // safe while the manifest's own filename is exactly that.
  for (const card of cards) {
    if (card.rank === 'back') continue;
    assert.equal(card.file, `${card.suit}-${card.rank}.png`,
      `${card.file} would be dealt as ${card.suit}-${card.rank} and never found`);
  }
});

test('the whole deck sits on one paper', { skip: CUT ? false : UNCUT }, (t) => {
  const cards = deck()!;
  const parsed = JSON.parse(readFileSync(MANIFEST, 'utf-8')) as { stock?: number[] };
  // normalize-stock.py records the target it put every card on. Its absence
  // means the pass has not been run, which is a fact rather than a failure.
  if (!parsed.stock) return t.skip('normalize-stock.py has not been run on this deck');
  assert.equal(parsed.stock.length, 3, 'stock is an RGB triple');
});

test('every card is cut to the same size', { skip: CUT ? false : UNCUT }, () => {
  const cards = deck()!;
  const parsed = JSON.parse(readFileSync(MANIFEST, 'utf-8')) as { size?: number[] };
  assert.ok(parsed.size && parsed.size.length === 2, 'the manifest records one canvas');
  // A deck whose cards are different sizes cannot be dealt face down.
  assert.deepEqual(parsed.size, [840, 1260]);
});

test('a seat sees only its own cards: counts and face-up cards stay, faces, the stock and the kitty under its top card go', async () => {
    const { redactGameState, HIDDEN_CARD } = await import('./cards.js');
    const game = {
      hands: { user: ['AH', '2H'], 'companion-a': ['KS', 'QS', 'JS'], 'companion-b': [{ card: '9C', faceUp: true }, { card: '8C', faceUp: false }] },
      stock: ['3D', '4D'],
      kitty: ['5S', '6S', '7S'],
      turn: 'user',
    };
    const seen = redactGameState(game, 'user');
    assert.deepEqual(seen.hands.user, ['AH', '2H']);
    assert.deepEqual(seen.hands['companion-a'], [HIDDEN_CARD, HIDDEN_CARD, HIDDEN_CARD]);
    assert.deepEqual(seen.hands['companion-b'], [{ card: '9C', faceUp: true }, { card: HIDDEN_CARD, faceUp: false }]);
    assert.deepEqual(seen.stock, [HIDDEN_CARD, HIDDEN_CARD]);
    assert.deepEqual(seen.kitty, ['5S', HIDDEN_CARD, HIDDEN_CARD]);
    assert.equal(seen.turn, 'user');
    assert.deepEqual(game.hands['companion-a'], ['KS', 'QS', 'JS'], 'the stored game is untouched');
    const solitaire = { tableau: [['AH']], stock: ['2H'] };
    assert.equal(redactGameState(solitaire, 'user'), solitaire, 'a game with no hands passes through');
});
