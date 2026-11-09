// The reading room's text handling (UI flip, Library slice 1).
import assert from 'node:assert/strict';
import test from 'node:test';
import { toParagraphs, passageMessage } from '../components/LibraryApp';
import { APPS } from './apps';

test('Gutenberg hard-wrapped lines rejoin into whole paragraphs', () => {
  const text = 'It was a dark\nand stormy night;\n  the rain fell.\n\n\nShe read on.\n';
  assert.deepEqual(toParagraphs(text), ['It was a dark and stormy night; the rain fell.', 'She read on.']);
});

test('a shared passage arrives quoted, with the book, chapter and her note', () => {
  const msg = passageMessage({ title: 'Wuthering Heights' }, 'CHAPTER IX', 'He shall never know\nhow I love him.', ' oh no ');
  assert.equal(msg, '📖 *Wuthering Heights* — CHAPTER IX\n\n> He shall never know\n> how I love him.\n\noh no');
  assert.ok(!passageMessage({ title: 'X' }, 'I', 'a', '').endsWith('\n'), 'no trailing blank note');
});

test('the Library is its own app in the drawer, not on the dock', () => {
  const lib = APPS.find((a) => a.id === 'library');
  assert.ok(lib);
  assert.equal(lib.screen, 'library');
  assert.ok(!lib.dock);
});

test('read-aloud starts at the piece holding the paragraph on screen', async () => {
  const { segmentForParagraph } = await import('./library-reader');
  const segs = [{ from: 0, to: 2 }, { from: 3, to: 3 }, { from: 4, to: 9 }];
  assert.equal(segmentForParagraph(segs, 0), 0);
  assert.equal(segmentForParagraph(segs, 3), 1);
  assert.equal(segmentForParagraph(segs, 7), 2);
  assert.equal(segmentForParagraph([], 4), 0);
});

test('margin notes underline their exact words, whitespace-tolerant, never overlapping', async () => {
  const { markQuotes } = await import('./library-reader');
  const note = (id: string, quote: string) => ({ id, chapter: 0, quote, paragraph: 0, note: 'n', author: 'companion-a', createdAt: '' });
  const p = 'He shall never know  how I love him (and that, not because he is handsome).';
  const pieces = markQuotes(p, [note('a', 'never know how I love'), note('b', 'love him (and'), note('c', 'not because')]);
  assert.equal(pieces.map((x) => x.text).join(''), p, 'the paragraph is whole');
  assert.deepEqual(pieces.filter((x) => x.note).map((x) => [x.note!.id, x.text]), [['a', 'never know  how I love'], ['c', 'not because']]);
  assert.deepEqual(markQuotes('plain', []), [{ text: 'plain' }]);
  assert.deepEqual(markQuotes('plain', [note('z', 'absent words')]), [{ text: 'plain' }]);
});

test('her highlights wash their words, across paragraphs, and share words with a margin note', async () => {
  const { markPage } = await import('./library-reader');
  const note = { id: 'n', chapter: 0, quote: 'the dark', paragraph: 0, note: 'n', author: 'companion-a', createdAt: '' };
  const hl = (id: string, quote: string, createdAt: string) => ({ id, chapter: 0, quote, color: 'pink' as const, note: '', source: 'owner' as const, createdAt });
  const paras = ['Do you ever get tired of the dark? she asked.', 'He only smiled.'];
  const pages = markPage(paras, [note], [hl('h', 'tired of the dark? she asked. He only', '1')]);
  // Every paragraph stays whole.
  assert.deepEqual(pages.map((ps) => ps.map((x) => x.text).join('')), paras);
  const first = pages[0].map((x) => [x.text, x.highlight?.id ?? null, x.note?.id ?? null, x.noteEnd ?? false]);
  assert.deepEqual(first, [
    ['Do you ever get ', null, null, false],
    ['tired of ', 'h', null, false],
    ['the dark', 'h', 'n', true],
    ['? she asked.', 'h', null, false],
  ]);
  assert.deepEqual(pages[1].map((x) => [x.text, x.highlight?.id ?? null]), [['He only', 'h'], [' smiled.', null]]);
});

test('overlapping highlights: the earlier keeps the shared words, the later shows on the rest', async () => {
  const { markPage } = await import('./library-reader');
  const hl = (id: string, quote: string, createdAt: string) => ({ id, chapter: 0, quote, color: 'yellow' as const, note: '', source: 'owner' as const, createdAt });
  const pages = markPage(['one two three four'], [], [hl('late', 'three four', '2'), hl('early', 'two three', '1')]);
  assert.deepEqual(pages[0].map((x) => [x.text, x.highlight?.id ?? null]), [['one ', null], ['two three', 'early'], [' four', 'late']]);
  assert.deepEqual(markPage(['plain'], [], [hl('x', 'absent', '1')]), [[{ text: 'plain' }]]);
});

