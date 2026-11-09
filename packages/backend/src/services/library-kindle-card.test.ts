// Library: the Kindle notebook card — a notes-only book on the shelf for a
// store book read in the Kindle app. Made-up titles and quotes throughout.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { zipSync, strToU8 } from 'fflate';
import {
  saveBook,
  removeBook,
  readShelf,
  setShelf,
  readHighlights,
  readKindlePending,
  readKindleCard,
  importKindleNotebook,
  shelveWaitingNotebooks,
  findKindleCover,
  fillSpineColors,
  readAlong,
  shelveUpload,
  titleKey,
  KINDLE_ID_BASE,
  UPLOAD_ID_BASE,
  LibraryError,
  type LibraryBook,
} from './library.js';
import { parseKindleNotebook } from './library-kindle.js';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'bl-library-card-'));
}

const NOTEBOOK = `The Quiet Orchard (Windmere Book 1)
by Ilse Varga
Free Kindle instant preview: https://read.amazon.com/kp/kshare?asin=B000000001

Annotations (3)
• 3 Highlights | Yellow (1), Pink (1), Aqua (1)

Chapter 1: Frost

Page 4 | Highlight (Yellow)
The pears came in hard and green and smelling of rain.
Nov 2, 2026

Page 4 | Note
the first line hooked me
Nov 2, 2026

Page 9 | Highlight (Pink)
She counted the trees twice, as if one might have wandered off.
Nov 3, 2026

Chapter 2: Thaw

Page 17 | Highlight (Aqua)
Nobody plants an orchard for themselves.
Nov 4, 2026
`;

const MORE = `${NOTEBOOK}
Page 22 | Highlight (Orange)
The ladder leaned where he had left it, patient as a dog.
Nov 5, 2026
`;

const pad = 'Wind moved through the rows like someone looking for a name. '.repeat(10);

function orchardBook(id: number, extra = ''): LibraryBook {
  return {
    id,
    title: 'The Quiet Orchard',
    authors: ['Ilse Varga'],
    cover: null,
    source: 'upload',
    fetchedAt: '2026-11-09T00:00:00.000Z',
    chapters: [
      { title: 'Chapter 1: Frost', text: `${pad}\n\nThe pears came in hard and green and smelling of rain.\n\n${pad}\n\nShe counted the trees twice, as if one might have wandered off.` },
      { title: 'Chapter 2: Thaw', text: `${pad}\n\n${extra || 'Nobody plants an orchard for themselves.'}\n\n${pad}` },
    ],
  };
}

async function jpeg(): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: 12, height: 18, channels: 3, background: { r: 200, g: 30, b: 40 } } }).jpeg().toBuffer());
}

/** A fetch that answers Open Library's search and cover URLs from a script. */
function stubFetch(answers: { coverId?: unknown; image?: Uint8Array | null; searchFails?: boolean }) {
  const calls: string[] = [];
  const fn = async (url: string) => {
    calls.push(url);
    if (url.startsWith('https://openlibrary.org/search.json')) {
      if (answers.searchFails) throw new Error('offline');
      return { ok: true, status: 200, json: async () => ({ docs: answers.coverId === undefined ? [] : [{ cover_i: answers.coverId }] }), text: async () => '' };
    }
    if (url.startsWith('https://covers.openlibrary.org/')) {
      const img = answers.image;
      if (!img) return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
      return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => img.slice().buffer };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fn, calls };
}

