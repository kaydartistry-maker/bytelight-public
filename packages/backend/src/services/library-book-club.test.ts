// The Book Club's rules and her reviews, on a scratch library folder.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BookClubError,
  OWNER_SEAT,
  addPitch,
  bookClubView,
  castVote,
  currentRound,
  finishRound,
  leaders,
  pickWinner,
  readRounds,
  startRound,
  stillWaiting,
  tally,
} from './library-book-club.js';
import { readShelf, saveBook, setReview, setShelf, LibraryError, type LibraryBook } from './library.js';

const SEATS = [{ id: 'companion-a', name: 'Companion A' }, { id: 'companion-b', name: 'Companion B' }];

const RAW = [
  '*** START OF THE PROJECT GUTENBERG EBOOK A CLUB BOOK ***',
  '',
  'CHAPTER I',
  '',
  `${'The rain kept on and the house was quiet. '.repeat(30)}`,
  '',
  'CHAPTER II',
  '',
  `${'The letter came in the morning, unsigned. '.repeat(30)}`,
  '',
  '*** END OF THE PROJECT GUTENBERG EBOOK A CLUB BOOK ***',
].join('\n');

function gutenbergFetch(id: number) {
  const calls: string[] = [];
  const meta = {
    id,
    title: 'A Club Book',
    authors: [{ name: 'Writer, Some' }],
    languages: ['en'],
    download_count: 7,
    formats: { 'text/plain; charset=utf-8': `https://www.gutenberg.org/ebooks/${id}.txt.utf-8` },
  };
  const impl = async (url: string) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => meta, text: async () => RAW };
  };
  return { impl, calls };
}

