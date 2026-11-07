// Copyright 2026 Aerie Systems. Licensed under the Apache License 2.0. Porting code from here? Keep this line, and credit Aerie in your NOTICE file for this and anything ported before.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_BATTLESHIP_FLEET, fleetFromOverride } from './battleship.js';

// Namesakes live in gitignored data/fleet.json rather than in the code, so a
// house can name its ships after its own people without forking the game.
// An override may rename ships and NOTHING else — a
// placement stored under one name cannot be validated against a different
// length, so a disagreeing file has to be ignored whole rather than half-applied.

const RENAMED = [
  { name: 'The Lighthouse', length: 4, color: '#e85d04' },
  { name: 'The Ferry', length: 3, color: '#1e3a5f' },
  { name: 'The Trawler', length: 3, color: '#7c3aed' },
  { name: 'The Dinghy', length: 2, color: '#cbd5e1' },
  { name: 'The Tugboat', length: 2, color: '#e11d48' },
];

test('the deck that ships is the ordinary one', () => {
  assert.deepEqual(
    DEFAULT_BATTLESHIP_FLEET.map(s => s.name),
    ['Battleship', 'Cruiser', 'Submarine', 'Destroyer', 'Patrol Boat'],
  );
  assert.deepEqual(DEFAULT_BATTLESHIP_FLEET.map(s => s.length), [4, 3, 3, 2, 2]);
});

test('a fleet the owner chose is honoured and changes only the names and colours', () => {
  const fleet = fleetFromOverride(RENAMED);
  assert.deepEqual(fleet.map(s => s.name), RENAMED.map(s => s.name));
  assert.deepEqual(fleet.map(s => s.length), DEFAULT_BATTLESHIP_FLEET.map(s => s.length));
  assert.equal(fleet[0].color, '#e85d04');
});

test('a fleet that would change the GAME is refused whole', () => {
  const longer = RENAMED.map((s, i) => (i === 0 ? { ...s, length: 5 } : s));
  assert.deepEqual(fleetFromOverride(longer), DEFAULT_BATTLESHIP_FLEET);
  assert.deepEqual(fleetFromOverride(RENAMED.slice(0, 4)), DEFAULT_BATTLESHIP_FLEET);
  assert.deepEqual(fleetFromOverride([...RENAMED, { name: 'Extra', length: 2, color: '#fff' }]), DEFAULT_BATTLESHIP_FLEET);
});

test('an unusable file falls back rather than throwing', () => {
  for (const bad of [null, undefined, {}, 'nope', 7, [], [{}, {}, {}, {}, {}]]) {
    assert.deepEqual(fleetFromOverride(bad), DEFAULT_BATTLESHIP_FLEET, JSON.stringify(bad));
  }
});

test('a ship with no name is not a rename', () => {
  const blank = RENAMED.map((s, i) => (i === 2 ? { ...s, name: '   ' } : s));
  assert.deepEqual(fleetFromOverride(blank), DEFAULT_BATTLESHIP_FLEET);
});

test('a junk colour keeps the shipped one instead of reaching the phone', () => {
  const badColor = RENAMED.map((s, i) => (i === 1 ? { ...s, color: 'navy' } : s));
  const fleet = fleetFromOverride(badColor);
  assert.equal(fleet[1].name, 'The Ferry');
  assert.equal(fleet[1].color, DEFAULT_BATTLESHIP_FLEET[1].color);
});