describe('Kindle notebook card', () => {
  it('a notebook for an unshelved book becomes a notes-only book on Reading', () => {
    const root = tmpRoot();
    try {
      const res = importKindleNotebook(parseKindleNotebook(NOTEBOOK), root);
      assert.equal(res.notebookCard, 'created');
      assert.equal(res.added, 3);
      assert.equal(res.unplaced, 3);
      const [card] = readShelf(root);
      assert.equal(card.id, res.book!.id);
      assert.ok(card.id > KINDLE_ID_BASE);
      assert.equal(card.source, 'kindle');
      assert.equal(card.title, 'The Quiet Orchard (Windmere Book 1)');
      assert.deepEqual(card.authors, ['Ilse Varga']);
      assert.equal(card.chapterCount, 0);
      assert.equal(card.shelf, 'reading');
      assert.equal(card.cover, null);
      assert.equal(existsSync(join(root, 'books', `${card.id}.json`)), false, 'no text file: it is notes only');

      const view = readKindleCard(card.id, root)!;
      assert.equal(view.highlights.length, 3);
      assert.deepEqual(view.highlights.map((h) => [h.chapterHint, h.page, h.color]), [
        ['Chapter 1: Frost', '4', 'yellow'],
        ['Chapter 1: Frost', '9', 'pink'],
        ['Chapter 2: Thaw', '17', 'blue'],
      ]);
      assert.equal(view.highlights[0].note, 'the first line hooked me');
      assert.ok(view.lastImportedAt);
      // Shelves and stars work on it like any book.
      assert.equal(setShelf(card.id, { shelf: 'finished', favorite: true }, root)?.favorite, true);
      // There is nothing for the companions to read along with.
      assert.throws(() => readAlong(card.id, 0, root), (e: unknown) => e instanceof LibraryError && /Kindle/.test((e as Error).message));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('re-importing the notebook updates the same card, never a second one', () => {
    const root = tmpRoot();
    try {
      const first = importKindleNotebook(parseKindleNotebook(NOTEBOOK), root);
      const again = importKindleNotebook(parseKindleNotebook(NOTEBOOK), root);
      assert.equal(again.notebookCard, 'updated');
      assert.equal(again.book!.id, first.book!.id);
      assert.equal(again.added, 0);
      assert.equal(again.duplicates, 3);
      const more = importKindleNotebook(parseKindleNotebook(MORE), root);
      assert.equal(more.added, 1);
      assert.equal(more.unplaced, 4);
      assert.equal(readShelf(root).length, 1);
      assert.equal(readKindleCard(first.book!.id, root)!.highlights.length, 4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('highlights already waiting (kept before cards existed) show on the card', () => {
    const root = tmpRoot();
    try {
      const key = titleKey('Saltglass (The Tidewater Book 1)');
      const legacy = {
        [key]: {
          title: 'Saltglass (The Tidewater Book 1)',
          highlights: [
            { quote: 'The sea keeps what you forget to hold.', color: 'yellow', note: '', chapterHint: 'One', createdAt: '2026-11-01T00:00:00.000Z' },
            { quote: 'Every lighthouse is a promise somebody kept.', color: 'pink', note: 'yes', chapterHint: 'Two', createdAt: '2026-11-02T00:00:00.000Z' },
          ],
        },
      };
      writeFileSync(join(root, 'kindle-pending.json'), JSON.stringify(legacy));
      const made = shelveWaitingNotebooks(root);
      assert.equal(made.length, 1);
      assert.equal(made[0].source, 'kindle');
      const view = readKindleCard(made[0].id, root)!;
      assert.deepEqual(view.highlights.map((h) => h.quote), legacy[key].highlights.map((h) => h.quote));
      assert.equal(view.lastImportedAt, made[0].addedAt, 'older ones date from the card');
      assert.equal(shelveWaitingNotebooks(root).length, 0, 'runs once');
      assert.equal(readShelf(root).length, 1);

      // Taking the card off the shelf takes its highlights, and it stays gone.
      assert.equal(removeBook(made[0].id, root), true);
      assert.equal(readKindlePending(root)[key], undefined);
      assert.equal(shelveWaitingNotebooks(root).length, 0);
      assert.equal(readShelf(root).length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a notebook brought in on top of older waiting highlights keeps them on the one card', () => {
    const root = tmpRoot();
    try {
      const key = titleKey('The Quiet Orchard');
      writeFileSync(join(root, 'kindle-pending.json'), JSON.stringify({
        [key]: { title: 'The Quiet Orchard (Windmere Book 1)', highlights: [
          { quote: 'The pears came in hard and green and smelling of rain.', color: 'yellow', note: '', chapterHint: 'Chapter 1: Frost', createdAt: '2026-11-02T00:00:00.000Z' },
        ] },
      }));
      const res = importKindleNotebook(parseKindleNotebook(NOTEBOOK), root);
      assert.equal(res.added, 2);
      assert.equal(res.duplicates, 1);
      const view = readKindleCard(res.book!.id, root)!;
      assert.equal(view.highlights.length, 3);
      assert.equal(view.highlights[0].page, '4', 'the older one picks up its page');
      assert.deepEqual(readKindlePending(root)[key].authors, ['Ilse Varga']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('when the real book arrives its highlights land on the text and the card retires, keeping her shelf and star', () => {
    const root = tmpRoot();
    try {
      const res = importKindleNotebook(parseKindleNotebook(NOTEBOOK), root);
      const cardId = res.book!.id;
      setShelf(cardId, { shelf: 'finished', favorite: true }, root);
      const saved = saveBook(orchardBook(UPLOAD_ID_BASE + 3), root);
      assert.deepEqual(saved.kindle, { placed: 3, waiting: 0, retired: true });
      const shelf = readShelf(root);
      assert.deepEqual(shelf.map((e) => e.id), [UPLOAD_ID_BASE + 3], 'the card is gone');
      assert.equal(shelf[0].shelf, 'finished');
      assert.equal(shelf[0].favorite, true);
      assert.equal(shelf[0].source, undefined);
      const hl = readHighlights(UPLOAD_ID_BASE + 3, root);
      assert.deepEqual(hl.map((h) => [h.chapter, h.color, h.source]), [[0, 'yellow', 'kindle'], [0, 'pink', 'kindle'], [1, 'blue', 'kindle']]);
      assert.equal(hl[0].note, 'the first line hooked me');
      assert.equal(readKindlePending(root)[titleKey('The Quiet Orchard')], undefined);
      assert.equal(readKindleCard(cardId, root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('highlights the real text lacks stay safe on the card, and later imports go to the real book', () => {
    const root = tmpRoot();
    try {
      const res = importKindleNotebook(parseKindleNotebook(NOTEBOOK), root);
      const cardId = res.book!.id;
      // This edition words the Thaw line differently.
      const realId = UPLOAD_ID_BASE + 4;
      const saved = saveBook(orchardBook(realId, 'No one ever planted an orchard for their own sake.'), root);
      assert.deepEqual(saved.kindle, { placed: 2, waiting: 1, retired: false });
      assert.equal(saved.shelf, 'reading', 'the card\'s shelf');
      assert.deepEqual(readShelf(root).map((e) => e.id).sort(), [realId, cardId].sort());
      assert.deepEqual(readKindleCard(cardId, root)!.highlights.map((h) => h.page), ['17']);
      // A later import matches the real book, not the card.
      const later = importKindleNotebook(parseKindleNotebook(MORE), root);
      assert.equal(later.notebookCard, undefined);
      assert.deepEqual(later.book, { id: realId, title: 'The Quiet Orchard' });
      assert.equal(later.duplicates, 2);
      assert.equal(readKindleCard(cardId, root)!.highlights.length, 2, 'the unfindable ones wait on the card');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uploads keep numbering below the Kindle card range', () => {
    const root = tmpRoot();
    try {
      importKindleNotebook(parseKindleNotebook(NOTEBOOK), root);
      const epub = zipSync({
        mimetype: strToU8('application/epub+zip'),
        'META-INF/container.xml': strToU8('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
        'OEBPS/content.opf': strToU8('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Other Book</dc:title><dc:creator>Someone</dc:creator></metadata><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'),
        'OEBPS/c1.xhtml': strToU8(`<html xmlns="http://www.w3.org/1999/xhtml"><body><h1>One</h1><p>${pad}</p></body></html>`),
      });
      const up = shelveUpload(epub, root);
      assert.equal(up.id, UPLOAD_ID_BASE + 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Kindle notebook card cover', () => {
  it('finds the cover on Open Library by title and author, keeps it, and its spine color follows', async () => {
    const root = tmpRoot();
    try {
      const { book } = importKindleNotebook(parseKindleNotebook(NOTEBOOK), root);
      const img = await jpeg();
      const stub = stubFetch({ coverId: 424242, image: img });
      // A spine pass ran before the cover was found: it must be worked out again.
      await fillSpineColors(root, stub.fn as never);
      assert.equal(readShelf(root)[0].spineColor, null);
      assert.equal(await findKindleCover(book!.id, root, stub.fn as never), true);
      const search = new URL(stub.calls[0]);
      assert.equal(search.searchParams.get('title'), 'The Quiet Orchard', 'series note left off');
      assert.equal(search.searchParams.get('author'), 'Ilse Varga');
      assert.equal(search.searchParams.get('limit'), '1');
      assert.match(stub.calls[1], /^https:\/\/covers\.openlibrary\.org\/b\/id\/424242-M\.jpg/);
      const card = readShelf(root)[0];
      assert.equal(card.cover, `/api/library/covers/${book!.id}.jpg`);
      assert.equal(card.spineColor, undefined);
      assert.deepEqual(new Uint8Array(readFileSync(join(root, 'covers', `${book!.id}.jpg`))), img);
      await fillSpineColors(root, stub.fn as never);
      assert.match(readShelf(root)[0].spineColor ?? '', /^#[0-9a-f]{6}$/);
      // Found once; not looked up again.
      assert.equal(await findKindleCover(book!.id, root, stub.fn as never), false);
      assert.equal(stub.calls.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const [why, answers] of [
    ['the search is unreachable', { searchFails: true }],
    ['Open Library has no cover', {}],
    ['a bad cover id', { coverId: 'x' }],
    ['the image is missing', { coverId: 7, image: null }],
    ['the image is not a JPEG', { coverId: 7, image: new Uint8Array(600).fill(0x47) }],
  ] as const) {
    it(`no cover when ${why}, and the card stands without one`, async () => {
      const root = tmpRoot();
      try {
        const { book } = importKindleNotebook(parseKindleNotebook(NOTEBOOK), root);
        const stub = stubFetch(answers as Parameters<typeof stubFetch>[0]);
        assert.equal(await findKindleCover(book!.id, root, stub.fn as never), false);
        const card = readShelf(root)[0];
        assert.equal(card.cover, null);
        assert.equal(existsSync(join(root, 'covers', `${book!.id}.jpg`)), false);
        assert.equal(readKindleCard(book!.id, root)!.highlights.length, 3);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it('only Kindle cards are looked up', async () => {
    const root = tmpRoot();
    try {
      saveBook(orchardBook(UPLOAD_ID_BASE + 9), root);
      const stub = stubFetch({ coverId: 1, image: await jpeg() });
      assert.equal(await findKindleCover(UPLOAD_ID_BASE + 9, root, stub.fn as never), false);
      assert.equal(stub.calls.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
