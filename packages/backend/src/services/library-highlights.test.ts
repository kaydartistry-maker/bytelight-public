// Library slice 4: her own highlights, and Kindle notebooks brought onto the shelf.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  saveBook,
  removeBook,
  readHighlights,
  addHighlight,
  updateHighlight,
  removeHighlight,
  locateQuote,
  titleKey,
  importKindleNotebook,
  readKindlePending,
  readAlong,
  highlightsSoFar,
  setProgress,
  LibraryError,
  type LibraryBook,
} from './library.js';
import { parseKindleNotebook, kindleColor } from './library-kindle.js';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(join(here, '__fixtures__', 'kindle-notebook-sample.txt'), 'utf-8');

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'bl-library-hl-'));
}

const filler = 'The fog sat on the harbor like a cat on a warm sill. '.repeat(12);

function lanternBook(id = 1_000_000_007, title = 'The Lantern Keeper'): LibraryBook {
  return {
    id,
    title,
    authors: ['Mara Quill'],
    cover: null,
    source: 'upload',
    fetchedAt: '2026-11-01T00:00:00.000Z',
    chapters: [
      { title: 'Chapter One', text: `${filler}\n\nThe lamp had burned every night for forty years, and nobody in the village\nremembered who first lit it.\n\n${filler}` },
      { title: 'Chapter Two', text: `${filler}\n\n"Do you ever get tired of the dark?" she asked.\n\nHe only smiled, the way the tide smiles at a stone.\n\n"I am not afraid of the water -- I am afraid of the quiet after it."` },
      { title: 'Chapter Three', text: `Gulls wheeled over the breakwater and the whole town smelled of salt and diesel and bread.\n\n${filler}` },
    ],
  };
}

describe('Kindle notebook parser', () => {
  it('reads the title, author, highlights with colors, chapters and dates, and counts bookmarks', () => {
    const nb = parseKindleNotebook(SAMPLE);
    assert.equal(nb.title, 'The Lantern Keeper (Harbor Lights Book 2)');
    assert.deepEqual(nb.authors, ['Mara Quill']);
    assert.equal(nb.bookmarks, 2);
    assert.equal(nb.highlights.length, 5);
    assert.deepEqual(nb.highlights.map((h) => h.color), ['yellow', 'pink', 'blue', 'orange', 'yellow']);
    assert.deepEqual(nb.highlights.map((h) => h.chapterHint), ['Chapter One', 'Chapter Two', 'Chapter Two', 'Chapter Three', 'Chapter Three']);
    assert.equal(nb.highlights[0].text, 'The lamp had burned every night for forty years, and nobody');
    assert.equal(nb.highlights[0].note, 'she kept it lit for him', 'a Note entry hangs on the highlight before it');
    assert.equal(nb.highlights[1].text, '“Do you ever get tired of the dark?” she asked. He only smiled, the way the tide smiles at a stone.', 'wrapped lines rejoin');
    assert.equal(nb.highlights[3].text, 'Gulls wheeled over the breakwater and the whole town smelled of salt and diesel and bread.', 'a page footer inside a highlight is skipped');
    assert.equal(nb.highlights[0].date?.slice(0, 10), '2026-10-02');
  });

  it('reads the -layout variant (indented, form feeds) the same way', () => {
    const layout = SAMPLE.split('\n').map((l) => (l.trim() ? `   ${l}` : l)).join('\n').replace(/\n1\n/, '\n                                     1\n');
    const a = parseKindleNotebook(SAMPLE);
    const b = parseKindleNotebook(layout);
    assert.deepEqual(b, a);
  });

  it('maps Kindle colors onto the four, Aqua as blue', () => {
    assert.equal(kindleColor('Aqua'), 'blue');
    assert.equal(kindleColor('Blue'), 'blue');
    assert.equal(kindleColor('Pink'), 'pink');
    assert.equal(kindleColor('Orange'), 'orange');
    assert.equal(kindleColor(undefined), 'yellow');
    assert.equal(kindleColor('Purple'), 'yellow');
  });

  it('refuses text that is not a notebook', () => {
    assert.throws(() => parseKindleNotebook('\n\n\n'), /Kindle notebook/);
  });
});