function book(id: number, title: string): LibraryBook {
  return { id, title, authors: ['Someone'], cover: null, source: 'upload', fetchedAt: new Date().toISOString(), chapters: [{ title: 'One', text: 'Words.' }] };
}

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'book-club-test-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('book club rounds', () => {
  it('goes open → reading → finished, one round at a time', async () => {
    const round = startRound(root);
    assert.equal(round.status, 'open');
    assert.throws(() => startRound(root), (e: unknown) => e instanceof BookClubError && e.status === 409);

    const p = addPitch(round.id, { by: 'companion-a', title: 'Dracula', author: 'Bram Stoker', pitch: 'Letters, dread, a castle.' }, SEATS, root);
    castVote(round.id, { voter: 'companion-a', pitchId: p.id }, SEATS, root);
    const picked = await pickWinner(round.id, {}, root);
    assert.equal(picked.status, 'reading');
    assert.equal(picked.winnerPitchId, p.id);
    assert.equal(picked.bookId, null, 'no Gutenberg id and not on the shelf: just shown');

    assert.throws(() => addPitch(round.id, { by: 'companion-b', title: 'Late', pitch: 'x' }, SEATS, root), /past pitching/);
    const done = finishRound(round.id, root);
    assert.equal(done.status, 'finished');
    assert.equal(currentRound(root), null);

    const view = bookClubView(SEATS, 'Her', root);
    assert.equal(view.current, null);
    assert.equal(view.past.length, 1);
    assert.equal(view.owner.id, OWNER_SEAT);
    // A new round can start once the last one is finished.
    assert.equal(startRound(root).status, 'open');
    assert.equal(readRounds(root).length, 2);
  });

  it('takes one pitch each: pitching again replaces it and keeps its votes', () => {
    const round = startRound(root);
    const first = addPitch(round.id, { by: 'companion-b', title: 'Rebecca', pitch: 'A house that remembers.' }, SEATS, root);
    castVote(round.id, { voter: 'owner', pitchId: first.id }, SEATS, root);
    const again = addPitch(round.id, { by: 'companion-b', title: 'Jane Eyre', author: 'Charlotte Brontë', pitch: 'Fire in the attic.' }, SEATS, root);
    assert.equal(again.id, first.id);
    const r = currentRound(root)!;
    assert.equal(r.pitches.length, 1);
    assert.equal(r.pitches[0].title, 'Jane Eyre');
    assert.equal(tally(r)[first.id], 1);
  });

  it('refuses strangers, empty titles, and companion pitches without a line', () => {
    const round = startRound(root);
    assert.throws(() => addPitch(round.id, { by: 'nobody', title: 'X', pitch: 'y' }, SEATS, root), /by must be one of/);
    assert.throws(() => addPitch(round.id, { by: 'companion-a', title: '  ', pitch: 'y' }, SEATS, root), /title/);
    assert.throws(() => addPitch(round.id, { by: 'companion-a', title: 'X' }, SEATS, root), /pitch/);
    // Hers can be just a title.
    assert.ok(addPitch(round.id, { by: OWNER_SEAT, title: 'Emma' }, SEATS, root));
    assert.throws(() => addPitch(round.id, { by: 'companion-a', title: 'X', pitch: 'y', bookId: 42 }, SEATS, root), /not on her shelf/);
    assert.throws(() => addPitch('nope', { by: 'companion-a', title: 'X', pitch: 'y' }, SEATS, root), (e: unknown) => e instanceof BookClubError && e.status === 404);
  });

  it('counts one vote each, and a second vote moves it', () => {
    const round = startRound(root);
    const a = addPitch(round.id, { by: 'companion-a', title: 'A', pitch: 'a' }, SEATS, root);
    const b = addPitch(round.id, { by: 'companion-b', title: 'B', pitch: 'b' }, SEATS, root);
    castVote(round.id, { voter: 'companion-a', pitchId: a.id }, SEATS, root);
    castVote(round.id, { voter: 'companion-a', pitchId: b.id }, SEATS, root);
    castVote(round.id, { voter: 'companion-b', pitchId: b.id }, SEATS, root);
    const r = currentRound(root)!;
    assert.deepEqual(tally(r), { [a.id]: 0, [b.id]: 2 });
    assert.deepEqual(leaders(r), [b.id]);
    assert.deepEqual(stillWaiting(r, SEATS), { pitch: [], vote: [] });
    assert.throws(() => castVote(round.id, { voter: 'companion-a', pitchId: 'missing' }, SEATS, root), /no pitch/);
    assert.throws(() => castVote(round.id, { voter: 'ghost', pitchId: a.id }, SEATS, root), /voter must be one of/);
  });

  it('a tie is hers to break, and only between the tied books', async () => {
    const round = startRound(root);
    const a = addPitch(round.id, { by: 'companion-a', title: 'A', pitch: 'a' }, SEATS, root);
    const b = addPitch(round.id, { by: 'companion-b', title: 'B', pitch: 'b' }, SEATS, root);
    const c = addPitch(round.id, { by: OWNER_SEAT, title: 'C' }, SEATS, root);
    castVote(round.id, { voter: 'companion-a', pitchId: a.id }, SEATS, root);
    castVote(round.id, { voter: 'companion-b', pitchId: b.id }, SEATS, root);
    await assert.rejects(pickWinner(round.id, {}, root), /tie/);
    await assert.rejects(pickWinner(round.id, { pitchId: c.id }, root), /tied/);
    const r = await pickWinner(round.id, { pitchId: b.id }, root);
    assert.equal(r.winnerPitchId, b.id);
  });

  it('when the votes chose, her pick has to match them', async () => {
    const round = startRound(root);
    const a = addPitch(round.id, { by: 'companion-a', title: 'A', pitch: 'a' }, SEATS, root);
    const b = addPitch(round.id, { by: 'companion-b', title: 'B', pitch: 'b' }, SEATS, root);
    castVote(round.id, { voter: 'owner', pitchId: a.id }, SEATS, root);
    await assert.rejects(pickWinner(round.id, { pitchId: b.id }, root), /already chose/);
  });

  it('a Gutenberg winner not yet shelved is fetched onto Reading', async () => {
    const round = startRound(root);
    const p = addPitch(round.id, { by: 'companion-a', title: 'A Club Book', pitch: 'Read it with me.', gutenbergId: 4242 }, SEATS, root);
    castVote(round.id, { voter: 'companion-a', pitchId: p.id }, SEATS, root);
    const { impl, calls } = gutenbergFetch(4242);
    const r = await pickWinner(round.id, {}, root, impl);
    assert.ok(calls.length > 0, 'fetched from Gutenberg');
    assert.equal(r.bookId, 4242);
    const entry = readShelf(root).find((e) => e.id === 4242);
    assert.equal(entry?.shelf, 'reading');
    assert.equal(r.shelveError, null);
  });

  it('a winner already on the shelf is linked, and moved to Reading from To Be Read; no fetch', async () => {
    saveBook(book(1_000_000_001, 'Her Own Book'), root);
    const round = startRound(root);
    const p = addPitch(round.id, { by: OWNER_SEAT, title: 'Her Own Book', bookId: 1_000_000_001 }, SEATS, root);
    castVote(round.id, { voter: 'owner', pitchId: p.id }, SEATS, root);
    const { impl, calls } = gutenbergFetch(1);
    const r = await pickWinner(round.id, {}, root, impl);
    assert.equal(calls.length, 0);
    assert.equal(r.bookId, 1_000_000_001);
    assert.equal(readShelf(root)[0].shelf, 'reading');
  });

  it('a fetch that fails still picks the winner and says why', async () => {
    const round = startRound(root);
    const p = addPitch(round.id, { by: 'companion-a', title: 'Gone', pitch: 'x', gutenbergId: 77 }, SEATS, root);
    castVote(round.id, { voter: 'companion-a', pitchId: p.id }, SEATS, root);
    const failing = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
    const r = await pickWinner(round.id, {}, root, failing);
    assert.equal(r.status, 'reading');
    assert.equal(r.bookId, null);
    assert.match(r.shelveError ?? '', /couldn't be fetched/);
  });

  it('an open round can be set aside with no winner', async () => {
    const round = startRound(root);
    await assert.rejects(pickWinner(round.id, {}, root), /Nobody has pitched/);
    const r = finishRound(round.id, root);
    assert.equal(r.status, 'finished');
    assert.equal(r.winnerPitchId, null);
    assert.throws(() => finishRound(round.id, root), /already finished/);
  });
});

