import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { leadersOf, namesList, seatName, starLine, stillToPitch, votersFor, winnerMode, type ClubRound } from './library-book-club';

const seats = [{ id: 'companion-a', name: 'Companion A' }, { id: 'companion-b', name: 'Companion B' }];

function round(over: Partial<ClubRound> = {}): ClubRound {
  return {
    id: 'r', status: 'open', startedAt: '', pitches: [], votes: {}, winnerPitchId: null, bookId: null,
    shelveError: null, pickedAt: null, finishedAt: null, turn: { state: 'idle', note: null, at: '' }, ...over,
  };
}
const pitch = (id: string, by: string) => ({ id, by, title: id, author: '', pitch: '', gutenbergId: null, bookId: null });

test('names: she is You, the companions by name, lists read naturally', () => {
  assert.equal(seatName('owner', seats), 'You');
  assert.equal(seatName('companion-b', seats), 'Companion B');
  assert.equal(namesList(['Companion A', 'Companion B']), 'Companion A and Companion B');
  assert.equal(namesList(['A', 'B', 'C']), 'A, B and C');
  assert.equal(namesList([]), '');
});

test('votes: who voted for what, ties and a clear winner', () => {
  const r = round({ pitches: [pitch('a', 'companion-a'), pitch('b', 'companion-b')], votes: { 'companion-b': 'a', owner: 'a', 'companion-a': 'b' } });
  assert.deepEqual(votersFor(r, 'a'), ['owner', 'companion-b']);
  assert.deepEqual(leadersOf(r), ['a']);
  assert.equal(winnerMode(r), 'single');
  assert.equal(winnerMode(round({ pitches: [pitch('a', 'companion-a'), pitch('b', 'companion-b')] })), 'tie');
  assert.equal(winnerMode(round()), 'none');
  assert.deepEqual(stillToPitch(round({ pitches: [pitch('a', 'companion-a')] }), seats).map((s) => s.id), ['companion-b']);
});

test('stars read as five, filled to the rating', () => {
  assert.equal(starLine(3), '★★★☆☆');
  assert.equal(starLine(9), '★★★★★');
});

test('the Library opens the Book Club and the review sheet from their own files', () => {
  const library = readFileSync(new URL('../components/LibraryApp.tsx', import.meta.url), 'utf8');
  assert.match(library, /from '\.\/LibraryBookClub'/);
  assert.match(library, /from '\.\/LibraryReview'/);
  assert.match(library, /Rate &amp; review|Rate & review/);
});