describe('finding a quote on the page', () => {
  const ch = lanternBook().chapters[1].text;
  it('is tolerant of curly quotes, dashes and spacing, and answers the page\'s own words', () => {
    assert.equal(locateQuote(ch, '“Do you ever get tired of   the dark?”'), '"Do you ever get tired of the dark?"');
    assert.equal(locateQuote(ch, 'I am not afraid of the water — I am afraid'), 'I am not afraid of the water -- I am afraid');
    assert.equal(locateQuote(ch, 'the quiet after it.'), 'the quiet after it."', 'punctuation clinging at an end she included rides along');
  });
  it('finds a highlight cut mid-quote and across paragraphs', () => {
    assert.equal(locateQuote(ch, 'tired of the dark?” she asked. He only smiled'), 'tired of the dark?" she asked. He only smiled');
  });
  it('answers null for words that are not there', () => {
    assert.equal(locateQuote(ch, 'nothing like this at all'), null);
  });
  it('folds titles: series notes, subtitles, case and a leading The', () => {
    assert.equal(titleKey('Flock (The Ravenhood Book 1)'), titleKey('flock'));
    assert.equal(titleKey('The Lantern Keeper: A Novel'), titleKey('Lantern Keeper'));
    assert.notEqual(titleKey('Lantern Keeper'), titleKey('Lantern Keepers'));
  });
});

