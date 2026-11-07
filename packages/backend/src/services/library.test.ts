import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  stripGutenbergBoilerplate,
  splitChapters,
  searchCatalog,
  fetchAndShelve,
  readShelf,
  readBook,
  setProgress,
  removeBook,
  saveBook,
  paragraphsOf,
  segmentsOf,
  currentlyReading,
  readAlong,
  addNote,
  readNotes,
  removeNote,
  LibraryError,
} from './library.js';

const para = (n: number) => `${'The house was quiet and the rain kept on. '.repeat(n)}\n`;

const RAW = [
  'The Project Gutenberg eBook of A Test Book',
  'This eBook is for the use of anyone anywhere.',
  '',
  '*** START OF THE PROJECT GUTENBERG EBOOK A TEST BOOK ***',
  '',
  'A TEST BOOK',
  '',
  'CONTENTS',
  '',
  'CHAPTER I',
  'CHAPTER II',
  '',
  '',
  'CHAPTER I.',
  'The Arrival',
  '',
  para(20),
  '',
  'CHAPTER II.',
  '',
  para(25),
  '',
  '*** END OF THE PROJECT GUTENBERG EBOOK A TEST BOOK ***',
  'Licence text that is not part of the book.',
].join('\n');

describe('library text', () => {
  it('strips the Gutenberg header and footer, keeping the book', () => {
    const body = stripGutenbergBoilerplate(RAW);
    assert.ok(body.startsWith('A TEST BOOK'));
    assert.ok(!body.includes('START OF THE PROJECT'));
    assert.ok(!body.includes('Licence text'));
  });

  it('splits on the book’s own chapter headings, subtitles included, contents list folded away', () => {
    const chapters = splitChapters(stripGutenbergBoilerplate(RAW));
    const titles = chapters.map((c) => c.title);
    assert.deepEqual(titles, ['CHAPTER I. — The Arrival', 'CHAPTER II.']);
    assert.ok(chapters[0].text.includes('rain kept on'));
    assert.ok(!chapters[0].text.startsWith('The Arrival'), 'the subtitle is not repeated as body text');
    assert.ok(chapters.every((c) => c.text.length > 0));
  });

  it('never drops a short section — it rides into the next chapter', () => {
    const body = ['CHAPTER I.', '', 'A note.', '', 'CHAPTER II.', '', para(20), '', 'CHAPTER III.', '', para(20)].join('\n');
    const chapters = splitChapters(body);
    assert.equal(chapters.length, 2);
    assert.ok(chapters[0].text.startsWith('A note.'), 'the short section is kept');
  });

  it('cuts a book with no headings into even parts at paragraph breaks', () => {
    const body = Array.from({ length: 60 }, () => para(15)).join('\n\n');
    const parts = splitChapters(body);
    assert.ok(parts.length >= 2);
    assert.equal(parts[0].title, 'Part 1');
    assert.equal(parts.map((p) => p.text).join('\n\n').replace(/\s+/g, ' ').trim(), body.replace(/\s+/g, ' ').trim());
  });
});

