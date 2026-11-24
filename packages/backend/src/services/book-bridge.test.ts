import test from 'node:test';
import assert from 'node:assert/strict';

const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const tmpRoot = mkdtempSync(join(tmpdir(), 'book-bridge-test-'));
process.env.RESONANT_HOME = tmpRoot;
process.env.DB_PATH = join(tmpRoot, 'bytelight.db');
const { loadConfig } = await import('../config.js');
loadConfig(join(tmpRoot, 'no-config.yaml'));
const { initDb, getDb } = await import('./db/init.js');
initDb(':memory:');
getDb().prepare('DELETE FROM companions').run();

const { saveBook, libraryDir, readNotes, reachedNotes } = await import('./library.js');
const bridge = await import('./book-bridge.js');

const root = libraryDir();
const book = {
  id: 1_000_000_777,
  title: 'The Lantern House',
  authors: ['A. Reader'],
  cover: null,
  source: 'upload' as const,
  fetchedAt: new Date().toISOString(),
  chapters: [
    { title: 'One', text: 'First room.\n\nThe lamp burned blue.\n\nA door opened.' },
    { title: 'Two', text: 'Rain crossed the glass.\n\nSomeone had written her name in the dust.\n\nThe stairs answered.' },
    { title: 'Three', text: 'The attic waited.\n\nA bell moved without wind.' },
  ],
};
saveBook(book, root);

test('pairing is one-use and only the token hash remains', () => {
  const t0 = 1_800_000_000_000;
  const made = bridge.createBookBridgePairingCode(t0);
  assert.match(made.code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  const { token } = bridge.claimBookBridgePairingCode(made.code, t0 + 1000);
  assert.ok(token.length >= 40);
  assert.ok(bridge.bookBridgeTokenValid(token));
  assert.throws(() => bridge.claimBookBridgePairingCode(made.code, t0 + 2000));
});

test('a BOOX page event advances the house bookmark without touching reader UI', () => {
  const result = bridge.ingestBookBridgeEvent({
    eventId: 'evt-1',
    book: { title: book.title, fingerprint: 'abc123' },
    position: { chapter: 0, fraction: 0.1 },
    viewport: { text: 'The lamp burned blue.', anchor: 'The lamp burned blue.' },
  }, root, 1_800_000_010_000);
  assert.equal(result.bookId, book.id);
  assert.equal(result.mode, 'live');
  assert.equal(bridge.bookBridgeView(root).current?.chapter, 0);
  assert.equal(bridge.readForBookBridge({ bookId: book.id, chapter: 0 }, root).cutAtHerPlace, true);
  assert.throws(() => bridge.readForBookBridge({ bookId: book.id, chapter: 1 }, root), /one chapter ahead|live mode/i);
});

test('one-chapter-ahead allows exactly one chapter and queues a hidden anchored note', () => {
  bridge.setBookBridgeMode(book.id, 'ahead', root);
  const next = bridge.readForBookBridge({ bookId: book.id, chapter: 1 }, root);
  assert.equal(next.chapter, 1);
  assert.match(next.paragraphs.join(' '), /written her name/);
  assert.throws(() => bridge.readForBookBridge({ bookId: book.id, chapter: 2 }, root), /one chapter/i);

  const queued = bridge.queueBookBridgeNote({
    bookId: book.id,
    chapter: 1,
    quote: 'Someone had written her name in the dust.',
    note: 'I was waiting for you at this sentence.',
    author: 'companion-a',
  }, root);
  assert.equal(readNotes(book.id, root).length, 1);
  assert.equal(reachedNotes(book.id, root).length, 0, 'ahead note stays sealed from ordinary Library surfaces');
  assert.equal(bridge.pendingBookBridgeNotes(book.id, root).length, 1);
  bridge.ingestBookBridgeEvent({
    eventId: 'evt-2', book: { title: book.title }, position: { chapter: 1, fraction: 0.8 },
    viewport: { text: 'Someone had written her name in the dust.' },
  }, root, 1_800_000_020_000);
  assert.equal(reachedNotes(book.id, root).length, 1, 'note appears once her bookmark reaches its anchor');
  bridge.ackBookBridgeNotes([queued.id], root);
  assert.equal(bridge.pendingBookBridgeNotes(book.id, root).length, 0);
});