test('a Kindle import answers in plain words', async () => {
  const { kindleResultMessage } = await import('../components/LibraryApp');
  const book = { id: 1, title: 'The September House' };
  assert.equal(kindleResultMessage({ book, added: 14, duplicates: 2, unplaced: 1, bookmarks: 3, pending: false }), '14 highlights added to The September House · 2 already here · 1 couldn\'t be placed');
  assert.equal(kindleResultMessage({ book, added: 1, duplicates: 0, unplaced: 0, bookmarks: 0, pending: false }), '1 highlight added to The September House');
  assert.equal(kindleResultMessage({ book, added: 0, duplicates: 5, unplaced: 0, bookmarks: 0, pending: false }), 'Nothing new for The September House · 5 already here');
  assert.equal(kindleResultMessage({ book: null, notebookTitle: 'Flock (The Ravenhood Book 1)', added: 0, duplicates: 0, unplaced: 2, bookmarks: 7, pending: true }), 'Flock (The Ravenhood Book 1) isn\'t on your shelf yet. Its 2 highlights are saved and will show up when you add the book.');
});

test('a notebook for an unshelved book says it stands on the shelf as a Kindle notebook', async () => {
  const { kindleResultMessage } = await import('../components/LibraryApp');
  const book = { id: 2_000_000_001, title: 'The Quiet Orchard (Windmere Book 1)' };
  const base = { book, notebookTitle: book.title, bookmarks: 0, pending: true };
  assert.equal(kindleResultMessage({ ...base, added: 2, duplicates: 0, unplaced: 2, notebookCard: 'created' }), 'The Quiet Orchard is on your shelf as a Kindle notebook · 2 highlights');
  assert.equal(kindleResultMessage({ ...base, added: 0, duplicates: 0, unplaced: 0, notebookCard: 'created' }), 'The Quiet Orchard is on your shelf as a Kindle notebook · no highlights yet');
  assert.equal(kindleResultMessage({ ...base, added: 1, duplicates: 2, unplaced: 3, notebookCard: 'updated' }), '1 new highlight on The Quiet Orchard\'s Kindle notebook · 3 in all');
  assert.equal(kindleResultMessage({ ...base, added: 0, duplicates: 3, unplaced: 3, notebookCard: 'updated' }), 'Nothing new for The Quiet Orchard\'s Kindle notebook · 3 already here');
});

test('the real book arriving says where the Kindle highlights went', async () => {
  const { kindleArrivalMessage } = await import('../components/LibraryApp');
  assert.equal(kindleArrivalMessage('The Quiet Orchard', undefined), null);
  assert.equal(kindleArrivalMessage('The Quiet Orchard', { placed: 3, waiting: 0, retired: true }), 'Your 3 Kindle highlights moved into The Quiet Orchard');
  assert.equal(kindleArrivalMessage('The Quiet Orchard', { placed: 2, waiting: 1, retired: false }), 'Your 2 Kindle highlights moved into The Quiet Orchard · 1 couldn\'t be found in this edition, so it stays on its Kindle notebook');
});

test('the notebook card groups highlights under Kindle\'s chapter headings and dates them shortly', async () => {
  const { groupByChapter, notebookLine, shortDate, shortTitle } = await import('../components/LibraryApp');
  const h = (chapterHint: string | null, quote: string) => ({ chapterHint, quote });
  const groups = groupByChapter([h('One', 'a'), h('One', 'b'), h(null, 'c'), h('Two', 'd'), h('One', 'e')]);
  assert.deepEqual(groups.map((g) => [g.heading, g.items.map((x) => x.quote)]), [['One', ['a', 'b', 'e']], [null, ['c']], ['Two', ['d']]]);
  const now = new Date('2026-11-09T12:00:00');
  assert.equal(shortDate('2026-11-09T10:00:00', now), 'Nov 9');
  assert.equal(shortDate('2025-03-02T10:00:00', now), 'Mar 2, 2025');
  assert.equal(shortDate('not a date', now), '');
  assert.equal(notebookLine(2, '2026-11-09T10:00:00', now), 'Read in Kindle · 2 highlights · last exported Nov 9');
  assert.equal(notebookLine(0, '', now), 'Read in Kindle · no highlights yet');
  assert.equal(shortTitle('Flock (The Ravenhood Book 1)'), 'Flock');
  assert.equal(shortTitle('Plain Title'), 'Plain Title');
});