describe('her highlights', () => {
  it('adds, changes, deletes, and goes with the book', () => {
    const root = tmpRoot();
    try {
      const book = lanternBook();
      saveBook(book, root);
      const h = addHighlight(book.id, { chapter: 0, quote: 'burned every night\nfor forty years', color: 'pink', note: ' mine ' }, root);
      assert.equal(h.quote, 'burned every night for forty years');
      assert.equal(h.color, 'pink');
      assert.equal(h.note, 'mine');
      assert.equal(h.source, 'owner');
      assert.throws(() => addHighlight(book.id, { chapter: 0, quote: 'not in this chapter at all' }, root), LibraryError);
      assert.throws(() => addHighlight(book.id, { chapter: 9, quote: 'lamp' }, root), LibraryError);
      assert.throws(() => addHighlight(book.id, { chapter: 0, quote: 'lamp', color: 'green' }, root), LibraryError);
      const changed = updateHighlight(book.id, h.id, { color: 'orange', note: 'changed' }, root);
      assert.equal(changed?.color, 'orange');
      assert.equal(readHighlights(book.id, root)[0].note, 'changed');
      assert.equal(updateHighlight(book.id, 'nope', { color: 'blue' }, root), null);
      addHighlight(book.id, { chapter: 2, quote: 'Gulls wheeled' }, root);
      assert.equal(removeHighlight(book.id, h.id, root), true);
      assert.equal(readHighlights(book.id, root).length, 1);
      removeBook(book.id, root);
      assert.equal(existsSync(join(root, 'highlights', `${book.id}.json`)), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Kindle import', () => {
  it('places highlights on the matching book, reports the unfindable, and adds only new ones on a second import', () => {
    const root = tmpRoot();
    try {
      const book = lanternBook();
      saveBook(book, root);
      const nb = parseKindleNotebook(SAMPLE);
      const first = importKindleNotebook(nb, root);
      assert.deepEqual(first.book, { id: book.id, title: 'The Lantern Keeper' });
      assert.equal(first.added, 4);
      assert.equal(first.duplicates, 0);
      assert.equal(first.unplaced, 1);
      assert.equal(first.bookmarks, 2);
      assert.equal(first.pending, false);
      const list = readHighlights(book.id, root);
      assert.deepEqual(list.map((h) => [h.chapter, h.color, h.source]), [[0, 'yellow', 'kindle'], [1, 'pink', 'kindle'], [1, 'blue', 'kindle'], [2, 'orange', 'kindle']]);
      assert.equal(list[0].note, 'she kept it lit for him');
      assert.equal(list[2].quote, 'I am not afraid of the water -- I am afraid of the quiet after it."', 'stored as the page\'s own words');
      // The one that couldn't be found waits under the book's title.
      const waiting = readKindlePending(root)[titleKey('The Lantern Keeper')];
      assert.equal(waiting?.highlights.length, 1);

      const again = importKindleNotebook(nb, root);
      assert.equal(again.added, 0);
      assert.equal(again.duplicates, 4);
      assert.equal(again.unplaced, 1);
      assert.equal(readHighlights(book.id, root).length, 4);
      assert.equal(readKindlePending(root)[titleKey('The Lantern Keeper')].highlights.length, 1, 'no double in waiting either');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a highlight she already made by hand counts as already here', () => {
    const root = tmpRoot();
    try {
      const book = lanternBook();
      saveBook(book, root);
      addHighlight(book.id, { chapter: 2, quote: 'Gulls wheeled over the breakwater and the whole town smelled of salt and diesel and bread.' }, root);
      const res = importKindleNotebook(parseKindleNotebook(SAMPLE), root);
      assert.equal(res.added, 3);
      assert.equal(res.duplicates, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps highlights for a book not on the shelf, and lays them in when it is shelved', () => {
    const root = tmpRoot();
    try {
      const nb = parseKindleNotebook(SAMPLE);
      const res = importKindleNotebook(nb, root);
      // Not shelved: the notebook stands on the shelf as a notes-only card.
      assert.equal(res.notebookCard, 'created');
      assert.ok(res.book && res.book.id >= 2_000_000_000);
      assert.equal(res.pending, true);
      assert.equal(res.added, 5, 'new to the card');
      assert.equal(res.unplaced, 5);
      assert.equal(res.notebookTitle, 'The Lantern Keeper (Harbor Lights Book 2)');
      const twice = importKindleNotebook(nb, root);
      assert.equal(twice.duplicates, 5);
      assert.equal(twice.unplaced, 5, 'waiting, once each');

      // Shelving the book (upload or Gutenberg both go through saveBook) lays them in.
      const book = lanternBook(1_000_000_009, 'Lantern Keeper: Harbor Lights');
      saveBook(book, root);
      assert.equal(readHighlights(book.id, root).length, 4);
      const left = readKindlePending(root)[titleKey('The Lantern Keeper')];
      assert.equal(left?.highlights.length, 1, 'the unfindable one keeps waiting');
      // Re-shelving doesn't double them.
      saveBook(book, root);
      assert.equal(readHighlights(book.id, root).length, 4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the companions see her highlights, never past her bookmark', () => {
  it('read-along carries her highlights on the words she has reached, in page order', () => {
    const root = tmpRoot();
    try {
      const book = lanternBook();
      saveBook(book, root);
      addHighlight(book.id, { chapter: 0, quote: 'nobody in the village', color: 'pink', note: 'him' }, root);
      addHighlight(book.id, { chapter: 0, quote: 'burned every night', color: 'blue' }, root);
      // Chapter two: one on its opening words, one on its last line.
      addHighlight(book.id, { chapter: 1, quote: 'The fog sat on the harbor' }, root);
      addHighlight(book.id, { chapter: 1, quote: 'afraid of the quiet after it', color: 'orange', note: 'ahead of her' }, root);
      // Read ahead into chapter three once, then went back.
      addHighlight(book.id, { chapter: 2, quote: 'Gulls wheeled' }, root);
      // She's early in chapter two.
      setProgress(book.id, 1, 0, root);

      const behind = readAlong(book.id, 0, root);
      assert.deepEqual(behind.highlights.map((h) => [h.quote, h.color, h.note]), [
        ['burned every night', 'blue', ''],
        ['nobody in the village', 'pink', 'him'],
      ], 'a finished chapter: all of hers, in page order');

      const here = readAlong(book.id, undefined, root);
      assert.equal(here.cutAtHerPlace, true);
      assert.deepEqual(here.highlights.map((h) => h.quote), ['The fog sat on the harbor'], 'the one past her place stays hidden');

      const all = highlightsSoFar(book.id, root);
      assert.equal(all.readInKindle, false);
      assert.deepEqual(all.highlights.map((h) => [h.chapter, h.quote]), [
        [0, 'burned every night'],
        [0, 'nobody in the village'],
        [1, 'The fog sat on the harbor'],
      ], 'nothing from her current chapter past her place, nothing from a chapter ahead');
      assert.equal(all.highlights[0].chapterTitle, 'Chapter One');

      // Reaching the end of chapter two shows its last line's highlight too.
      setProgress(book.id, 1, 1, root);
      assert.equal(readAlong(book.id, undefined, root).highlights.length, 2);
      assert.equal(highlightsSoFar(book.id, root).highlights.some((h) => h.chapter === 2), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a Kindle notebook card shares all its highlights, with Kindle’s chapter', () => {
    const root = tmpRoot();
    try {
      const res = importKindleNotebook(parseKindleNotebook(SAMPLE), root);
      const card = highlightsSoFar(res.book!.id, root);
      assert.equal(card.readInKindle, true);
      assert.equal(card.highlights.length, 5);
      assert.equal(card.highlights[0].chapter, null);
      assert.equal(card.highlights[0].chapterTitle, 'Chapter One');
      assert.equal(card.highlights[0].note, 'she kept it lit for him');
      assert.equal(card.highlights[0].source, 'kindle');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a book she has not started, or one not on her shelf', () => {
    const root = tmpRoot();
    try {
      const book = lanternBook();
      saveBook(book, root);
      assert.throws(() => highlightsSoFar(book.id, root), /not started/);
      assert.throws(() => highlightsSoFar(42, root), LibraryError);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
