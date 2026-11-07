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