describe('library catalog and shelf', () => {
  const meta = {
    id: 999001,
    title: 'A Test Book',
    authors: [{ name: 'Writer, Some' }],
    languages: ['en'],
    download_count: 42,
    formats: {
      'text/plain; charset=utf-8': 'https://www.gutenberg.org/ebooks/999001.txt.utf-8',
      'application/zip': 'https://example.invalid/book.zip',
      'image/jpeg': 'https://www.gutenberg.org/cache/epub/999001/pg999001.cover.medium.jpg',
    },
  };
  const fakeFetch = async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (url.includes('search=') ? { results: [meta, { ...meta, id: 2, formats: { 'application/epub+zip': 'x' } }] } : meta),
    text: async () => RAW,
  });

  it('search keeps only books with plain text and names authors the cover way', async () => {
    const results = await searchCatalog('test', fakeFetch);
    assert.equal(results.length, 1);
    assert.deepEqual(results[0].authors, ['Some Writer']);
    assert.equal(results[0].cover, meta.formats['image/jpeg']);
  });

  it('shelves a book, keeps the bookmark across a re-fetch, and removes it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'library-'));
    try {
      const entry = await fetchAndShelve(meta.id, fakeFetch, root);
      assert.equal(entry.chapterCount, 2);
      assert.equal(readShelf(root).length, 1);
      assert.equal(readBook(meta.id, root)?.chapters[0].title, 'CHAPTER I. — The Arrival');

      const marked = setProgress(meta.id, 1, 0.4, root);
      assert.equal(marked?.progress?.chapter, 1);
      assert.equal(setProgress(meta.id, 99, 7, root)?.progress?.chapter, 1, 'chapter and fraction are clamped');

      await fetchAndShelve(meta.id, fakeFetch, root);
      assert.equal(readShelf(root)[0].progress?.chapter, 1, 'a re-fetch keeps her place');

      assert.equal(removeBook(meta.id, root), true);
      assert.equal(readShelf(root).length, 0);
      assert.equal(readBook(meta.id, root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('reading along', () => {
  const words = (i: number) => `Paragraph ${i} says the rain kept on and the house stayed quiet.`;
  const chapterText = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `${tag} ${words(i)}`).join('\n\n');
  const book = {
    id: 999002,
    title: 'Two Rooms',
    authors: ['Some Writer'],
    cover: null,
    source: 'gutenberg' as const,
    fetchedAt: '2026-10-21T00:00:00.000Z',
    chapters: [
      { title: 'One', text: chapterText('first', 10) },
      { title: 'Two', text: chapterText('second', 10) },
      { title: 'Three', text: chapterText('third', 10) },
    ],
  };

  it('splits paragraphs on blank lines and unwraps hard-wrapped lines', () => {
    assert.deepEqual(paragraphsOf('one\nline\n\n\n two \n\n'), ['one line', 'two']);
  });

  it('cuts read-aloud segments at paragraph breaks, covering every paragraph once', () => {
    const paragraphs = Array.from({ length: 9 }, () => 'x'.repeat(500));
    const segs = segmentsOf(paragraphs, 1200);
    assert.deepEqual(segs[0], { from: 0, to: 1 });
    assert.equal(segs[0].from, 0);
    assert.equal(segs[segs.length - 1].to, 8);
    for (let i = 1; i < segs.length; i++) assert.equal(segs[i].from, segs[i - 1].to + 1);
    assert.deepEqual(segmentsOf(['y'.repeat(5000)], 1200), [{ from: 0, to: 0 }], 'a long paragraph is its own segment');
    assert.deepEqual(segmentsOf([]), []);
  });

  it('never reads past her bookmark', () => {
    const root = mkdtempSync(join(tmpdir(), 'library-'));
    try {
      saveBook(book, root);
      assert.equal(currentlyReading(root), null, 'nothing is being read before a bookmark');
      assert.throws(() => readAlong(book.id, undefined, root), LibraryError);

      setProgress(book.id, 1, 0.25, root);
      assert.equal(currentlyReading(root)?.id, book.id);

      const here = readAlong(book.id, undefined, root);
      assert.equal(here.chapter, 1);
      assert.equal(here.cutAtHerPlace, true);
      assert.equal(here.paragraphs.length, 4, 'ceil(0.25 × 10) + 1 paragraphs');
      assert.equal(here.totalParagraphs, 10);

      const behind = readAlong(book.id, 0, root);
      assert.equal(behind.paragraphs.length, 10, 'a chapter she finished is whole');
      assert.equal(behind.cutAtHerPlace, false);

      assert.throws(() => readAlong(book.id, 2, root), /no reading ahead/);
      assert.throws(() => readAlong(book.id, 9, root), LibraryError);
      assert.throws(() => readAlong(123, undefined, root), LibraryError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('hangs margin notes only on words she has reached, and clears them with the book', () => {
    const root = mkdtempSync(join(tmpdir(), 'library-'));
    try {
      saveBook(book, root);
      setProgress(book.id, 1, 0.25, root);

      const note = addNote({ bookId: book.id, chapter: 1, quote: '  second Paragraph 2 says\nthe rain ', note: 'This line.', author: 'Companion-A' }, root);
      assert.equal(note.paragraph, 2);
      assert.equal(note.author, 'companion-a');
      assert.equal(note.quote, 'second Paragraph 2 says the rain');
      assert.equal(addNote({ bookId: book.id, chapter: 0, quote: 'first Paragraph 9', note: 'Earlier.', author: 'companion-b' }, root).paragraph, 9);

      assert.throws(() => addNote({ bookId: book.id, chapter: 1, quote: 'second Paragraph 8', note: 'x', author: 'companion-a' }, root), /not on a page she has reached/);
      assert.throws(() => addNote({ bookId: book.id, chapter: 2, quote: 'third Paragraph 0', note: 'x', author: 'companion-a' }, root), /no reading ahead/);
      assert.throws(() => addNote({ bookId: book.id, chapter: 1, quote: 'se', note: 'x', author: 'companion-a' }, root), LibraryError);
      assert.throws(() => addNote({ bookId: book.id, chapter: 1, quote: 'second Paragraph 1', note: ' ', author: 'companion-a' }, root), LibraryError);
      assert.throws(() => addNote({ bookId: book.id, chapter: 1, quote: 'second Paragraph 1', note: 'x', author: 'Not A Slug' }, root), LibraryError);

      assert.equal(readNotes(book.id, root).length, 2);
      assert.equal(removeNote(book.id, note.id, root), true);
      assert.equal(removeNote(book.id, note.id, root), false);
      assert.equal(readNotes(book.id, root).length, 1);

      removeBook(book.id, root);
      assert.deepEqual(readNotes(book.id, root), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
