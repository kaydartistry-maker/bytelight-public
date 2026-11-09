import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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
  setShelf,
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
  parseOpdsSearch,
  parseOpdsBook,
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

describe('catalog fallback when Gutendex is down', () => {
  const SEARCH = `<?xml version="1.0"?><feed>
<id>http://www.gutenberg.org/ebooks/search.opds/?query=dorian</id>
<entry><id>https://www.gutenberg.org/ebooks/subjects/search.opds/?query=dorian</id><title>Subjects</title><content type="text">One subject heading matches.</content></entry>
<entry><id>https://www.gutenberg.org/ebooks/174.opds</id><title>The Picture of Dorian Gray</title><content type="text">Oscar Wilde</content></entry>
<entry><id>https://www.gutenberg.org/ebooks/33689.opds</id><title>Art &amp; Morality: A Defence of &quot;Dorian&quot;</title><content type="text">Stuart Mason</content></entry>
</feed>`;
  const BOOK = `<feed><title>The Picture of Dorian Gray by Oscar Wilde</title>
<entry><title>The Picture of Dorian Gray</title><content type="xhtml"><div>
<p>Author: Wilde, Oscar, 1854-1900</p><p>EBook No.: 174</p></div></content></entry>
<entry><title>The Picture of Dorian Gray</title></entry></feed>`;
  const deadGutendex = async (url: string) => {
    if (url.includes('gutendex.com')) throw new Error('The operation was aborted due to timeout');
    return {
      ok: true,
      status: 200,
      json: async () => { throw new Error('not json'); },
      text: async () => (url.includes('search.opds') ? SEARCH : url.endsWith('/174.opds') ? BOOK : RAW),
    };
  };

  it('reads Gutenberg search results, skipping non-book entries and decoding titles', () => {
    const r = parseOpdsSearch(SEARCH);
    assert.deepEqual(r.map((b) => b.id), [174, 33689]);
    assert.deepEqual(r[0].authors, ['Oscar Wilde']);
    assert.equal(r[1].title, 'Art & Morality: A Defence of "Dorian"');
    assert.match(r[0].cover ?? '', /pg174\.cover\.medium\.jpg$/);
  });

  it('reads one book page, dropping the life dates from the author', () => {
    const b = parseOpdsBook(174, BOOK);
    assert.equal(b?.title, 'The Picture of Dorian Gray');
    assert.deepEqual(b?.authors, [{ name: 'Wilde, Oscar' }]);
  });

  it('search and shelving both keep working with Gutendex dead', async () => {
    const results = await searchCatalog('dorian', deadGutendex);
    assert.equal(results[0].title, 'The Picture of Dorian Gray');
    const root = mkdtempSync(join(tmpdir(), 'library-'));
    try {
      const entry = await fetchAndShelve(174, deadGutendex, root);
      assert.equal(entry.title, 'The Picture of Dorian Gray');
      assert.deepEqual(entry.authors, ['Oscar Wilde']);
      assert.equal(entry.chapterCount, 2);
      assert.equal(entry.shelf, 'tbr');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('library shelves', () => {
  const book = (id: number) => ({
    id, title: `Book ${id}`, authors: ['A'], cover: null, source: 'gutenberg' as const,
    fetchedAt: '2026-11-09T00:00:00Z', chapters: [{ title: 'One', text: 'x' }, { title: 'Two', text: 'y' }],
  });

  it('a new book lands on To Be Read and moves to Currently Reading when she reads it', () => {
    const root = mkdtempSync(join(tmpdir(), 'library-'));
    try {
      assert.equal(saveBook(book(1), root).shelf, 'tbr');
      assert.equal(readShelf(root)[0].favorite, false);
      setProgress(1, 0, 0.1, root);
      assert.equal(readShelf(root)[0].shelf, 'reading');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('moves between shelves, stars a favorite, keeps both across a re-shelve, refuses unknown shelves', () => {
    const root = mkdtempSync(join(tmpdir(), 'library-'));
    try {
      saveBook(book(2), root);
      assert.equal(setShelf(2, { shelf: 'finished', favorite: true }, root)?.shelf, 'finished');
      setProgress(2, 1, 0.5, root);
      assert.equal(readShelf(root)[0].shelf, 'finished', 'rereading a finished book keeps it finished');
      saveBook(book(2), root);
      assert.deepEqual([readShelf(root)[0].shelf, readShelf(root)[0].favorite], ['finished', true]);
      assert.equal(setShelf(2, { favorite: false }, root)?.favorite, false);
      assert.throws(() => setShelf(2, { shelf: 'attic' }, root), LibraryError);
      assert.equal(setShelf(404, { shelf: 'dnf' }, root), null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('books shelved before shelves existed read as reading (started) or tbr (not)', () => {
    const root = mkdtempSync(join(tmpdir(), 'library-'));
    try {
      saveBook(book(3), root);
      saveBook(book(4), root);
      setProgress(3, 0, 0.2, root);
      const path = join(root, 'shelf.json');
      const old = JSON.parse(readFileSync(path, 'utf-8')).map(({ shelf: _s, favorite: _f, ...rest }: Record<string, unknown>) => rest);
      writeFileSync(path, JSON.stringify(old));
      const byId = Object.fromEntries(readShelf(root).map((e) => [e.id, e]));
      assert.equal(byId[3].shelf, 'reading');
      assert.equal(byId[4].shelf, 'tbr');
      assert.equal(byId[4].favorite, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
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
