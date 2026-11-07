// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// byte-light: the DB opens against a throwaway home the way rooms.card.test.ts
// does, and the house's companions come from the registry seed (migration
// 014: companion-a, companion-b, companion-c) rather than Aerie's createCompanion().
const tmpRoot = mkdtempSync(join(tmpdir(), 'card-room-test-'));
process.env.RESONANT_HOME = tmpRoot;
writeFileSync(join(tmpRoot, 'config.yaml'), 'agent:\n  cwd: .\n  model: claude-sonnet-4-6\n');

const { initDb } = await import('../db.js');
const { listCompanions } = await import('./rooms.js');
const {
  ownerSeat,
  buildCardRoomPrompt,
  getCardTable,
  newCardTable,
  seatOrder,
  viewCardTable,
} = await import('./cards.js');

// Two contracts that have each already failed in real use, and neither of
// which anything was checking. They are here as guards rather than as coverage:
// both bugs were invisible to the type system and to every existing test, and
// both were found on the owner's own screen.
//
// Dealing a table needs the cut deck, and the art is gitignored — so the seat
// contract skips itself on a clone rather than failing there. loadDeck refusing
// to deal without art is the correct behaviour, not the thing under test.

const HERE = dirname(fileURLToPath(import.meta.url));
// The house's own deck (data/cards, gitignored) or the plain one that ships
// with the code (packages/backend/assets/cards) — loadDeck takes either.
const DECK_CUT = existsSync(join(HERE, '../../../../../data/cards/cards.json'))
  || existsSync(join(HERE, '../../../assets/cards/cards.json'));
const UNCUT = 'no deck on disk — neither data/cards nor assets/cards has a manifest';

function seedHouse(): { slugs: string[] } {
  initDb(join(tmpRoot, 'test.db'));
  return { slugs: listCompanions().map((c) => c.id) };
}

test('every seat is keyed and served by SLUG, never by a uuid', { skip: DECK_CUT ? false : UNCUT }, () => {
  const { slugs } = seedHouse();
  assert.ok(slugs.length > 0, 'the registry seed gives the house its companions');

  // The chairs on the phone are looked up by slug. Keying them by a raw id put
  // three uuids and three broken-image glyphs at the owner's table mid-game.
  // byte-light's registry id IS the slug, so the guard is the uuid shape.
  assert.deepEqual(seatOrder(), [...slugs, ownerSeat()]);

  const created = newCardTable('klondike');
  const stored = getCardTable(created.id);
  assert.ok(stored, 'the table it just made should be readable back');

  const storedKeys = Object.keys(stored.seats);
  assert.deepEqual(storedKeys.sort(), [...slugs, ownerSeat()].sort());

  const view = viewCardTable(stored, ownerSeat());
  const viewed = view.seats.map((seat) => seat.slug);
  assert.deepEqual(viewed.sort(), [...slugs, ownerSeat()].sort());
  for (const seat of [...storedKeys, ...viewed]) {
    assert.ok(
      !/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seat),
      `a uuid-shaped seat means the phone will render a raw id (${seat})`,
    );
  }

  // The owner's own chair is the only one whose hand is visible to them.
  const mine = view.seats.find((seat) => seat.slug === ownerSeat());
  assert.ok(mine && Array.isArray(mine.hand), 'the owner sees their own hand');
  assert.ok(view.seats.filter((seat) => seat.hand !== undefined).length === 1);
});

test('what the owner said reaches the prompt, and it goes last', () => {
  // The failure this guards was silent in every instrument: the message was
  // written to the database and rendered on the owner's screen, and simply never put
  // into the turn. The room answered the board three times running.
  const line = 'lol are you responding to me';
  const prompt = buildCardRoomPrompt('klondike', 'Stock 0, waste 0.', line);

  assert.ok(prompt.includes(line), 'the prompt must carry what they actually said');
  assert.ok(prompt.trimEnd().endsWith(line), 'what the owner said goes last, after the framing and the board');
  assert.ok(prompt.includes('Stock 0, waste 0.'), 'the board still travels with it');

  // A board-less table must not quietly drop the owner's line along with the board.
  const dealt = buildCardRoomPrompt('klondike', null, line);
  assert.ok(dealt.includes('Nothing dealt yet.'));
  assert.ok(dealt.trimEnd().endsWith(line));

  // Markdown in the owner's line is theirs and is passed through untouched.
  const emphatic = '**this** one, the _seven_';
  assert.ok(buildCardRoomPrompt('klondike', null, emphatic).trimEnd().endsWith(emphatic));
});