describe('her reviews', () => {
  it('rates a book, keeps the review through a re-shelve and a move, and clears it', () => {
    saveBook(book(1_000_000_005, 'Rated'), root);
    const e = setReview(1_000_000_005, { stars: 4, text: '  Loved the ending.  ' }, root)!;
    assert.equal(e.review?.stars, 4);
    assert.equal(e.review?.text, 'Loved the ending.');
    saveBook(book(1_000_000_005, 'Rated'), root);
    setShelf(1_000_000_005, { shelf: 'finished' }, root);
    assert.equal(readShelf(root)[0].review?.stars, 4);
    setReview(1_000_000_005, { stars: null }, root);
    assert.equal(readShelf(root)[0].review, undefined);
  });

  it('refuses stars outside 1–5 and books not on the shelf', () => {
    saveBook(book(1_000_000_006, 'Rated'), root);
    for (const stars of [0, 6, 2.5, 'x', undefined]) {
      assert.throws(() => setReview(1_000_000_006, { stars }, root), LibraryError);
    }
    assert.equal(setReview(123, { stars: 3 }, root), null);
  });

  it('a Kindle notebook card can be rated, and its review moves to the real book when it arrives', () => {
    // A notes-only card, as the Kindle import leaves it on the shelf.
    writeFileSync(join(root, 'shelf.json'), JSON.stringify([{
      id: 2_000_000_001, title: 'The Card Book', authors: ['Someone'], cover: null, chapterCount: 0,
      addedAt: new Date().toISOString(), progress: null, shelf: 'finished', favorite: false, source: 'kindle',
    }]));
    assert.equal(setReview(2_000_000_001, { stars: 5, text: 'Read it on the Kindle.' }, root)?.review?.stars, 5);
    saveBook(book(1_000_000_009, 'The Card Book'), root);
    const shelf = readShelf(root);
    assert.equal(shelf.some((e) => e.id === 2_000_000_001), false, 'the card retired');
    assert.equal(shelf.find((e) => e.id === 1_000_000_009)?.review?.text, 'Read it on the Kindle.');
  });
});
